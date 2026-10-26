import { generateKeyPairSync, createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalize, canonicalSha256, signEnvelope, transcriptEventHash, MANIFEST_SIGNATURE_DOMAIN, RECEIPT_SIGNATURE_DOMAIN,
  TRANSCRIPT_EVENT_SIGNATURE_DOMAIN, VERIFICATION_REPORT_SIGNATURE_DOMAIN, type JsonValue, type CeremonyManifestV1,
  type SignedEnvelope, type VerificationReportV1 } from "@moss/phase2-protocol";
import { createTestFixture } from "../../finalizer/tests/fixture.js";
import { PublicationWitness, type MirrorArchive } from "../src/witness.js";
import { buildWitnessServer } from "../src/server.js";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(canonicalize(value as JsonValue));

async function fixture() {
  const base = await createTestFixture();
  await rm(base.root, { recursive: true, force: true });
  const root = generateKeyPairSync("ed25519"), coordinator = generateKeyPairSync("ed25519"), verifier = generateKeyPairSync("ed25519"), witnessKey = generateKeyPairSync("ed25519");
  const publicRef = (keyId: string, pair: typeof root) => ({ keyId, algorithm: "Ed25519" as const, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() });
  const manifest: CeremonyManifestV1 = { ...base.manifest, purpose: "rehearsal",
    coordinatorKeys: [publicRef("coordinator", coordinator)], verifierKeys: [{ ...publicRef("verifier", verifier), verifierImageDigest: `sha256:${"1".repeat(64)}` }],
    verifierPolicy: { requiredOperators: 1, operatorKeyIds: ["verifier"], passesPerOperator: 1 },
    publication: { witness: publicRef("witness", witnessKey), endpoint: "https://witness.example/v1/publications" } };
  const envelope = signEnvelope(manifest as unknown as JsonValue, { keyId: "root", privateKey: root.privateKey, domain: MANIFEST_SIGNATURE_DOMAIN }) as unknown as SignedEnvelope<CeremonyManifestV1>;
  const objects = new Map<string, Buffer>(); let mirrored = 0, failMirror = false;
  const archive: MirrorArchive = {
    async read(key) { return objects.get(key) ?? null; },
    async put(key, bytes) {
      const old = objects.get(key); if (old && !old.equals(bytes)) throw new Error("immutable conflict");
      objects.set(key, bytes);
      return { sha256: hash(bytes), versionId: "version-1", url: `https://mirror.example/${key}?versionId=version-1` };
    },
    async mirror() { if (failMirror) throw new Error("mirror unavailable"); mirrored++; },
  };
  const config = { manifest: envelope, rootPublicKey: root.publicKey, privateKey: witnessKey.privateKey, archive, allowRehearsal: true };
  const witness = new PublicationWitness(config);
  const genesis = { type: "moss.phase2.publication.v1", manifest: envelope,
    head: { generation: 0, sha256: manifest.relation.genesisZkey.sha256, byteLength: manifest.relation.genesisZkey.byteLength, eventSequence: 0, eventHash: "0".repeat(64) }, receipt: null, event: null, reports: [] };
  function next() {
    const report: VerificationReportV1 = { schemaVersion: 1, type: "moss.phase2.verification-report.v1",
      ceremonyId: manifest.ceremonyId, submissionId: "223e4567-e89b-42d3-a456-426614174000", jobId: "323e4567-e89b-42d3-a456-426614174000", jobAttempt: 1,
      predecessorSha256: genesis.head.sha256, candidateSha256: "2".repeat(64), genesisSha256: genesis.head.sha256,
      expectedContributionName: "participant", expectedContributionHashBlake2b512: "3".repeat(128), expectedContributionIndex: 1,
      observedContributionName: "participant", observedContributionHashBlake2b512: "3".repeat(128), observedContributionIndex: 1,
      operatorKeyId: "verifier", verifierImageDigest: manifest.verifierKeys[0]!.verifierImageDigest, snarkjsVersion: "0.7.6", passNumber: 1,
      checks: { objectHash: true, framing: true, exactPrefix: true, exactlyOneContribution: true, contributionMetadata: true, contributionHash: true, verifyFromInit: true },
      result: "valid", startedAt: manifest.schedule.opensAt, completedAt: manifest.schedule.opensAt };
    const event = { schemaVersion: 1 as const, ceremonyId: manifest.ceremonyId, sequence: 1, previousEventHash: genesis.head.eventHash,
      eventType: "CONTRIBUTION_ACCEPTED", createdAt: manifest.schedule.opensAt,
      payload: { submissionId: report.submissionId, generation: 1, predecessorSha256: report.predecessorSha256, successorSha256: report.candidateSha256,
        contributionHashBlake2b512: report.expectedContributionHashBlake2b512, contributionName: report.expectedContributionName, clientKind: "browser", clientReleaseSha256: manifest.webRelease.sha256 } };
    const eventHash = transcriptEventHash(event);
    const receipt = { schemaVersion: 1, type: "moss.phase2.receipt.v1", ceremonyId: manifest.ceremonyId,
      relationManifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest as unknown as JsonValue), sequence: 1, generation: 1,
      predecessor: manifest.relation.genesisZkey, successor: { sha256: report.candidateSha256, byteLength: 1000, urls: ["https://artifacts.example/next"] },
      contributionIndex: 1, contributionName: "participant", contributionHashBlake2b512: report.expectedContributionHashBlake2b512, participantPseudonym: "participant",
      clientKind: "browser", clientReleaseSha256: manifest.webRelease.sha256, acceptedAt: event.createdAt, transcriptEventHash: eventHash };
    return { type: genesis.type, manifest: envelope, head: { generation: 1, sha256: report.candidateSha256, byteLength: 1000, eventSequence: 1, eventHash },
      receipt: signEnvelope(receipt as JsonValue, { keyId: "coordinator", privateKey: coordinator.privateKey, domain: RECEIPT_SIGNATURE_DOMAIN }),
      event: signEnvelope(event as JsonValue, { keyId: "coordinator", privateKey: coordinator.privateKey, domain: TRANSCRIPT_EVENT_SIGNATURE_DOMAIN }),
      reports: [signEnvelope(report as unknown as JsonValue, { keyId: "verifier", privateKey: verifier.privateKey, domain: VERIFICATION_REPORT_SIGNATURE_DOMAIN })] };
  }
  return { witness, config, objects, genesis, next, mirrored: () => mirrored, failMirror: () => { failMirror = true; } };
}

describe("independent publication witness", () => {
  it("mirrors before acknowledging and recovers idempotently across restart", async () => {
    const f = await fixture();
    const first = await f.witness.acknowledge(encode(f.genesis));
    expect(f.mirrored()).toBe(1);
    expect(await new PublicationWitness(f.config).acknowledge(encode(f.genesis))).toEqual(first);
    expect(f.mirrored()).toBe(1);
    const next = await f.witness.acknowledge(encode(f.next()));
    expect(next.payload.eventSequence).toBe(1); expect(f.mirrored()).toBe(2);
  });
  it("rejects missing predecessors, missing reports, forged signatures and altered heads", async () => {
    const f = await fixture(); const next = f.next();
    await expect(f.witness.acknowledge(encode(next))).rejects.toThrow(/predecessor/);
    await f.witness.acknowledge(encode(f.genesis));
    await expect(f.witness.acknowledge(encode({ ...next, reports: [] }))).rejects.toThrow(/insufficient/);
    await expect(f.witness.acknowledge(encode({ ...next, head: { ...next.head, sha256: "4".repeat(64) } }))).rejects.toThrow();
    next.receipt.signature = "invalid";
    await expect(f.witness.acknowledge(encode(next))).rejects.toThrow();
    expect(f.mirrored()).toBe(1);
  });
  it("does not acknowledge failed retention and rejects changed bytes at an acknowledged sequence", async () => {
    const f = await fixture(); f.failMirror();
    await expect(f.witness.acknowledge(encode(f.genesis))).rejects.toThrow(); expect(f.objects.size).toBe(0);
    const g = await fixture(); await g.witness.acknowledge(encode(g.genesis));
    await expect(g.witness.acknowledge(encode({ ...g.genesis, extra: "different bundle" }))).rejects.toThrow();
  });
  it("serves a bounded HTTP endpoint with generic errors", async () => {
    const server = buildWitnessServer({ async acknowledge() { throw new Error("private diagnostic"); } });
    try {
      const response = await server.inject({ method: "POST", url: "/v1/publications", headers: { "content-type": "application/json" }, payload: "{}" });
      expect(response.statusCode).toBe(409); expect(response.body).not.toContain("private diagnostic");
      expect((await server.inject({ url: "/healthz" })).statusCode).toBe(200);
    } finally { await server.close(); }
  });
});
