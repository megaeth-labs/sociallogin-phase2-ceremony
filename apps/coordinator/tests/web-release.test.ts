import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { Pool } from "pg";
import type { ArtifactStore } from "@moss/phase2-storage";
import { canonicalSha256, signEnvelope, REHEARSAL_WEB_RELEASE_DOMAIN, type CeremonyManifestV1, type JsonValue,
  type RehearsalWebReleaseAuthorization, type SignedEnvelope } from "@moss/phase2-protocol";
import { PostgresCoordinatorOperations } from "../src/runtime.js";
const root = generateKeyPairSync("ed25519");
const manifest = {purpose: "rehearsal", ceremonyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", slug: "test",
  webRelease: {sha256: "1".repeat(64)}, cliReleases: [],
  contributionPolicy: {requirePinnedClientRelease: true, lease: {heartbeatSeconds: 30}},
} as unknown as CeremonyManifestV1;
const envelope = {schemaVersion: 1, keyId: "root", payload: manifest, signature: "unused"} as SignedEnvelope<CeremonyManifestV1>;
const signed = signEnvelope({schemaVersion: 1, type: "moss.phase2.rehearsal-web-release.v1", ceremonyId: manifest.ceremonyId,
  manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest as unknown as JsonValue),
  originalWebReleaseSha256: manifest.webRelease.sha256, authorizedAt: "2026-09-28T23:00:00.000Z",
  release: {sha256: "2".repeat(64), byteLength: 100, sourceCommit: "3".repeat(40), urls: ["https://archive.example/release.json"]}},
  {keyId: "root", privateKey: root.privateKey, domain: REHEARSAL_WEB_RELEASE_DOMAIN}) as unknown as SignedEnvelope<RehearsalWebReleaseAuthorization>;
const options = {pool: {async query(sql: string) {
  if (sql.includes("FROM submissions")) throw Error("reached submission lookup");
  return {rows: sql.includes("FROM ceremonies") ? [{state: "OPEN", target: "OPEN"}] : [], rowCount: 0};
}} as unknown as Pool, store: {} as ArtifactStore, manifestEnvelope: envelope, coordinatorKeyId: "unused", coordinatorPrivateKey: root.privateKey,
  publicBaseUrl: "https://coordinator.example", genesisZkeyPath: "/unused", production: false, allowRehearsal: true,
  webReleaseAuthorization: {envelope: signed, rootPublicKey: root.publicKey.export({type: "spki", format: "pem"}).toString()}};
describe("coordinator supplementary browser release", () => {
  it("permits the original and authorized browser labels, but rejects unlisted ones", async () => {
    const operations = new PostgresCoordinatorOperations(options);
    for (const digest of ["1", "2", "4"]) {
      await expect(operations.submit("lease", "participant", {uploadId: "upload", predecessorSha256: "a".repeat(64),
        contributionHashBlake2b512: "b".repeat(128), clientKind: "browser", clientReleaseSha256: digest.repeat(64)}, "key"))
        .rejects.toThrow(digest === "4" ? /not permitted/ : /reached submission lookup/);
    }
    expect(await operations.getWebReleaseAuthorization("test")).toEqual(signed);
    expect(await operations.getManifest("test")).toEqual(envelope);
  });
  it("permits CLI builds pinned in the manifest or added by a verified update, and rejects others", async () => {
    const cliManifest = {...manifest, cliReleases: [{sha256: "5".repeat(64)}]} as unknown as CeremonyManifestV1;
    const operations = new PostgresCoordinatorOperations({...options, manifestEnvelope: {...envelope, payload: cliManifest},
      webReleaseAuthorization: undefined});
    // History verification is the update store's job; this checks only how the submission uses it.
    operations.getOperationalUpdates = async () => ({updates: [{payload: {cliRelease: {sha256: "6".repeat(64)}}}] as never, appliedAt: []});
    for (const digest of ["5", "6", "7"]) {
      await expect(operations.submit("lease", "participant", {uploadId: "upload", predecessorSha256: "a".repeat(64),
        contributionHashBlake2b512: "b".repeat(128), clientKind: "cli", clientReleaseSha256: digest.repeat(64)}, "key"))
        .rejects.toThrow(digest === "7" ? /not permitted/ : /reached submission lookup/);
    }
  });
  it("fails startup on unauthorized amendments or a non-rehearsal runtime", () => {
    expect(() => new PostgresCoordinatorOperations({...options, allowRehearsal: false})).toThrow(/explicit rehearsal/);
    expect(() => new PostgresCoordinatorOperations({...options, webReleaseAuthorization: {...options.webReleaseAuthorization,
      envelope: {...signed, payload: {...signed.payload, manifestSha256: "9".repeat(64)}}}})).toThrow(/signature/);
  });
});
