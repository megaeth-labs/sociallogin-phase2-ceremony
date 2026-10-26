import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertFinalizationRecord, canonicalSha256, FINALIZATION_RECORD_DOMAIN, signEnvelope, verifyFinalizationRecord,
  type CeremonyManifestV1, type FinalizationRecordV1, type JsonValue, type SignedEnvelope } from "../src/index.js";

const root = generateKeyPairSync("ed25519");
const manifest = { schemaVersion: 1, keyId: "root", signature: "", payload: {
  purpose: "production", ceremonyId: "11111111-1111-4111-8111-111111111111",
  schedule: { opensAt: "2026-11-01T00:00:00.000Z", sealsAt: "2026-11-10T00:00:00.000Z" },
  beacon: { source: "ethereum-block", chainId: 1, blockNumber: 23_000_000, expectedAt: "2026-11-10T06:00:00.000Z",
    numIterationsExp: 10, contributionName: "final", derivation: "MOSS_PHASE2_BEACON_V1" },
  verifierPolicy: { verificationMethod: "bellman-transition-v1", operatorKeyIds: ["v"], requiredOperators: 1, passesPerOperator: 1 },
  contributionPolicy: { maximumContributions: 100_000 },
} } as unknown as SignedEnvelope<CeremonyManifestV1>;
const manifestSha256 = canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest.payload as unknown as JsonValue);
const checkpoint = { ceremonyId: manifest.payload.ceremonyId, state: "SEALED" as const, generation: 1200,
  headSha256: "a".repeat(64), headByteLength: 368_901_148, eventHash: "b".repeat(64), eventSequence: 2400 };
const artifact = (hash: string, name: string) => ({ sha256: hash.repeat(64), byteLength: 100, versionId: `v-${name}`,
  url: `https://archive.example/finalization/${hash.repeat(64)}/x/sha256/${hash.repeat(64)}/${name}?versionId=v-${name}` });
const record: FinalizationRecordV1 = {
  schemaVersion: 1, type: "moss.phase2.finalization.v1", ceremonyId: manifest.payload.ceremonyId, manifestSha256,
  sealedCheckpoint: { generation: 1200, headSha256: "a".repeat(64), headByteLength: 368_901_148, eventHash: "b".repeat(64), eventSequence: 2400 },
  ordinaryContributions: 1200, beaconContributions: 1,
  beacon: { source: "ethereum-block", chainId: 1, blockNumber: 23_000_000, blockHash: "c".repeat(64), derivation: "MOSS_PHASE2_BEACON_V1",
    numIterationsExp: 10, beaconHash: "d".repeat(64), contributionHashBlake2b512: "e".repeat(128) },
  completedAt: "2026-11-11T00:00:00.000Z", publicInputs: 20,
  proofTests: { fixtures: 1, validProofs: 2, solidityTests: 4 },
  audit: { transitionsReplayed: 1200, receiptsChecked: 1200 },
  artifacts: {
    finalZkey: artifact("1", "final.zkey"), verificationKey: artifact("2", "verification_key.json"),
    solidityVerifier: artifact("3", "Verifier.sol"), sealedImport: artifact("4", "sealed-import.zkey"),
    beaconEvidence: artifact("5", "ethereum-block-evidence.json"), finalizerSummary: artifact("6", "final-artifacts.json"),
    auditReport: artifact("7", "ceremony-audit.json"), proofEvidence: artifact("8", "proof-verification-index.json"),
    artifactIndex: artifact("9", "publication-index.json"),
  },
};
const context = { manifest: manifest.payload, manifestSha256, checkpoint };
const sign = (value: unknown, privateKey = root.privateKey, keyId = "root") =>
  signEnvelope(value as JsonValue, { keyId, privateKey, domain: FINALIZATION_RECORD_DOMAIN }) as unknown as SignedEnvelope<FinalizationRecordV1>;
const patched = (mutate: (copy: Record<string, any>) => void) => { const copy = structuredClone(record) as Record<string, any>; mutate(copy); return copy; };

describe("production finalization record", () => {
  it("accepts a root-signed record bound to the manifest and sealed checkpoint", () => {
    expect(verifyFinalizationRecord(sign(record), manifest, root.publicKey, checkpoint)).toEqual(record);
    expect(assertFinalizationRecord(record, { ...context, checkpoint: { ...checkpoint, state: "FINALIZED" } })).toEqual(record);
  });
  it("rejects a forged, wrong-key or wrong-domain signature", () => {
    const other = generateKeyPairSync("ed25519");
    expect(() => verifyFinalizationRecord(sign(record, other.privateKey), manifest, root.publicKey, checkpoint)).toThrow(/signature/);
    expect(() => verifyFinalizationRecord(sign(record, root.privateKey, "other"), manifest, root.publicKey, checkpoint)).toThrow(/manifest root/);
    const tampered = sign(record); tampered.payload = { ...record, completedAt: "2026-11-12T00:00:00.000Z" };
    expect(() => verifyFinalizationRecord(tampered, manifest, root.publicKey, checkpoint)).toThrow(/signature/);
    const wrongDomain = signEnvelope(record as unknown as JsonValue, { keyId: "root", privateKey: root.privateKey,
      domain: "MOSS_PHASE2_REHEARSAL_FINALIZATION_V1" }) as unknown as SignedEnvelope<FinalizationRecordV1>;
    expect(() => verifyFinalizationRecord(wrongDomain, manifest, root.publicKey, checkpoint)).toThrow(/signature/);
  });
  it("never completes a rehearsal and rejects the rehearsal record type", () => {
    expect(() => assertFinalizationRecord(record, { ...context, manifest: { ...manifest.payload, purpose: "rehearsal" } })).toThrow(/rehearsal/);
    expect(() => assertFinalizationRecord(patched((r) => { r.type = "moss.phase2.rehearsal-finalization.v1"; }), context)).toThrow(/schema/);
  });
  it.each([
    { state: "OPEN" }, { generation: 1201 }, { headSha256: "f".repeat(64) }, { headByteLength: 1 },
    { eventHash: "f".repeat(64) }, { eventSequence: 2401 }, { ceremonyId: "other" },
  ])("rejects a conflicting live checkpoint: %j", (patch) => {
    expect(() => assertFinalizationRecord(record, { ...context, checkpoint: { ...checkpoint, ...patch } as typeof checkpoint })).toThrow();
  });
  it.each<[string, (r: Record<string, any>) => void]>([
    ["manifest hash", (r) => { r.manifestSha256 = "0".repeat(64); }],
    ["contribution count", (r) => { r.ordinaryContributions = 1199; }],
    ["two beacons", (r) => { r.beaconContributions = 2; }],
    ["beacon block", (r) => { r.beacon.blockNumber = 23_000_001; }],
    ["beacon exponent", (r) => { r.beacon.numIterationsExp = 32; }],
    ["beacon source", (r) => { r.beacon.source = "drand"; }],
    ["block hash", (r) => { r.beacon.blockHash = "0x" + "c".repeat(64); }],
    ["early completion", (r) => { r.completedAt = "2026-11-09T23:59:59.000Z"; }],
    ["non-canonical time", (r) => { r.completedAt = "2026-11-11"; }],
    ["public inputs", (r) => { r.publicInputs = 19; }],
    ["partial replay", (r) => { r.audit.transitionsReplayed = 1199; }],
    ["partial receipts", (r) => { r.audit.receiptsChecked = 1; }],
    ["no proof tests", (r) => { r.proofTests.validProofs = 0; }],
    ["extra field", (r) => { r.note = "trust me"; }],
    ["missing artifact", (r) => { delete r.artifacts.auditReport; }],
    ["unknown artifact", (r) => { r.artifacts.extra = artifact("a", "extra"); }],
    ["mutable download", (r) => { r.artifacts.finalZkey.url = r.artifacts.finalZkey.url.split("?")[0]; }],
    ["other version", (r) => { r.artifacts.finalZkey.versionId = "v-other"; }],
    ["unaddressed path", (r) => { r.artifacts.finalZkey.url = "https://archive.example/final.zkey?versionId=v-final.zkey"; }],
    ["http download", (r) => { r.artifacts.finalZkey.url = r.artifacts.finalZkey.url.replace("https:", "http:"); }],
    ["credentials", (r) => { r.artifacts.finalZkey.url = r.artifacts.finalZkey.url.replace("https://", "https://u:p@"); }],
    ["fragment", (r) => { r.artifacts.finalZkey.url += "#x"; }],
    ["extra query", (r) => { r.artifacts.finalZkey.url += "&download=1"; }],
  ])("rejects %s", (_label, mutate) => {
    expect(() => assertFinalizationRecord(patched(mutate), context)).toThrow(/finalization record/);
  });
  it("requires the imported sealed key exactly when the manifest uses Bellman transitions", () => {
    const zkeyManifest = { ...manifest.payload, verifierPolicy: { ...manifest.payload.verifierPolicy, verificationMethod: "snarkjs-zkey-v1" as const } };
    const zkeyHash = canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", zkeyManifest as unknown as JsonValue);
    const withoutImport = patched((r) => { r.manifestSha256 = zkeyHash; delete r.artifacts.sealedImport; });
    expect(() => assertFinalizationRecord(withoutImport, { ...context, manifest: zkeyManifest, manifestSha256: zkeyHash })).not.toThrow();
    expect(() => assertFinalizationRecord(patched((r) => { r.manifestSha256 = zkeyHash; }), { ...context, manifest: zkeyManifest, manifestSha256: zkeyHash })).toThrow(/artifacts/);
    expect(() => assertFinalizationRecord(patched((r) => { delete r.artifacts.sealedImport; }), context)).toThrow(/artifacts/);
  });
  it("binds a drand beacon to the committed chain and round", () => {
    const drand = { ...manifest.payload, beacon: { source: "drand", chainHash: "1".repeat(64), round: 900, expectedAt: "2026-11-10T06:00:00.000Z",
      numIterationsExp: 10, contributionName: "final", derivation: "MOSS_PHASE2_BEACON_V1" } } as unknown as CeremonyManifestV1;
    const hash = canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", drand as unknown as JsonValue);
    const beacon = { source: "drand", chainHash: "1".repeat(64), round: 900, randomness: "2".repeat(64), derivation: "MOSS_PHASE2_BEACON_V1",
      numIterationsExp: 10, beaconHash: "d".repeat(64), contributionHashBlake2b512: "e".repeat(128) };
    const ok = patched((r) => { r.manifestSha256 = hash; r.beacon = beacon; });
    expect(() => assertFinalizationRecord(ok, { ...context, manifest: drand, manifestSha256: hash })).not.toThrow();
    expect(() => assertFinalizationRecord(patched((r) => { r.manifestSha256 = hash; r.beacon = { ...beacon, round: 901 }; }),
      { ...context, manifest: drand, manifestSha256: hash })).toThrow(/commitment/);
  });
});
