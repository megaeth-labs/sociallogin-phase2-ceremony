/**
 * Progress a contributor reports with each lease heartbeat. It is advisory and
 * self-reported: it can only shorten a slot that is visibly not going to
 * finish, never extend one, and a malformed report is treated as no report.
 */
export type LeaseProgressStage = "downloading" | "computing" | "uploading" | "other";

export interface LeaseProgress {
  stage: LeaseProgressStage;
  /** Fraction of the current download or upload completed, when known. */
  fraction: number | null;
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

function byteFraction(done: unknown, total: unknown): number | null {
  if (typeof done !== "number" || typeof total !== "number"
    || !Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return fraction(done / total);
}

/**
 * Reads the browser's `{phase, percent, uploadedBytes?, totalBytes?}` or the
 * CLI's `{stage, receivedBytes | uploadedBytes, totalBytes}`.
 */
export function parseLeaseProgress(body: unknown): LeaseProgress | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const report = body as Record<string, unknown>;

  if (typeof report.phase === "string") {
    const stage = STAGES[report.phase] ?? "other";
    if (stage === "uploading") return { stage, fraction: byteFraction(report.uploadedBytes, report.totalBytes) };
    const percent = report.percent;
    if (stage !== "downloading" || typeof percent !== "number" || !Number.isFinite(percent)) {
      return { stage, fraction: null };
    }
    // Past the download share the browser is checking the file it already has.
    if (percent >= BROWSER_DOWNLOAD_SHARE) return { stage: "other", fraction: null };
    return { stage, fraction: fraction(percent / BROWSER_DOWNLOAD_SHARE) };
  }

  if (typeof report.stage === "string") {
    const stage = STAGES[report.stage.toLowerCase()] ?? "other";
    if (stage === "downloading") return { stage, fraction: byteFraction(report.receivedBytes, report.totalBytes) };
    if (stage === "uploading") return { stage, fraction: byteFraction(report.uploadedBytes, report.totalBytes) };
    return { stage, fraction: null };
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

/**
 * When a claimed slot is released because its upload cannot finish before the
 * slot's deadline. A submission must arrive while the slot is still claimed,
 * so an upload projected to end after the deadline is wasted either way;
 * releasing it early lets the next participant start sooner.
 */
export const UPLOAD_RELEASE_POLICY = {
  graceSeconds: 90,
  stallSeconds: 240,
} as const;
