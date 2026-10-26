import { afterEach, describe, expect, it, vi } from "vitest";
import { getBrowserContributionCapabilities } from "../src/browserContribution.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(result: boolean | "timeout" | "error" = true) {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { storage: {
    getDirectory: vi.fn(), estimate: async () => ({ quota: 2e9, usage: 0 }),
  } });
  // Window exposes file handles but not the worker-only sync method.
  vi.stubGlobal("FileSystemFileHandle", { prototype: {} });
  const terminate = vi.fn();
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:capability-test");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal("Worker", class {
    onmessage?: (event: { data: boolean }) => void;
    onerror?: (event: { preventDefault(): void }) => void;
    terminate = terminate;
    constructor() {
      if (result !== "timeout") queueMicrotask(() => {
        if (result === "error") this.onerror?.({ preventDefault() {} });
        else this.onmessage?.({ data: result });
      });
    }
  });
  return { terminate, create, revoke };
}

describe("worker-only OPFS capability detection", () => {
  it("accepts worker support even when Window has no sync-access method", async () => {
    const mocks = setup();
    const result = await getBrowserContributionCapabilities({ inputSizeBytes: 368440348 });
    expect(result.supported).toBe(true);
    expect(result.syncAccessHandles).toBe(true);
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(mocks.revoke).toHaveBeenCalledWith("blob:capability-test");
  });
  it.each([false, "error"] as const)("fails closed on worker result %s", async (value) => {
    const mocks = setup(value);
    expect((await getBrowserContributionCapabilities()).reasons).toContain("opfs-sync-access-unavailable");
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(mocks.revoke).toHaveBeenCalledOnce();
  });
  it("times out and cleans up a stalled worker", async () => {
    vi.useFakeTimers();
    const mocks = setup("timeout");
    const pending = getBrowserContributionCapabilities();
    await vi.advanceTimersByTimeAsync(10000);
    expect((await pending).supported).toBe(false);
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(mocks.revoke).toHaveBeenCalledOnce();
  });
  it("does not spawn another worker when already in a supported worker", async () => {
    const mocks = setup();
    vi.stubGlobal("FileSystemFileHandle", { prototype: { createSyncAccessHandle() {} } });
    expect((await getBrowserContributionCapabilities()).supported).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("fails closed when creating a worker is blocked", async () => {
    const mocks = setup();
    vi.stubGlobal("Worker", class { constructor() { throw Error("blocked"); } });
    expect((await getBrowserContributionCapabilities()).supported).toBe(false);
    expect(mocks.revoke).toHaveBeenCalledOnce();
  });
});
