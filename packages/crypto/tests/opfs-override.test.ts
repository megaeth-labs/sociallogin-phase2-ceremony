import { afterEach, describe, expect, it, vi } from "vitest";
const probe = vi.hoisted(() => vi.fn());
vi.mock("../src/browserContribution.js", () => ({ getBrowserContributionCapabilities: probe }));
vi.mock("../src/worker/opfs-contribute.js", () => ({ contributeOpfsFiles: vi.fn(), contributeBellmanOpfsFiles: vi.fn() }));
import { runOpfsContributionJob } from "../src/worker/opfs-job.js";
const source = { kind: "download" as const, url: "https://example.com/input", expectedSize: 100, expectedSha256: `0x${"a".repeat(64)}` };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("explicit readiness override", () => {
  it("still blocks failed estimates without opt-in", async () => {
    probe.mockResolvedValue({ supported: false, reasons: ["insufficient-opfs-quota"] });
    await expect(runOpfsContributionJob(source, new Uint8Array(32), "test")).rejects.toMatchObject({ code: "BROWSER_CONTRIBUTION_UNAVAILABLE" });
  });
  it("tries actual storage instead of trusting a failed estimate after opt-in", async () => {
    const getDirectory = vi.fn().mockRejectedValue(new Error("actual storage unavailable"));
    vi.stubGlobal("navigator", { storage: { getDirectory } });
    await expect(runOpfsContributionJob(source, new Uint8Array(32), "test", undefined, "bellman", true)).rejects.toThrow("actual storage unavailable");
    expect(probe).not.toHaveBeenCalled();
    expect(getDirectory).toHaveBeenCalledOnce();
  });
  it("does not bypass artifact metadata validation", async () => {
    await expect(runOpfsContributionJob({ ...source, expectedSha256: "invalid" }, new Uint8Array(32), "test", undefined, "bellman", true)).rejects.toMatchObject({ code: "INVALID_ARTIFACT_METADATA" });
  });
});
