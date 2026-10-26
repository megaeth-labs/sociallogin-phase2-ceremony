import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import { canonicalSha256, signEnvelope, verifyRehearsalWebRelease, REHEARSAL_WEB_RELEASE_DOMAIN,
  type CeremonyManifestV1, type JsonValue, type SignedEnvelope, type RehearsalWebReleaseAuthorization } from "../src/index.js";
const root = generateKeyPairSync("ed25519");
const manifest = {purpose: "rehearsal", ceremonyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", webRelease: {sha256: "1".repeat(64)}} as CeremonyManifestV1;
const original = {schemaVersion: 1, keyId: "root", payload: manifest, signature: "unused"} as SignedEnvelope<CeremonyManifestV1>;
const authorization: RehearsalWebReleaseAuthorization = {schemaVersion: 1, type: "moss.phase2.rehearsal-web-release.v1",
  ceremonyId: manifest.ceremonyId, manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest as unknown as JsonValue),
  originalWebReleaseSha256: manifest.webRelease.sha256, authorizedAt: "2026-09-28T23:00:00.000Z",
  release: {sha256: "2".repeat(64), byteLength: 100, sourceCommit: "3".repeat(40), urls: ["https://archive.example/releases/immutable.json"]}};
const signed = (value: unknown = authorization, domain = REHEARSAL_WEB_RELEASE_DOMAIN) => signEnvelope(value as JsonValue,
  {keyId: "root", privateKey: root.privateKey, domain}) as unknown as SignedEnvelope<RehearsalWebReleaseAuthorization>;
describe("rehearsal supplemental web release authorization", () => {
  it("verifies the root signature and preserves the original manifest", () => {
    const before = JSON.stringify(original);
    expect(verifyRehearsalWebRelease(signed(), original, root.publicKey)).toEqual(authorization);
    expect(JSON.stringify(original)).toBe(before);
  });
  it("rejects production ceremonies", () => {
    expect(() => verifyRehearsalWebRelease(signed(), {...original, payload: {...manifest, purpose: undefined}}, root.publicKey)).toThrow(/rehearsal-only/);
  });
  it("rejects tampering, wrong root keys, domains and key identifiers", () => {
    expect(() => verifyRehearsalWebRelease({...signed(), payload: {...authorization, authorizedAt: "2026-09-29T00:00:00.000Z"}}, original, root.publicKey)).toThrow(/signature/);
    expect(() => verifyRehearsalWebRelease(signed(), original, generateKeyPairSync("ed25519").publicKey)).toThrow(/signature/);
    expect(() => verifyRehearsalWebRelease(signed(authorization, "OTHER"), original, root.publicKey)).toThrow(/signature/);
    expect(() => verifyRehearsalWebRelease({...signed(), keyId: "other"}, original, root.publicKey)).toThrow(/key id/);
  });
  it("rejects authorization for a different ceremony, manifest or original release", () => {
    for (const patch of [{ceremonyId: "other"}, {manifestSha256: "4".repeat(64)}, {originalWebReleaseSha256: "5".repeat(64)}]) {
      expect(() => verifyRehearsalWebRelease(signed({...authorization, ...patch}), original, root.publicKey)).toThrow(/different ceremony/);
    }
  });
  it("rejects mutable source labels, insecure URLs, extra fields and duplicate release", () => {
    for (const patch of [{sourceCommit: "main"}, {urls: ["http://archive.example/file"]}, {sha256: manifest.webRelease.sha256}, {extra: true}]) {
      expect(() => verifyRehearsalWebRelease(signed({...authorization, release: {...authorization.release, ...patch}}), original, root.publicKey)).toThrow();
    }
    expect(() => verifyRehearsalWebRelease(signed({...authorization, policy: "skip-verification"}), original, root.publicKey)).toThrow(/invalid/);
  });
});
