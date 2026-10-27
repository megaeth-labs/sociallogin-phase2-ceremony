/**
 * Progress a contributor reports with each lease heartbeat. It is advisory and
 * self-reported: it can only shorten a slot that is visibly not going to
 * finish, never extend one, and a malformed report is treated as no report.
 */
export type LeaseProgressStage = "downloading" | "computing" | "uploading" | "other";

export interface LeaseProgress {
  stage: LeaseProgressStage;
  /** Fraction of the predecessor download completed, when known. */
  downloadFraction: number | null;
}

/**
 * The browser reports the whole attempt as 0–100, of which the download is the
 * first 15 points (`apps/ceremony/src/lib/contribution-progress.ts`).
 */
const BROWSER_DOWNLOAD_SHARE = 15;

const STAGES: Record<string, LeaseProgressStage> = {
  downloading: "downloading",
  computing: "computing",
  uploading: "uploading",
};

function fraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Reads the browser's `{phase, percent}` or the CLI's `{stage, receivedBytes, totalBytes}`. */
export function parseLeaseProgress(body: unknown): LeaseProgress | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const report = body as Record<string, unknown>;

  if (typeof report.phase === "string") {
    const stage = STAGES[report.phase] ?? "other";
    const percent = report.percent;
    if (stage !== "downloading" || typeof percent !== "number" || !Number.isFinite(percent)) {
      return { stage, downloadFraction: null };
    }
    // Past the download share the browser is checking the file it already has.
    if (percent >= BROWSER_DOWNLOAD_SHARE) return { stage: "other", downloadFraction: null };
    return { stage, downloadFraction: fraction(percent / BROWSER_DOWNLOAD_SHARE) };
  }

  if (typeof report.stage === "string") {
    const stage = STAGES[report.stage.toLowerCase()] ?? "other";
    const received = report.receivedBytes;
    const total = report.totalBytes;
    if (stage !== "downloading" || typeof received !== "number" || typeof total !== "number"
      || !Number.isFinite(received) || !Number.isFinite(total) || total <= 0) {
      return { stage, downloadFraction: null };
    }
    return { stage, downloadFraction: fraction(received / total) };
  }

  return null;
}

/**
 * When a claimed slot is released because its download cannot finish in time.
 * Grace comes first so a slow start is never judged; after that a download is
 * released if, at its average rate so far, the whole file would take longer
 * than the projection limit, or if it reports no progress for the stall limit.
 */
export const DOWNLOAD_RELEASE_POLICY = {
  graceSeconds: 180,
  projectedDownloadLimitSeconds: 900,
  stallSeconds: 240,
} as const;
