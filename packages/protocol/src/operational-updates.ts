import type { KeyLike } from "node:crypto";
import { canonicalSha256, canonicalize } from "./jcs.js";
import { verifyEnvelope } from "./signing.js";
import { assertIsoDate, assertRelease } from "./validation.js";
import type { CeremonyManifestV1, JsonValue, ReleaseRef, SignedEnvelope } from "./types.js";

export const OPERATIONAL_UPDATE_DOMAIN = "MOSS_PHASE2_OPERATIONAL_UPDATE_V1";
export const MAX_OPERATIONAL_UPDATES = 256;
export interface OperationalPolicy {
  minHeartbeatGraceSeconds: number;
  maxHeartbeatGraceSeconds: number;
  allowWebReleaseUpdates: boolean;
  /** Absent in manifests signed before CLI release updates existed, which means false. */
  allowCliReleaseUpdates?: boolean;
}
export interface OperationalUpdate {
  schemaVersion: 1;
  type: "moss.phase2.operational-update.v1";
  ceremonyId: string;
  manifestSha256: string;
  sequence: number;
  previousUpdateSha256: string | null;
  authorizedAt: string;
  reason: string;
  heartbeatGraceSeconds?: number;
  webRelease?: ReleaseRef;
  /** Adds a CLI build to the manifest's cliReleases; earlier authorizations stay valid. */
  cliRelease?: ReleaseRef;
}
export function operationalPolicy(manifest: CeremonyManifestV1, allowRehearsal = false): OperationalPolicy | undefined {
  return manifest.operationalPolicy ?? (allowRehearsal && manifest.purpose === "rehearsal"
    ? { minHeartbeatGraceSeconds: 30, maxHeartbeatGraceSeconds: 600, allowWebReleaseUpdates: true }
    : undefined);
}
export function operationalUpdateHash(update: SignedEnvelope<OperationalUpdate>): string {
  return canonicalSha256(OPERATIONAL_UPDATE_DOMAIN, update as unknown as JsonValue);
}
/** A narrow allowlist: this message cannot amend ceremony commitments or verifier policy. */
export function verifyOperationalUpdate(
  envelope: SignedEnvelope<OperationalUpdate>, manifest: SignedEnvelope<CeremonyManifestV1>,
  rootPublicKey: KeyLike, previous: SignedEnvelope<OperationalUpdate> | null, allowRehearsal = false,
): OperationalUpdate {
  if (!envelope || typeof envelope !== "object" || JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(["keyId", "payload", "schemaVersion", "signature"])) throw new Error("Invalid operational update envelope");
  if (Buffer.byteLength(canonicalize(envelope as unknown as JsonValue)) > 8192) throw new Error("Operational update exceeds size limit");
  const policy = operationalPolicy(manifest.payload, allowRehearsal);
  if (!policy) throw new Error("Operational updates were not authorized by the signed manifest");
  if (envelope.keyId !== manifest.keyId) throw new Error("Operational update root key differs from manifest");
  const value = verifyEnvelope(envelope as unknown as SignedEnvelope<JsonValue>, {
    publicKey: rootPublicKey, domain: OPERATIONAL_UPDATE_DOMAIN,
  }) as unknown as OperationalUpdate;
  const keys = ["schemaVersion", "type", "ceremonyId", "manifestSha256", "sequence", "previousUpdateSha256", "authorizedAt", "reason",
    ...(value?.heartbeatGraceSeconds === undefined ? [] : ["heartbeatGraceSeconds"]),
    ...(value?.webRelease === undefined ? [] : ["webRelease"]),
    ...(value?.cliRelease === undefined ? [] : ["cliRelease"])].sort();
  if (!value || typeof value !== "object" || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
    || value.schemaVersion !== 1 || value.type !== "moss.phase2.operational-update.v1") throw new Error("Invalid operational update schema");
  if (value.ceremonyId !== manifest.payload.ceremonyId || value.manifestSha256 !== canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest.payload as unknown as JsonValue)) throw new Error("Operational update belongs to a different ceremony manifest");
  if (value.sequence !== (previous?.payload.sequence ?? 0) + 1 || value.sequence > MAX_OPERATIONAL_UPDATES
    || value.previousUpdateSha256 !== (previous ? operationalUpdateHash(previous) : null)) throw new Error("Operational update sequence or predecessor mismatch");
  assertIsoDate(value.authorizedAt, "authorizedAt");
  if (previous && value.authorizedAt < previous.payload.authorizedAt) throw new Error("Operational update time moved backwards");
  if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 500) throw new Error("Operational update requires a short public reason");
  if (value.heartbeatGraceSeconds === undefined && value.webRelease === undefined && value.cliRelease === undefined) throw new Error("Operational update has no changes");
  if (value.heartbeatGraceSeconds !== undefined && (!Number.isSafeInteger(value.heartbeatGraceSeconds)
    || value.heartbeatGraceSeconds < policy.minHeartbeatGraceSeconds || value.heartbeatGraceSeconds > policy.maxHeartbeatGraceSeconds
    || value.heartbeatGraceSeconds * 2 >= manifest.payload.contributionPolicy.lease.absoluteSeconds)) throw new Error("Heartbeat grace is outside the authorized bounds");
  if (value.webRelease !== undefined) {
    if (!policy.allowWebReleaseUpdates) throw new Error("Browser release updates are not authorized");
    assertRelease(value.webRelease, "operational web release", { production: true });
  }
  if (value.cliRelease !== undefined) {
    if (policy.allowCliReleaseUpdates !== true) throw new Error("CLI release updates are not authorized");
    assertRelease(value.cliRelease, "operational CLI release", { production: true });
  }
  return value;
}
export function verifyOperationalUpdates(updates: SignedEnvelope<OperationalUpdate>[], manifest: SignedEnvelope<CeremonyManifestV1>, root: KeyLike, allowRehearsal = false): void {
  if (!Array.isArray(updates) || updates.length > MAX_OPERATIONAL_UPDATES) throw new Error("Operational update history exceeds the limit");
  const releases = new Map<string, string>();
  if (manifest.payload.webRelease) releases.set(manifest.payload.webRelease.sourceCommit, manifest.payload.webRelease.sha256);
  const cliReleases = new Map<string, string>();
  for (const release of manifest.payload.cliReleases ?? []) cliReleases.set(release.sourceCommit, release.sha256);
  updates.forEach((value, i) => {
    const update = verifyOperationalUpdate(value, manifest, root, updates[i - 1] ?? null, allowRehearsal);
    if (update.webRelease) {
      const { sourceCommit, sha256 } = update.webRelease;
      if (releases.has(sourceCommit) && releases.get(sourceCommit) !== sha256) throw new Error("Use a distinct source commit for a different browser release");
      releases.set(sourceCommit, sha256);
    }
    if (update.cliRelease) {
      const { sourceCommit, sha256 } = update.cliRelease;
      if (cliReleases.has(sourceCommit) && cliReleases.get(sourceCommit) !== sha256) throw new Error("Use a distinct source commit for a different CLI release");
      cliReleases.set(sourceCommit, sha256);
    }
  });
}
/**
 * Every CLI build the ceremony authorizes: the manifest's own, then each one a
 * verified update added, with the time it was authorized. Verify the updates first.
 */
export function authorizedCliReleases(
  manifest: CeremonyManifestV1, updates: SignedEnvelope<OperationalUpdate>[],
): { sha256: string; authorizedAt: string | null }[] {
  return [
    ...manifest.cliReleases.map((release) => ({ sha256: release.sha256, authorizedAt: null })),
    ...updates.flatMap((update) => update.payload.cliRelease
      ? [{ sha256: update.payload.cliRelease.sha256, authorizedAt: update.payload.authorizedAt }] : []),
  ];
}
