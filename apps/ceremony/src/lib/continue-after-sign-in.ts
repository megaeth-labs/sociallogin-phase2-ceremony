/**
 * "Contribute now" while signed out sends the visitor through GitHub. The
 * callback URL carries this marker so the homepage can pick the flow back up
 * at the browser check instead of asking for a second click.
 */
const PARAM = "continue";
const VALUE = "contribute";

export function signInCallbackUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set(PARAM, VALUE);
  return url.pathname + url.search + url.hash;
}

export function hasContinueMarker(href: string): boolean {
  return new URL(href).searchParams.get(PARAM) === VALUE;
}

export function withoutContinueMarker(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(PARAM);
  return url.pathname + url.search + url.hash;
}

export interface ContinueState {
  isAuthenticated: boolean;
  /** Contributions are open and this release runs them in the browser. */
  canContribute: boolean;
  eligibility: { hasEligibleCircuits: boolean; contributedCircuitIds: string[] } | null | undefined;
  eligibilityLoading: boolean;
  eligibilityError: boolean;
  /** Whether the participant's existing attempts have been checked. */
  activity: "loading" | "ready" | "error";
  hasPendingContribution: boolean;
}

/**
 * "wait" until everything needed is known; then "begin" only for a first-time
 * contributor with nothing in progress. Anyone else stays on the homepage,
 * which already shows their receipt or attempt.
 */
export function continueAfterSignIn(state: ContinueState): "wait" | "begin" | "stay" {
  if (!state.isAuthenticated || state.eligibilityLoading || state.activity === "loading") return "wait";
  if (!state.canContribute || state.eligibilityError || state.activity === "error" || state.hasPendingContribution) return "stay";
  const eligibility = state.eligibility;
  if (!eligibility) return "wait";
  return eligibility.hasEligibleCircuits && eligibility.contributedCircuitIds.length === 0 ? "begin" : "stay";
}
