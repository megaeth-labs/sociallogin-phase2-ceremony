import { generateKeyPairSync } from "node:crypto";

import {
  canonicalSha256,
  CHECKPOINT_SIGNATURE_DOMAIN,
  MANIFEST_SIGNATURE_DOMAIN,
  OPERATIONAL_UPDATE_DOMAIN,
  RECEIPT_SIGNATURE_DOMAIN,
  signEnvelope,
  type CeremonyManifestV1,
  type ContributionReceiptV1,
  type HeadCheckpointV1,
  type JsonValue,
} from "@moss/phase2-protocol";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUpdatedCliReleases } from "./ceremony-state.js";
import type { CeremonyClient } from "./client.js";
import { verifyReceiptCommand, verifyReceiptFileContents, verifyReceiptFileContentsWithKey, readReceiptJson } from "./commands/verify-receipt.js";

import {
  verifyCheckpoint,
  verifyManifest,
  verifyReceipt,
  verifyStatusAgainstCheckpoint,
} from "./trust.js";
import type { CheckpointEnvelope, ManifestEnvelope, ReceiptEnvelope } from "./types.js";

const HEX_32 = "11".repeat(32);
const HEX_64 = "22".repeat(64);
const CEREMONY_ID = "24e98dbb-d0f7-4ec4-8c44-e89dfd15e169";

describe("signed coordinator state", () => {
  it("binds unsigned status and the final receipt to signed ceremony state", () => {
    const root = generateKeyPairSync("ed25519");
    const coordinator = generateKeyPairSync("ed25519");
    const manifest = manifestFixture(coordinator.publicKey.export({ type: "spki", format: "pem" }).toString());
    const manifestEnvelope = sign(
      manifest,
      "root-test",
      root.privateKey,
      MANIFEST_SIGNATURE_DOMAIN,
    ) as unknown as ManifestEnvelope;
    const verifiedManifest = verifyManifest(manifestEnvelope, root.publicKey, {
      production: false,
      expectedSlug: manifest.slug,
    });

    const checkpoint: HeadCheckpointV1 = {
      schemaVersion: 1,
      type: "moss.phase2.checkpoint.v1",
      ceremonyId: manifest.ceremonyId,
      state: "OPEN",
      revision: 4,
      generation: 0,
      headSha256: manifest.relation.genesisZkey.sha256,
      headByteLength: manifest.relation.genesisZkey.byteLength,
      eventSequence: 0,
      eventHash: "00".repeat(32),
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const checkpointEnvelope = sign(
      checkpoint,
      "coordinator-test",
      coordinator.privateKey,
      CHECKPOINT_SIGNATURE_DOMAIN,
    ) as unknown as CheckpointEnvelope;
    const verifiedCheckpoint = verifyCheckpoint(checkpointEnvelope, manifest);
    const status = {
      ceremonyId: manifest.ceremonyId,
      state: "OPEN",
      generation: 0,
      head: {
        sha256: checkpoint.headSha256,
        byteLength: checkpoint.headByteLength,
        downloadUrl: `http://127.0.0.1/artifacts/${checkpoint.headSha256}.zkey`,
      },
      queueDepth: 1,
      manifestSha256: verifiedManifest.manifestSha256,
    };
    expect(() => verifyStatusAgainstCheckpoint({
      manifestEnvelope,
      manifest,
      manifestSha256: verifiedManifest.manifestSha256,
      checkpointEnvelope,
      checkpoint: verifiedCheckpoint,
      status,
    })).not.toThrow();

    const receipt: ContributionReceiptV1 = {
      schemaVersion: 1,
      type: "moss.phase2.receipt.v1",
      ceremonyId: manifest.ceremonyId,
      relationManifestSha256: verifiedManifest.manifestSha256,
      sequence: 1,
      generation: 1,
      predecessor: manifest.relation.genesisZkey,
      successor: { sha256: "33".repeat(32), byteLength: 110, urls: ["http://127.0.0.1/successor"] },
      contributionIndex: 1,
      contributionName: "moss-test-contributor",
      contributionHashBlake2b512: HEX_64,
      participantPseudonym: "test-user",
      clientKind: "cli",
      clientReleaseSha256: "55".repeat(32),
      acceptedAt: new Date().toISOString(),
      transcriptEventHash: "44".repeat(32),
    };
    const receiptEnvelope = sign(
      receipt,
      "coordinator-test",
      coordinator.privateKey,
      RECEIPT_SIGNATURE_DOMAIN,
    ) as unknown as ReceiptEnvelope;
    const expected = {
      manifestSha256: verifiedManifest.manifestSha256,
      predecessorSha256: receipt.predecessor.sha256,
      predecessorByteLength: receipt.predecessor.byteLength,
      successorSha256: receipt.successor.sha256,
      successorByteLength: receipt.successor.byteLength,
      contributionHashBlake2b512: receipt.contributionHashBlake2b512,
      contributionName: receipt.contributionName,
      baseGeneration: 0,
    };
    expect(verifyReceipt(receiptEnvelope, manifest, expected)).toEqual(receipt);
    expect(() => verifyReceipt(receiptEnvelope, manifest, {
      ...expected,
      successorSha256: "55".repeat(32),
    })).toThrow("local contribution");
  });

  it("rejects status that diverges from the signed checkpoint", () => {
    const root = generateKeyPairSync("ed25519");
    const coordinator = generateKeyPairSync("ed25519");
    const manifest = manifestFixture(coordinator.publicKey.export({ type: "spki", format: "pem" }).toString());
    const manifestEnvelope = sign(manifest, "root-test", root.privateKey, MANIFEST_SIGNATURE_DOMAIN) as unknown as ManifestEnvelope;
    const verified = verifyManifest(manifestEnvelope, root.publicKey, { production: false, expectedSlug: manifest.slug });
    const checkpoint: HeadCheckpointV1 = {
      schemaVersion: 1, type: "moss.phase2.checkpoint.v1", ceremonyId: manifest.ceremonyId,
      state: "OPEN", revision: 1, generation: 0, headSha256: manifest.relation.genesisZkey.sha256,
      headByteLength: 100, eventSequence: 0, eventHash: "00".repeat(32),
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const checkpointEnvelope = sign(checkpoint, "coordinator-test", coordinator.privateKey, CHECKPOINT_SIGNATURE_DOMAIN) as unknown as CheckpointEnvelope;
    expect(() => verifyStatusAgainstCheckpoint({
      manifestEnvelope,
      manifest,
      manifestSha256: verified.manifestSha256,
      checkpointEnvelope,
      checkpoint: verifyCheckpoint(checkpointEnvelope, manifest),
      status: {
        ceremonyId: manifest.ceremonyId,
        state: "OPEN",
        generation: 0,
        head: { sha256: "98".repeat(32), byteLength: 100, downloadUrl: "http://127.0.0.1/bad" },
        queueDepth: 0,
        manifestSha256: verified.manifestSha256,
      },
    })).toThrow("signed checkpoint");
  });
});

function manifestFixture(coordinatorPublicKey: string): CeremonyManifestV1 {
  const opensAt = new Date(Date.now() - 60_000).toISOString();
  const sealsAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const verifierPublicKey = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" }).toString();
  return {
    schemaVersion: 1,
    ceremonyId: CEREMONY_ID,
    slug: "moss-phase2-test",
    relation: {
      profile: "google-rs256-zksync-v3",
      relationId: "google-rs256-zksync-v3-groth16-bn254-2",
      verifierVersion: 4,
      proofSystem: "groth16",
      curve: "bn254",
      sourceRepository: "https://example.test/source",
      sourceCommit: "abc123",
      sourceClosureSha256: HEX_32,
      circomVersion: "2.2.3",
      snarkjsVersion: "0.7.6",
      r1cs: { sha256: "66".repeat(32), byteLength: 100, urls: ["http://127.0.0.1/r1cs"] },
      ptau: { sha256: "77".repeat(32), blake2b512: "88".repeat(64), byteLength: 100, urls: ["http://127.0.0.1/ptau"] },
      genesisZkey: { sha256: "99".repeat(32), byteLength: 100, urls: ["http://127.0.0.1/genesis"] },
    },
    schedule: { opensAt, sealsAt },
    beacon: {
      source: "drand", chainHash: "test-chain", round: 1,
      expectedAt: new Date(Date.parse(sealsAt) + 60_000).toISOString(),
      derivation: "MOSS_PHASE2_BEACON_V1", numIterationsExp: 10, contributionName: "test beacon",
    },
    coordinatorKeys: [{ keyId: "coordinator-test", algorithm: "Ed25519", publicKeyPem: coordinatorPublicKey }],
    verifierKeys: [{
      keyId: "verifier-test", algorithm: "Ed25519", publicKeyPem: verifierPublicKey,
      verifierImageDigest: `sha256:${"aa".repeat(32)}`,
    }],
    verifierPolicy: { operatorKeyIds: ["verifier-test"], requiredOperators: 1, passesPerOperator: 1 },
    contributionPolicy: {
      targetContributions: 1, maximumContributions: 1, maxArtifactByteLength: 1_000,
      requirePinnedClientRelease: false,
      lease: { offerSeconds: 30, absoluteSeconds: 3_600, heartbeatSeconds: 15 },
      verifierJobSeconds: 300, verifierMaxAttempts: 2,
    },
    webRelease: { sha256: "bb".repeat(32), byteLength: 1, urls: ["http://127.0.0.1/web"], sourceCommit: "abc" },
    cliReleases: [{ sha256: "cc".repeat(32), byteLength: 1, urls: ["http://127.0.0.1/cli"], sourceCommit: "abc" }],
  };
}

function sign<T>(value: T, keyId: string, privateKey: Parameters<typeof signEnvelope>[1]["privateKey"], domain: string) {
  return signEnvelope(value as unknown as JsonValue, { keyId, privateKey, domain });
}


describe("offline receipt command", () => {
  it("checks receipt signatures, manifest binding, CLI evidence and tampering", async () => {
    const root = generateKeyPairSync("ed25519");
    const coordinator = generateKeyPairSync("ed25519");
    const manifest = manifestFixture(coordinator.publicKey.export({ type: "spki", format: "pem" }).toString());
    const envelope = sign(manifest, "root-test", root.privateKey, MANIFEST_SIGNATURE_DOMAIN) as unknown as ManifestEnvelope;
    const { manifestSha256 } = verifyManifest(envelope, root.publicKey, { production: false, expectedSlug: manifest.slug });
    const receipt: ContributionReceiptV1 = {
      schemaVersion: 1, type: "moss.phase2.receipt.v1", ceremonyId: manifest.ceremonyId,
      relationManifestSha256: manifestSha256, sequence: 1, generation: 1, contributionIndex: 1,
      predecessor: manifest.relation.genesisZkey,
      successor: { sha256: "33".repeat(32), byteLength: 110, urls: ["http://127.0.0.1/successor"] },
      contributionName: "local-test", contributionHashBlake2b512: HEX_64, participantPseudonym: "Alice",
      clientKind: "cli", clientReleaseSha256: null, acceptedAt: new Date().toISOString(), transcriptEventHash: HEX_32,
    };
    const signed = sign(receipt, "coordinator-test", coordinator.privateKey, RECEIPT_SIGNATURE_DOMAIN);
    const file = { receiptEnvelope: signed, localEvidence: { predecessorSha256: receipt.predecessor.sha256, successorSha256: receipt.successor.sha256, contributionHashBlake2b512: receipt.contributionHashBlake2b512, contributionName: receipt.contributionName } };
    for (const input of [file, signed, { signedReceipt: signed, contributionIndex: 1, contributionHash: receipt.successor.sha256 }]) {
      expect(verifyReceiptFileContents(input, manifest, manifestSha256)).toEqual([receipt]);
    }
    expect(() => verifyReceiptFileContents({ ...signed, payload: { ...receipt, participantPseudonym: "Mallory" } }, manifest, manifestSha256)).toThrow(/signature/);
    expect(() => verifyReceiptFileContents(signed, manifest, "00".repeat(32))).toThrow(/manifest/);
    expect(() => verifyReceiptFileContents({ ...file, localEvidence: { ...file.localEvidence, successorSha256: HEX_32 } }, manifest, manifestSha256)).toThrow(/evidence/);
    expect(() => verifyReceiptFileContents([signed, signed], manifest, manifestSha256)).toThrow(/Duplicate/);
    expect(() => verifyReceiptFileContents({ signedReceipt: signed, contributionIndex: 9 }, manifest, manifestSha256)).toThrow(/summary/);
    expect(verifyReceiptFileContentsWithKey(file, coordinator.publicKey, manifest.ceremonyId)).toEqual([receipt]);
    expect(() => verifyReceiptFileContentsWithKey({ ...signed, payload: { ...receipt, participantPseudonym: "Mallory" } }, coordinator.publicKey, manifest.ceremonyId)).toThrow(/signature/);
    expect(() => verifyReceiptFileContentsWithKey({ ...file, localEvidence: { ...file.localEvidence, successorSha256: HEX_32 } }, coordinator.publicKey, manifest.ceremonyId)).toThrow(/evidence/);
    const dir = await mkdtemp(join(tmpdir(), "moss-offline-receipt-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = vi.fn(() => { throw new Error("offline verification must not fetch"); });
    vi.stubGlobal("fetch", fetch);
    try {
      await writeFile(join(dir, "receipt.json"), JSON.stringify(file));
      await writeFile(join(dir, "manifest.json"), JSON.stringify(envelope));
      await writeFile(join(dir, "root.pub"), root.publicKey.export({ type: "spki", format: "pem" }));
      const options = { manifest: join(dir, "manifest.json"), manifestRootKey: join(dir, "root.pub"), slug: manifest.slug, allowDevelopmentManifest: true };
      await expect(verifyReceiptCommand(join(dir, "receipt.json"), options)).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("receipt signature and ceremony binding verified"));
      expect(fetch).not.toHaveBeenCalled();
      await expect(verifyReceiptCommand(join(dir, "receipt.json"), { ...options, slug: "wrong" })).rejects.toThrow(/slug/);
      await expect(verifyReceiptCommand(join(dir, "receipt.json"), { ...options, allowDevelopmentManifest: false })).rejects.toThrow();
      await writeFile(join(dir, "root.pub"), generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
      await expect(verifyReceiptCommand(join(dir, "receipt.json"), options)).rejects.toThrow(/signature/);
      // Without the manifest: the published signing key and ceremony ID.
      await writeFile(join(dir, "signing.pub"), coordinator.publicKey.export({ type: "spki", format: "pem" }));
      const byKey = { signingKey: join(dir, "signing.pub"), ceremonyId: manifest.ceremonyId };
      await expect(verifyReceiptCommand(join(dir, "receipt.json"), byKey)).resolves.toBeUndefined();
      await expect(verifyReceiptCommand(join(dir, "receipt.json"), { ...byKey, ceremonyId: "other" })).rejects.toThrow(/different ceremony/);
      await expect(verifyReceiptCommand(join(dir, "receipt.json"), { signingKey: byKey.signingKey })).rejects.toThrow(/both required/);
      await expect(verifyReceiptCommand(join(dir, "receipt.json"), { ...byKey, slug: manifest.slug })).rejects.toThrow(/either/);
      await writeFile(join(dir, "signing.pub"), generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
      await expect(verifyReceiptCommand(join(dir, "receipt.json"), byKey)).rejects.toThrow(/signature/);
      await writeFile(join(dir, "oversize.json"), "x".repeat(1_048_577));
      await expect(readReceiptJson(join(dir, "oversize.json"))).rejects.toThrow(/1 MB/);
    } finally { log.mockRestore(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); }
  });
});

it("requires signed rehearsal purpose plus explicit opt-in and retains hosted pins", () => {
  const root = generateKeyPairSync("ed25519");
  const coordinator = generateKeyPairSync("ed25519");
  const manifest = manifestFixture(coordinator.publicKey.export({ type: "spki", format: "pem" }).toString());
  manifest.purpose = "rehearsal";
  manifest.relation.sourceCommit = "a".repeat(40);
  for (const artifact of [manifest.relation.r1cs, manifest.relation.ptau, manifest.relation.genesisZkey, manifest.webRelease, ...manifest.cliReleases]) {
    artifact.urls = ["https://archive.example/artifact"];
  }
  for (const release of [manifest.webRelease, ...manifest.cliReleases]) release.sourceCommit = "a".repeat(40);
  if (manifest.beacon.source === "drand") manifest.beacon.chainHash = "a".repeat(64);
  const signed = () => sign(manifest, "root-test", root.privateKey, MANIFEST_SIGNATURE_DOMAIN) as unknown as ManifestEnvelope;
  const options = { production: true, expectedSlug: manifest.slug, allowRehearsal: true };
  expect(() => verifyManifest(signed(), root.publicKey, options)).not.toThrow();
  expect(() => verifyManifest(signed(), root.publicKey, { ...options, allowRehearsal: false })).toThrow(/rehearsal/);
  delete manifest.purpose;
  expect(() => verifyManifest(signed(), root.publicKey, options)).toThrow(/signed for rehearsal/);
  // Unmarked, the same single-verifier manifest is a valid production manifest.
  expect(() => verifyManifest(signed(), root.publicKey, { ...options, allowRehearsal: false })).not.toThrow();
  manifest.purpose = "rehearsal";
  manifest.relation.ptau.urls = ["http://archive.example/ptau"];
  expect(() => verifyManifest(signed(), root.publicKey, options)).toThrow(/HTTPS/);
});

it("accepts later CLI builds only from a root-signed, chained update history", async () => {
  const root = generateKeyPairSync("ed25519");
  const manifest = manifestFixture(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
  manifest.operationalPolicy = { minHeartbeatGraceSeconds: 30, maxHeartbeatGraceSeconds: 300, allowWebReleaseUpdates: true, allowCliReleaseUpdates: true };
  const manifestEnvelope = sign(manifest, "root-test", root.privateKey, MANIFEST_SIGNATURE_DOMAIN) as unknown as ManifestEnvelope;
  const release = { sha256: "c".repeat(64), byteLength: 100, sourceCommit: "d".repeat(40), urls: ["https://releases.example/cli.js"] };
  const update = (privateKey: typeof root.privateKey) => sign({ schemaVersion: 1, type: "moss.phase2.operational-update.v1",
    ceremonyId: manifest.ceremonyId, manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest as unknown as JsonValue),
    sequence: 1, previousUpdateSha256: null, authorizedAt: new Date().toISOString(), reason: "Fix a CLI upload retry", cliRelease: release },
    "root-test", privateKey, OPERATIONAL_UPDATE_DOMAIN);
  const dir = await mkdtemp(join(tmpdir(), "moss-cli-updates-"));
  try {
    await writeFile(join(dir, "root.pub"), root.publicKey.export({ type: "spki", format: "pem" }));
    const trusted = { manifestEnvelope, manifest } as never;
    const client = (updates: unknown[]) => ({ getOperationalUpdates: async () => updates }) as unknown as CeremonyClient;
    await expect(loadUpdatedCliReleases(client([update(root.privateKey)]), trusted, join(dir, "root.pub")))
      .resolves.toEqual([...manifest.cliReleases.map((entry) => entry.sha256), release.sha256]);
    await expect(loadUpdatedCliReleases(client([update(generateKeyPairSync("ed25519").privateKey)]), trusted, join(dir, "root.pub")))
      .rejects.toThrow(/signature/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
