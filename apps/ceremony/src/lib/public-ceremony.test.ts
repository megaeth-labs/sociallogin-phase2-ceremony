import { describe, expect, it } from "vitest";
import { ceremonyStage, claimAvailable, phasePercent } from "./public-ceremony";
import finalization from "@/lib/rehearsal-finalization.json";
import type { StatusResponse } from "./api";
const now = Date.parse("2026-09-24T12:00:00Z");
const status: StatusResponse = {
  ceremonyState: "OPEN",
  isActive: true,
  totalContributions: 2,
  targetContributions: 100,
  endDate: "2026-10-01T12:00:00Z",
  startedAt: now - 1000,
  beaconApplied: false,
  circuits: [],
  headByteLength: 1000,
};
describe("public ceremony lifecycle", () => {
  it("does not turn the deadline or contribution cap into finalization", () => {
    expect(
      ceremonyStage({ ...status, endDate: "2026-09-24T11:00:00Z" }, now),
    ).toBe("sealed");
    expect(
      ceremonyStage(
        { ...status, isActive: false, totalContributions: 100 },
        now,
      ),
    ).toBe("capacity");
    expect(
      ceremonyStage(
        { ...status, ceremonyState: "WAITING_FOR_BEACON", isActive: false },
        now,
      ),
    ).toBe("sealed");
    expect(
      ceremonyStage(
        { ...status, ceremonyState: "FINALIZED", isActive: false },
        now,
      ),
    ).toBe("finalized");
  });
  it("keeps unavailable, paused, cancelled and scheduled ceremonies out of open state", () => {
    expect(ceremonyStage(null, now)).toBe("unavailable");
    for (const state of ["PAUSED", "ABORTED", "CANCELLED"])
      expect(ceremonyStage({ ...status, ceremonyState: state }, now)).toBe(
        "paused",
      );
    expect(ceremonyStage({ ...status, startedAt: now + 1000 }, now)).toBe(
      "scheduled",
    );
    expect(ceremonyStage(status, now)).toBe("open");
  });
});
it("allows a claim only strictly before a valid offer expiry", () => {
  expect(claimAvailable(null, now)).toBe(false);
  expect(claimAvailable("invalid", now)).toBe(false);
  expect(claimAvailable(new Date(now).toISOString(), now)).toBe(false);
  expect(claimAvailable(new Date(now - 1).toISOString(), now)).toBe(false);
  expect(claimAvailable(new Date(now + 1).toISOString(), now)).toBe(true);
});
it("does not invent upload or verification percentages", () => {
  expect(phasePercent("uploading", 85)).toBeNull();
  expect(phasePercent("verifying", 92)).toBeNull();
  expect(phasePercent("downloading", 10)).toBe(50);
  expect(phasePercent("computing", -1)).toBeNull();
  expect(phasePercent("computing", 200)).toBeNull();
  expect(phasePercent("computing", NaN)).toBeNull();
});

it("shows offline finalization without rewriting the coordinator checkpoint state", () => {
  const completed = { ...status, ceremonyState: "SEALED", finalization: finalization.payload };
  expect(ceremonyStage(completed, now)).toBe("finalized");
  expect(completed.ceremonyState).toBe("SEALED");
});
