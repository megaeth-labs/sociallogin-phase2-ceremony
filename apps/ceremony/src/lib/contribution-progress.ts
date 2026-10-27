import type { ContributionStage } from "./worker-client";

/**
 * Shown when the coordinator released the slot during the download: it frees a
 * slot whose download cannot finish in time, and a sleeping or offline computer
 * stops the heartbeats that keep it.
 */
export const DOWNLOAD_SLOT_RELEASED =
  "Your slot was released while the contribution file was downloading. This happens when the download is too slow to finish within the slot, or when the computer sleeps or loses its connection. Try again on a faster connection, or contribute with the command-line client from a server.";

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
