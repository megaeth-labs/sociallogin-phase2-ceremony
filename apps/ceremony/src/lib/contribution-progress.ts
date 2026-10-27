import type { ContributionStage } from "./worker-client";

/**
 * Shown when the coordinator released the slot during the download: it frees a
 * slot whose download cannot finish in time, and a sleeping or offline computer
 * stops the heartbeats that keep it.
 */
export const DOWNLOAD_SLOT_RELEASED =
  "Your slot was released while the contribution file was downloading. This happens when the download is too slow to finish within the slot, or when the computer sleeps or loses its connection. Try again on a faster connection.";

/** The page stopped an upload that could not finish before the slot's deadline. */
export const UPLOAD_TOO_SLOW =
  "Your upload was too slow to finish within your slot, so it was stopped and the slot passed to the next person. Try again on a faster connection.";

/**
 * Whether an upload, at its average rate so far, would end after the slot's
 * deadline (with a margin for the submission). Judged only after a minute, so a
 * slow start is not mistaken for a slow connection.
 */
export function projectedUploadMisses(input: {
  startedAt: number; now: number; uploaded: number; total: number; deadline: number;
}): boolean {
  const elapsed = input.now - input.startedAt;
  if (!Number.isFinite(input.deadline) || input.total <= 0 || elapsed < 60_000) return false;
  if (input.uploaded <= 0) return elapsed >= 90_000;
  const projectedEnd = input.startedAt + (elapsed * input.total) / input.uploaded;
  return projectedEnd > input.deadline - 15_000;
}

/** The coordinator released the slot during the upload. */
export const UPLOAD_SLOT_RELEASED =
  "Your slot was released while your contribution was uploading. This happens when the upload is too slow to finish within the slot, or when the computer sleeps or loses its connection. Try again on a faster connection.";

export interface WorkerProgress {
  phase: "downloading" | "computing";
  label: string;
  percent: number | null;
  heartbeatPercent: number;
}

/** Byte percentages describe each check, never estimated computation time. */
export function workerProgress(
  stage: ContributionStage,
  percent: number,
  computed: boolean,
): WorkerProgress | null {
  const measured = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, Math.floor(percent)))
    : null;
  const value = measured ?? 0;
  switch (stage) {
    case "download":
      return {
        phase: "downloading",
        label: "Downloading artifact",
        percent: measured,
        heartbeatPercent: value * 0.15,
      };
    case "validate":
      return computed
        ? {
            phase: "computing",
            label: "Checking input integrity after computation",
            percent: measured,
            heartbeatPercent: 70 + value * 0.05,
          }
        : {
            phase: "downloading",
            label: "Checking downloaded artifact integrity",
            percent: measured,
            heartbeatPercent: 15 + value * 0.05,
          };
    // Bellman reports only start/end. Even the legacy logger's section weights
    // are not a measured fraction of total work, so do not present them as one.
    case "compute":
      return {
        phase: "computing",
        label: "Computing your contribution",
        percent: null,
        heartbeatPercent: 20 + value * 0.5,
      };
    case "hash":
      return {
        phase: "computing",
        label: "Hashing your contribution for upload",
        percent: measured,
        heartbeatPercent: 75 + value * 0.1,
      };
    default:
      return null;
  }
}
