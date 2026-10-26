import { createPublicKey, type KeyObject } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
  CHECKPOINT_SIGNATURE_DOMAIN,
  MANIFEST_SIGNATURE_DOMAIN,
  RECEIPT_SIGNATURE_DOMAIN,
  assertCheckpoint,
  assertManifest,
  assertReceipt,
  canonicalSha256,
  verifyEnvelope,
  type CeremonyManifestV1,
  type ContributionReceiptV1,
  type HeadCheckpointV1,
  type JsonValue,
  type SignedEnvelope,
} from "@moss/phase2-protocol";

import type {
  CheckpointEnvelope,
  ManifestEnvelope,
  ReceiptEnvelope,
  StatusResponse,
  TrustedCeremonyState,
} from "./types.js";

const CLOCK_TOLERANCE_MS = 5 * 60_000;

export async function readManifestRootPublicKey(path: string): Promise<KeyObject> {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new Error("Manifest root public-key path is not a regular file.");
  }
  const key = createPublicKey(await readFile(path, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Manifest root public key must be Ed25519.");
  }
  return key;
}

export function verifyManifest(
  envelope: ManifestEnvelope,
  rootPublicKey: KeyObject,
  options: { production: boolean; expectedSlug: string; allowRehearsal?: boolean },
): { manifest: CeremonyManifestV1; manifestSha256: string } {
  const manifest = verifyEnvelope(envelope as unknown as SignedEnvelope<JsonValue>, {
    publicKey: rootPublicKey,
    domain: MANIFEST_SIGNATURE_DOMAIN,
  }) as unknown as CeremonyManifestV1;

  assertManifest(manifest, { production: options.production, allowRehearsal: options.allowRehearsal });
  if (manifest.slug !== options.expectedSlug) {
    throw new Error(
      `Signed manifest slug mismatch: expected ${options.expectedSlug}, received ${manifest.slug}.`,
    );
  }
  assertUniqueCoordinatorKeys(manifest);

  return {
    manifest,
    manifestSha256: canonicalSha256(
      "MOSS_PHASE2_MANIFEST_PAYLOAD_V1",
      manifest as unknown as JsonValue,
    ),
  };
}

export function verifyCheckpoint(
  envelope: CheckpointEnvelope,
  manifest: CeremonyManifestV1,
  now = Date.now(),
): HeadCheckpointV1 {
  const key = coordinatorKey(manifest, envelope.keyId);
  const checkpoint = verifyEnvelope(
    envelope as unknown as SignedEnvelope<JsonValue>,
    { publicKey: key, domain: CHECKPOINT_SIGNATURE_DOMAIN },
  ) as unknown as HeadCheckpointV1;

  assertCheckpoint(checkpoint);
  if (checkpoint.ceremonyId !== manifest.ceremonyId) {
    throw new Error("Signed checkpoint belongs to a different ceremony.");
  }
  if (Date.parse(checkpoint.expiresAt) <= now) {
    throw new Error("Signed checkpoint is expired.");
  }
  if (Date.parse(checkpoint.issuedAt) > now + CLOCK_TOLERANCE_MS) {
    throw new Error("Signed checkpoint was issued too far in the future.");
  }
  return checkpoint;
}

export function verifyStatusAgainstCheckpoint(input: {
  manifestEnvelope: ManifestEnvelope;
  manifest: CeremonyManifestV1;
  manifestSha256: string;
  checkpointEnvelope: CheckpointEnvelope;
  checkpoint: HeadCheckpointV1;
  status: StatusResponse;
}): TrustedCeremonyState {
  const { manifest, manifestSha256, checkpoint, status } = input;
  if (status.ceremonyId !== manifest.ceremonyId) {
    throw new Error("Coordinator status belongs to a different ceremony.");
  }
  if (status.manifestSha256 !== manifestSha256) {
    throw new Error("Coordinator status does not match the signed manifest.");
  }
  if (
    status.state !== checkpoint.state ||
    status.generation !== checkpoint.generation ||
    status.head.sha256 !== checkpoint.headSha256 ||
    status.head.byteLength !== checkpoint.headByteLength
  ) {
    throw new Error("Coordinator status does not match the signed checkpoint.");
  }
  return input;
}

export function verifyReceipt(
  envelope: ReceiptEnvelope,
  manifest: CeremonyManifestV1,
  expected: {
    manifestSha256: string;
    predecessorSha256: string;
    predecessorByteLength: number;
    successorSha256: string;
    successorByteLength: number;
    contributionHashBlake2b512: string;
    contributionName: string;
    baseGeneration: number;
  },
  now = Date.now(),
): ContributionReceiptV1 {
  const key = coordinatorKey(manifest, envelope.keyId);
  const receipt = verifyEnvelope(
    envelope as unknown as SignedEnvelope<JsonValue>,
    { publicKey: key, domain: RECEIPT_SIGNATURE_DOMAIN },
  ) as unknown as ContributionReceiptV1;

  assertReceipt(receipt);
  if (receipt.ceremonyId !== manifest.ceremonyId) {
    throw new Error("Signed receipt belongs to a different ceremony.");
  }
  if (receipt.relationManifestSha256 !== expected.manifestSha256) {
    throw new Error("Signed receipt references a different manifest.");
  }
  if (
    receipt.predecessor.sha256 !== expected.predecessorSha256 ||
    receipt.predecessor.byteLength !== expected.predecessorByteLength
  ) {
    throw new Error("Signed receipt predecessor does not match the lease.");
  }
  if (
    receipt.successor.sha256 !== expected.successorSha256 ||
    receipt.successor.byteLength !== expected.successorByteLength
  ) {
    throw new Error("Signed receipt successor does not match the local contribution.");
  }
  if (receipt.contributionHashBlake2b512 !== expected.contributionHashBlake2b512) {
    throw new Error("Signed receipt contribution hash does not match the local contribution.");
  }
  if (receipt.contributionName !== expected.contributionName) {
    throw new Error("Signed receipt contribution name does not match the lease.");
  }
  if (receipt.generation !== expected.baseGeneration + 1) {
    throw new Error("Signed receipt generation is not the leased successor generation.");
  }
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
    throw new Error("Signed receipt sequence is invalid.");
  }
  if (Date.parse(receipt.acceptedAt) > now + CLOCK_TOLERANCE_MS) {
    throw new Error("Signed receipt acceptance time is too far in the future.");
  }
  return receipt;
}

function assertUniqueCoordinatorKeys(manifest: CeremonyManifestV1): void {
  if (manifest.coordinatorKeys.length === 0) {
    throw new Error("Signed manifest does not authorize a coordinator key.");
  }
  const ids = new Set<string>();
  for (const ref of manifest.coordinatorKeys) {
    if (ref.algorithm !== "Ed25519" || ids.has(ref.keyId)) {
      throw new Error("Signed manifest coordinator keys are invalid or duplicated.");
    }
    ids.add(ref.keyId);
    const key = createPublicKey(ref.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error(`Coordinator key ${ref.keyId} is not Ed25519.`);
    }
  }
}

function coordinatorKey(manifest: CeremonyManifestV1, keyId: string): KeyObject {
  const matches = manifest.coordinatorKeys.filter((candidate) => candidate.keyId === keyId);
  if (matches.length !== 1) {
    throw new Error(`Signed envelope uses unauthorized coordinator key ${keyId}.`);
  }
  const key = createPublicKey(matches[0].publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`Coordinator key ${keyId} is not Ed25519.`);
  }
  return key;
}
