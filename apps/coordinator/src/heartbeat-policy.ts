import type { CeremonyManifestV1 } from "@moss/phase2-protocol";

/** Rehearsal-only liveness relaxation; never changes artifact acceptance or slot deadlines. */
export function heartbeatGraceSeconds(
  manifest: CeremonyManifestV1,
  allowRehearsal: boolean = false,
): number {
  const signed = manifest.contributionPolicy.lease.heartbeatSeconds;
  return allowRehearsal && manifest.purpose === "rehearsal"
    ? Math.max(signed, 300)
    : signed;
}
