// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const crypto = vi.hoisted(() => ({ removeBrowserContributionFile: vi.fn(async (_name: string) => undefined) }));
vi.mock("@wonderland/cabure-crypto/browser", () => crypto);

import {
  abandonAttemptOnUnload,
  cancelAttempt,
  getContributionLockName,
  settleAbandonedAttempt,
  type ParticipantStateResponse,
} from "./api";

const JOURNALS = "moss.phase2.contribution-journals.v1";
const PARTICIPANT = "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169";
const OTHER = "24e98dbb-d0f7-8ec4-8c44-e89dfd15e169";
const OUTPUT = "cabure-phase2-1234-abcd.zkey";
const DELETE_URL = "https://coordinator.test/v1/ceremonies/moss/queue/me";

const fetchMock = vi.fn();
let deleteResponse: () => Response;

function journal(participantId: string, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, ceremonyId: "ceremony-1", participantId, updatedAt: new Date().toISOString(), ...extra };
}
function storedJournals(): Array<Record<string, unknown>> {
  return JSON.parse(localStorage.getItem(JOURNALS) ?? "[]");
}
function deletes() {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
}
function state(lease: string | null, queue: ParticipantStateResponse["queue"] = null): ParticipantStateResponse {
  return {
    ceremonyId: "ceremony-1", participantId: PARTICIPANT, queue, submission: null,
    lease: lease === null ? null : {
      leaseId: "lease-1", state: lease, expiresAt: new Date(Date.now() + 60_000).toISOString(), baseGeneration: 1,
      expectedContributionName: "participant",
      predecessor: { sha256: "11".repeat(32), byteLength: 100, downloadUrl: "https://coordinator.test/head" },
    },
  };
}
function stubLocks(held: string[] | null) {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: held === null ? undefined : {
      query: vi.fn(async () => ({ held: held.map((name) => ({ name, mode: "exclusive" })) })),
      request: vi.fn(async (name: string, _options: unknown, task: (lock: unknown) => unknown) =>
        await task(held.includes(name) ? null : { name, mode: "exclusive" })),
    },
  });
}

beforeEach(() => {
  // Node's own localStorage shadows jsdom's, so stub a plain one.
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
  crypto.removeBrowserContributionFile.mockClear();
  fetchMock.mockReset();
  deleteResponse = () => new Response(null, { status: 204 });
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/ceremony/bootstrap") {
      return Response.json({ coordinatorBaseUrl: "https://coordinator.test", manifest: { payload: { ceremonyId: "ceremony-1", slug: "moss" } } });
    }
    if (url === "/api/ceremony/auth/token") {
      return Response.json({ token: "participant-token", participantId: PARTICIPANT, expiresAt: Date.now() / 1_000 + 3_600 });
    }
    if (url === DELETE_URL && init?.method === "DELETE") return deleteResponse();
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem(JOURNALS, JSON.stringify([
    journal(OTHER, { leaseId: "other-lease" }),
    journal(PARTICIPANT, { leaseId: "lease-1", claimedLeaseId: "lease-1", outputFileName: OUTPUT }),
  ]));
});
afterEach(() => {
  vi.unstubAllGlobals();
  stubLocks(null);
});

describe("cancelling an attempt", () => {
  it("releases the slot and removes the saved output and journal entry", async () => {
    expect(await cancelAttempt()).toBe("cancelled");
    expect(deletes()).toHaveLength(1);
    expect(crypto.removeBrowserContributionFile).toHaveBeenCalledWith(OUTPUT);
    expect(storedJournals().map((row) => row.participantId)).toEqual([OTHER]);
  });

  it("keeps everything when the coordinator already has the contribution", async () => {
    deleteResponse = () => Response.json(
      { error: "cancellation unavailable: the contribution is already submitted for verification" },
      { status: 409 },
    );
    expect(await cancelAttempt()).toBe("submitted");
    expect(crypto.removeBrowserContributionFile).not.toHaveBeenCalled();
    expect(storedJournals()).toHaveLength(2);
  });
});

describe("closing the page", () => {
  it("sends a keepalive cancel with the cached token, without waiting on the network", async () => {
    expect(await getContributionLockName()).toBe(`moss-phase2-contribution:ceremony-1:${PARTICIPANT}`);
    fetchMock.mockClear();
    abandonAttemptOnUnload();
    const [[url, init]] = deletes();
    expect(String(url)).toBe(DELETE_URL);
    expect(init).toMatchObject({ method: "DELETE", keepalive: true, credentials: "omit" });
    expect(new Headers((init as RequestInit).headers).get("authorization")).toBe("Bearer participant-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(crypto.removeBrowserContributionFile).toHaveBeenCalledWith(OUTPUT);
    // Only the claim marker stays, so the next visit can explain the cancellation.
    const own = storedJournals().find((row) => row.participantId === PARTICIPANT)!;
    expect(own.claimedLeaseId).toBe("lease-1");
    expect(own.outputFileName).toBeUndefined();
    expect(own.leaseId).toBeUndefined();
  });
});

describe("settling an abandoned attempt", () => {
  it("never cancels while another tab holds the contribution lock", async () => {
    stubLocks([`moss-phase2-contribution:ceremony-1:${PARTICIPANT}`]);
    expect(await settleAbandonedAttempt(state("ACTIVE"))).toBe("running");
    expect(deletes()).toHaveLength(0);
    expect(crypto.removeBrowserContributionFile).not.toHaveBeenCalled();
    expect(storedJournals()).toHaveLength(2);
  });

  it("cancels a slot this browser claimed once no tab holds the lock, and sweeps worker files", async () => {
    stubLocks([]);
    const removeEntry = vi.fn(async (_name: string) => undefined);
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        getDirectory: async () => ({
          removeEntry,
          async *keys() {
            yield "cabure-phase2-99aa.input.zkey";
            yield "cabure-phase2-99aa.zkey";
            yield "unrelated.bin";
          },
        }),
      },
    });
    expect(await settleAbandonedAttempt(state("ACTIVE"))).toBe("cancelled");
    expect(deletes()).toHaveLength(1);
    expect(crypto.removeBrowserContributionFile).toHaveBeenCalledWith(OUTPUT);
    expect(storedJournals().map((row) => row.participantId)).toEqual([OTHER]);
    expect(removeEntry.mock.calls.map(([name]) => name)).toEqual(["cabure-phase2-99aa.input.zkey", "cabure-phase2-99aa.zkey"]);
  });

  it("falls back to the server expiry without Web Locks", async () => {
    stubLocks(null);
    expect(await settleAbandonedAttempt(state("ACTIVE"))).toBe("unknown");
    expect(deletes()).toHaveLength(0);
    expect(storedJournals()).toHaveLength(2);
  });

  it("cleans up a journal whose slot is no longer active", async () => {
    stubLocks(null);
    expect(await settleAbandonedAttempt(state("CANCELLED"))).toBe("cancelled");
    expect(deletes()).toHaveLength(0);
    expect(crypto.removeBrowserContributionFile).toHaveBeenCalledWith(OUTPUT);
    expect(storedJournals().map((row) => row.participantId)).toEqual([OTHER]);
  });

  it("leaves a live queue place alone", async () => {
    stubLocks([]);
    expect(await settleAbandonedAttempt(state(null, { ticketId: "t", status: "QUEUED", position: 2, offer: null }))).toBe("none");
    expect(deletes()).toHaveLength(0);
    expect(storedJournals()).toHaveLength(2);
  });
});
