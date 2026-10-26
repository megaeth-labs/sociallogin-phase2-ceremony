import { describe, expect, it } from "vitest";

import {
  durableUploadRecoveryAction,
  shouldResetAttemptJournal,
} from "./contribute.js";

const evidence = {
  manifestSha256: "11".repeat(32),
  predecessorSha256: "22".repeat(32),
  predecessorByteLength: 100,
  successorSha256: "33".repeat(32),
  successorByteLength: 200,
  contributionHashBlake2b512: "44".repeat(64),
  contributionName: "moss-participant",
  baseGeneration: 2,
  participantPseudonym: "participant",
};

describe("durableUploadRecoveryAction", () => {
  it("finishes an ingested local upload and directly submits a completed one", () => {
    const base = {
      uploadId: "upload-1",
      expiresAt: "2026-07-30T12:10:00.000Z",
      artifact: {
        sha256: evidence.successorSha256,
        byteLength: evidence.successorByteLength,
      },
    };
    expect(durableUploadRecoveryAction({ ...base, state: "UPLOADING" }, evidence))
      .toBe("complete");
    expect(durableUploadRecoveryAction({ ...base, state: "COMPLETED" }, evidence))
      .toBe("submit");
  });

  it("returns null before bytes are durable and rejects mismatched bytes", () => {
    expect(durableUploadRecoveryAction({
      uploadId: "upload-1",
      state: "INITIATED",
      expiresAt: "2026-07-30T12:10:00.000Z",
    }, evidence)).toBeNull();
    expect(() => durableUploadRecoveryAction({
      uploadId: "upload-1",
      state: "UPLOADING",
      expiresAt: "2026-07-30T12:10:00.000Z",
      artifact: { sha256: "55".repeat(32), byteLength: 200 },
    }, evidence)).toThrow(/differs/u);
  });
});

describe("shouldResetAttemptJournal", () => {
  const base = {
    ceremonyId: "ceremony-1",
    participantId: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169",
    queue: null,
    lease: null,
    submission: null,
  };

  it("resets stale idempotency and evidence after a pre-submission attempt ends", () => {
    expect(shouldResetAttemptJournal(base)).toBe(true);
    expect(shouldResetAttemptJournal({
      ...base,
      lease: {
        leaseId: "lease-1",
        state: "EXPIRED",
        expiresAt: "2026-07-30T12:10:00.000Z",
        baseGeneration: 2,
        expectedContributionName: "moss-participant",
        predecessor: {
          sha256: "22".repeat(32),
          byteLength: 100,
          downloadUrl: "http://127.0.0.1:8787/artifact",
        },
      },
    })).toBe(true);
  });

  it("preserves live queue, lease, and submission recovery state", () => {
    expect(shouldResetAttemptJournal({
      ...base,
      queue: { ticketId: "ticket-1", status: "QUEUED", position: 1, offer: null },
    })).toBe(false);
    expect(shouldResetAttemptJournal({
      ...base,
      lease: {
        leaseId: "lease-1",
        state: "ACTIVE",
        expiresAt: "2026-07-30T12:10:00.000Z",
        baseGeneration: 2,
        expectedContributionName: "moss-participant",
        predecessor: {
          sha256: "22".repeat(32),
          byteLength: 100,
          downloadUrl: "http://127.0.0.1:8787/artifact",
        },
      },
    })).toBe(false);
    expect(shouldResetAttemptJournal({
      ...base,
      submission: { submissionId: "submission-1", state: "VERIFYING" },
    })).toBe(false);
  });
});
