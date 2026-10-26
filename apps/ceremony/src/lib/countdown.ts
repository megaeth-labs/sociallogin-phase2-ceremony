export function remainingTime(deadline: string, now: number): string | null {
  const end = Date.parse(deadline);
  if (!Number.isFinite(end) || !Number.isFinite(now)) return null;
  const seconds = Math.max(0, Math.ceil((end - now) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * A countdown sized to its range: "12d 23h" for days, "5h 12m" for hours,
 * "1:59" under an hour. `remainingTime` keeps the full precision for the
 * detailed schedule panel.
 */
export function friendlyRemaining(deadline: string, now: number): string | null {
  const end = Date.parse(deadline);
  if (!Number.isFinite(end) || !Number.isFinite(now)) return null;
  const seconds = Math.max(0, Math.ceil((end - now) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

const localTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const utcTime = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: "UTC" });

/** "02:08 UTC (22:08 your time)" for a deadline later today. */
export function formatDeadline(iso: string) {
  const at = new Date(iso);
  return `${utcTime.format(at)} UTC (${localTime.format(at)} your time)`;
}

const utcFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** "26 Oct 2026, 00:23 UTC" for a signed ISO timestamp. */
export function formatUtc(iso: string) {
  return `${utcFormat.format(new Date(iso))} UTC`;
}
