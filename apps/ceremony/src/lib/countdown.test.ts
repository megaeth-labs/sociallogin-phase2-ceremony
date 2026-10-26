import { describe, expect, it } from "vitest";
import { remainingTime } from "./countdown";

describe("ceremony countdown", () => {
  const end = "2026-09-24T15:30:27Z";
  const timestamp = Date.parse(end);
  it("counts down across days and rounds partial seconds up", () => {
    expect(remainingTime(end, timestamp - 86400000)).toBe("1d 00h 00m 00s");
    expect(remainingTime(end, timestamp - 3661000)).toBe("0d 01h 01m 01s");
    expect(remainingTime(end, timestamp - 1)).toBe("0d 00h 00m 01s");
  });
  it("stops at zero at and after the deadline without going negative", () => {
    expect(remainingTime(end, timestamp)).toBe("0d 00h 00m 00s");
    expect(remainingTime(end, timestamp + 86400000)).toBe("0d 00h 00m 00s");
  });
  it("does not invent a schedule for invalid inputs", () => {
    expect(remainingTime("invalid", timestamp)).toBeNull();
    expect(remainingTime(end, NaN)).toBeNull();
  });
});

import { friendlyRemaining } from "./countdown";
describe("friendlyRemaining", () => {
  const end = "2026-10-14T12:00:00.000Z";
  const t = Date.parse(end);
  it("sizes the countdown to its range", () => {
    expect(friendlyRemaining(end, t - (13 * 86400 + 5 * 3600) * 1000)).toBe("13d 5h");
    expect(friendlyRemaining(end, t - (5 * 3600 + 12 * 60) * 1000)).toBe("5h 12m");
    expect(friendlyRemaining(end, t - 119_000)).toBe("1:59");
    expect(friendlyRemaining(end, t + 5000)).toBe("0:00");
    expect(friendlyRemaining("invalid", t)).toBeNull();
  });
});
