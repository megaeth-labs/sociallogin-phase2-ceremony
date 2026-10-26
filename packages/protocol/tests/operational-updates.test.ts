import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizedCliReleases, canonicalSha256, OPERATIONAL_UPDATE_DOMAIN, operationalUpdateHash, signEnvelope,
  verifyOperationalUpdate, verifyOperationalUpdates, type CeremonyManifestV1, type JsonValue,
  type OperationalUpdate, type SignedEnvelope } from "../src/index.js";
const root = generateKeyPairSync("ed25519");
const manifest = { keyId: "root", payload: { purpose: "production", ceremonyId: "test",
  contributionPolicy: { lease: { heartbeatSeconds: 300, absoluteSeconds: 5400 } },
  operationalPolicy: { minHeartbeatGraceSeconds: 30, maxHeartbeatGraceSeconds: 600, allowWebReleaseUpdates: true },
} } as SignedEnvelope<CeremonyManifestV1>;
const payload: OperationalUpdate = { schemaVersion: 1, type: "moss.phase2.operational-update.v1", ceremonyId: "test",
  manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest.payload as unknown as JsonValue),
  sequence: 1, previousUpdateSha256: null, authorizedAt: "2026-10-02T12:00:00.000Z", reason: "Reduce queue delay", heartbeatGraceSeconds: 120 };
const sign = (value: unknown) => signEnvelope(value as JsonValue, { keyId: "root", privateKey: root.privateKey, domain: OPERATIONAL_UPDATE_DOMAIN }) as unknown as SignedEnvelope<OperationalUpdate>;
describe("root-authorized operational updates", () => {
  it("accepts a linked sequence with a browser release while preserving prior authorizations", () => {
    const one = sign(payload);
    const two = sign({ ...payload, sequence: 2, previousUpdateSha256: operationalUpdateHash(one), webRelease: {
      sha256: "a".repeat(64), byteLength: 100, sourceCommit: "b".repeat(40), urls: ["https://archive.test/release.json?versionId=immutable"] } });
    expect(() => verifyOperationalUpdates([one, two], manifest, root.publicKey)).not.toThrow();
    expect(() => verifyOperationalUpdates([two], manifest, root.publicKey)).toThrow(/sequence/);
  });
  it("rejects tampering, wrong roots, replay and attempts to amend security commitments", () => {
    const one = sign(payload);
    expect(() => verifyOperationalUpdate({ ...one, payload: { ...payload, heartbeatGraceSeconds: 600 } }, manifest, root.publicKey, null)).toThrow(/signature/);
    expect(() => verifyOperationalUpdate(one, manifest, generateKeyPairSync("ed25519").publicKey, null)).toThrow(/signature/);
    expect(() => verifyOperationalUpdate(one, manifest, root.publicKey, one)).toThrow(/sequence/);
    for (const key of ["verifierPolicy", "beacon", "schedule", "relation", "cliReleases"]) {
      expect(() => verifyOperationalUpdate(sign({ ...payload, [key]: {} }), manifest, root.publicKey, null)).toThrow(/schema/);
    }
  });
  it("adds CLI releases only when the manifest opts in, keeping earlier builds authorized", () => {
    const release = (sha: string, commit: string) => ({ sha256: sha.repeat(64), byteLength: 100, sourceCommit: commit.repeat(40),
      urls: ["https://archive.test/cli.js?versionId=immutable"] });
    const optedIn = structuredClone(manifest);
    optedIn.payload.operationalPolicy = { ...optedIn.payload.operationalPolicy!, allowCliReleaseUpdates: true };
    optedIn.payload.cliReleases = [release("c", "d")];
    const base = { ...payload, manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", optedIn.payload as unknown as JsonValue) };
    const { heartbeatGraceSeconds: _grace, ...noGrace } = base;
    const one = sign({ ...noGrace, reason: "Fix a CLI upload retry", cliRelease: release("e", "f") });
    expect(() => verifyOperationalUpdates([one], optedIn, root.publicKey)).not.toThrow();
    expect(authorizedCliReleases(optedIn.payload, [one])).toEqual([
      { sha256: "c".repeat(64), authorizedAt: null }, { sha256: "e".repeat(64), authorizedAt: payload.authorizedAt }]);
    // Same source commit as the manifest's build, different bytes.
    expect(() => verifyOperationalUpdates([sign({ ...noGrace, cliRelease: release("e", "d") })], optedIn, root.publicKey)).toThrow(/distinct source commit/);
    expect(() => verifyOperationalUpdate(sign({ ...noGrace, cliRelease: { ...release("e", "f"), sourceCommit: "main" } }), optedIn, root.publicKey, null)).toThrow();
    // Without the opt-in, including manifests signed before it existed.
    for (const allow of [false, undefined]) {
      const closed = structuredClone(optedIn);
      if (allow === undefined) delete closed.payload.operationalPolicy!.allowCliReleaseUpdates;
      else closed.payload.operationalPolicy!.allowCliReleaseUpdates = allow;
      const update = sign({ ...noGrace, manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", closed.payload as unknown as JsonValue), cliRelease: release("e", "f") });
      expect(() => verifyOperationalUpdate(update, closed, root.publicKey, null)).toThrow(/CLI release updates are not authorized/);
    }
  });
  it("enforces bounded grace and explicit production opt-in", () => {
    for (const heartbeatGraceSeconds of [0, 29, 601, 1.5]) {
      expect(() => verifyOperationalUpdate(sign({ ...payload, heartbeatGraceSeconds }), manifest, root.publicKey, null)).toThrow(/bounds/);
    }
    const legacy = structuredClone(manifest); delete legacy.payload.operationalPolicy;
    expect(() => verifyOperationalUpdate(sign(payload), legacy, root.publicKey, null, true)).toThrow(/not authorized/);
    expect(() => verifyOperationalUpdate(sign({ ...payload, reason: " " }), manifest, root.publicKey, null)).toThrow(/reason/);
  });
});
