import { readFileSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalSha256, operationalUpdateHash, signEnvelope, MANIFEST_SIGNATURE_DOMAIN, OPERATIONAL_UPDATE_DOMAIN, REHEARSAL_WEB_RELEASE_DOMAIN, type JsonValue, type OperationalUpdate, type SignedEnvelope } from "@moss/phase2-protocol";
import { loadCoordinatorBootstrap } from "./coordinator-bootstrap";
const root = generateKeyPairSync("ed25519");
const manifest = JSON.parse(readFileSync(new URL("../../../../ceremonies/company-rehearsal-2026-09-r2/manifest.signed.json", import.meta.url), "utf8")).payload;
const envelope = signEnvelope(manifest, {keyId: "test-root", privateKey: root.privateKey, domain: MANIFEST_SIGNATURE_DOMAIN});
const release = {...manifest.webRelease, sha256: "5".repeat(64), sourceCommit: "6".repeat(40)};
const auth = signEnvelope({schemaVersion: 1, type: "moss.phase2.rehearsal-web-release.v1", ceremonyId: manifest.ceremonyId,
  manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest as JsonValue), originalWebReleaseSha256: manifest.webRelease.sha256,
  authorizedAt: "2026-09-28T23:00:00.000Z", release}, {keyId: "test-root", privateKey: root.privateKey, domain: REHEARSAL_WEB_RELEASE_DOMAIN});
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");vi.stubEnv("CEREMONY_MODE", "rehearsal");
  vi.stubEnv("COORDINATOR_BASE_URL", "https://coordinator.test");vi.stubEnv("CEREMONY_SLUG", manifest.slug);
  vi.stubEnv("MANIFEST_ROOT_KEY_ID", "test-root");vi.stubEnv("MANIFEST_ROOT_PUBLIC_KEY_FILE", undefined);
  vi.stubEnv("MANIFEST_ROOT_PUBLIC_KEY", root.publicKey.export({format: "pem", type: "spki"}).toString());
  vi.stubEnv("MANIFEST_ROOT_PUBLIC_KEY_SPKI_SHA256", createHash("sha256").update(root.publicKey.export({format: "der", type: "spki"})).digest("hex"));
  vi.stubEnv("MOSS_WEB_BUILD_ID", release.sourceCommit);
});
afterEach(() => {vi.unstubAllEnvs();vi.unstubAllGlobals()});
function network(authorization: unknown = auth, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => url.pathname.endsWith("/manifest") ? Response.json(envelope) : url.pathname.endsWith("/operational-updates") ? Response.json({updates: [], appliedAt: []}) : Response.json(authorization, {status})));
}
describe("bootstrap authorized rehearsal release", () => {
  it("accepts production hot updates and keeps the original build available", async () => {
    const production = structuredClone(manifest);
    delete production.primaryPublication;
    production.purpose = "production";
    production.verifierKeys.push({ ...production.verifierKeys[0], keyId: "second-verifier", publicKeyPem: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() });
    production.verifierPolicy.operatorKeyIds.push("second-verifier");
    production.verifierPolicy.requiredOperators = 2;
    production.contributionPolicy.lease.heartbeatSeconds = 300;
    production.operationalPolicy = { minHeartbeatGraceSeconds: 30, maxHeartbeatGraceSeconds: 600, allowWebReleaseUpdates: true };
    const signed = signEnvelope(production, { keyId: "test-root", privateKey: root.privateKey, domain: MANIFEST_SIGNATURE_DOMAIN });
    const update = signEnvelope({ schemaVersion: 1, type: "moss.phase2.operational-update.v1", ceremonyId: production.ceremonyId,
      manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", production), sequence: 1, previousUpdateSha256: null,
      authorizedAt: "2026-10-02T12:00:00.000Z", reason: "UI repair", webRelease: release,
    }, { keyId: "test-root", privateKey: root.privateKey, domain: OPERATIONAL_UPDATE_DOMAIN }) as SignedEnvelope<OperationalUpdate>;
    vi.stubEnv("CEREMONY_MODE", "production");
    let updates: SignedEnvelope<OperationalUpdate>[] = [update];
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => url.pathname.endsWith("/manifest") ? Response.json(signed) : Response.json({ updates })));
    expect((await loadCoordinatorBootstrap()).activeWebRelease).toEqual(release);
    vi.stubEnv("MOSS_WEB_BUILD_ID", production.webRelease.sourceCommit);
    expect((await loadCoordinatorBootstrap()).activeWebRelease).toEqual(production.webRelease);
    expect((await loadCoordinatorBootstrap()).heartbeatGraceSeconds).toBe(300);
    const { webRelease: _release, cliRelease: _cliRelease, ...base } = update.payload;
    const grace = signEnvelope({ ...base, sequence: 2, previousUpdateSha256: operationalUpdateHash(update),
      authorizedAt: "2026-10-02T13:00:00.000Z", reason: "slow uploads", heartbeatGraceSeconds: 420,
    }, { keyId: "test-root", privateKey: root.privateKey, domain: OPERATIONAL_UPDATE_DOMAIN }) as SignedEnvelope<OperationalUpdate>;
    updates = [update, grace];
    expect((await loadCoordinatorBootstrap()).heartbeatGraceSeconds).toBe(420);
    updates = [{ ...update, payload: { ...update.payload, reason: "tampered" } }];
    await expect(loadCoordinatorBootstrap()).rejects.toThrow(/signature/);
  });
  it("exposes only a root-verified release bound to this manifest and running build", async () => {
    network(); expect(await loadCoordinatorBootstrap()).toMatchObject({manifest: envelope, activeWebRelease: release, webReleaseAuthorization: auth});
  });
  it("rejects a tampered authorization and mismatched build", async () => {
    network({...auth, payload: {...auth.payload, ceremonyId: "other"}});
    await expect(loadCoordinatorBootstrap()).rejects.toThrow(/signature/);
    network();vi.stubEnv("MOSS_WEB_BUILD_ID", "7".repeat(40));
    await expect(loadCoordinatorBootstrap()).rejects.toThrow(/not been authorized/);
  });
  it("fails closed on unavailable authorization and supports the original release with null authorization", async () => {
    network(null, 503);await expect(loadCoordinatorBootstrap()).rejects.toThrow(/unavailable/);
    network(null);await expect(loadCoordinatorBootstrap()).rejects.toThrow(/not been authorized/);
    vi.stubEnv("MOSS_WEB_BUILD_ID", manifest.webRelease.sourceCommit);
    expect((await loadCoordinatorBootstrap()).activeWebRelease).toEqual(manifest.webRelease);
  });
});
