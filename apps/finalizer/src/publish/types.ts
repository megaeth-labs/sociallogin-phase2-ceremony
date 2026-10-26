export const PUBLICATION_INDEX_TYPE = "moss.phase2.final-publication-index.v1" as const;
export const PUBLICATION_JOURNAL_TYPE = "moss.phase2.final-publication-journal.v1" as const;
export const PUBLICATION_INDEX_FILE = "publication-index.json" as const;

/** Roles a published final artifact can take. Keys of the index's `artifacts`. */
export type PublishedRole =
  | "finalZkey"
  | "verificationKey"
  | "solidityVerifier"
  | "beaconEvidence"
  | "finalizerSummary"
  | "importedSealedZkey"
  | "auditReport"
  | "proofEvidence";

export interface PublishedArtifact {
  fileName: string;
  contentType: string;
  sha256: string;
  byteLength: number;
  objectKey: string;
  versionId: string;
  url: string;
}

export interface FinalPublicationIndexV1 {
  schemaVersion: 1;
  type: typeof PUBLICATION_INDEX_TYPE;
  ceremonyId: string;
  label: string;
  publicBaseUrl: string;
  finalizerSummarySha256: string;
  artifacts: Partial<Record<PublishedRole, PublishedArtifact>> &
    Record<"finalZkey" | "verificationKey" | "solidityVerifier" | "beaconEvidence" | "finalizerSummary", PublishedArtifact>;
}

/** One stored version (or delete marker) at an exact object key. */
export interface StoredVersion {
  versionId: string;
  deleteMarker: boolean;
  byteLength: number;
}

export interface StoredVersionDetail {
  versionId: string;
  byteLength: number;
  /** SHA-256 hex recorded at upload in object metadata; never trusted alone. */
  sha256?: string;
  objectLockMode?: string;
  objectLockRetainUntil?: string;
}

/** Thrown by a store when a conditional (If-None-Match: *) write finds an object. */
export class ConditionalWriteConflict extends Error {
  constructor(message = "an object already exists at this key") {
    super(message);
    this.name = "ConditionalWriteConflict";
  }
}

/**
 * The narrow S3 surface publication needs. Every write is conditional on the
 * key being empty, so a retried or concurrent run can never add a second
 * version under a hash-addressed key.
 */
export interface PublicationStore {
  listVersions(key: string): Promise<StoredVersion[]>;
  headVersion(key: string, versionId: string): Promise<StoredVersionDetail | null>;
  putObject(input: {
    key: string;
    body: Uint8Array;
    sha256: string;
    contentType: string;
  }): Promise<{ versionId: string }>;
  createMultipart(input: {
    key: string;
    sha256: string;
    contentType: string;
  }): Promise<{ uploadId: string }>;
  uploadPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    body: Uint8Array;
    sha256: string;
  }): Promise<{ etag: string; checksumSha256?: string }>;
  completeMultipart(input: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string; checksumSha256?: string }>;
  }): Promise<{ versionId: string }>;
  abortMultipart(input: { key: string; uploadId: string }): Promise<void>;
}

export interface PublicationJournalV1 {
  schemaVersion: 1;
  type: typeof PUBLICATION_JOURNAL_TYPE;
  ceremonyId: string;
  label: string;
  publicBaseUrl: string;
  finalizerSummarySha256: string;
  /** Multipart uploads started but not known to be completed or aborted. */
  pendingMultipart: Array<{ key: string; uploadId: string }>;
  published: Partial<Record<PublishedRole | "publicationIndex", PublishedArtifact>>;
}

export interface PublishOptions {
  /** Finalizer output directory containing final-artifacts.json and its outputs. */
  finalizerOutputDir: string;
  /** Optional `moss.phase2.ceremony-audit.v1` report. */
  auditReportPath?: string;
  /** Optional `moss.phase2.proof-tests.v1` index. */
  proofEvidencePath?: string;
  /** Short operator label in the object path, e.g. the publication date. */
  label: string;
  /** Public HTTPS origin (and optional path prefix) serving the bucket. */
  publicBaseUrl: string;
  journalPath: string;
  /** Local copy of the published index. Must not already exist unless identical. */
  indexOutPath?: string;
  /** When set, every object must be COMPLIANCE-locked until at least this time. */
  minimumRetentionUntil?: string;
  singlePutMaxBytes?: number;
  partSizeBytes?: number;
}

export interface PublishDependencies {
  store: PublicationStore;
  fetch?: typeof fetch;
}

export interface PublishResult {
  index: PublishedArtifact;
  artifacts: FinalPublicationIndexV1["artifacts"];
}
