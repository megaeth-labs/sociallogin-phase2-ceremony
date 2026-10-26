import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalSha256, verifyEnvelope, type HeadCheckpointV1, type SignedEnvelope, type CeremonyManifestV1, type JsonValue } from "@moss/phase2-protocol";
import { FINALIZATION_DOMAIN, verifiedRehearsalFinalization, type RehearsalFinalization } from "./finalization";
import record from "@/lib/rehearsal-finalization.json";
const manifest = JSON.parse(readFileSync(new URL("../../../../ceremonies/company-rehearsal-2026-09-r2/manifest.signed.json", import.meta.url), "utf8")) as SignedEnvelope<CeremonyManifestV1>;
const root = readFileSync(new URL("../../../../ceremonies/company-rehearsal-2026-09-r2/ceremony-root.pub", import.meta.url), "utf8");
const hash = canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest.payload as unknown as JsonValue);
const checkpoint = { ceremonyId: record.payload.ceremonyId, state: "SEALED", generation: 7, headSha256: record.payload.sealedHeadSha256, headByteLength: record.payload.sealedHeadByteLength, eventHash: record.payload.sealedEventHash, eventSequence: record.payload.sealedEventSequence } as HeadCheckpointV1;
const verify = async (envelope: SignedEnvelope<RehearsalFinalization>) => verifyEnvelope(envelope, { publicKey: root, domain: FINALIZATION_DOMAIN });
describe("rehearsal finalization evidence", () => {
  it("ships the same public record for independent download", () => {
    expect(JSON.parse(readFileSync(new URL("../../public/ceremony-finalization.json", import.meta.url), "utf8"))).toEqual(record);
    expect(JSON.parse(readFileSync(new URL("../../../../ceremonies/company-rehearsal-2026-09-r2/finalization.signed.json", import.meta.url), "utf8"))).toEqual(record);
  });
  it("verifies the actual root signature and exact sealed chain", async () => {
    expect(await verifiedRehearsalFinalization(manifest, checkpoint, hash, verify)).toEqual(record.payload);
  });
  it("does not attach the rehearsal result to another ceremony", async () => {
    expect(await verifiedRehearsalFinalization({ ...manifest, payload: { ...manifest.payload, ceremonyId: "other" } }, checkpoint, hash, verify)).toBeUndefined();
  });
  it("never applies the rehearsal record to production", async () => {
    await expect(verifiedRehearsalFinalization({ ...manifest, payload: { ...manifest.payload, purpose: "production" } }, checkpoint, hash, verify)).rejects.toThrow();
  });
  it("rejects a tampered download even with otherwise correct metadata", async () => {
    const changed = structuredClone(record) as SignedEnvelope<RehearsalFinalization>;
    changed.payload.artifacts.finalZkey.url = "https://attacker.example/key";
    await expect(verifiedRehearsalFinalization(manifest, checkpoint, hash, verify, changed)).rejects.toThrow();
  });
  it.each([
    { state: "OPEN" }, { generation: 8 }, { headSha256: "a".repeat(64) },
    { headByteLength: 1 }, { eventHash: "a".repeat(64) }, { eventSequence: 8 },
  ])("rejects a conflicting live checkpoint: %j", async (patch) => {
    await expect(verifiedRehearsalFinalization(manifest, { ...checkpoint, ...patch } as HeadCheckpointV1, hash, verify)).rejects.toThrow();
  });
  it("rejects a different manifest or beacon commitment", async () => {
    await expect(verifiedRehearsalFinalization(manifest, checkpoint, "a".repeat(64), verify)).rejects.toThrow();
    await expect(verifiedRehearsalFinalization({ ...manifest, payload: { ...manifest.payload, beacon: { ...manifest.payload.beacon, numIterationsExp: 10 } } }, checkpoint, hash, verify)).rejects.toThrow();
  });
});

describe("production finalization record", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { existsSync } = await import("node:fs");
  const { signEnvelope } = await import("@moss/phase2-protocol");
  const { verifiedFinalization, verifiedProductionFinalization, PRODUCTION_FINALIZATION_DOMAIN } = await import("./finalization");
  const { SAMPLE_PRODUCTION_FINALIZATION } = await import("@/app/preview/sample-finalization");
  const productionRecord = (await import("@/lib/ceremony-finalization.json")).default as unknown;
  const rootKey = generateKeyPairSync("ed25519");
  const production = { ...manifest, keyId: "production-root", payload: { ...manifest.payload, purpose: "production" } } as SignedEnvelope<CeremonyManifestV1>;
  const productionHash = canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", production.payload as unknown as JsonValue);
  // The rehearsal manifest signs exponent 32 and the zkey-free Bellman method; reuse its real sealed chain.
  const payload = { ...SAMPLE_PRODUCTION_FINALIZATION, manifestSha256: productionHash };
  const sign = (value: unknown, domain = PRODUCTION_FINALIZATION_DOMAIN, keyId = "production-root") =>
    signEnvelope(value as JsonValue, { keyId, privateKey: rootKey.privateKey, domain }) as unknown as SignedEnvelope<typeof payload>;
  const verifyProduction = async (envelope: SignedEnvelope<unknown>) =>
    verifyEnvelope(envelope as SignedEnvelope<JsonValue>, { publicKey: rootKey.publicKey, domain: PRODUCTION_FINALIZATION_DOMAIN });

  it("ships no production record until the ceremony is finalized, and serves the same bytes when it does", () => {
    const published = new URL("../../public/finalization.signed.json", import.meta.url);
    if (productionRecord === null) expect(existsSync(published)).toBe(false);
    else expect(JSON.parse(readFileSync(published, "utf8"))).toEqual(productionRecord);
  });
  it("verifies a root-signed record against the production manifest and the sealed chain", async () => {
    expect(await verifiedProductionFinalization(production, checkpoint, productionHash, verifyProduction, sign(payload))).toEqual(payload);
  });
  it("shows nothing for a production manifest when no record ships", async () => {
    expect(await verifiedProductionFinalization(production, checkpoint, productionHash, verifyProduction, null)).toBeUndefined();
    if (productionRecord === null) expect(await verifiedFinalization(production, checkpoint, productionHash, async () => { throw Error("unused"); })).toBeUndefined();
  });
  it("never applies a production record to a rehearsal, or a rehearsal record to production", async () => {
    await expect(verifiedProductionFinalization({ ...production, payload: manifest.payload }, checkpoint, hash, verifyProduction, sign(payload))).rejects.toThrow();
    await expect(verifiedRehearsalFinalization(production, checkpoint, productionHash, verify)).rejects.toThrow();
  });
  it("rejects a record signed by another key, under another domain, or for another chain", async () => {
    await expect(verifiedProductionFinalization(production, checkpoint, productionHash, verifyProduction, sign(payload, PRODUCTION_FINALIZATION_DOMAIN, "other-root"))).rejects.toThrow();
    await expect(verifiedProductionFinalization(production, checkpoint, productionHash, verifyProduction, sign(payload, FINALIZATION_DOMAIN))).rejects.toThrow();
    await expect(verifiedProductionFinalization(production, { ...checkpoint, generation: 8 }, productionHash, verifyProduction, sign(payload))).rejects.toThrow();
    const mutable = structuredClone(payload); mutable.artifacts.finalZkey.url = "https://attacker.example/key";
    await expect(verifiedProductionFinalization(production, checkpoint, productionHash, verifyProduction, sign(mutable))).rejects.toThrow();
  });
});
