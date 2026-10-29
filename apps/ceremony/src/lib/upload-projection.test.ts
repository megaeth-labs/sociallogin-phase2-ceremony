import { describe, expect, it } from "vitest";
import { projectedUploadMisses } from "./contribution-progress";

const start = 1_000_000;
const minute = 60_000;
const deadline = start + 20 * minute;

describe("upload projection", () => {
  it("never judges the first minute", () => {
    expect(projectedUploadMisses({ startedAt: start, now: start + 30_000, uploaded: 1, total: 1_000, deadline })).toBe(false);
  });
  it("stops an upload that would end after the slot's deadline", () => {
    // 10% in 5 minutes projects 50 minutes.
    expect(projectedUploadMisses({ startedAt: start, now: start + 5 * minute, uploaded: 100, total: 1_000, deadline })).toBe(true);
  });
  it("keeps an upload that will finish with time to submit", () => {
    // 50% in 2 minutes projects 4 minutes.
    expect(projectedUploadMisses({ startedAt: start, now: start + 2 * minute, uploaded: 500, total: 1_000, deadline })).toBe(false);
  });
  it("stops an upload that has sent nothing for 90 seconds", () => {
    expect(projectedUploadMisses({ startedAt: start, now: start + 80_000, uploaded: 0, total: 1_000, deadline })).toBe(false);
    expect(projectedUploadMisses({ startedAt: start, now: start + 90_000, uploaded: 0, total: 1_000, deadline })).toBe(true);
  });
});
