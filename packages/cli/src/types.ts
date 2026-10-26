import type {
  CeremonyManifestV1,
  ContributionReceiptV1,
  HeadCheckpointV1,
  OperationalUpdate,
  SignedEnvelope,
} from "@moss/phase2-protocol";

export interface StatusResponse {
  ceremonyId: string;
  state: string;
  generation: number;
  head: {
    sha256: string;
    byteLength: number;
    downloadUrl: string;
  };
  queueDepth: number;
  manifestSha256: string;
}

export interface PredecessorRef {
  sha256: string;
  byteLength: number;
  downloadUrl: string;
}

export interface OfferResponse {
  leaseId: string;
  expiresAt: string;
  baseGeneration: number;
  expectedContributionName: string;
  predecessor: PredecessorRef;
}

export interface QueueResponse {
  ticketId: string;
  status: string;
  position: number;
  offer: OfferResponse | null;
}

export interface LeaseResponse extends OfferResponse {
  state: string;
  submissionId?: string;
}

export interface UploadGrant {
  uploadId: string;
  objectKey: string;
  expiresAt: string;
  method: "local-proxy" | "s3-multipart";
  uploadUrl?: string;
  headers?: Record<string, string>;
}

export interface UploadPartGrant {
  partNumber: number;
  url: string;
  headers?: Record<string, string>;
}

export interface UploadedArtifactResponse {
  uploadId: string;
  state: "UPLOADING";
  byteLength: number;
  sha256: string;
}

export interface CompletedUploadResponse {
  uploadId: string;
  state: "COMPLETED";
  artifact: {
    sha256: string;
    byteLength: number;
  };
}

export interface UploadStateResponse {
  uploadId: string;
  state: string;
  expiresAt: string;
  artifact?: {
    sha256: string;
    byteLength: number;
  };
}

export interface SubmissionResponse {
  submissionId: string;
  state: string;
  receiptId?: string;
}

/**
 * Authenticated, participant-scoped recovery view. The coordinator returns the
 * current queue/lease and the most recent submission, retaining an accepted
 * submission so a client can recover its signed receipt after a restart.
 */
export interface ParticipantStateResponse {
  ceremonyId: string;
  participantId: string;
  queue: QueueResponse | null;
  lease: LeaseResponse | null;
  submission: SubmissionResponse | null;
}

export type ManifestEnvelope = SignedEnvelope<CeremonyManifestV1>;
export type CheckpointEnvelope = SignedEnvelope<HeadCheckpointV1>;
export type ReceiptEnvelope = SignedEnvelope<ContributionReceiptV1>;
export type OperationalUpdateEnvelope = SignedEnvelope<OperationalUpdate>;

export interface TrustedCeremonyState {
  manifestEnvelope: ManifestEnvelope;
  manifest: CeremonyManifestV1;
  manifestSha256: string;
  checkpointEnvelope: CheckpointEnvelope;
  checkpoint: HeadCheckpointV1;
  status: StatusResponse;
}

export interface CliAuthInitResponse {
  userCode: string;
  verificationUri: string;
  loginCode: string;
  interval: number;
  expiresIn: number;
}

export interface CliAuthTokenResponse {
  token: string;
  participantId: string;
  participantName: string;
  expiresAt: number;
}

export interface StoredAuth {
  ceremonyUrl: string;
  token: string;
  participantId: string;
  participantName: string;
  expiresAt: number;
}
