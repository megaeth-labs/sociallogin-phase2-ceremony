import type {
  ArtifactStore,
  CanonicalArtifact,
  QuarantineArtifact,
  S3ArtifactClient,
  UploadGrant,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class S3ArtifactStore implements ArtifactStore {
  constructor(
    private readonly client: S3ArtifactClient,
    private readonly quarantineBucket: string,
    private readonly archiveBucket: string,
    private readonly options: { production: boolean; minimumRetentionUntil?: string },
  ) {
    if (options.production) {
      if (!options.minimumRetentionUntil) {
        throw new Error("production S3 storage requires a minimum retention horizon");
      }
      assertCanonicalDate(options.minimumRetentionUntil, "minimum retention horizon");
    }
  }

  async createUpload(input: {
    ceremonyId: string; leaseId: string; uploadId: string; expiresAt: string; maxByteLength: number;
  }): Promise<UploadGrant> {
    for (const value of [input.ceremonyId, input.leaseId, input.uploadId]) {
      if (!SAFE_COMPONENT.test(value)) throw new Error("upload identifier is unsafe");
    }
    const objectKey = `quarantine/${input.ceremonyId}/${input.leaseId}/${input.uploadId}.zkey`;
    const created = await this.client.createMultipartUpload({
      bucket: this.quarantineBucket, key: objectKey, maxByteLength: input.maxByteLength, expiresAt: input.expiresAt,
    });
    const grant: UploadGrant = {
      uploadId: input.uploadId,
      backendUploadId: created.uploadId,
      objectKey,
      expiresAt: input.expiresAt,
      method: "s3-multipart",
      uploadUrl: created.uploadUrl,
      headers: created.headers,
    };
    return grant;
  }

  async completeUpload(input: {
    grant: UploadGrant; expectedSha256: string; expectedByteLength: number;
    multipartParts?: Array<{ partNumber: number; etag: string }>;
  }): Promise<QuarantineArtifact> {
    if (!SHA256.test(input.expectedSha256)) throw new Error("expected SHA-256 is invalid");
    if (input.grant.method !== "s3-multipart") throw new Error("upload grant is not S3 multipart");
    const parts = input.multipartParts ?? [];
    if (parts.length === 0) throw new Error("multipart completion requires parts");
    const backendUploadId = input.grant.backendUploadId;
    if (!backendUploadId) throw new Error("S3 upload grant has no backend multipart ID");
    let completedVersionId: string | undefined;
    try {
      const completed = await this.client.completeMultipartUpload({
        bucket: this.quarantineBucket,
        key: input.grant.objectKey,
        uploadId: backendUploadId,
        parts,
      });
      completedVersionId = completed.versionId;
    } catch (completionError) {
      // CompleteMultipartUpload consumes the multipart ID before its response
      // can be durably recorded. Reconcile the unique, lease-bound key and
      // accept it only when its provider checksum and exact length match.
      const reconciled = await this.client.headVersion({
        bucket: this.quarantineBucket,
        key: input.grant.objectKey,
      }).catch(() => null);
      if (!reconciled
        || reconciled.byteLength !== input.expectedByteLength
        || reconciled.checksumSha256 !== input.expectedSha256) {
        throw completionError;
      }
      completedVersionId = reconciled.versionId;
    }
    if (!completedVersionId) throw new Error("S3 multipart completion returned no version ID");
    const head = await this.client.headVersion({
      bucket: this.quarantineBucket,
      key: input.grant.objectKey,
      versionId: completedVersionId,
    });
    if (!head || head.versionId !== completedVersionId) {
      throw new Error("S3 versioning is required for quarantine artifacts");
    }
    if (head.byteLength !== input.expectedByteLength || head.checksumSha256 !== input.expectedSha256) {
      throw new Error("S3 whole-object checksum or byte length differs from submission");
    }
    return {
      backend: "s3", objectKey: input.grant.objectKey, versionId: head.versionId,
      sha256: head.checksumSha256, byteLength: head.byteLength,
    };
  }

  async createUploadParts(input: {
    grant: UploadGrant; partNumbers: number[];
  }): Promise<Array<{ partNumber: number; url: string; headers?: Record<string, string> }>> {
    if (input.grant.method !== "s3-multipart") throw new Error("upload grant is not S3 multipart");
    if (input.partNumbers.length === 0 || input.partNumbers.length > 1_000
      || new Set(input.partNumbers).size !== input.partNumbers.length
      || input.partNumbers.some((part) => !Number.isSafeInteger(part) || part < 1 || part > 10_000)) {
      throw new Error("multipart part-number request is invalid");
    }
    return this.client.signedUploadPartUrls({
      bucket: this.quarantineBucket,
      key: input.grant.objectKey,
      uploadId: requireBackendUploadId(input.grant),
      partNumbers: input.partNumbers,
      expiresAt: input.grant.expiresAt,
    });
  }

  async promoteImmutable(input: {
    ceremonyId: string; generation: number; quarantine: QuarantineArtifact;
  }): Promise<CanonicalArtifact> {
    if (input.quarantine.backend !== "s3" || !input.quarantine.versionId) throw new Error("S3 promotion requires an exact source version");
    const objectKey = `canonical/${input.ceremonyId}/sha256/${input.quarantine.sha256}.zkey`;
    const copied = await this.client.copyImmutable({
      sourceBucket: this.quarantineBucket,
      destinationBucket: this.archiveBucket,
      sourceKey: input.quarantine.objectKey,
      sourceVersionId: input.quarantine.versionId,
      destinationKey: objectKey,
      sha256: input.quarantine.sha256,
    });
    if (!copied.versionId) throw new Error("canonical S3 object has no version ID");
    if (copied.checksumSha256 !== input.quarantine.sha256 || copied.byteLength !== input.quarantine.byteLength) {
      throw new Error("canonical S3 copy does not match the quarantined artifact");
    }
    if (this.options.production && copied.objectLockMode !== "COMPLIANCE") {
      throw new Error("production canonical S3 object is not in Object Lock compliance mode");
    }
    if (this.options.production) {
      assertCanonicalDate(copied.objectLockRetainUntil, "canonical Object Lock retention");
      if (copied.objectLockRetainUntil < this.options.minimumRetentionUntil!) {
        throw new Error("production canonical S3 retention ends before the required horizon");
      }
    }
    return { ...input.quarantine, objectKey, versionId: copied.versionId, immutable: true };
  }

  async findCanonical(ceremonyId: string, sha256: string): Promise<CanonicalArtifact | null> {
    if (!SHA256.test(sha256)) throw new Error("artifact SHA-256 is invalid");
    const objectKey = `canonical/${ceremonyId}/sha256/${sha256}.zkey`;
    const head = await this.client.headVersion({ bucket: this.archiveBucket, key: objectKey });
    if (!head) return null;
    if (!head.versionId || head.checksumSha256 !== sha256) {
      throw new Error("canonical S3 object is not bound to the requested content hash");
    }
    if (this.options.production) {
      if (head.objectLockMode !== "COMPLIANCE" || !head.objectLockRetainUntil) {
        throw new Error("production canonical S3 object is not retention locked");
      }
      assertCanonicalDate(head.objectLockRetainUntil, "canonical Object Lock retention");
      if (head.objectLockRetainUntil < this.options.minimumRetentionUntil!) {
        throw new Error("production canonical S3 retention ends before the required horizon");
      }
    }
    return {
      backend: "s3",
      objectKey,
      versionId: head.versionId,
      sha256,
      byteLength: head.byteLength,
      immutable: true,
    };
  }

  async statCanonical(artifact: CanonicalArtifact): Promise<CanonicalArtifact | null> {
    if (artifact.backend !== "s3" || !SHA256.test(artifact.sha256) || !artifact.versionId) {
      throw new Error("S3 canonical artifact pin is invalid");
    }
    const head = await this.client.headVersion({
      bucket: this.archiveBucket,
      key: artifact.objectKey,
      versionId: artifact.versionId,
    });
    if (!head) return null;
    if (head.versionId !== artifact.versionId
      || head.checksumSha256 !== artifact.sha256
      || head.byteLength !== artifact.byteLength) {
      throw new Error("canonical S3 object differs from its persisted version pin");
    }
    this.assertProductionRetention(head);
    return artifact;
  }

  async downloadUrl(artifact: CanonicalArtifact, expiresInSeconds: number): Promise<string> {
    const exact = await this.statCanonical(artifact);
    if (!exact) throw new Error("canonical artifact not found");
    return this.client.signedDownloadUrl({
      bucket: this.archiveBucket,
      key: exact.objectKey,
      versionId: exact.versionId,
      expiresInSeconds,
    });
  }


  async openCanonical(artifact: CanonicalArtifact, range?: { start: number; endInclusive: number }) {
    if (!this.client.openVersion || artifact.backend !== "s3" || !artifact.versionId) {
      throw new Error("S3 exact-version streaming is unavailable");
    }
    return this.client.openVersion({ bucket: this.archiveBucket, key: artifact.objectKey,
      versionId: artifact.versionId, range });
  }

  async quarantineDownloadUrl(artifact: QuarantineArtifact, expiresInSeconds: number): Promise<string> {
    if (artifact.backend !== "s3" || !artifact.versionId) throw new Error("artifact is not an exact S3 version");
    return this.client.signedDownloadUrl({
      bucket: this.quarantineBucket,
      key: artifact.objectKey,
      versionId: artifact.versionId,
      expiresInSeconds,
    });
  }

  private assertProductionRetention(head: {
    objectLockMode?: string;
    objectLockRetainUntil?: string;
  }): void {
    if (!this.options.production) return;
    if (head.objectLockMode !== "COMPLIANCE" || !head.objectLockRetainUntil) {
      throw new Error("production canonical S3 object is not retention locked");
    }
    assertCanonicalDate(head.objectLockRetainUntil, "canonical Object Lock retention");
    if (head.objectLockRetainUntil < this.options.minimumRetentionUntil!) {
      throw new Error("production canonical S3 retention ends before the required horizon");
    }
  }
}

function requireBackendUploadId(grant: UploadGrant): string {
  if (!grant.backendUploadId) throw new Error("S3 upload grant has no backend multipart ID");
  return grant.backendUploadId;
}

function assertCanonicalDate(value: string, label: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be canonical ISO-8601`);
  }
}
