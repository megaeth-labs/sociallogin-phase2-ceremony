import { authorizedCliReleases, verifyOperationalUpdates } from "@moss/phase2-protocol";

import { CeremonyClient } from "./client.js";
import {
  readManifestRootPublicKey,
  verifyCheckpoint,
  verifyManifest,
  verifyStatusAgainstCheckpoint,
} from "./trust.js";
import type { LeaseResponse, TrustedCeremonyState } from "./types.js";

export async function loadTrustedCeremonyState(
  client: CeremonyClient,
  manifestRootKeyPath: string,
  options: { allowDevelopmentManifest?: boolean; allowRehearsal?: boolean } = {},
): Promise<TrustedCeremonyState> {
  const rootPublicKey = await readManifestRootPublicKey(manifestRootKeyPath);
  const manifestEnvelope = await client.getManifest();
  const { manifest, manifestSha256 } = verifyManifest(manifestEnvelope, rootPublicKey, {
    production: options.allowDevelopmentManifest !== true,
    allowRehearsal: options.allowRehearsal,
    expectedSlug: client.target.slug,
  });
  let mismatch: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [checkpointEnvelope, status] = await Promise.all([
      client.getCheckpoint(),
      client.getStatus(),
    ]);
    const checkpoint = verifyCheckpoint(checkpointEnvelope, manifest);
    try {
      return verifyStatusAgainstCheckpoint({
        manifestEnvelope,
        manifest,
        manifestSha256,
        checkpointEnvelope,
        checkpoint,
        status,
      });
    } catch (error) {
      mismatch = error;
    }
  }
  throw mismatch;
}

/**
 * CLI builds authorized after signing: the coordinator's update history,
 * verified against the trusted manifest and the pinned root key.
 */
export async function loadUpdatedCliReleases(
  client: CeremonyClient,
  trusted: TrustedCeremonyState,
  manifestRootKeyPath: string,
  options: { allowRehearsal?: boolean } = {},
): Promise<string[]> {
  const [rootPublicKey, updates] = await Promise.all([
    readManifestRootPublicKey(manifestRootKeyPath),
    client.getOperationalUpdates(),
  ]);
  verifyOperationalUpdates(updates, trusted.manifestEnvelope, rootPublicKey, options.allowRehearsal === true);
  return authorizedCliReleases(trusted.manifest, updates).map((release) => release.sha256);
}

export function assertLeaseMatchesCheckpoint(
  lease: LeaseResponse,
  trusted: TrustedCeremonyState,
): void {
  if (trusted.checkpoint.state !== "OPEN") {
    throw new Error(`Signed ceremony checkpoint is not open (state ${trusted.checkpoint.state}).`);
  }
  if (lease.state !== "ACTIVE") {
    throw new Error(`Claimed lease is not active (state ${lease.state}).`);
  }
  if (Date.parse(lease.expiresAt) <= Date.now()) {
    throw new Error("Claimed lease is already expired.");
  }
  if (
    lease.baseGeneration !== trusted.checkpoint.generation ||
    lease.predecessor.sha256 !== trusted.checkpoint.headSha256 ||
    lease.predecessor.byteLength !== trusted.checkpoint.headByteLength
  ) {
    throw new Error("Lease predecessor does not match the fresh signed checkpoint.");
  }
}
