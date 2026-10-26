import { expect, it } from "vitest";
import {
  continueAfterSignIn, hasContinueMarker, signInCallbackUrl, withoutContinueMarker, type ContinueState,
} from "./continue-after-sign-in";

const ready: ContinueState = {
  isAuthenticated: true,
  canContribute: true,
  eligibility: { hasEligibleCircuits: true, contributedCircuitIds: [] },
  eligibilityLoading: false,
  eligibilityError: false,
  activity: "ready",
  hasPendingContribution: false,
};

it("marks the sign-in return URL and removes the mark afterwards", () => {
  const back = signInCallbackUrl("https://site.test/?ref=x#top");
  expect(back).toBe("/?ref=x&continue=contribute#top");
  expect(hasContinueMarker(`https://site.test${back}`)).toBe(true);
  expect(withoutContinueMarker(`https://site.test${back}`)).toBe("/?ref=x#top");
  expect(hasContinueMarker("https://site.test/")).toBe(false);
});
it("opens the browser check for a first-time contributor", () => {
  expect(continueAfterSignIn(ready)).toBe("begin");
});
it("waits until the session, eligibility and existing attempts are known", () => {
  expect(continueAfterSignIn({ ...ready, isAuthenticated: false })).toBe("wait");
  expect(continueAfterSignIn({ ...ready, eligibilityLoading: true })).toBe("wait");
  expect(continueAfterSignIn({ ...ready, activity: "loading" })).toBe("wait");
  expect(continueAfterSignIn({ ...ready, eligibility: undefined })).toBe("wait");
});
it("keeps returning and blocked participants on the homepage", () => {
  expect(continueAfterSignIn({ ...ready, eligibility: { hasEligibleCircuits: true, contributedCircuitIds: ["c"] } })).toBe("stay");
  expect(continueAfterSignIn({ ...ready, eligibility: { hasEligibleCircuits: false, contributedCircuitIds: ["c"] } })).toBe("stay");
  expect(continueAfterSignIn({ ...ready, hasPendingContribution: true })).toBe("stay");
  expect(continueAfterSignIn({ ...ready, canContribute: false })).toBe("stay");
  expect(continueAfterSignIn({ ...ready, eligibilityError: true })).toBe("stay");
  expect(continueAfterSignIn({ ...ready, activity: "error" })).toBe("stay");
});
