import { expect, it } from "vitest";
import { rehearsalReviewEnabled, reviewBackendReady, screenReviewEnabled } from "./rehearsal-review";
it("requires both rehearsal purpose and explicit review opt-in", () => {
  expect(rehearsalReviewEnabled({ CEREMONY_MODE: "rehearsal", REHEARSAL_REVIEW_MODE: "true" })).toBe(true);
  expect(rehearsalReviewEnabled({ CEREMONY_MODE: "production", REHEARSAL_REVIEW_MODE: "true" })).toBe(false);
  expect(rehearsalReviewEnabled({ CEREMONY_MODE: "rehearsal" })).toBe(false);
});
it("requires real closed backend readiness, not merely a successful response", async () => {
  const good = { mode: "review", database: "ready", contributionsEnabled: false, schedule: null, beacon: null };
  expect(await reviewBackendReady("https://backend.example", async () => Response.json(good))).toBe(true);
  expect(await reviewBackendReady("https://backend.example", async () => Response.json({ ...good, contributionsEnabled: true }))).toBe(false);
  expect(await reviewBackendReady("http://backend.example", async () => Response.json(good))).toBe(false);
  expect(await reviewBackendReady("https://backend.example", async () => { throw new Error("unavailable"); })).toBe(false);
});

it("exposes screen review only for development or rehearsal without reopening contributions", () => {
  expect(screenReviewEnabled({ NODE_ENV: "production", CEREMONY_MODE: "rehearsal" })).toBe(true);
  expect(rehearsalReviewEnabled({ NODE_ENV: "production", CEREMONY_MODE: "rehearsal" })).toBe(false);
  expect(screenReviewEnabled({ NODE_ENV: "production", CEREMONY_MODE: "production" })).toBe(false);
  expect(screenReviewEnabled({})).toBe(false);
  expect(screenReviewEnabled({ NODE_ENV: "development" })).toBe(true);
});
