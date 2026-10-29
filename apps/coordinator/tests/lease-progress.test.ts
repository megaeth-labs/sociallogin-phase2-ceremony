import { describe, expect, it } from "vitest";
import { parseLeaseProgress } from "../src/lease-progress.js";

describe("heartbeat progress", () => {
  it("reads the browser's download share of its overall percent", () => {
    expect(parseLeaseProgress({ phase: "downloading", percent: 0 })).toEqual({ stage: "downloading", fraction: 0 });
    expect(parseLeaseProgress({ phase: "downloading", percent: 7.5 })).toEqual({ stage: "downloading", fraction: 0.5 });
    // Past 15 the browser is checking a file it already downloaded.
    expect(parseLeaseProgress({ phase: "downloading", percent: 17 })).toEqual({ stage: "other", fraction: null });
    expect(parseLeaseProgress({ phase: "computing", percent: 40 })).toEqual({ stage: "computing", fraction: null });
    expect(parseLeaseProgress({ phase: "uploading", percent: 85 })).toEqual({ stage: "uploading", fraction: null });
  });

  it("reads upload byte counts from the browser and the CLI", () => {
    expect(parseLeaseProgress({ phase: "uploading", percent: 88, uploadedBytes: 92_110_183, totalBytes: 368_440_732 }))
      .toEqual({ stage: "uploading", fraction: 0.25 });
    // Releases before this one report no upload bytes, so nothing is judged.
    expect(parseLeaseProgress({ phase: "uploading", percent: 85 })).toEqual({ stage: "uploading", fraction: null });
    expect(parseLeaseProgress({ stage: "UPLOADING", uploadedBytes: 50, totalBytes: 100 })).toEqual({ stage: "uploading", fraction: 0.5 });
  });

  it("reads the CLI's byte counts", () => {
    expect(parseLeaseProgress({ stage: "DOWNLOADING", receivedBytes: 92_110_183, totalBytes: 368_440_732 }))
      .toEqual({ stage: "downloading", fraction: 0.25 });
    expect(parseLeaseProgress({ stage: "COMPUTING" })).toEqual({ stage: "computing", fraction: null });
    expect(parseLeaseProgress({ stage: "CLAIMED" })).toEqual({ stage: "other", fraction: null });
  });

  it("treats malformed or missing reports as no report", () => {
    for (const body of [undefined, null, "x", [], {}, { phase: 3 }, { stage: 1 }]) {
      expect(parseLeaseProgress(body)).toBeNull();
    }
    expect(parseLeaseProgress({ phase: "downloading", percent: Number.NaN })).toEqual({ stage: "downloading", fraction: null });
    expect(parseLeaseProgress({ stage: "DOWNLOADING", receivedBytes: 5, totalBytes: 0 })).toEqual({ stage: "downloading", fraction: null });
    expect(parseLeaseProgress({ stage: "DOWNLOADING", receivedBytes: 9, totalBytes: 3 })).toEqual({ stage: "downloading", fraction: 1 });
  });
});
