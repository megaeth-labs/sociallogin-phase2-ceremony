import type { Readable } from "node:stream";

import type {
  CeremonyManifestV1,
  RehearsalWebReleaseAuthorization,
  ContributionReceiptV1,
  HeadCheckpointV1,
  SignedEnvelope,
  VerificationReportV1,
} from "@moss/phase2-protocol";
import type { UploadGrant } from "@moss/phase2-storage";

import type { ParticipantPrincipal } from "./auth.js";

export interface CoordinatorOfferResponse {
  leaseId: string;
  expiresAt: string;
  baseGeneration: number;
  expectedContributionName: string;
  predecessor: { sha256: string; byteLength: number; downloadUrl: string };
}

export interface CoordinatorQueueResponse {
  ticketId: string;
  status: string;
  position: number;
  offer: CoordinatorOfferResponse | null;
}

export interface CoordinatorLeaseResponse extends CoordinatorOfferResponse {
  state: string;
  submissionId?: string;
}

export interface CoordinatorSubmissionResponse {
  submissionId: string;
  state: string;
  receiptId?: string;
}

export interface ParticipantCeremonyStateResponse {
  ceremonyId: string;
  participantId: string;
  queue: CoordinatorQueueResponse | null;
  lease: CoordinatorLeaseResponse | null;
  submission: CoordinatorSubmissionResponse | null;
}

export interface CoordinatorOperations {
  getOperationalUpdates?(slug: string): Promise<{ updates: import("@moss/phase2-protocol").SignedEnvelope<import("@moss/phase2-protocol").OperationalUpdate>[]; appliedAt: string[] }>;
  applyOperationalUpdate?(slug: string, envelope: import("@moss/phase2-protocol").SignedEnvelope<import("@moss/phase2-protocol").OperationalUpdate>): Promise<{ sequence: number; updateSha256: string }>;
  getWebReleaseAuthorization?(slug: string): Promise<SignedEnvelope<RehearsalWebReleaseAuthorization> | null>;
  getManifest(slug: string): Promise<SignedEnvelope<CeremonyManifestV1>>;
  getCheckpoint(slug: string): Promise<SignedEnvelope<HeadCheckpointV1>>;
  getStatus(slug: string): Promise<{
    ceremonyId: string;
    state: string;
    generation: number;
    head: { sha256: string; byteLength: number; downloadUrl: string };
    queueDepth: number;
    manifestSha256: string;
  }>;
  openCanonicalArtifact(
    slug: string,
    sha256: string,
    range?: { start: number; endInclusive?: number },
  ): Promise<{
    stream: Readable;
    byteLength: number;
    totalByteLength: number;
    start: number;
    endInclusive: number;
  }>;
  joinQueue(slug: string, principal: ParticipantPrincipal, idempotencyKey: string): Promise<unknown>;
  /** Stable audit links can redirect to an immutable archive version. */
  getCanonicalArtifactRedirect?(slug: string, sha256: string): Promise<string | null>;
  getMyQueue(slug: string, participantId: string): Promise<unknown>;
  getParticipantState(slug: string, participantId: string): Promise<ParticipantCeremonyStateResponse>;
  cancelMyQueue(slug: string, participantId: string): Promise<void>;
  claimOffer(leaseId: string, participantId: string): Promise<unknown>;
  getLease(leaseId: string, participantId: string): Promise<unknown>;
  /**
   * Liveness only. Clients report progress alongside it, but the coordinator
   * has never stored or acted on that, so it is not accepted here: an unused
   * parameter carrying unvalidated client input invites someone to start
   * trusting it.
   */
  heartbeat(leaseId: string, participantId: string): Promise<void>;
  createUpload(leaseId: string, participantId: string): Promise<UploadGrant>;
  getUpload(uploadId: string, participantId: string): Promise<{
    uploadId: string;
    state: string;
    expiresAt: string;
    artifact?: { sha256: string; byteLength: number };
  }>;
  createUploadParts(uploadId: string, participantId: string, partNumbers: number[]): Promise<unknown>;
  ingestLocalUpload(uploadId: string, participantId: string, body: Readable): Promise<unknown>;
  completeUpload(uploadId: string, participantId: string, input: {
    sha256: string;
    byteLength: number;
    parts?: Array<{ partNumber: number; etag: string }>;
  }): Promise<unknown>;
  submit(leaseId: string, participantId: string, input: {
    uploadId: string;
    predecessorSha256: string;
    contributionHashBlake2b512: string;
    clientKind: "browser" | "cli" | "other";
    clientReleaseSha256?: string;
  }, idempotencyKey: string): Promise<unknown>;
  getSubmission(submissionId: string, participantId: string): Promise<unknown>;
  getReceipt(receiptId: string, participantId: string): Promise<SignedEnvelope<ContributionReceiptV1>>;
  listPublications(slug: string, after: number): Promise<unknown[]>;
  /** Accepted receipts after generation `after`, oldest first; `limit` is 1 to 50 (default 50). */
  listContributions(slug: string, after: number, limit?: number): Promise<Array<SignedEnvelope<ContributionReceiptV1>>>;
  claimVerifierJob(operatorKeyId: string): Promise<unknown | null>;
  heartbeatVerifierJob(jobId: string, operatorKeyId: string): Promise<{ leaseExpiresAt: string }>;
  recordVerifierReport(envelope: SignedEnvelope<VerificationReportV1>): Promise<void>;
}

export interface RouteRequest {
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: unknown;
  raw?: Readable;
}

export interface RouteReply {
  code(statusCode: number): RouteReply;
  header(name: string, value: string): RouteReply;
  removeHeader(name: string): RouteReply;
  send(payload?: unknown): unknown;
}

export interface FastifyLike {
  route(options: {
    method: string;
    url: string;
    bodyLimit?: number;
    handler(request: RouteRequest, reply: RouteReply): Promise<unknown>;
  }): void;
  addContentTypeParser?(contentType: string, parser: (request: unknown, payload: Readable, done: (error: Error | null, body?: unknown) => void) => void): void;
}
