import { verifyPrimaryPublication, type PrimaryPublication, verifyPublicationAck, type PublicationAck, type SignedEnvelope } from "@moss/phase2-protocol";
import {
  assertReceipt,
  contributionGenesis,
  assertVerificationReport,
  assertVerifierPolicy,
  evaluateVerifierPolicy,
  transcriptEventHash,
  verifyEnvelope,
  VERIFICATION_REPORT_SIGNATURE_DOMAIN,
  RECEIPT_SIGNATURE_DOMAIN,
  TRANSCRIPT_EVENT_SIGNATURE_DOMAIN,
  canonicalize,
  canonicalSha256,
  type CeremonyManifestV1,
  type JsonValue,
  type VerificationReportV1,
} from "@moss/phase2-protocol";

import type {
  AcceptanceInput,
  CeremonyPolicyRow,
  LeaseView,
  PgClientLike,
  PgPoolLike,
  QueueTicketView,
  SubmissionAcceptanceRow,
  SubmissionView,
} from "./types.js";

export interface StoreOptions {
  production: boolean;
  trustedManifest?: CeremonyManifestV1;
  allowRehearsal?: boolean;
}

export class PgCeremonyStore {
  constructor(private readonly pool: PgPoolLike, private readonly options: StoreOptions) {}

  async joinQueue(input: {
    ticketId: string;
    ceremonyId: string;
    participantId: string;
    authSubjectHash: string;
    publicPseudonym: string;
    idempotencyKey: string;
  }): Promise<QueueTicketView> {
    return this.transaction(async (client) => {
      const ceremony = await client.query<{ state: string }>(
        "SELECT state FROM ceremonies WHERE id = $1 FOR SHARE",
        [input.ceremonyId],
      );
      if (ceremony.rows[0]?.state !== "OPEN") throw new Error("ceremony is not open");
      const priorContribution = await client.query(
        `SELECT 1 FROM contributions c JOIN participants p ON p.id=c.participant_id
         WHERE c.ceremony_id=$1 AND p.auth_subject_hash=$2 LIMIT 1`,
        [input.ceremonyId, input.authSubjectHash],
      );
      if ((priorContribution.rowCount ?? priorContribution.rows.length) > 0
          && !(this.options.allowRehearsal === true
            && this.options.trustedManifest?.purpose === "rehearsal"
            && this.options.trustedManifest.ceremonyId === input.ceremonyId)) {
        throw new Error("participant has already contributed to this ceremony");
      }
      const participant = await client.query<{ id: string }>(
        `INSERT INTO participants (id, auth_subject_hash, public_pseudonym)
         VALUES ($1,$2,$3)
         ON CONFLICT (auth_subject_hash) DO UPDATE SET public_pseudonym = EXCLUDED.public_pseudonym
         RETURNING id`,
        [input.participantId, input.authSubjectHash, input.publicPseudonym],
      );
      const participantId = requireRow(participant.rows[0], "participant upsert returned no row").id;
      // The participant upsert serializes joins for the same account. A new
      // request ID (for example, another tab) must reuse its live queue entry
      // without resetting its FIFO position or creating another slot.
      const existing = await client.query<Record<string, unknown>>(
        `SELECT id, ceremony_id, participant_id, status, enqueued_at
         FROM queue_tickets WHERE ceremony_id=$1 AND participant_id=$2
           AND status IN ('QUEUED','OFFERED','LEASED')`,
        [input.ceremonyId, participantId],
      );
      if (existing.rows[0]) return mapTicket(existing.rows[0]);
      const result = await client.query<{
        id: string; ceremony_id: string; participant_id: string; status: string; enqueued_at: Date | string;
      }>(
        `INSERT INTO queue_tickets (id, ceremony_id, participant_id, status, idempotency_key)
         VALUES ($1,$2,$3,'QUEUED',$4)
         ON CONFLICT (ceremony_id, participant_id, idempotency_key)
         DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING id, ceremony_id, participant_id, status, enqueued_at`,
        [input.ticketId, input.ceremonyId, participantId, input.idempotencyKey],
      );
      return mapTicket(requireRow(result.rows[0], "queue ticket insert returned no row"));
    });
  }

  /**
   * Leave the queue or give up a claimed slot, releasing it at once rather
   * than holding everyone behind until the heartbeat lapses. A contribution
   * already submitted for verification cannot be withdrawn.
   */
  async cancelParticipantAttempt(input: { ceremonyId: string; participantId: string }): Promise<void> {
    await this.transaction(async (client) => {
      // Lock the live leases first. A concurrent submission either commits
      // before this and is seen as SUBMITTED, or waits and then finds the
      // lease no longer ACTIVE.
      const live = await client.query<{ id: string; state: string }>(
        `SELECT id, state FROM leases WHERE ceremony_id=$1 AND participant_id=$2
           AND state IN ('OFFERED','ACTIVE','SUBMITTED','VERIFYING') FOR UPDATE`,
        [input.ceremonyId, input.participantId],
      );
      if (live.rows.some((lease) => lease.state === "SUBMITTED" || lease.state === "VERIFYING")) {
        throw new Error("cancellation unavailable: the contribution is already submitted for verification");
      }
      const leaseIds = live.rows.map((lease) => lease.id);
      if (leaseIds.length > 0) {
        await client.query("UPDATE leases SET state='CANCELLED' WHERE id = ANY($1::uuid[])", [leaseIds]);
        await client.query(
          "UPDATE artifact_uploads SET state='EXPIRED' WHERE lease_id = ANY($1::uuid[]) AND state IN ('INITIATED','UPLOADING')",
          [leaseIds],
        );
      }
      const tickets = await client.query(
        `UPDATE queue_tickets SET status='CANCELLED' WHERE ceremony_id=$1 AND participant_id=$2
           AND status IN ('QUEUED','OFFERED','LEASED')`,
        [input.ceremonyId, input.participantId],
      );
      if ((tickets.rowCount ?? 0) === 0) throw new Error("queue ticket not found");
    });
  }

  /**
   * One-based place of a waiting ticket: 1 means next in line. The ticket's own
   * timestamp is read inside SQL because a JavaScript Date drops PostgreSQL's
   * microseconds, which would exclude the ticket from its own count.
   */
  async queuePosition(ceremonyId: string, ticketId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM queue_tickets q, queue_tickets me
       WHERE me.id=$2 AND q.ceremony_id=$1 AND q.status='QUEUED'
         AND (q.enqueued_at,q.id)<=(me.enqueued_at,me.id)`,
      [ceremonyId, ticketId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async issueNextOffer(input: {
    ceremonyId: string;
    leaseId: string;
    capabilityHash: string;
    expiresAt: string;
  }): Promise<LeaseView | null> {
    return this.transaction(async (client) => {
      // Match acceptance's lock order: ceremony first, then leases. Read the
      // contribution limit and head together after any concurrent acceptance.
      const ceremony = await client.query<CeremonyPolicyRow>(
        `SELECT id, state, verifier_policy, head_generation, head_sha256, head_byte_length,
                event_sequence, event_hash, revision,
                manifest->'contributionPolicy'->>'maximumContributions' AS maximum_contributions
         FROM ceremonies WHERE id = $1 FOR UPDATE`,
        [input.ceremonyId],
      );
      const head = ceremony.rows[0];
      if (!head || head.state !== "OPEN") return null;
      if (asNumber(head.head_generation) >= this.maximumContributions(head)) return null;
      if (this.options.production) {
        const publication = this.options.trustedManifest?.publication;
        if (!publication && !this.options.trustedManifest?.primaryPublication) throw new Error("hosted ceremony requires signed publication policy");
        const row = await client.query<{ acknowledgement: SignedEnvelope<PublicationAck> }>(
          "SELECT acknowledgement FROM ceremony_publications WHERE ceremony_id=$1 AND event_sequence=$2 AND event_hash=$3",
          [input.ceremonyId, asNumber(head.event_sequence), head.event_hash],
        );
        if (!row.rows[0]) return null;
        if (this.options.trustedManifest?.primaryPublication) {
          verifyPrimaryPublication(row.rows[0].acknowledgement as unknown as SignedEnvelope<PrimaryPublication>, this.options.trustedManifest, {
            ceremonyId: input.ceremonyId, eventSequence: asNumber(head.event_sequence), eventHash: head.event_hash,
          });
        } else if (publication) verifyPublicationAck(row.rows[0].acknowledgement, publication.witness, {
          ceremonyId: input.ceremonyId, eventSequence: asNumber(head.event_sequence), eventHash: head.event_hash,
        });
      }

      await client.query(
        `UPDATE leases SET state = 'EXPIRED'
         WHERE ceremony_id = $1 AND state IN ('OFFERED','ACTIVE') AND expires_at <= now()`,
        [input.ceremonyId],
      );
      await client.query(
        `UPDATE queue_tickets SET status = 'EXPIRED'
         WHERE ceremony_id = $1 AND status IN ('OFFERED','LEASED')
           AND id IN (SELECT ticket_id FROM leases WHERE ceremony_id = $1 AND state = 'EXPIRED')`,
        [input.ceremonyId],
      );
      const active = await client.query(
        `SELECT 1 FROM leases WHERE ceremony_id = $1
         AND state IN ('OFFERED','ACTIVE','SUBMITTED','VERIFYING') LIMIT 1`,
        [input.ceremonyId],
      );
      if ((active.rowCount ?? active.rows.length) > 0) return null;
      const ticket = await client.query<{ id: string; participant_id: string }>(
        `SELECT id, participant_id FROM queue_tickets
         WHERE ceremony_id = $1 AND status = 'QUEUED'
         ORDER BY enqueued_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [input.ceremonyId],
      );
      if (!ticket.rows[0]) return null;
      const expectedContributionName = `moss-${ticket.rows[0].participant_id}`;
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO leases
          (id, ceremony_id, ticket_id, participant_id, state, base_generation,
           predecessor_sha256, predecessor_byte_length, expected_contribution_name,
           capability_hash, expires_at)
         VALUES ($1,$2,$3,$4,'OFFERED',$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [input.leaseId, input.ceremonyId, ticket.rows[0].id, ticket.rows[0].participant_id,
          asNumber(head.head_generation), head.head_sha256, asNumber(head.head_byte_length),
          expectedContributionName, input.capabilityHash, input.expiresAt],
      );
      await client.query("UPDATE queue_tickets SET status = 'OFFERED', offered_at = now() WHERE id = $1", [ticket.rows[0].id]);
      return mapLease(requireRow(result.rows[0], "lease insert returned no row"));
    });
  }

  async claimLease(input: { leaseId: string; participantId: string; expiresAt: string }): Promise<LeaseView> {
    return this.transaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE leases SET state = 'ACTIVE', claimed_at = now(), heartbeat_at = now(), expires_at = $3
         WHERE id = $1 AND participant_id = $2 AND state = 'OFFERED' AND expires_at > now()
         RETURNING *`,
        [input.leaseId, input.participantId, input.expiresAt],
      );
      const lease = requireRow(result.rows[0], "lease is unavailable or expired");
      await client.query("UPDATE queue_tickets SET status = 'LEASED' WHERE id = $1 AND status = 'OFFERED'", [lease.ticket_id]);
      return mapLease(lease);
    });
  }

  async heartbeat(input: { leaseId: string; participantId: string }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE leases SET heartbeat_at = now()
       WHERE id = $1 AND participant_id = $2 AND state = 'ACTIVE' AND expires_at > now()`,
      [input.leaseId, input.participantId],
    );
    if ((result.rowCount ?? 0) !== 1) throw new Error("lease is unavailable or expired");
  }

  async createSubmission(input: {
    id: string;
    ceremonyId: string;
    leaseId: string;
    participantId: string;
    predecessorSha256: string;
    candidateSha256: string;
    candidateByteLength: number;
    quarantineObjectKey: string;
    quarantineVersionId: string;
    claimedContributionHash: string;
    clientKind: "browser" | "cli" | "other";
    clientReleaseSha256?: string;
  }): Promise<SubmissionView> {
    return this.transaction(async (client) => {
      const lease = await client.query<{ predecessor_sha256: string }>(
        `UPDATE leases SET state = 'SUBMITTED'
         WHERE id = $1 AND ceremony_id = $2 AND participant_id = $3
           AND state = 'ACTIVE' AND expires_at > now()
           AND predecessor_sha256 = $4
         RETURNING predecessor_sha256`,
        [input.leaseId, input.ceremonyId, input.participantId, input.predecessorSha256],
      );
      if (!lease.rows[0]) throw new Error("active lease does not match submission predecessor");
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO submissions
          (id, ceremony_id, lease_id, participant_id, state, predecessor_sha256,
           candidate_sha256, candidate_byte_length, quarantine_object_key,
           quarantine_version_id, claimed_contribution_hash, client_kind, client_release_sha256)
         VALUES ($1,$2,$3,$4,'SUBMITTED',$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [input.id, input.ceremonyId, input.leaseId, input.participantId, input.predecessorSha256,
          input.candidateSha256, input.candidateByteLength, input.quarantineObjectKey,
          input.quarantineVersionId, input.claimedContributionHash, input.clientKind,
          input.clientReleaseSha256 ?? null],
      );
      return mapSubmission(requireRow(result.rows[0], "submission insert returned no row"));
    });
  }

  async recordVerificationReport(input: {
    id: string;
    report: VerificationReportV1;
    signature: string;
  }): Promise<void> {
    const report = input.report;
    assertVerificationReport(report, { production: this.options.production });
    await this.transaction(async (client) => {
      const trustedManifest = this.options.trustedManifest;
      if (this.options.production && !trustedManifest) throw new Error("production report storage requires a trusted signed manifest");
      const submission = await client.query<{
        candidate_sha256: string; ceremony_id: string; predecessor_sha256: string;
        claimed_contribution_hash: string; expected_contribution_name: string;
        base_generation: string | number;
        genesis_sha256: string; verifier_policy: import("@moss/phase2-protocol").VerifierPolicy;
        verifier_keys: Array<{ keyId: string; verifierImageDigest: string }>;
        job_live: boolean;
      }>(
        `SELECT s.candidate_sha256,s.ceremony_id,s.predecessor_sha256,
                s.claimed_contribution_hash,l.expected_contribution_name,l.base_generation,
                COALESCE(c.manifest->'relation'->'genesisBellman'->>'sha256', c.manifest->'relation'->'genesisZkey'->>'sha256') AS genesis_sha256,
                c.verifier_policy,c.manifest->'verifierKeys' AS verifier_keys,
                EXISTS (SELECT 1 FROM verification_jobs j
                  WHERE j.submission_id=s.id AND j.operator_key_id=$2
                    AND j.job_id=$3 AND j.attempt=$4
                    AND j.state='CLAIMED' AND j.lease_until>clock_timestamp()) AS job_live
         FROM submissions s JOIN ceremonies c ON c.id=s.ceremony_id
         JOIN leases l ON l.id=s.lease_id
         WHERE s.id = $1 FOR UPDATE OF s`,
        [report.submissionId, report.operatorKeyId, report.jobId, report.jobAttempt],
      );
      const row = requireRow(submission.rows[0], "submission not found");
      const policy = trustedManifest?.verifierPolicy ?? row.verifier_policy;
      const verifierKeys = trustedManifest?.verifierKeys ?? row.verifier_keys;
      const genesisSha256 = trustedManifest ? contributionGenesis(trustedManifest).sha256 : row.genesis_sha256;
      const verifier = verifierKeys.find((key) => key.keyId === report.operatorKeyId);
      if ((report.verificationMethod ?? "snarkjs-zkey-v1") !== (policy.verificationMethod ?? "snarkjs-zkey-v1")
        || row.candidate_sha256 !== report.candidateSha256 || row.ceremony_id !== report.ceremonyId
        || row.predecessor_sha256 !== report.predecessorSha256 || genesisSha256 !== report.genesisSha256
        || row.claimed_contribution_hash !== report.expectedContributionHashBlake2b512
        || row.expected_contribution_name !== report.expectedContributionName
        || asNumber(row.base_generation) + 1 !== report.expectedContributionIndex
        || !policy.operatorKeyIds.includes(report.operatorKeyId)
        || report.passNumber > policy.passesPerOperator
        || !verifier || verifier.verifierImageDigest !== report.verifierImageDigest) {
        throw new Error("verification report is not bound to the submission");
      }
      const existingResult = await client.query<{
        payload: VerificationReportV1;
        signature: string;
        result: VerificationReportV1["result"];
      }>(
        `SELECT payload,signature,result FROM verification_reports
         WHERE submission_id=$1 AND operator_key_id=$2 AND pass_number=$3
           AND job_id=$4 AND job_attempt=$5
         FOR UPDATE`,
        [report.submissionId, report.operatorKeyId, report.passNumber,
          report.jobId, report.jobAttempt],
      );
      const existing = existingResult.rows[0];
      if (existing && existing.signature === input.signature
        && canonicalize(existing.payload as unknown as JsonValue)
          === canonicalize(report as unknown as JsonValue)) {
        return;
      }
      const sameJob = existing?.payload.jobId === report.jobId
        && existing.payload.jobAttempt === report.jobAttempt;
      const isLiveErrorUpgrade = existing?.result === "error"
        && (report.result === "valid" || report.result === "invalid")
        && sameJob
        && row.job_live;
      if (existing ? !isLiveErrorUpgrade : !row.job_live) {
        throw new Error("verification report job is stale or the report conflicts with an existing pass");
      }
      const inserted = await client.query(
        `INSERT INTO verification_reports
          (id, ceremony_id, submission_id, operator_key_id, job_id, job_attempt,
           pass_number, candidate_sha256, result, payload, signature)
         SELECT $1,$2,$3,$4,$10,$11,$5,$6,$7,$8::jsonb,$9
         WHERE EXISTS (SELECT 1 FROM verification_jobs j
           WHERE j.submission_id=$3 AND j.operator_key_id=$4
             AND j.job_id=$10 AND j.attempt=$11
             AND j.state='CLAIMED' AND j.lease_until>clock_timestamp())
         ON CONFLICT (submission_id, operator_key_id, job_id, job_attempt, pass_number) DO UPDATE
         SET result=EXCLUDED.result,payload=EXCLUDED.payload,signature=EXCLUDED.signature,created_at=now()
         WHERE verification_reports.result='error'
           AND EXCLUDED.result IN ('valid','invalid')`,
        [input.id, report.ceremonyId, report.submissionId, report.operatorKeyId,
          report.passNumber, report.candidateSha256, report.result, JSON.stringify(report), input.signature,
          report.jobId, report.jobAttempt],
      );
      if ((inserted.rowCount ?? inserted.rows.length) !== 1) {
        throw new Error("verification report job expired before the report could be recorded");
      }
      await client.query(
        `UPDATE submissions SET state = 'VERIFYING', updated_at = now()
         WHERE id = $1 AND state IN ('SUBMITTED','VERIFYING')`,
        [report.submissionId],
      );
      await client.query("UPDATE leases SET state = 'VERIFYING' WHERE id = (SELECT lease_id FROM submissions WHERE id = $1) AND state IN ('SUBMITTED','VERIFYING')", [report.submissionId]);
    });
  }

  async acceptVerifiedSubmission(input: AcceptanceInput): Promise<void> {
    await this.transaction(async (client) => {
      const ceremonyResult = await client.query<CeremonyPolicyRow>(
        `SELECT id, state, verifier_policy, head_generation, head_sha256, head_byte_length,
                event_sequence, event_hash, revision, seals_at,
                manifest->'contributionPolicy'->>'maximumContributions' AS maximum_contributions,
                clock_timestamp() < seals_at AS before_seal
         FROM ceremonies WHERE id = $1 FOR UPDATE`,
        [input.ceremonyId],
      );
      const ceremony = requireRow(ceremonyResult.rows[0], "ceremony not found");
      if (ceremony.state !== "OPEN") throw new Error("ceremony is not open");
      const trustedManifest = this.options.trustedManifest;
      if (this.options.production && !trustedManifest) throw new Error("production acceptance requires a trusted signed manifest");
      const signedSealsAt = trustedManifest?.schedule.sealsAt;
      if (signedSealsAt !== undefined
        && new Date(ceremony.seals_at).getTime() !== Date.parse(signedSealsAt)) {
        throw new Error("database ceremony seal does not match the signed manifest");
      }
      if (ceremony.before_seal !== true) throw new Error("ceremony acceptance deadline has passed");
      const maximumContributions = this.maximumContributions(ceremony);
      if (asNumber(ceremony.head_generation) >= maximumContributions) {
        throw new Error("ceremony contribution limit has been reached");
      }
      const verifierPolicy = trustedManifest?.verifierPolicy ?? ceremony.verifier_policy;
      assertVerifierPolicy(verifierPolicy, { production: this.options.production });

      const submissionResult = await client.query<SubmissionAcceptanceRow>(
        `SELECT s.id, s.lease_id, s.participant_id, s.predecessor_sha256,
                s.candidate_sha256, s.candidate_byte_length, s.claimed_contribution_hash,
                s.state, l.expected_contribution_name, l.base_generation,
                l.state AS lease_state,p.public_pseudonym,
                s.client_kind, s.client_release_sha256
         FROM submissions s JOIN leases l ON l.id = s.lease_id
         JOIN participants p ON p.id=s.participant_id
         WHERE s.id = $1 AND s.ceremony_id = $2 FOR UPDATE OF s, l`,
        [input.submissionId, input.ceremonyId],
      );
      const submission = requireRow(submissionResult.rows[0], "submission not found");
      assertReceipt(input.receipt);
      if (submission.state !== "VERIFYING" || submission.lease_state !== "VERIFYING") throw new Error("submission is not awaiting acceptance");
      if (submission.candidate_sha256 !== input.canonicalArtifact.sha256
        || asNumber(submission.candidate_byte_length) !== input.canonicalArtifact.byteLength) {
        throw new Error("canonical artifact does not match submission");
      }
      const generation = asNumber(ceremony.head_generation) + 1;
      if (submission.predecessor_sha256 !== ceremony.head_sha256
        || asNumber(submission.base_generation) !== asNumber(ceremony.head_generation)) {
        throw new Error("submission is stale relative to canonical head");
      }
      if (input.event.previousEventHash !== ceremony.event_hash
        || input.event.sequence !== asNumber(ceremony.event_sequence) + 1
        || input.eventHash !== transcriptEventHash(input.event)) {
        throw new Error("transcript event is not the next canonical event");
      }
      const relationManifestSha256 = trustedManifest
        ? canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", trustedManifest as unknown as import("@moss/phase2-protocol").JsonValue)
        : input.receipt.relationManifestSha256;
      const expectedEventPayload = input.event.payload as Record<string, unknown>;
      if (input.receipt.generation !== generation
        || input.receipt.ceremonyId !== input.ceremonyId
        || input.receipt.relationManifestSha256 !== relationManifestSha256
        || input.receipt.sequence !== input.event.sequence
        || input.receipt.predecessor.sha256 !== ceremony.head_sha256
        || input.receipt.predecessor.byteLength !== asNumber(ceremony.head_byte_length)
        || input.receipt.successor.sha256 !== submission.candidate_sha256
        || input.receipt.successor.byteLength !== asNumber(submission.candidate_byte_length)
        || input.receipt.transcriptEventHash !== input.eventHash
        || input.receipt.contributionHashBlake2b512 !== input.contributionHash
        || input.receipt.contributionName !== input.contributionName
        || input.receipt.acceptedAt !== input.acceptedAt
        || submission.claimed_contribution_hash !== input.contributionHash
        || submission.expected_contribution_name !== input.contributionName
        || input.receipt.participantPseudonym !== submission.public_pseudonym
        // Provenance must be what the submission recorded, not what the
        // signer chose to put in the receipt.
        || input.receipt.clientKind !== submission.client_kind
        || input.receipt.clientReleaseSha256 !== (submission.client_release_sha256 ?? null)
        || expectedEventPayload.clientKind !== submission.client_kind
        || (expectedEventPayload.clientReleaseSha256 ?? null) !== (submission.client_release_sha256 ?? null)
        || input.event.ceremonyId !== input.ceremonyId
        || input.event.eventType !== "CONTRIBUTION_ACCEPTED"
        || input.event.createdAt !== input.acceptedAt
        || expectedEventPayload.submissionId !== input.submissionId
        || expectedEventPayload.generation !== generation
        || expectedEventPayload.predecessorSha256 !== ceremony.head_sha256
        || expectedEventPayload.successorSha256 !== submission.candidate_sha256
        || expectedEventPayload.contributionHashBlake2b512 !== input.contributionHash
        || expectedEventPayload.contributionName !== input.contributionName) {
        throw new Error("receipt is not bound to the accepted transition");
      }
      if (trustedManifest) {
        verifyWithAnyCoordinatorKey(input.event as unknown as import("@moss/phase2-protocol").JsonValue,
          input.eventSignature, TRANSCRIPT_EVENT_SIGNATURE_DOMAIN, trustedManifest);
        verifyWithAnyCoordinatorKey(input.receipt as unknown as import("@moss/phase2-protocol").JsonValue,
          input.receiptSignature, RECEIPT_SIGNATURE_DOMAIN, trustedManifest);
      }

      const reportsResult = await client.query<{
        payload: VerificationReportV1;
        signature: string;
        operator_key_id: string;
        job_id: string;
        job_attempt: string | number;
      }>(
        `SELECT payload,signature,operator_key_id,job_id,job_attempt FROM verification_reports
         WHERE submission_id = $1 AND candidate_sha256 = $2`,
        [input.submissionId, submission.candidate_sha256],
      );
      const reports = reportsResult.rows.map((row) => {
        const key = trustedManifest?.verifierKeys.find((candidate) => candidate.keyId === row.operator_key_id);
        if (trustedManifest && !key) throw new Error("stored verification report uses an unauthorized key");
        assertVerificationReport(row.payload, { production: this.options.production });
        if ((row.payload.verificationMethod ?? "snarkjs-zkey-v1") !== (verifierPolicy.verificationMethod ?? "snarkjs-zkey-v1")
          || row.payload.operatorKeyId !== row.operator_key_id
          || row.payload.jobId !== row.job_id
          || row.payload.jobAttempt !== asNumber(row.job_attempt)
          || !verifierPolicy.operatorKeyIds.includes(row.payload.operatorKeyId)
          || row.payload.passNumber > verifierPolicy.passesPerOperator
          || row.payload.submissionId !== input.submissionId
          || row.payload.ceremonyId !== input.ceremonyId
          || row.payload.candidateSha256 !== submission.candidate_sha256
          || row.payload.predecessorSha256 !== submission.predecessor_sha256
          || row.payload.expectedContributionName !== submission.expected_contribution_name
          || row.payload.expectedContributionHashBlake2b512 !== submission.claimed_contribution_hash
          || row.payload.expectedContributionIndex !== asNumber(submission.base_generation) + 1
          || trustedManifest && (row.payload.genesisSha256 !== contributionGenesis(trustedManifest).sha256
            || row.payload.verifierImageDigest !== key?.verifierImageDigest)) {
          throw new Error("stored verification report is not bound to accepted state");
        }
        if (key) {
          const verified = verifyEnvelope({ schemaVersion: 1, keyId: row.operator_key_id,
            payload: row.payload as never, signature: row.signature }, {
            publicKey: key.publicKeyPem, domain: VERIFICATION_REPORT_SIGNATURE_DOMAIN,
          }) as unknown as VerificationReportV1;
          assertVerificationReport(verified, { production: this.options.production });
        }
        // Errors can precede a successful fresh attempt and may have no
        // observed metadata. They remain bound and authenticated above, but
        // never count as valid passes. assertVerificationReport enforces exact
        // observed metadata for every valid report. An invalid verdict is a
        // veto, including when acceptance races the runtime's rejection path.
        if (row.payload.result === "invalid") {
          throw new Error("stored verification report rejects candidate");
        }
        return row.payload;
      });
      const evaluation = evaluateVerifierPolicy(verifierPolicy, reports);
      if (!evaluation.satisfied) throw new Error("production verifier policy is not satisfied");

      await client.query(
        `INSERT INTO artifacts
          (sha256, ceremony_id, kind, byte_length, storage_backend, object_key,
           storage_version_id, immutable, predecessor_sha256, generation, verified_at)
         VALUES ($1,$2,'CONTRIBUTION',$3,$4,$5,$6,true,$7,$8,now())`,
        [input.canonicalArtifact.sha256, input.ceremonyId, input.canonicalArtifact.byteLength,
          input.canonicalArtifact.storageBackend, input.canonicalArtifact.objectKey,
          input.canonicalArtifact.storageVersionId, ceremony.head_sha256, generation],
      );
      await client.query(
        `INSERT INTO transcript_events
          (ceremony_id, sequence, previous_event_hash, event_hash, event_type,
           payload, signature, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [input.ceremonyId, input.event.sequence, input.event.previousEventHash,
          input.eventHash, input.event.eventType, JSON.stringify(input.event.payload),
          input.eventSignature, input.event.createdAt],
      );
      await client.query(
        `INSERT INTO contributions
          (ceremony_id, generation, submission_id, participant_id,
           predecessor_sha256, successor_sha256, contribution_hash,
           contribution_name, receipt, receipt_signature, accepted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [input.ceremonyId, generation, input.submissionId, submission.participant_id,
          ceremony.head_sha256, submission.candidate_sha256, input.contributionHash,
          input.contributionName, JSON.stringify(input.receipt), input.receiptSignature,
          input.acceptedAt],
      );
      const update = await client.query(
        `UPDATE ceremonies
         SET head_generation = $3, head_sha256 = $4, head_byte_length = $5,
             event_sequence = $6, event_hash = $7, revision = revision + 1,
             updated_at = now()
         WHERE id = $1 AND state = 'OPEN' AND head_generation = $2 AND head_sha256 = $8
           AND clock_timestamp() < seals_at
           AND clock_timestamp() >= observed_time_high_water
           AND ($9::timestamptz IS NULL OR seals_at = $9::timestamptz)
           AND head_generation < $10
           AND (manifest->'contributionPolicy'->>'maximumContributions')::bigint = $10`,
        [input.ceremonyId, asNumber(ceremony.head_generation), generation,
          submission.candidate_sha256, input.canonicalArtifact.byteLength,
          input.event.sequence, input.eventHash, ceremony.head_sha256, signedSealsAt ?? null,
          maximumContributions],
      );
      if ((update.rowCount ?? 0) !== 1) throw new Error("canonical head compare-and-swap failed");
      await client.query("UPDATE submissions SET state = 'ACCEPTED', updated_at = now() WHERE id = $1", [input.submissionId]);
      await client.query("UPDATE leases SET state = 'ACCEPTED' WHERE id = $1", [submission.lease_id]);
      await client.query("UPDATE queue_tickets SET status = 'COMPLETED', completed_at = now() WHERE id = (SELECT ticket_id FROM leases WHERE id = $1)", [submission.lease_id]);
      await client.query(
        "INSERT INTO outbox (id, topic, payload) VALUES ($1,'contribution.accepted',$2::jsonb)",
        [input.outboxId, JSON.stringify({ receipt: input.receipt, signature: input.receiptSignature })],
      );
    });
  }

  private maximumContributions(ceremony: CeremonyPolicyRow): number {
    const limit = Number(ceremony.maximum_contributions);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
      throw new Error("database ceremony contribution limit is invalid");
    }
    const manifest = this.options.trustedManifest;
    if (this.options.production && !manifest) {
      throw new Error("production contribution limit requires a trusted signed manifest");
    }
    if (manifest && (manifest.ceremonyId !== ceremony.id
      || manifest.contributionPolicy.maximumContributions !== limit)) {
      throw new Error("database ceremony contribution limit does not match the signed manifest");
    }
    return limit;
  }

  private async transaction<T>(operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* retain original failure */ }
      throw error;
    } finally {
      client.release?.();
    }
  }
}

function verifyWithAnyCoordinatorKey(
  payload: import("@moss/phase2-protocol").JsonValue,
  signature: string,
  domain: string,
  manifest: CeremonyManifestV1,
): void {
  for (const key of manifest.coordinatorKeys) {
    try {
      verifyEnvelope({ schemaVersion: 1, keyId: key.keyId, payload, signature }, {
        publicKey: key.publicKeyPem,
        domain,
      });
      return;
    } catch { /* try the next manifest-authorized key */ }
  }
  throw new Error("coordinator transition signature is not authorized by the manifest");
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) throw new Error(message);
  return row;
}

function asNumber(value: string | number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("database integer is outside the safe range");
  return number;
}

function mapTicket(row: Record<string, unknown>): QueueTicketView {
  return {
    id: String(row.id), ceremonyId: String(row.ceremony_id), participantId: String(row.participant_id),
    status: String(row.status), enqueuedAt: new Date(row.enqueued_at as string | Date).toISOString(),
  };
}

function mapLease(row: Record<string, unknown>): LeaseView {
  return {
    id: String(row.id), ceremonyId: String(row.ceremony_id), participantId: String(row.participant_id),
    state: String(row.state), baseGeneration: asNumber(row.base_generation as string | number),
    predecessorSha256: String(row.predecessor_sha256), predecessorByteLength: asNumber(row.predecessor_byte_length as string | number),
    expectedContributionName: String(row.expected_contribution_name),
    expiresAt: new Date(row.expires_at as string | Date).toISOString(),
  };
}

function mapSubmission(row: Record<string, unknown>): SubmissionView {
  return {
    id: String(row.id), ceremonyId: String(row.ceremony_id), leaseId: String(row.lease_id),
    state: String(row.state), predecessorSha256: String(row.predecessor_sha256),
    candidateSha256: String(row.candidate_sha256), candidateByteLength: asNumber(row.candidate_byte_length as string | number),
    quarantineObjectKey: String(row.quarantine_object_key), quarantineVersionId: String(row.quarantine_version_id),
    claimedContributionHash: String(row.claimed_contribution_hash),
  };
}
