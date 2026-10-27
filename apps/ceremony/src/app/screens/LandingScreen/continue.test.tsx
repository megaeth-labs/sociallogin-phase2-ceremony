// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LandingScreen } from ".";

const state = vi.hoisted(() => ({
  eligibility: { hasEligibleCircuits: true, contributedCircuitIds: [] as string[] },
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: "authenticated", data: { participantId: "p", participantName: "alice" } }),
  signIn: vi.fn(),
}));
vi.mock("@/hooks/useCeremonyStatus", () => ({
  useCeremonyStatus: () => ({
    status: {
      ceremonyState: "OPEN", isActive: true, totalContributions: 1, targetContributions: 10,
      endDate: new Date(Date.now() + 86_400_000).toISOString(), startedAt: Date.now() - 86_400_000,
      beaconApplied: false, circuits: [], headByteLength: 1,
    },
    statusError: null,
  }),
}));
vi.mock("@/hooks/useParticipantEligibility", () => ({
  useParticipantEligibility: () => ({ eligibility: state.eligibility, eligibilityLoading: false, eligibilityError: null }),
}));
vi.mock("@/app/components/ContributionHistory", () => ({ ContributionHistory: () => null }));
vi.mock("@/app/components/PublicCeremony/LobbyTraits", () => ({ LobbyTraits: () => null }));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED", "true");
  window.history.replaceState(null, "", "/?continue=contribute");
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

function renderLanding(onBegin: () => void, activityStatus: "loading" | "ready" = "ready", queued = false) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <LandingScreen onAuth={vi.fn()} onBegin={onBegin} onVerify={vi.fn()} activityStatus={activityStatus}
        hasQueuePlace={queued} activity={queued ? <p>Your queue card</p> : undefined} />
    </QueryClientProvider>,
  );
}

it("takes a first-time contributor straight to the browser check after sign-in", () => {
  state.eligibility = { hasEligibleCircuits: true, contributedCircuitIds: [] };
  const onBegin = vi.fn();
  renderLanding(onBegin);
  expect(onBegin).toHaveBeenCalledTimes(1);
  expect(window.location.search).toBe("");
});
it("waits for existing attempts to load before deciding", () => {
  const onBegin = vi.fn();
  renderLanding(onBegin, "loading");
  expect(onBegin).not.toHaveBeenCalled();
  expect(window.location.search).toBe("?continue=contribute");
});
it("leaves someone who already contributed on the homepage", () => {
  state.eligibility = { hasEligibleCircuits: true, contributedCircuitIds: ["c"] };
  const onBegin = vi.fn();
  renderLanding(onBegin);
  expect(onBegin).not.toHaveBeenCalled();
  expect(window.location.search).toBe("");
});
it("shows only the welcome and the queue card to someone already in the queue", () => {
  state.eligibility = { hasEligibleCircuits: true, contributedCircuitIds: [] };
  const onBegin = vi.fn();
  const { container } = renderLanding(onBegin, "ready", true);
  expect(onBegin).not.toHaveBeenCalled();
  const text = container.textContent ?? "";
  expect(text).not.toContain("Contribute now");
  expect(text.indexOf("Welcome, alice.")).toBeGreaterThanOrEqual(0);
  expect(text.indexOf("Welcome, alice.")).toBeLessThan(text.indexOf("Your queue card"));
});
