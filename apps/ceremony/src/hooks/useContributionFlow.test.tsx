// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientCircuitConfig } from "@/lib/ceremony-config";

const api = vi.hoisted(() => ({
  abandonAttemptOnUnload: vi.fn(),
  cancelAttempt: vi.fn(),
  claimOffer: vi.fn(),
  getContributionArtifactFormat: vi.fn(),
  getContributionLockName: vi.fn(),
  getHeartbeatIntervalMs: vi.fn(),
  getQueuePosition: vi.fn(),
  getStatus: vi.fn(),
  heartbeatLease: vi.fn(),
  journalContributionEvidence: vi.fn(),
  joinQueue: vi.fn(),
  submitContribution: vi.fn(),
  uploadZkey: vi.fn(),
}));
const locks = vi.hoisted(() => ({
  acquireContributionLock: vi.fn(),
  release: vi.fn(),
}));
const worker = vi.hoisted(() => ({ runContribution: vi.fn() }));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/contribution-lock", () => ({ acquireContributionLock: locks.acquireContributionLock }));
vi.mock("@/hooks/useParticipant", () => ({
  useParticipant: () => ({ participantId: "participant-1" }),
}));
vi.mock("@wonderland/cabure-crypto/browser", () => ({
  getBrowserContributionCapabilities: vi.fn(),
  removeBrowserContributionFile: vi.fn(async () => undefined),
  requestPersistentBrowserStorage: vi.fn(async () => true),
}));
vi.mock("@/lib/worker-client", () => worker);

import { ALREADY_OPEN_ELSEWHERE, useContributionFlow } from "./useContributionFlow";
import { DOWNLOAD_SLOT_RELEASED, UPLOAD_SLOT_RELEASED, UPLOAD_TOO_SLOW } from "@/lib/contribution-progress";

const circuits = [{ id: "relation", label: "Relation" }] as ClientCircuitConfig[];
const offer = {
  leaseId: "lease-1",
  expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
  baseGeneration: 3,
  expectedContributionName: "participant",
  predecessor: { sha256: "11".repeat(32), byteLength: 100, downloadUrl: "https://a.test/head" },
};
const lease = { ...offer, state: "ACTIVE" };
const receipt = { receiptId: "receipt-1", circuitId: "relation" };
const output = new Blob([new Uint8Array(200)]);
const computed = {
  outputFile: { getFile: async () => output },
  outputFileName: "cabure-phase2-1234.zkey",
  outputSize: output.size,
  contributionHash: "ab".repeat(64),
  zkeyHash: "cd".repeat(32),
};

function queue(offerClaimed = false) {
  return { participantId: "participant-1", circuitId: "relation", position: 1, estimatedWaitSeconds: 0, offer, offerClaimed };
}

// Most tests drive the claim by hand; the auto-claim tests opt in.
function render({ autoClaim = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => useContributionFlow({
      overrideFailedCheck: true,
      entropySeed: new Uint8Array(32),
      selectedCircuitIds: ["relation"],
      circuits,
      active: true,
      autoClaim,
    }),
    { wrapper },
  );
}

async function joinAndWaitForOffer(result: ReturnType<typeof render>["result"]) {
  await act(async () => {
    await result.current.joinAndStart({ circuitIds: ["relation"] }, circuits);
  });
  await waitFor(() => expect(result.current.offer).not.toBeNull());
}

const closePage = () => window.dispatchEvent(new Event("pagehide"));
const never = () => new Promise<never>(() => undefined);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED", "true");
  for (const mock of [...Object.values(api), ...Object.values(locks), worker.runContribution]) mock.mockReset();
  locks.acquireContributionLock.mockResolvedValue({ supported: true, release: locks.release });
  api.getContributionLockName.mockResolvedValue("moss-phase2-contribution:c:participant-1");
  api.cancelAttempt.mockResolvedValue("cancelled");
  api.joinQueue.mockResolvedValue({ positions: [queue()] });
  api.getQueuePosition.mockResolvedValue(queue());
  api.claimOffer.mockResolvedValue(lease);
  api.getHeartbeatIntervalMs.mockResolvedValue(60_000);
  api.heartbeatLease.mockResolvedValue(undefined);
  api.journalContributionEvidence.mockResolvedValue(undefined);
  api.uploadZkey.mockResolvedValue("upload-1");
  worker.runContribution.mockResolvedValue(computed);
});
afterEach(() => vi.unstubAllEnvs());

describe("closing the page cancels the attempt", () => {
  it("gives up the queue place when closed while waiting", async () => {
    const { result } = render();
    await joinAndWaitForOffer(result);
    closePage();
    expect(api.abandonAttemptOnUnload).toHaveBeenCalledTimes(1);
  });

  it("gives up a claimed slot when closed before submission", async () => {
    worker.runContribution.mockImplementation(never);
    const { result } = render();
    await joinAndWaitForOffer(result);
    act(() => result.current.claim());
    await waitFor(() => expect(worker.runContribution).toHaveBeenCalled());
    closePage();
    closePage();
    expect(api.abandonAttemptOnUnload).toHaveBeenCalledTimes(1);
  });

  it("does not cancel once the contribution is handed over for verification", async () => {
    api.submitContribution.mockImplementation(never);
    const { result } = render();
    await joinAndWaitForOffer(result);
    act(() => result.current.claim());
    await waitFor(() => expect(result.current.submitted).toBe(true));
    expect(result.current.contributionPhase).toBe("verifying");
    closePage();
    expect(api.abandonAttemptOnUnload).not.toHaveBeenCalled();
  });

  it("does not cancel after an accepted contribution, and releases the lock", async () => {
    api.submitContribution.mockResolvedValue(receipt);
    const { result } = render();
    await joinAndWaitForOffer(result);
    act(() => result.current.claim());
    await waitFor(() => expect(result.current.finalizeReady).toBe(true));
    closePage();
    expect(api.abandonAttemptOnUnload).not.toHaveBeenCalled();
    expect(locks.release).toHaveBeenCalled();
  });

  it("cannot start while another tab holds the contribution lock", async () => {
    locks.acquireContributionLock.mockResolvedValue(null);
    const { result } = render();
    await act(async () => {
      await expect(result.current.joinAndStart({ circuitIds: ["relation"] }, circuits))
        .rejects.toThrow(ALREADY_OPEN_ELSEWHERE);
    });
    expect(api.joinQueue).not.toHaveBeenCalled();
    closePage();
    expect(api.abandonAttemptOnUnload).not.toHaveBeenCalled();
  });
});

describe("claiming a slot automatically", () => {
  it("starts the contribution as soon as a slot is offered", async () => {
    worker.runContribution.mockImplementation(never);
    const { result, unmount } = render({ autoClaim: true });
    await act(async () => {
      await result.current.joinAndStart({ circuitIds: ["relation"] }, circuits);
    });
    await waitFor(() => expect(api.claimOffer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(worker.runContribution).toHaveBeenCalled());
    expect(result.current.claiming).toBe(true);
    unmount();
  });

  it("does not claim a slot another tab or browser already holds", async () => {
    api.joinQueue.mockResolvedValue({ positions: [queue(true)] });
    api.getQueuePosition.mockResolvedValue(queue(true));
    const { result, unmount } = render({ autoClaim: true });
    await joinAndWaitForOffer(result);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(api.claimOffer).not.toHaveBeenCalled();
    unmount();
  });

  it("claims each offer once, and never again after that attempt fails", async () => {
    api.uploadZkey.mockRejectedValueOnce(new Error("Upload interrupted"));
    const { result, unmount } = render({ autoClaim: true });
    await act(async () => {
      await result.current.joinAndStart({ circuitIds: ["relation"] }, circuits);
    });
    await waitFor(() => expect(result.current.contributionError).toBe("Upload interrupted"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(api.claimOffer).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("a slot released during the download", () => {
  it("explains a slot lost while the file was downloading", async () => {
    api.getHeartbeatIntervalMs.mockResolvedValue(10);
    api.heartbeatLease
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("lease is unavailable or expired"));
    worker.runContribution.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
    const { result, unmount } = render();
    await joinAndWaitForOffer(result);
    act(() => result.current.claim());
    await waitFor(() => expect(result.current.contributionError).toBe(DOWNLOAD_SLOT_RELEASED));
    unmount();
  });
});

describe("uploads", () => {
  it("reports upload bytes with each heartbeat", async () => {
    api.getHeartbeatIntervalMs.mockResolvedValue(10);
    let finishUpload: (value: string) => void = () => undefined;
    api.uploadZkey.mockImplementation(({ onProgress }: { onProgress: (uploaded: number, total: number) => void }) => {
      onProgress(50, 200);
      return new Promise((resolve) => { finishUpload = resolve; });
    });
    const { result, unmount } = render();
    await joinAndWaitForOffer(result);
    act(() => result.current.claim());
    await waitFor(() => expect(api.heartbeatLease).toHaveBeenCalledWith(
      "lease-1", expect.objectContaining({ phase: "uploading", uploadedBytes: 50, totalBytes: 200 }), expect.anything()));
    expect(result.current.contributionProgress).toBeCloseTo(86.75);
    finishUpload("upload-1");
    unmount();
  });

  it("stops an upload that cannot finish before the slot's deadline", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    api.uploadZkey.mockImplementation(({ onProgress, signal }: { onProgress: (uploaded: number, total: number) => void; signal: AbortSignal }) => {
      now += 10 * 60_000;
      onProgress(1, 1_000);
      return Promise.reject(signal.reason);
    });
    const { result, unmount } = render();
    await joinAndWaitForOffer(result);
    act(() => result.current.claim());
    await waitFor(() => expect(result.current.contributionError).toBe(UPLOAD_TOO_SLOW));
    expect(api.cancelAttempt).toHaveBeenCalled();
    clock.mockRestore();
    unmount();
  });

  it("explains a slot lost while uploading", async () => {
    api.getHeartbeatIntervalMs.mockResolvedValue(10);
    api.heartbeatLease
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("lease is unavailable or expired"));
    api.uploadZkey.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
    const { result, unmount } = render();
    await joinAndWaitForOffer(result);
    act(() => result.current.claim());
    await waitFor(() => expect(result.current.contributionError).toBe(UPLOAD_SLOT_RELEASED));
    unmount();
  });
});

describe("an ended queue place", () => {
  const ended = () => new Error("queue ticket not found");
  // The place stays gone until the participant joins again.
  const endPlaceUntilJoin = () => {
    api.getQueuePosition.mockRejectedValue(ended());
    api.joinQueue.mockImplementation(async () => {
      api.getQueuePosition.mockResolvedValue(queue());
      return { positions: [queue()] };
    });
  };

  it("waits for a click to rejoin after a missed turn, instead of cycling", async () => {
    const { result, unmount } = render();
    await joinAndWaitForOffer(result);
    endPlaceUntilJoin();
    await waitFor(() => expect(result.current.turnMissed).toBe(true), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    expect(api.joinQueue).toHaveBeenCalledTimes(1);

    act(() => result.current.rejoin());
    await waitFor(() => expect(result.current.turnMissed).toBe(false));
    expect(api.joinQueue).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.offer).not.toBeNull());
    unmount();
  }, 15_000);

  it("rejoins by itself only after an explicit retry of a failed attempt", async () => {
    api.uploadZkey.mockRejectedValueOnce(new Error("Upload interrupted"));
    const { result, unmount } = render();
    await joinAndWaitForOffer(result);
    act(() => result.current.claim());
    await waitFor(() => expect(result.current.contributionError).toBe("Upload interrupted"));
    expect(api.joinQueue).toHaveBeenCalledTimes(1);

    endPlaceUntilJoin();
    act(() => result.current.retry());
    await waitFor(() => expect(api.joinQueue).toHaveBeenCalledTimes(2));
    expect(result.current.turnMissed).toBe(false);
    unmount();
  });
});

describe("failed and cancelled attempts", () => {
  it("releases a failed claimed slot and rejoins the queue on retry, never resuming it", async () => {
    api.uploadZkey.mockRejectedValueOnce(new Error("Upload interrupted"));
    const { result } = render();
    await joinAndWaitForOffer(result);
    act(() => result.current.claim());
    await waitFor(() => expect(result.current.contributionError).toBe("Upload interrupted"));
    expect(api.cancelAttempt).toHaveBeenCalledTimes(1);
    expect(result.current.submitted).toBe(false);
    closePage();
    expect(api.abandonAttemptOnUnload).not.toHaveBeenCalled();

    const polls = api.getQueuePosition.mock.calls.length;
    act(() => result.current.retry());
    await waitFor(() => expect(api.getQueuePosition.mock.calls.length).toBeGreaterThan(polls));
    expect(result.current.contributionError).toBeNull();
    expect(api.claimOffer).toHaveBeenCalledTimes(1);
    closePage();
    expect(api.abandonAttemptOnUnload).toHaveBeenCalledTimes(1);
  });

  it("never releases a slot whose contribution was already submitted", async () => {
    api.submitContribution.mockRejectedValueOnce(new Error("Timed out waiting for independent contribution verification."));
    const { result } = render();
    await joinAndWaitForOffer(result);
    act(() => result.current.claim());
    await waitFor(() => expect(result.current.contributionError).not.toBeNull());
    expect(result.current.submitted).toBe(true);
    expect(api.cancelAttempt).not.toHaveBeenCalled();
  });

  it("reports a refused cancel so the page can show the verification instead", async () => {
    api.cancelAttempt.mockResolvedValueOnce("submitted");
    const { result } = render();
    await joinAndWaitForOffer(result);
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.cancel();
    });
    expect(outcome).toBe("submitted");
    expect(locks.release).toHaveBeenCalled();
    closePage();
    expect(api.abandonAttemptOnUnload).not.toHaveBeenCalled();
  });

  it("does not claim a slot another tab or browser already holds", async () => {
    api.joinQueue.mockResolvedValue({ positions: [queue(true)] });
    api.getQueuePosition.mockResolvedValue(queue(true));
    const { result } = render();
    await joinAndWaitForOffer(result);
    await waitFor(() => expect(result.current.queueError).toMatch(/another tab or browser/));
    act(() => result.current.claim());
    expect(api.claimOffer).not.toHaveBeenCalled();
  });
});
