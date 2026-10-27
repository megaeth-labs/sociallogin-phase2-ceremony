import { describe, expect, it } from "vitest";

import {
  abandonedAttemptPlan,
  activeLeaseFromState,
  heartbeatClientIntervalMs,
  parseParticipantState,
  queueOfferClaimed,
  shouldStartFreshBrowserAttempt,
} from "./api";

describe("heartbeatClientIntervalMs", () => {
  it("sends comfortably inside the coordinator's signed maximum gap", () => {
    expect(heartbeatClientIntervalMs(15)).toBe(5_000);
    expect(heartbeatClientIntervalMs(20)).toBe(5_000);
    expect(heartbeatClientIntervalMs(300)).toBe(5_000);
  });

  it("retains a one-second lower bound and rejects malformed policy", () => {
    expect(heartbeatClientIntervalMs(1)).toBe(1_000);
    expect(() => heartbeatClientIntervalMs(0)).toThrow(/invalid/i);
    expect(() => heartbeatClientIntervalMs(1.5)).toThrow(/invalid/i);
  });
});

describe("parseParticipantState", () => {
  it("accepts the participant-scoped accepted-submission recovery contract", () => {
    const expiry = new Date(Date.now() + 60_000).toISOString();
    expect(parseParticipantState({
      ceremonyId: "ceremony-1",
      participantId: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169",
      queue: null,
      lease: {
        leaseId: "lease-1",
        state: "ACCEPTED",
        submissionId: "submission-1",
        expiresAt: expiry,
        baseGeneration: 2,
        expectedContributionName: "participant",
        predecessor: {
          sha256: "11".repeat(32),
          byteLength: 100,
          downloadUrl: "http://127.0.0.1:8787/artifacts/head.zkey",
        },
      },
      submission: {
        submissionId: "submission-1",
        state: "ACCEPTED",
        receiptId: "receipt-1",
      },
    })).toMatchObject({
      queue: null,
      lease: { leaseId: "lease-1" },
      submission: { receiptId: "receipt-1" },
    });
  });

  it("rejects cross-linked state with a different submission", () => {
    const expiry = new Date(Date.now() + 60_000).toISOString();
    expect(() => parseParticipantState({
      ceremonyId: "ceremony-1",
      participantId: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169",
      queue: null,
      lease: {
        leaseId: "lease-1",
        state: "VERIFYING",
        submissionId: "submission-1",
        expiresAt: expiry,
        baseGeneration: 0,
        expectedContributionName: "participant",
        predecessor: {
          sha256: "11".repeat(32),
          byteLength: 100,
          downloadUrl: "http://127.0.0.1:8787/artifacts/head.zkey",
        },
      },
      submission: { submissionId: "submission-2", state: "VERIFYING" },
    })).toThrow(/disagree/i);
  });
});

describe("shouldStartFreshBrowserAttempt", () => {
  const offer = {
    leaseId: "lease-1",
    state: "ACTIVE",
    expiresAt: "2026-07-30T12:10:00.000Z",
    baseGeneration: 2,
    expectedContributionName: "moss-participant",
    predecessor: {
      sha256: "11".repeat(32),
      byteLength: 100,
      downloadUrl: "http://127.0.0.1:8787/artifacts/head.zkey",
    },
  };
  const base = {
    ceremonyId: "ceremony-1",
    participantId: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169",
    queue: null,
    lease: null,
    submission: null,
  };

  it.each(["EXPIRED", "REJECTED", "STALE", "CANCELLED"])(
    "starts a fresh attempt after a terminal %s lease with no submission",
    (state) => {
      expect(shouldStartFreshBrowserAttempt({
        ...base,
        lease: { ...offer, state },
      })).toBe(true);
    },
  );

  it("starts fresh when no coordinator attempt remains", () => {
    expect(shouldStartFreshBrowserAttempt(base)).toBe(true);
  });

  it("preserves every live or recoverable coordinator attempt", () => {
    expect(shouldStartFreshBrowserAttempt({
      ...base,
      lease: offer,
    })).toBe(false);
    expect(shouldStartFreshBrowserAttempt({
      ...base,
      queue: {
        ticketId: "ticket-1",
        status: "QUEUED",
        position: 1,
        offer: null,
      },
    })).toBe(false);
    expect(shouldStartFreshBrowserAttempt({
      ...base,
      lease: { ...offer, state: "VERIFYING", submissionId: "submission-1" },
      submission: { submissionId: "submission-1", state: "VERIFYING" },
    })).toBe(false);
  });
});


describe("rehearsal repeat recovery", () => {
  it("allows a new accepted attempt only during rehearsal and never replaces in-flight work", () => {
    const state = { ceremonyId: "ceremony", participantId: "participant", queue: null, lease: null,
      submission: { submissionId: "submission", state: "ACCEPTED", receiptId: "receipt" } };
    expect(shouldStartFreshBrowserAttempt(state)).toBe(false);
    expect(shouldStartFreshBrowserAttempt(state, true)).toBe(true);
    for (const status of ["SUBMITTED", "VERIFYING", "VERIFIED"]) {
      expect(shouldStartFreshBrowserAttempt({ ...state, submission: { ...state.submission, state: status } }, true)).toBe(false);
    }
  });
});

describe("claimed slots", () => {
  const offer = {
    leaseId: "lease-1", expiresAt: "2026-10-23T13:30:00.000Z", baseGeneration: 1,
    expectedContributionName: "participant",
    predecessor: { sha256: "11".repeat(32), byteLength: 100, downloadUrl: "https://a.test/head" },
  };
  it("treats a LEASED ticket's offer as already claimed", () => {
    expect(queueOfferClaimed({ status: "LEASED", offer })).toBe(true);
    expect(queueOfferClaimed({ status: "OFFERED", offer })).toBe(false);
    expect(queueOfferClaimed({ status: "LEASED", offer: null })).toBe(false);
  });
  it("recovers a failed claim only as the same ACTIVE lease", () => {
    const state = { ceremonyId: "c", participantId: "p", queue: null, submission: null, lease: { ...offer, state: "ACTIVE" } };
    expect(activeLeaseFromState(state, "lease-1")).toBe(state.lease);
    expect(activeLeaseFromState(state, "lease-2")).toBeNull();
    expect(activeLeaseFromState({ ...state, lease: { ...offer, state: "EXPIRED" } }, "lease-1")).toBeNull();
    expect(activeLeaseFromState({ ...state, lease: null }, "lease-1")).toBeNull();
  });
});

describe("abandonedAttemptPlan", () => {
  const lease = {
    leaseId: "lease-1", expiresAt: "2026-10-23T13:30:00.000Z", baseGeneration: 1,
    expectedContributionName: "participant",
    predecessor: { sha256: "11".repeat(32), byteLength: 100, downloadUrl: "https://a.test/head" },
  };
  const active = { ceremonyId: "c", participantId: "p", queue: null, submission: null, lease: { ...lease, state: "ACTIVE" } };

  it("cancels a slot this browser claimed only when no tab holds the lock", () => {
    expect(abandonedAttemptPlan({ state: active, claimedLeaseId: "lease-1", lock: "free" }))
      .toEqual({ cancel: true, discard: true, outcome: "cancelled" });
    expect(abandonedAttemptPlan({ state: active, claimedLeaseId: "lease-1", lock: "held" }))
      .toEqual({ cancel: false, discard: false, outcome: "running" });
  });

  it("never auto-cancels without Web Locks or for a slot claimed elsewhere", () => {
    for (const [claimedLeaseId, lock] of [["lease-1", "unsupported"], [null, "free"], ["lease-0", "free"]] as const) {
      expect(abandonedAttemptPlan({ state: active, claimedLeaseId, lock }))
        .toEqual({ cancel: false, discard: false, outcome: "unknown" });
    }
  });

  it("never touches a submitted, verifying or accepted contribution", () => {
    for (const state of ["SUBMITTED", "VERIFYING", "ACCEPTED"]) {
      expect(abandonedAttemptPlan({
        state: { ...active, lease: { ...active.lease, state, submissionId: "s" }, submission: { submissionId: "s", state } },
        claimedLeaseId: "lease-1",
        lock: "free",
      })).toEqual({ cancel: false, discard: false, outcome: "none" });
    }
  });

  it("cleans up after a claimed slot that is no longer active", () => {
    expect(abandonedAttemptPlan({
      state: { ...active, lease: { ...active.lease, state: "CANCELLED" } }, claimedLeaseId: "lease-1", lock: "free",
    })).toEqual({ cancel: false, discard: true, outcome: "cancelled" });
    // A submission that failed later is reported on its own, not as a closed page.
    expect(abandonedAttemptPlan({
      state: { ...active, lease: { ...active.lease, state: "REJECTED", submissionId: "s" }, submission: { submissionId: "s", state: "REJECTED" } },
      claimedLeaseId: "lease-1", lock: "unsupported",
    })).toEqual({ cancel: false, discard: true, outcome: "none" });
  });

  it("leaves a live queue place and other browsers' attempts alone", () => {
    const queued = { ...active, lease: null, queue: { ticketId: "t", status: "QUEUED", position: 2, offer: null } };
    expect(abandonedAttemptPlan({ state: queued, claimedLeaseId: "lease-1", lock: "free" }))
      .toEqual({ cancel: false, discard: false, outcome: "none" });
    // Another tab of this browser is waiting in that place.
    expect(abandonedAttemptPlan({ state: queued, claimedLeaseId: null, lock: "held" }))
      .toEqual({ cancel: false, discard: false, outcome: "running" });
    expect(abandonedAttemptPlan({ state: { ...active, lease: null }, claimedLeaseId: null, lock: "free" }))
      .toEqual({ cancel: false, discard: false, outcome: "none" });
  });
});
