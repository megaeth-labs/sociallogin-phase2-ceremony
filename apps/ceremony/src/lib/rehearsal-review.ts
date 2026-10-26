/** Opt-in review deployment, never enabled merely by NODE_ENV=production. */
export function rehearsalReviewEnabled(source: Record<string, string | undefined> = process.env) {
  return source.CEREMONY_MODE === "rehearsal" && source.REHEARSAL_REVIEW_MODE === "true";
}
export async function reviewBackendReady(base: string | undefined, fetcher = fetch): Promise<boolean> {
  if (!base) return false;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
    const response = await fetcher(new URL("/v1/rehearsal/setup", url), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const status = await response.json();
    return status.mode === "review" && status.database === "ready" && status.contributionsEnabled === false && status.schedule === null && status.beacon === null;
  } catch { return false; }
}

/** Screen gallery is separate from the prelaunch coordinator review mode. */
export function screenReviewEnabled(source: Record<string, string | undefined> = process.env) {
  return source.NODE_ENV === "development" || source.CEREMONY_MODE === "rehearsal";
}
