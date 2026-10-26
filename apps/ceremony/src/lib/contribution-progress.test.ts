import { expect, it } from "vitest";
import { workerProgress } from "./contribution-progress";

it("shows measured byte progress for download and separate integrity checks", () => {
  expect(workerProgress("download", 42, false)).toMatchObject({
    phase: "downloading",
    percent: 42,
    label: "Downloading artifact",
  });
  expect(workerProgress("validate", 5, false)).toMatchObject({
    phase: "downloading",
    percent: 5,
    label: "Checking downloaded artifact integrity",
  });
  expect(workerProgress("validate", 5, true)).toMatchObject({
    phase: "computing",
    percent: 5,
    label: "Checking input integrity after computation",
  });
  expect(workerProgress("hash", 62, true)).toMatchObject({
    phase: "computing",
    percent: 62,
    label: "Hashing your contribution for upload",
  });
});
it("never presents start/end-only computation events as frozen percentages", () => {
  for (const percent of [0, 50, 100])
    expect(workerProgress("compute", percent, true)?.percent).toBeNull();
  expect(workerProgress("download", NaN, false)?.percent).toBeNull();
  expect(workerProgress("done", 100, true)).toBeNull();
});
it("keeps heartbeat progress forward through successive checks", () => {
  const events = [
    ["download", 100, false],
    ["validate", 0, false],
    ["validate", 100, false],
    ["compute", 0, true],
    ["compute", 100, true],
    ["validate", 0, true],
    ["validate", 100, true],
    ["hash", 0, true],
    ["hash", 100, true],
  ] as const;
  const values = events.map(
    ([stage, percent, computed]) =>
      workerProgress(stage, percent, computed)!.heartbeatPercent,
  );
  expect(values).toEqual([...values].sort((a, b) => a - b));
});
