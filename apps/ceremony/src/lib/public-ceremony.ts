import type { StatusResponse } from "./api";

export type PublicCeremonyStage =
  | "unavailable"
  | "scheduled"
  | "open"
  | "capacity"
  | "sealed"
  | "finalized"
  | "paused";
export function ceremonyStage(
  status: StatusResponse | null,
  now: number,
): PublicCeremonyStage {
  if (!status) return "unavailable";
  if (status.finalization || status.ceremonyState === "FINALIZED" || status.beaconApplied)
    return "finalized";
  if (["ABORTED", "CANCELLED", "PAUSED"].includes(status.ceremonyState ?? ""))
    return "paused";
  if (
    ["SEALED", "WAITING_FOR_BEACON", "FINALIZING"].includes(
      status.ceremonyState ?? "",
    ) ||
    (status.endDate && Date.parse(status.endDate) <= now)
  )
    return "sealed";
  if (
    status.startedAt > now ||
    ["DRAFT", "PREPARING", "PREPARED"].includes(status.ceremonyState ?? "")
  )
    return "scheduled";
  if (status.isActive) return "open";
  if (
    status.targetContributions > 0 &&
    status.totalContributions >= status.targetContributions
  )
    return "capacity";
  return "paused";
}
export function claimAvailable(expiresAt: string | null, now: number): boolean {
  return (
    expiresAt !== null &&
    Number.isFinite(Date.parse(expiresAt)) &&
    Date.parse(expiresAt) > now
  );
}
export function phasePercent(
  phase: "downloading" | "computing" | "uploading" | "verifying",
  overall: number,
): number | null {
  // Uploads report bytes as points 85–92 of the overall progress.
  if (phase === "uploading" && Number.isFinite(overall) && overall > 85) {
    return Math.max(0, Math.min(100, Math.floor(((overall - 85) / 7) * 100)));
  }
  // Computation reports no byte progress, and verification is asynchronous.
  if (
    phase === "computing" ||
    phase === "uploading" ||
    phase === "verifying" ||
    !Number.isFinite(overall)
  )
    return null;
  const value = (overall / 20) * 100;
  return Math.max(0, Math.min(100, Math.floor(value)));
}
