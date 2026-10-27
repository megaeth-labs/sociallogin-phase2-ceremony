import { describe, expect, it } from "vitest";
import { parseLeaseProgress } from "../src/lease-progress.js";

describe("heartbeat progress", () => {
  it("reads the browser's download share of its overall percent", () => {
    expect(parseLeaseProgress({ phase: "downloading", percent: 0 })).toEqual({ stage: "downloading", downloadFraction: 0 });
    expect(parseLeaseProgress({ phase: "downloading", percent: 7.5 })).toEqual({ stage: "downloading", downloadFraction: 0.5 });
    // Past 15 the browser is checking a file it already downloaded.
    expect(parseLeaseProgress({ phase: "downloading", percent: 17 })).toEqual({ stage: "other", downloadFraction: null });
    expect(parseLeaseProgress({ phase: "computing", percent: 40 })).toEqual({ stage: "computing", downloadFraction: null });
    expect(parseLeaseProgress({ phase: "uploading", percent: 85 })).toEqual({ stage: "uploading", downloadFraction: null });
  });

  it("reads the CLI's byte counts", () => {
    expect(parseLeaseProgress({ stage: "DOWNLOADING", receivedBytes: 92_110_183, totalBytes: 368_440_732 }))
      .toEqual({ stage: "downloading", downloadFraction: 0.25 });
    expect(parseLeaseProgress({ stage: "COMPUTING" })).toEqual({ stage: "computing", downloadFraction: null });
    expect(parseLeaseProgress({ stage: "CLAIMED" })).toEqual({ stage: "other", downloadFraction: null });
  });

  it("treats malformed or missing reports as no report", () => {
    for (const body of [undefined, null, "x", [], {}, { phase: 3 }, { stage: 1 }]) {
      expect(parseLeaseProgress(body)).toBeNull();
    }
    expect(parseLeaseProgress({ phase: "downloading", percent: Number.NaN })).toEqual({ stage: "downloading", downloadFraction: null });
    expect(parseLeaseProgress({ stage: "DOWNLOADING", receivedBytes: 5, totalBytes: 0 })).toEqual({ stage: "downloading", downloadFraction: null });
    expect(parseLeaseProgress({ stage: "DOWNLOADING", receivedBytes: 9, totalBytes: 3 })).toEqual({ stage: "downloading", downloadFraction: 1 });
  });
});
