import { createPublicKey, type KeyObject } from "node:crypto";
import { open } from "node:fs/promises";

import {
  CHECKPOINT_SIGNATURE_DOMAIN,
  MANIFEST_SIGNATURE_DOMAIN,
  assertArtifactRef,
  assertCheckpoint,
  assertManifest,
  assertSafeId,
  canonicalize,
  verifyEnvelope,
  type CeremonyManifestV1,
  type HeadCheckpointV1,
  type JsonValue,
  type PublicKeyRef,
  type SignedEnvelope,
} from "@moss/phase2-protocol";

import { sha256Bytes } from "./hashing.js";
import type {
  FinalizeOptions,
  LoadedFinalizationAuthority,
} from "./types.js";

const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_PUBLIC_KEY_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
// Match the protocol's full Git object-ID rule: SHA-1 repositories use 40 hex
// characters and SHA-256 repositories use 64.
const GIT_COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const PRINTABLE_NAME = /^[\x20-\x7e]{1,64}$/u;

export async function loadFinalizationAuthority(
  options: Pick<
    FinalizeOptions,
    | "allowRehearsal"
    | "manifestEnvelopePath"
    | "rootPublicKeyPath"
    | "expectedRootKeyId"
    | "expectedRootKeySpkiSha256"
    | "sealedCheckpointEnvelopePath"
    | "expectedSealedHeadSha256"
    | "expectedSealedHeadByteLength"
  >,
): Promise<LoadedFinalizationAuthority> {
  assertSafeId(options.expectedRootKeyId, "expectedRootKeyId");
  assertSha256(
    options.expectedRootKeySpkiSha256,
    "expectedRootKeySpkiSha256",
  );
  assertSha256(
    options.expectedSealedHeadSha256,
    "expectedSealedHeadSha256",
  );
  if (
    !Number.isSafeInteger(options.expectedSealedHeadByteLength) ||
    options.expectedSealedHeadByteLength <= 0
  ) {
    throw new Error("expectedSealedHeadByteLength must be a positive safe integer");
  }

  const [manifestBytes, rootPublicKeyBytes] = await Promise.all([
    readSmallRegularFile(options.manifestEnvelopePath, MAX_ENVELOPE_BYTES),
    readSmallRegularFile(options.rootPublicKeyPath, MAX_PUBLIC_KEY_BYTES),
  ]);
  const rootPublicKey = parseEd25519PublicKey(
    rootPublicKeyBytes.toString("utf8"),
    "manifest root key",
  );
  const rootKeySpkiSha256 = publicKeySpkiSha256(rootPublicKey);
  if (rootKeySpkiSha256 !== options.expectedRootKeySpkiSha256) {
    throw new Error("manifest root public key does not match the expected fingerprint");
  }

  const manifestEnvelope = parseSignedEnvelope<CeremonyManifestV1>(
    manifestBytes,
    "ceremony manifest envelope",
  );
  if (manifestEnvelope.keyId !== options.expectedRootKeyId) {
    throw new Error("ceremony manifest envelope was not signed by the expected root key ID");
  }
  const manifest = verifyEnvelope(
    manifestEnvelope as unknown as SignedEnvelope<JsonValue>,
    {
      publicKey: rootPublicKey,
      domain: MANIFEST_SIGNATURE_DOMAIN,
    },
  ) as unknown as CeremonyManifestV1;
  assertProductionFinalizationManifest(manifest, options.allowRehearsal);

  const checkpointBytes = await readSmallRegularFile(
    options.sealedCheckpointEnvelopePath,
    MAX_ENVELOPE_BYTES,
  );
  const checkpointEnvelope = parseSignedEnvelope<HeadCheckpointV1>(
    checkpointBytes,
    "sealed checkpoint envelope",
  );
  const coordinatorKey = uniqueKeyById(
    manifest.coordinatorKeys,
    checkpointEnvelope.keyId,
    "coordinator",
  );
  const coordinatorPublicKey = parseManifestPublicKey(
    coordinatorKey,
    "checkpoint coordinator key",
  );
  const checkpoint = verifyEnvelope(
    checkpointEnvelope as unknown as SignedEnvelope<JsonValue>,
    {
      publicKey: coordinatorPublicKey,
      domain: CHECKPOINT_SIGNATURE_DOMAIN,
    },
  ) as unknown as HeadCheckpointV1;
  assertCheckpoint(checkpoint);

  if (checkpoint.ceremonyId !== manifest.ceremonyId) {
    throw new Error("sealed checkpoint belongs to a different ceremony");
  }
  if (checkpoint.state !== "SEALED") {
    throw new Error("checkpoint state must be exactly SEALED");
  }
  if (checkpoint.headByteLength <= 0) {
    throw new Error("sealed checkpoint head byte length must be positive");
  }
  if (checkpoint.generation <= 0) {
    throw new Error(
      "sealed checkpoint must contain at least one ordinary contribution before the public beacon",
    );
  }
  if (
    checkpoint.generation > manifest.contributionPolicy.maximumContributions ||
    checkpoint.headByteLength > manifest.contributionPolicy.maxArtifactByteLength
  ) {
    throw new Error("sealed checkpoint exceeds the signed contribution policy");
  }
  if (
    checkpoint.headSha256 !== options.expectedSealedHeadSha256 ||
    checkpoint.headByteLength !== options.expectedSealedHeadByteLength
  ) {
    throw new Error("sealed checkpoint does not match the independently expected head");
  }

  return {
    manifest,
    manifestEnvelopeSha256: sha256Bytes(manifestBytes),
    manifestCanonicalPayloadSha256: sha256Bytes(
      canonicalize(manifest as unknown as JsonValue),
    ),
    manifestRootKeyId: manifestEnvelope.keyId,
    manifestRootKeySpkiSha256: rootKeySpkiSha256,
    checkpoint,
    checkpointEnvelopeSha256: sha256Bytes(checkpointBytes),
    checkpointSignerKeyId: checkpointEnvelope.keyId,
  };
}

function assertProductionFinalizationManifest(
  manifest: CeremonyManifestV1,
  allowRehearsal = false,
): void {
  assertManifest(manifest, { production: true, allowRehearsal });
  if (!Array.isArray(manifest.coordinatorKeys) || manifest.coordinatorKeys.length === 0) {
    throw new Error("manifest must contain at least one coordinator key");
  }
  assertUniquePublicKeys(manifest.coordinatorKeys, "coordinator");
  assertUniquePublicKeys(manifest.verifierKeys, "verifier");
  if (!/^https:\/\//u.test(manifest.relation.sourceRepository)) {
    throw new Error("manifest source repository must use HTTPS");
  }
  if (!GIT_COMMIT.test(manifest.relation.sourceCommit)) {
    throw new Error("manifest source commit must be a full lowercase commit hash");
  }
  assertArtifactRef(manifest.webRelease, "webRelease");
  if (!GIT_COMMIT.test(manifest.webRelease.sourceCommit)) {
    throw new Error("manifest web release source commit is invalid");
  }
  if (!Array.isArray(manifest.cliReleases) || manifest.cliReleases.length === 0) {
    throw new Error("manifest must contain at least one CLI release");
  }
  for (const [index, release] of manifest.cliReleases.entries()) {
    assertArtifactRef(release, `cliReleases[${index}]`);
    if (!GIT_COMMIT.test(release.sourceCommit)) {
      throw new Error(`manifest CLI release ${index} source commit is invalid`);
    }
  }

  const beacon = manifest.beacon;
  // assertManifest above validates both committed sources, including mainnet
  // chain ID and the beacon time being after sealing. The resolver verifies
  // finalized block evidence before any beacon operation is performed.
  if (
    !Number.isSafeInteger(beacon.numIterationsExp) ||
    beacon.numIterationsExp < 10 ||
    beacon.numIterationsExp > 32
  ) {
    throw new Error("finalizer supports beacon iteration exponents from 10 through 32");
  }
  if (!PRINTABLE_NAME.test(beacon.contributionName)) {
    throw new Error("manifest beacon contribution name must be 1-64 printable ASCII bytes");
  }
}

function assertUniquePublicKeys(
  keys: readonly PublicKeyRef[],
  label: string,
): void {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(`manifest ${label} keys must be nonempty`);
  }
  const ids = new Set<string>();
  for (const key of keys) {
    assertSafeId(key.keyId, `${label} keyId`);
    if (ids.has(key.keyId)) throw new Error(`manifest ${label} key IDs must be unique`);
    ids.add(key.keyId);
    parseManifestPublicKey(key, `${label} public key`);
  }
}

function uniqueKeyById(
  keys: readonly PublicKeyRef[],
  keyId: string,
  label: string,
): PublicKeyRef {
  const matches = keys.filter((key) => key.keyId === keyId);
  if (matches.length !== 1) {
    throw new Error(`signed envelope ${label} key ID is not uniquely authorized`);
  }
  return matches[0];
}

function parseManifestPublicKey(key: PublicKeyRef, label: string): KeyObject {
  if (key.algorithm !== "Ed25519") {
    throw new Error(`${label} algorithm must be Ed25519`);
  }
  return parseEd25519PublicKey(key.publicKeyPem, label);
}

function parseEd25519PublicKey(pem: string, label: string): KeyObject {
  if (pem.includes("PRIVATE KEY")) {
    throw new Error(`${label} must not contain private key material`);
  }
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error(`${label} is not a valid public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} must be Ed25519`);
  }
  return key;
}

function publicKeySpkiSha256(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  return sha256Bytes(der);
}

function parseSignedEnvelope<T>(
  bytes: Buffer,
  label: string,
): SignedEnvelope<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} must be an object`);
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.keyId !== "string" ||
    typeof parsed.signature !== "string" ||
    !isRecord(parsed.payload)
  ) {
    throw new Error(`${label} shape is invalid`);
  }
  return parsed as unknown as SignedEnvelope<T>;
}

async function readSmallRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maxBytes)) {
      throw new Error("authority input must be a nonempty bounded regular file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      BigInt(bytes.byteLength) !== before.size
    ) {
      throw new Error("authority input changed while it was being read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be lowercase SHA-256 hex`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
