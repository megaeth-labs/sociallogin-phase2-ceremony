import { generateKeyPairSync, createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { canonicalize, signEnvelope, PUBLICATION_ACK_DOMAIN, verifyPublicationAck,
  type CeremonyManifestV1, type JsonValue } from "@moss/phase2-protocol";
import { publishAndWitness } from "../src/publication.js";
const witness = generateKeyPairSync("ed25519");
const key = { keyId: "witness", algorithm: "Ed25519" as const,
  publicKeyPem: witness.publicKey.export({ type: "spki", format: "pem" }).toString() };
const ceremonyId = "123e4567-e89b-42d3-a456-426614174000";
const eventHash = "a".repeat(64);
const bundle: JsonValue = { type: "synthetic publication fixture" };
const sha256 = createHash("sha256").update(canonicalize(bundle)).digest("hex");
function ack(overrides = {}) {
  return signEnvelope({ type: "moss.phase2.publication-ack.v1", ceremonyId, eventSequence: 1, eventHash,
    bundleSha256: sha256, mirror: { url: "https://mirror.example/evidence.json?versionId=v1", versionId: "v1", sha256 },
    witnessedAt: new Date().toISOString(), ...overrides }, { privateKey: witness.privateKey, keyId: key.keyId, domain: PUBLICATION_ACK_DOMAIN });
}
const input = { manifest: { ceremonyId, publication: { witness: key, endpoint: "https://witness.example/publish" } } as CeremonyManifestV1,
  bundle, eventSequence: 1, eventHash, archive: { publishBytes: async () => ({ versionId: "v1", sha256 }) } };
describe("publication gate", () => {
  it("requires signed acknowledgement of the exact archived bundle", async () => {
    const result = await publishAndWitness({ ...input, fetcher: async () => new Response(JSON.stringify(ack())) });
    expect(result.sha256).toBe(sha256);
    for (const changed of [{ eventHash: "b".repeat(64) }, { ceremonyId: "different" }, { bundleSha256: "b".repeat(64) }]) {
      await expect(publishAndWitness({ ...input, fetcher: async () => new Response(JSON.stringify(ack(changed))) })).rejects.toThrow(/bind/);
    }
  });
  it("does not publish when the witness fails or the archive pin is invalid", async () => {
    await expect(publishAndWitness({ ...input, fetcher: async () => new Response("", { status: 503 }) })).rejects.toThrow(/acknowledged/);
    await expect(publishAndWitness({ ...input, archive: { publishBytes: async () => ({ versionId: "null", sha256 }) } })).rejects.toThrow(/archive pin/);
  });
  it("rejects substituted witness identities and unversioned mirror claims", () => {
    expect(() => verifyPublicationAck(ack() as never, { ...key, keyId: "other" }, { ceremonyId, eventSequence: 1, eventHash })).toThrow(/signer/);
    expect(() => verifyPublicationAck(ack({ mirror: { url: "https://mirror.example", versionId: "null", sha256 } }) as never, key, { ceremonyId, eventSequence: 1, eventHash })).toThrow(/bind/);
  });
});

it("archives deterministic coordinator checkpoints without a duplicate mirror for primary publication policy", async () => {
  const { PRIMARY_PUBLICATION_DOMAIN, verifyPrimaryPublication } = await import("@moss/phase2-protocol");
  const manifest = { ceremonyId, purpose: "rehearsal", coordinatorKeys: [key],
    primaryPublication: { archiveBaseUrl: "https://archive.example/" } } as CeremonyManifestV1;
  const writes: string[] = [];
  const primary = { ...input, manifest, signPrimary: (record: import("@moss/phase2-protocol").PrimaryPublication) => signEnvelope(record as unknown as JsonValue,
    { keyId: key.keyId, privateKey: witness.privateKey, domain: PRIMARY_PUBLICATION_DOMAIN }) as unknown as import("@moss/phase2-protocol").SignedEnvelope<import("@moss/phase2-protocol").PrimaryPublication>,
    fetcher: async () => { throw new Error("must not contact a witness"); },
    archive: { publishBytes: async (path: string, bytes: Buffer) => {
      writes.push(path); return { versionId: "v1", sha256: createHash("sha256").update(bytes).digest("hex") };
    } } };
  const first = await publishAndWitness(primary);
  const second = await publishAndWitness(primary);
  expect(first).toEqual(second);
  expect(writes).toHaveLength(4);
  expect(writes[1]).toContain("checkpoint-");
  expect(verifyPrimaryPublication(first.acknowledgement as never, manifest, { ceremonyId, eventSequence: 1, eventHash }).archive.url).toContain("versionId=v1");
  expect(() => verifyPrimaryPublication(first.acknowledgement as never, manifest, { ceremonyId, eventSequence: 2, eventHash })).toThrow(/bind/);
  // Production may rely on the coordinator's own checkpoint, but never alongside a witness policy.
  const production = { ...manifest, purpose: "production" } as CeremonyManifestV1;
  expect(await publishAndWitness({ ...primary, manifest: production })).toEqual(first);
  await expect(publishAndWitness({ ...primary, manifest: { ...production, publication: { endpoint: "https://witness.example", witness: key } } as CeremonyManifestV1 })).rejects.toThrow(/authorized/);
  await expect(publishAndWitness({ ...primary, signPrimary: undefined })).rejects.toThrow(/authorized/);
  await expect(publishAndWitness({ ...primary, archive: { publishBytes: async () => { throw new Error("archive unavailable"); } } })).rejects.toThrow(/unavailable/);
});
