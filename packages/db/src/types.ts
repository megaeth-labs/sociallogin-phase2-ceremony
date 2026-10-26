import type {
  ContributionReceiptV1,
  TranscriptEventV1,
  VerificationReportV1,
  VerifierPolicy,
} from "@moss/phase2-protocol";

export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface PgClientLike {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
  release?(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}

export interface QueueTicketView {
  id: string;
  ceremonyId: string;
  participantId: string;
  status: string;
  enqueuedAt: string;
}

export interface LeaseView {
  id: string;
  ceremonyId: string;
  participantId: string;
  state: string;
  baseGeneration: number;
  predecessorSha256: string;
  predecessorByteLength: number;
  expectedContributionName: string;
  expiresAt: string;
}

export interface SubmissionView {
  id: string;
  ceremonyId: string;
  leaseId: string;
  state: string;
  predecessorSha256: string;
  candidateSha256: string;
  candidateByteLength: number;
  quarantineObjectKey: string;
  quarantineVersionId: string;
  claimedContributionHash: string;
}

export interface AcceptanceInput {
  ceremonyId: string;
  submissionId: string;
  canonicalArtifact: {
    sha256: string;
    byteLength: number;
    storageBackend: "local" | "s3";
    objectKey: string;
    storageVersionId: string;
  };
  contributionHash: string;
  contributionName: string;
  acceptedAt: string;
  event: TranscriptEventV1;
  eventHash: string;
  eventSignature: string;
  receipt: ContributionReceiptV1;
  receiptSignature: string;
  outboxId: string;
}

export interface CeremonyPolicyRow {
  id: string;
  state: string;
  seals_at: string | Date;
  before_seal: boolean;
  maximum_contributions: string | number;
  verifier_policy: VerifierPolicy;
  head_generation: string | number;
  head_sha256: string;
  head_byte_length: string | number;
  event_sequence: string | number;
  event_hash: string;
  revision: string | number;
}

export interface SubmissionAcceptanceRow {
  id: string;
  lease_id: string;
  participant_id: string;
  predecessor_sha256: string;
  candidate_sha256: string;
  candidate_byte_length: string | number;
  claimed_contribution_hash: string;
  state: string;
  expected_contribution_name: string;
  base_generation: string | number;
  lease_state: string;
  public_pseudonym: string;
  client_kind: "browser" | "cli" | "other";
  client_release_sha256: string | null;
}

export type StoredVerificationReport = VerificationReportV1;
