import type { Readable } from "node:stream";

export interface QuarantineArtifact {
  backend: "local" | "s3";
  objectKey: string;
  versionId: string;
  sha256: string;
  byteLength: number;
}

export interface CanonicalArtifact extends QuarantineArtifact {
  immutable: true;
}

export interface UploadGrant {
  /** Coordinator-owned identifier used in public API routes and the database. */
  uploadId: string;
  /** Provider-owned multipart identifier; never use this as a public route ID. */
  backendUploadId?: string;
  objectKey: string;
  expiresAt: string;
  method: "local-proxy" | "s3-multipart";
  uploadUrl?: string;
  headers?: Record<string, string>;
}

export interface ArtifactStore {
  createUpload(input: {
    ceremonyId: string;
    leaseId: string;
    uploadId: string;
    expiresAt: string;
    maxByteLength: number;
  }): Promise<UploadGrant>;
  createUploadParts?(input: {
    grant: UploadGrant;
    partNumbers: number[];
  }): Promise<Array<{ partNumber: number; url: string; headers?: Record<string, string> }>>;
  ingestLocalUpload?(input: {
    grant: UploadGrant;
    body: Readable;
    maxByteLength: number;
  }): Promise<QuarantineArtifact>;
  completeUpload(input: {
    grant: UploadGrant;
    expectedSha256: string;
    expectedByteLength: number;
    multipartParts?: Array<{ partNumber: number; etag: string }>;
  }): Promise<QuarantineArtifact>;
  promoteImmutable(input: {
    ceremonyId: string;
    generation: number;
    quarantine: QuarantineArtifact;
  }): Promise<CanonicalArtifact>;
  /** Discover an immutable content-addressed object during promotion recovery. */
  findCanonical(ceremonyId: string, sha256: string): Promise<CanonicalArtifact | null>;
  /** Resolve only the exact object key and version already persisted by the coordinator. */
  statCanonical(artifact: CanonicalArtifact): Promise<CanonicalArtifact | null>;
  openCanonical?(
    artifact: CanonicalArtifact,
    range?: { start: number; endInclusive: number },
  ): Promise<Readable>;
  openQuarantine?(artifact: QuarantineArtifact): Promise<Readable>;
  quarantineDownloadUrl?(artifact: QuarantineArtifact, expiresInSeconds: number): Promise<string>;
  downloadUrl(artifact: CanonicalArtifact, expiresInSeconds: number): Promise<string>;
}

export interface S3ArtifactClient {
  openVersion?(input: { bucket: string; key: string; versionId: string; range?: { start: number; endInclusive: number } }): Promise<Readable>;
  createMultipartUpload(input: {
    bucket: string;
    key: string;
    maxByteLength: number;
    expiresAt: string;
  }): Promise<{ uploadId: string; uploadUrl?: string; headers?: Record<string, string> }>;
  signedUploadPartUrls(input: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumbers: number[];
    expiresAt: string;
  }): Promise<Array<{ partNumber: number; url: string; headers?: Record<string, string> }>>;
  completeMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<{ versionId: string }>;
  headVersion(input: { bucket: string; key: string; versionId?: string }): Promise<{
    versionId: string;
    byteLength: number;
    checksumSha256: string;
    objectLockMode?: string;
    objectLockRetainUntil?: string;
  } | null>;
  copyImmutable(input: {
    sourceBucket: string;
    destinationBucket: string;
    sourceKey: string;
    sourceVersionId: string;
    destinationKey: string;
    sha256: string;
  }): Promise<{
    versionId: string;
    objectLockMode: string;
    objectLockRetainUntil: string;
    checksumSha256: string;
    byteLength: number;
  }>;
  signedDownloadUrl(input: { bucket: string; key: string; versionId?: string; expiresInSeconds: number }): Promise<string>;
}
