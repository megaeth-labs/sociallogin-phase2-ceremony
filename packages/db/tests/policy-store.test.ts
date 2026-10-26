import { describe, expect, it } from "vitest";

import { transcriptEventHash, type CeremonyManifestV1, type TranscriptEventV1, type VerificationReportV1 } from "@moss/phase2-protocol";

import {
  PgCeremonyStore,
  type AcceptanceInput,
  type PgClientLike,
  type PgPoolLike,
  type QueryResult,
} from "../src/index.js";

describe("PgCeremonyStore transactions", () => {
  it("rolls back queue admission when the ceremony is closed", async () => {
    const statements: string[] = [];
    const client: PgClientLike = {
      async query<Row>(text: string): Promise<QueryResult<Row>> {
        statements.push(text.trim());
        if (text.includes("SELECT state FROM ceremonies")) return { rows: [{ state: "SEALED" } as Row], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    const pool: PgPoolLike = { connect: async () => client, query: client.query.bind(client) };
    const store = new PgCeremonyStore(pool, { production: false });
    await expect(store.joinQueue({
      ticketId: "123e4567-e89b-42d3-a456-426614174000",
      ceremonyId: "223e4567-e89b-42d3-a456-426614174000",
      participantId: "323e4567-e89b-42d3-a456-426614174000",
      authSubjectHash: "1".repeat(64),
      publicPseudonym: "tester",
      idempotencyKey: "0123456789abcdef",
    })).rejects.toThrow(/not open/u);
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it.each([
    ["rehearsal", true, true],
    ["rehearsal", false, false],
    ["production", true, false],
    [undefined, true, false],
  ])("repeat admission with purpose=%s and opt-in=%s", async (purpose, allowRehearsal, allowed) => {
    const client: PgClientLike = {
      async query<Row>(text: string): Promise<QueryResult<Row>> {
        if (text.includes("SELECT state FROM ceremonies")) return { rows: [{ state: "OPEN" } as Row], rowCount: 1 };
        if (text.includes("JOIN participants")) return { rows: [{} as Row], rowCount: 1 };
        if (text.includes("INSERT INTO participants")) return { rows: [{ id: "participant" } as Row], rowCount: 1 };
        if (text.includes("INSERT INTO queue_tickets")) return { rows: [{ id: "ticket", ceremony_id: "ceremony", participant_id: "participant", status: "QUEUED", enqueued_at: new Date() } as Row], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    const store = new PgCeremonyStore({ connect: async () => client, query: client.query.bind(client) }, {
      production: true, allowRehearsal,
      trustedManifest: { ceremonyId: "ceremony", purpose } as CeremonyManifestV1,
    });
    const attempt = store.joinQueue({ ticketId: "ticket", ceremonyId: "ceremony", participantId: "participant", authSubjectHash: "a".repeat(64), publicPseudonym: "tester", idempotencyKey: "fresh-attempt" });
    if (allowed) await expect(attempt).resolves.toMatchObject({ status: "QUEUED" });
    else await expect(attempt).rejects.toThrow(/already contributed/);
  });

  it("rejects acceptance under the ceremony row lock once seals_at is reached", async () => {
    const statements: string[] = [];
    const client: PgClientLike = {
      async query<Row>(text: string): Promise<QueryResult<Row>> {
        statements.push(text.trim());
        if (text.includes("FROM ceremonies WHERE id = $1 FOR UPDATE")) {
          return { rows: [{
            id: CEREMONY_ID,
            state: "OPEN",
            seals_at: "2026-07-30T12:00:00.000Z",
            before_seal: false,
          } as Row], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const pool: PgPoolLike = { connect: async () => client, query: client.query.bind(client) };
    const store = new PgCeremonyStore(pool, { production: false });
    await expect(store.acceptVerifiedSubmission({
      ceremonyId: CEREMONY_ID,
    } as AcceptanceInput)).rejects.toThrow(/acceptance deadline has passed/u);
    expect(statements[1]).toContain("clock_timestamp() < seals_at AS before_seal");
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it("rechecks seals_at in the canonical-head CAS and rolls back a boundary crossing", async () => {
    const fixture = acceptanceFixture();
    const statements: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client: PgClientLike = {
      async query<Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
        statements.push({ text: text.trim(), values });
        if (text.includes("FROM ceremonies WHERE id = $1 FOR UPDATE")) {
          return { rows: [fixture.ceremony as Row], rowCount: 1 };
        }
        if (text.includes("FROM submissions s JOIN leases")) {
          return { rows: [fixture.submission as Row], rowCount: 1 };
        }
        if (text.includes("FROM verification_reports")) {
          return { rows: [{
            payload: fixture.report,
            signature: "development-signature",
            operator_key_id: fixture.report.operatorKeyId,
            job_id: fixture.report.jobId,
            job_attempt: fixture.report.jobAttempt,
          } as Row], rowCount: 1 };
        }
        if (text.includes("UPDATE ceremonies") && text.includes("head_generation")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: text.startsWith("INSERT") ? 1 : 0 };
      },
    };
    const pool: PgPoolLike = { connect: async () => client, query: client.query.bind(client) };
    const store = new PgCeremonyStore(pool, { production: false });
    await expect(store.acceptVerifiedSubmission(fixture.input)).rejects.toThrow(
      /canonical head compare-and-swap failed/u,
    );
    const cas = statements.find(({ text }) =>
      text.includes("UPDATE ceremonies") && text.includes("head_generation"));
    expect(cas?.text).toContain("AND clock_timestamp() < seals_at");
    expect(cas?.text).toContain("seals_at = $9::timestamptz");
    expect(cas?.values?.[8]).toBeNull();
    expect(statements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("refuses a receipt whose client provenance differs from the submission", async () => {
    // The receipt is public and auditors use it to count how many
    // contributions depended on the served web bundle. It must say what the
    // submission recorded, not whatever the signer chose — relabelling a
    // browser contribution as CLI would hide exactly the exposure it reports.
    for (const tamper of [
      { clientKind: "browser" as const },
      { clientReleaseSha256: "8".repeat(64) },
      { clientReleaseSha256: null },
    ]) {
      const fixture = acceptanceFixture();
      const input = { ...fixture.input, receipt: { ...fixture.input.receipt, ...tamper } };
      const client: PgClientLike = {
        async query<Row>(text: string): Promise<QueryResult<Row>> {
          if (text.includes("FROM ceremonies WHERE id = $1 FOR UPDATE")) {
            return { rows: [fixture.ceremony as Row], rowCount: 1 };
          }
          if (text.includes("FROM submissions s JOIN leases")) {
            return { rows: [fixture.submission as Row], rowCount: 1 };
          }
          if (text.includes("FROM verification_reports")) {
            return { rows: [{
              payload: fixture.report,
              signature: "development-signature",
              operator_key_id: fixture.report.operatorKeyId,
              job_id: fixture.report.jobId,
              job_attempt: fixture.report.jobAttempt,
            } as Row], rowCount: 1 };
          }
          return { rows: [], rowCount: text.startsWith("INSERT") ? 1 : 0 };
        },
      };
      const pool: PgPoolLike = { connect: async () => client, query: client.query.bind(client) };
      const store = new PgCeremonyStore(pool, { production: false });
      await expect(store.acceptVerifiedSubmission(input)).rejects.toThrow(
        /not bound to the accepted transition/u,
      );
    }
  });
});

describe("acceptance after verifier retries", () => {
  it("accepts a fresh unanimous retry while retaining earlier process errors", async () => {
    const fixture = acceptanceFixture();
    fixture.ceremony.verifier_policy = {
      operatorKeyIds: ["operator-one", "operator-two"], requiredOperators: 2, passesPerOperator: 2,
    };
    const error = failedReport(fixture.report, "error");
    const valid = fixture.ceremony.verifier_policy.operatorKeyIds.flatMap((operatorKeyId) =>
      [1, 2].map((passNumber) => ({ ...fixture.report, operatorKeyId, passNumber, jobAttempt: 2 })));
    const harness = acceptanceHarness(fixture, [error, ...valid]);

    await expect(harness.store.acceptVerifiedSubmission(fixture.input)).resolves.toBeUndefined();
    expect(harness.statements.at(-1)?.text).toBe("COMMIT");
    expect(harness.statements.some(({ text }) => text.includes("INSERT INTO contributions"))).toBe(true);
    expect(harness.statements.some(({ text }) => /DELETE FROM verification_reports/u.test(text))).toBe(false);
  });

  it("does not count an error report toward the required passes", async () => {
    const fixture = acceptanceFixture();
    fixture.ceremony.verifier_policy.passesPerOperator = 2;
    const error = { ...failedReport(fixture.report, "error"), passNumber: 2 };
    const harness = acceptanceHarness(fixture, [error, { ...fixture.report, jobAttempt: 2 }]);

    await expect(harness.store.acceptVerifiedSubmission(fixture.input)).rejects.toThrow(/policy is not satisfied/u);
    expect(harness.statements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("retains an invalid verdict as a veto even if a later report says valid", async () => {
    const fixture = acceptanceFixture();
    // An invalid verdict may have observed the expected metadata and failed
    // the algebraic check. Matching metadata must not let it be ignored.
    const invalid: VerificationReportV1 = {
      ...fixture.report, result: "invalid", errorCode: "VERIFY_FAILED",
      checks: { ...fixture.report.checks, verifyFromInit: false },
    };
    const harness = acceptanceHarness(fixture, [invalid, { ...fixture.report, jobAttempt: 2 }]);

    await expect(harness.store.acceptVerifiedSubmission(fixture.input)).rejects.toThrow(/rejects candidate/u);
    expect(harness.statements.at(-1)?.text).toBe("ROLLBACK");
    expect(harness.statements.some(({ text }) => text.includes("INSERT INTO contributions"))).toBe(false);
  });

  it("still checks the expected binding of retained error reports", async () => {
    const fixture = acceptanceFixture();
    const error = { ...failedReport(fixture.report, "error"), expectedContributionName: "another-participant" };
    const harness = acceptanceHarness(fixture, [error, { ...fixture.report, jobAttempt: 2 }]);

    await expect(harness.store.acceptVerifiedSubmission(fixture.input)).rejects.toThrow(/not bound/u);
    expect(harness.statements.at(-1)?.text).toBe("ROLLBACK");
  });
});

describe("transactional contribution limit", () => {
  it("does not offer a lease when a concurrent acceptance filled the last slot", async () => {
    const fixture = acceptanceFixture();
    fixture.ceremony.head_generation = fixture.ceremony.maximum_contributions;
    const harness = offerHarness(fixture);

    await expect(harness.store.issueNextOffer(offerInput())).resolves.toBeNull();
    expect(harness.statements.some(({ text }) => text.includes("INSERT INTO leases"))).toBe(false);
    expect(harness.statements.at(-1)?.text).toBe("COMMIT");
  });

  it("offers the last available slot from the locked head", async () => {
    const fixture = acceptanceFixture();
    fixture.ceremony.head_generation = fixture.ceremony.maximum_contributions - 1;
    const harness = offerHarness(fixture);

    const lease = await harness.store.issueNextOffer(offerInput());
    expect(lease?.baseGeneration).toBe(fixture.ceremony.head_generation);
    const lock = harness.statements.findIndex(({ text }) => text.includes("FROM ceremonies WHERE id = $1 FOR UPDATE"));
    const mutation = harness.statements.findIndex(({ text }) => text.startsWith("UPDATE leases"));
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(mutation);
  });

  it("rejects an over-limit acceptance even when the caller bypasses offer issuance", async () => {
    const fixture = acceptanceFixture(26);
    const harness = acceptanceHarness(fixture, [fixture.report]);

    await expect(harness.store.acceptVerifiedSubmission(fixture.input)).rejects.toThrow(/contribution limit/u);
    expect(harness.statements.at(-1)?.text).toBe("ROLLBACK");
    expect(harness.statements.some(({ text }) => text.includes("INSERT INTO contributions"))).toBe(false);
  });

  it("accepts the final permitted contribution and rechecks the limit in the CAS", async () => {
    const fixture = acceptanceFixture();
    fixture.ceremony.maximum_contributions = 1;
    const harness = acceptanceHarness(fixture, [fixture.report]);

    await expect(harness.store.acceptVerifiedSubmission(fixture.input)).resolves.toBeUndefined();
    const cas = harness.statements.find(({ text }) => text.includes("UPDATE ceremonies") && text.includes("head_generation"));
    expect(cas?.text).toContain("AND head_generation < $10");
    expect(cas?.text).toContain("manifest->'contributionPolicy'->>'maximumContributions'");
    expect(cas?.values?.[9]).toBe(1);
    expect(harness.statements.at(-1)?.text).toBe("COMMIT");
  });

  it("rejects a database limit that differs from the signed policy for offers and acceptance", async () => {
    const fixture = acceptanceFixture();
    const trustedManifest = {
      ceremonyId: CEREMONY_ID,
      schedule: { sealsAt: fixture.ceremony.seals_at },
      contributionPolicy: { maximumContributions: 1 },
    } as CeremonyManifestV1;
    const offer = offerHarness(fixture, trustedManifest);
    const acceptance = acceptanceHarness(fixture, [fixture.report], trustedManifest);

    await expect(offer.store.issueNextOffer(offerInput())).rejects.toThrow(/limit does not match the signed manifest/u);
    await expect(acceptance.store.acceptVerifiedSubmission(fixture.input)).rejects.toThrow(/limit does not match the signed manifest/u);
  });

  it.each([null, undefined, 0, -1, 1.5, "NaN"])("fails closed with an invalid persisted limit (%s)", async (limit) => {
    const fixture = acceptanceFixture();
    Object.assign(fixture.ceremony, { maximum_contributions: limit });
    const harness = offerHarness(fixture);
    await expect(harness.store.issueNextOffer(offerInput())).rejects.toThrow(/limit/u);
    expect(harness.statements.at(-1)?.text).toBe("ROLLBACK");
  });
});

describe("verification report authorization", () => {
  it("rejects a valid Bellman report for a zkey epoch", async () => {
    const fixture = acceptanceFixture();
    const report = structuredClone(fixture.report);
    report.verificationMethod = "bellman-transition-v1";
    report.observedContributionName = null;
    report.checks.verifyFromInit = false;
    report.checks.bellmanTransition = true;
    const harness = reportHarness(fixture, { jobLive: true });
    await expect(harness.store.recordVerificationReport({ id: "723e4567-e89b-42d3-a456-426614174000", report, signature: "new-signature" })).rejects.toThrow(/not bound/u);
    expect(harness.statements.some(({ text }) => text.includes("INSERT INTO verification_reports"))).toBe(false);
  });

  it("binds signed expected contribution metadata to the submission lease", async () => {
    const fixture = acceptanceFixture();
    const report = structuredClone(fixture.report);
    report.expectedContributionName = "different-participant";
    report.observedContributionName = "different-participant";
    const harness = reportHarness(fixture, { jobLive: true });
    await expect(harness.store.recordVerificationReport({
      id: "723e4567-e89b-42d3-a456-426614174000",
      report,
      signature: "new-signature",
    })).rejects.toThrow(/not bound/u);
    expect(harness.statements.some(({ text }) => text.includes("INSERT INTO verification_reports"))).toBe(false);
    const bindingQuery = harness.statements.find(({ text }) =>
      text.includes("SELECT s.candidate_sha256,s.ceremony_id,s.predecessor_sha256"));
    expect(bindingQuery?.text).toContain("j.job_id=$3 AND j.attempt=$4");
    expect(bindingQuery?.values).toEqual([
      report.submissionId,
      report.operatorKeyId,
      report.jobId,
      report.jobAttempt,
    ]);
  });

  it("allows only an identical no-op retry after the exact job lease expires", async () => {
    const fixture = acceptanceFixture();
    const harness = reportHarness(fixture, {
      jobLive: false,
      existing: { payload: fixture.report, signature: "same-signature", result: "valid" },
    });
    await expect(harness.store.recordVerificationReport({
      id: "723e4567-e89b-42d3-a456-426614174000",
      report: fixture.report,
      signature: "same-signature",
    })).resolves.toBeUndefined();
    expect(harness.statements.some(({ text }) => text.includes("INSERT INTO verification_reports"))).toBe(false);

    const changed = structuredClone(fixture.report);
    changed.completedAt = "2026-07-30T11:59:59.001Z";
    const rejected = reportHarness(fixture, {
      jobLive: false,
      existing: { payload: fixture.report, signature: "same-signature", result: "valid" },
    });
    await expect(rejected.store.recordVerificationReport({
      id: "823e4567-e89b-42d3-a456-426614174000",
      report: changed,
      signature: "changed-signature",
    })).rejects.toThrow(/stale|conflicts/u);
  });

  it("upgrades an error only while the same attempt remains live", async () => {
    const fixture = acceptanceFixture();
    const errorReport = structuredClone(fixture.report);
    errorReport.result = "error";
    errorReport.checks = {
      objectHash: true,
      framing: false,
      exactPrefix: false,
      exactlyOneContribution: false,
      contributionMetadata: false,
      contributionHash: false,
      verifyFromInit: false,
    };
    errorReport.observedContributionName = null;
    errorReport.observedContributionHashBlake2b512 = null;
    errorReport.observedContributionIndex = null;
    errorReport.errorCode = "VERIFIER_PROCESS_ERROR";
    const harness = reportHarness(fixture, {
      jobLive: true,
      existing: { payload: errorReport, signature: "error-signature", result: "error" },
    });
    await expect(harness.store.recordVerificationReport({
      id: "923e4567-e89b-42d3-a456-426614174000",
      report: fixture.report,
      signature: "valid-signature",
    })).resolves.toBeUndefined();
    const insert = harness.statements.find(({ text }) => text.includes("INSERT INTO verification_reports"));
    expect(insert?.text).toContain("j.lease_until>clock_timestamp()");
    expect(insert?.text).toContain("ON CONFLICT (submission_id, operator_key_id, job_id, job_attempt, pass_number)");

    const expired = reportHarness(fixture, {
      jobLive: false,
      existing: { payload: errorReport, signature: "error-signature", result: "error" },
    });
    await expect(expired.store.recordVerificationReport({
      id: "a23e4567-e89b-42d3-a456-426614174000",
      report: fixture.report,
      signature: "valid-signature",
    })).rejects.toThrow(/stale|conflicts/u);
  });
});

const CEREMONY_ID = "223e4567-e89b-42d3-a456-426614174000";
const SUBMISSION_ID = "423e4567-e89b-42d3-a456-426614174000";

function acceptanceFixture(generation = 1) {
  const predecessorSha256 = "1".repeat(64);
  const candidateSha256 = "2".repeat(64);
  const contributionHash = "3".repeat(128);
  const acceptedAt = "2026-07-30T11:59:59.000Z";
  const event: TranscriptEventV1 = {
    schemaVersion: 1,
    ceremonyId: CEREMONY_ID,
    sequence: generation,
    previousEventHash: "0".repeat(64),
    eventType: "CONTRIBUTION_ACCEPTED",
    payload: {
      submissionId: SUBMISSION_ID,
      generation,
      predecessorSha256,
      successorSha256: candidateSha256,
      contributionHashBlake2b512: contributionHash,
      contributionName: "moss-participant",
      clientKind: "cli",
      clientReleaseSha256: "7".repeat(64),
    },
    createdAt: acceptedAt,
  };
  const eventHash = transcriptEventHash(event);
  const report: VerificationReportV1 = {
    schemaVersion: 1,
    type: "moss.phase2.verification-report.v1",
    ceremonyId: CEREMONY_ID,
    submissionId: SUBMISSION_ID,
    jobId: "523e4567-e89b-42d3-a456-426614174000",
    jobAttempt: 1,
    predecessorSha256,
    candidateSha256,
    genesisSha256: "4".repeat(64),
    expectedContributionName: "moss-participant",
    expectedContributionHashBlake2b512: contributionHash,
    expectedContributionIndex: generation,
    observedContributionName: "moss-participant",
    observedContributionHashBlake2b512: contributionHash,
    observedContributionIndex: generation,
    operatorKeyId: "operator-one",
    verifierImageDigest: "development",
    snarkjsVersion: "0.7.6",
    passNumber: 1,
    checks: {
      objectHash: true,
      framing: true,
      exactPrefix: true,
      exactlyOneContribution: true,
      contributionMetadata: true,
      contributionHash: true,
      verifyFromInit: true,
    },
    result: "valid",
    startedAt: acceptedAt,
    completedAt: acceptedAt,
  };
  const input: AcceptanceInput = {
    ceremonyId: CEREMONY_ID,
    submissionId: SUBMISSION_ID,
    canonicalArtifact: {
      sha256: candidateSha256,
      byteLength: 101,
      storageBackend: "local",
      objectKey: "canonical/candidate.zkey",
      storageVersionId: candidateSha256,
    },
    contributionHash,
    contributionName: "moss-participant",
    acceptedAt,
    event,
    eventHash,
    eventSignature: "development-signature",
    receipt: {
      schemaVersion: 1,
      type: "moss.phase2.receipt.v1",
      ceremonyId: CEREMONY_ID,
      relationManifestSha256: "5".repeat(64),
      sequence: generation,
      generation,
      predecessor: { sha256: predecessorSha256, byteLength: 100, urls: ["https://example.test/previous"] },
      successor: { sha256: candidateSha256, byteLength: 101, urls: ["https://example.test/candidate"] },
      contributionIndex: generation,
      contributionName: "moss-participant",
      contributionHashBlake2b512: contributionHash,
      participantPseudonym: "alice",
      clientKind: "cli",
      clientReleaseSha256: "7".repeat(64),
      acceptedAt,
      transcriptEventHash: eventHash,
    },
    receiptSignature: "development-signature",
    outboxId: "523e4567-e89b-42d3-a456-426614174000",
  };
  return {
    ceremony: {
      id: CEREMONY_ID,
      state: "OPEN",
      seals_at: "2026-07-30T12:00:00.000Z",
      before_seal: true,
      maximum_contributions: 25,
      verifier_policy: { operatorKeyIds: [report.operatorKeyId], requiredOperators: 1, passesPerOperator: 1 },
      head_generation: generation - 1,
      head_sha256: predecessorSha256,
      head_byte_length: 100,
      event_sequence: generation - 1,
      event_hash: event.previousEventHash,
      revision: 0,
    },
    submission: {
      id: SUBMISSION_ID,
      lease_id: "623e4567-e89b-42d3-a456-426614174000",
      participant_id: "323e4567-e89b-42d3-a456-426614174000",
      predecessor_sha256: predecessorSha256,
      candidate_sha256: candidateSha256,
      candidate_byte_length: 101,
      claimed_contribution_hash: contributionHash,
      state: "VERIFYING",
      expected_contribution_name: "moss-participant",
      base_generation: generation - 1,
      lease_state: "VERIFYING",
      public_pseudonym: "alice",
      client_kind: "cli",
      client_release_sha256: "7".repeat(64),
    },
    report,
    input,
  };
}

function failedReport(report: VerificationReportV1, result: "error" | "invalid"): VerificationReportV1 {
  return {
    ...report, result, errorCode: "VERIFIER_PROCESS_ERROR",
    observedContributionName: null,
    observedContributionHashBlake2b512: null,
    observedContributionIndex: null,
    checks: { ...report.checks, framing: false, exactPrefix: false, exactlyOneContribution: false,
      contributionMetadata: false, contributionHash: false, verifyFromInit: false },
  };
}

function acceptanceHarness(
  fixture: ReturnType<typeof acceptanceFixture>,
  reports: VerificationReportV1[],
  trustedManifest?: CeremonyManifestV1,
) {
  const statements: Array<{ text: string; values?: readonly unknown[] }> = [];
  const client: PgClientLike = {
    async query<Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
      statements.push({ text: text.trim(), values });
      if (text.includes("FROM ceremonies WHERE id = $1 FOR UPDATE")) return { rows: [fixture.ceremony as Row], rowCount: 1 };
      if (text.includes("FROM submissions s JOIN leases")) return { rows: [fixture.submission as Row], rowCount: 1 };
      if (text.includes("FROM verification_reports")) return {
        rows: reports.map((report) => ({ payload: report, signature: "development-signature",
          operator_key_id: report.operatorKeyId, job_id: report.jobId, job_attempt: report.jobAttempt }) as Row),
        rowCount: reports.length,
      };
      return { rows: [], rowCount: /^(?:INSERT|UPDATE)/u.test(text.trim()) ? 1 : 0 };
    },
  };
  const pool: PgPoolLike = { connect: async () => client, query: client.query.bind(client) };
  return { store: new PgCeremonyStore(pool, { production: false, trustedManifest }), statements };
}

function offerInput() {
  return { ceremonyId: CEREMONY_ID, leaseId: "623e4567-e89b-42d3-a456-426614174000",
    capabilityHash: "6".repeat(64), expiresAt: "2026-07-30T11:59:59.000Z" };
}

function offerHarness(fixture: ReturnType<typeof acceptanceFixture>, trustedManifest?: CeremonyManifestV1) {
  const statements: Array<{ text: string; values?: readonly unknown[] }> = [];
  const client: PgClientLike = {
    async query<Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
      statements.push({ text: text.trim(), values });
      if (text.includes("FROM ceremonies WHERE id = $1 FOR UPDATE")) return { rows: [fixture.ceremony as Row], rowCount: 1 };
      if (text.includes("SELECT id, participant_id FROM queue_tickets")) return {
        rows: [{ id: "723e4567-e89b-42d3-a456-426614174000", participant_id: fixture.submission.participant_id } as Row], rowCount: 1,
      };
      if (text.includes("INSERT INTO leases")) return { rows: [{
        id: offerInput().leaseId, ceremony_id: CEREMONY_ID, participant_id: fixture.submission.participant_id,
        state: "OFFERED", base_generation: fixture.ceremony.head_generation,
        predecessor_sha256: fixture.ceremony.head_sha256, predecessor_byte_length: fixture.ceremony.head_byte_length,
        expected_contribution_name: "moss-participant", expires_at: offerInput().expiresAt,
      } as Row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const pool: PgPoolLike = { connect: async () => client, query: client.query.bind(client) };
  return { store: new PgCeremonyStore(pool, { production: false, trustedManifest }), statements };
}

function reportHarness(
  fixture: ReturnType<typeof acceptanceFixture>,
  options: {
    jobLive: boolean;
    existing?: { payload: VerificationReportV1; signature: string; result: VerificationReportV1["result"] };
  },
) {
  const statements: Array<{ text: string; values?: readonly unknown[] }> = [];
  const client: PgClientLike = {
    async query<Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
      statements.push({ text: text.trim(), values });
      if (text.includes("SELECT s.candidate_sha256,s.ceremony_id,s.predecessor_sha256")) {
        return { rows: [{
          candidate_sha256: fixture.submission.candidate_sha256,
          ceremony_id: CEREMONY_ID,
          predecessor_sha256: fixture.submission.predecessor_sha256,
          claimed_contribution_hash: fixture.submission.claimed_contribution_hash,
          expected_contribution_name: fixture.submission.expected_contribution_name,
          base_generation: fixture.submission.base_generation,
          genesis_sha256: fixture.report.genesisSha256,
          verifier_policy: { operatorKeyIds: [fixture.report.operatorKeyId], requiredOperators: 1, passesPerOperator: 1 },
          verifier_keys: [{
            keyId: fixture.report.operatorKeyId,
            verifierImageDigest: fixture.report.verifierImageDigest,
          }],
          job_live: options.jobLive,
        } as Row], rowCount: 1 };
      }
      if (text.includes("SELECT payload,signature,result FROM verification_reports")) {
        return options.existing
          ? { rows: [options.existing as Row], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO verification_reports")) return { rows: [{} as Row], rowCount: 1 };
      return { rows: [], rowCount: text.startsWith("UPDATE") ? 1 : 0 };
    },
  };
  const pool: PgPoolLike = { connect: async () => client, query: client.query.bind(client) };
  return { store: new PgCeremonyStore(pool, { production: false }), statements };
}

it("does not offer a hosted lease until the exact head has a witness acknowledgement", async () => {
  const statements: string[] = [];
  const manifest = { ceremonyId: CEREMONY_ID, contributionPolicy: { maximumContributions: 3 },
    publication: { witness: { keyId: "witness", algorithm: "Ed25519", publicKeyPem: "unused until an acknowledgement exists" }, endpoint: "https://witness.example" } } as CeremonyManifestV1;
  const client: PgClientLike = { async query<Row>(text: string): Promise<QueryResult<Row>> {
    statements.push(text);
    if (text.includes("FROM ceremonies WHERE id = $1 FOR UPDATE")) return { rows: [{ id: CEREMONY_ID, state: "OPEN", head_generation: 1,
      maximum_contributions: 3, event_sequence: 1, event_hash: "a".repeat(64) } as Row], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const store = new PgCeremonyStore({ connect: async () => client, query: client.query.bind(client) }, { production: true, trustedManifest: manifest });
  await expect(store.issueNextOffer({ ceremonyId: CEREMONY_ID, leaseId: "unused", capabilityHash: "unused", expiresAt: "2030-01-01T00:00:00.000Z" })).resolves.toBeNull();
  expect(statements.some((s) => s.includes("ceremony_publications"))).toBe(true);
  expect(statements.some((s) => s.includes("INSERT INTO leases"))).toBe(false);
});

it.each([["rehearsal", true], ["production", false]] as const)("keeps primary-archive %s offers blocked until a matching signed checkpoint exists", async (purpose, allowRehearsal) => {
  const manifest = { ceremonyId: CEREMONY_ID, purpose, contributionPolicy: { maximumContributions: 10 },
    primaryPublication: { archiveBaseUrl: "https://archive.example/" }, coordinatorKeys: [] } as unknown as CeremonyManifestV1;
  let corrupted = false;
  const statements: string[] = [];
  const client: PgClientLike = { async query<Row>(text: string): Promise<QueryResult<Row>> {
    statements.push(text);
    if (text.includes("FROM ceremonies WHERE id = $1 FOR UPDATE")) return { rows: [{ id: CEREMONY_ID, state: "OPEN", head_generation: 1,
      maximum_contributions: 10, event_sequence: 1, event_hash: "a".repeat(64) } as Row], rowCount: 1 };
    if (corrupted && text.includes("SELECT acknowledgement")) return { rows: [{ acknowledgement: { keyId: "untrusted" } } as Row], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const store = new PgCeremonyStore({ connect: async () => client, query: client.query.bind(client) }, { production: true, allowRehearsal, trustedManifest: manifest });
  const offer = { ceremonyId: CEREMONY_ID, leaseId: "unused", capabilityHash: "unused", expiresAt: "2030-01-01T00:00:00.000Z" };
  await expect(store.issueNextOffer(offer)).resolves.toBeNull();
  corrupted = true;
  await expect(store.issueNextOffer(offer)).rejects.toThrow(/signer/);
  expect(statements.some(s => s.includes("INSERT INTO leases"))).toBe(false);
});
