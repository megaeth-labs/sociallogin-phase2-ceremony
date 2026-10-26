import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import {
  ConditionalWriteConflict,
  type PublicationStore,
  type StoredVersion,
  type StoredVersionDetail,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * AWS S3 publication store. Credentials come from the SDK's default provider
 * chain at run time; nothing here names a profile. Metadata `sha256` is only a
 * routing hint: publication re-downloads every object and hashes the bytes.
 */
export class AwsPublicationStore implements PublicationStore {
  constructor(private readonly client: S3Client, private readonly bucket: string) {
    if (!bucket) throw new Error("publication bucket is required");
  }

  /** Refuses buckets that could overwrite or drop a published version. */
  async assertConfiguration(options: { requireObjectLock: boolean }): Promise<void> {
    const versioning = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket }));
    if (versioning.Status !== "Enabled") throw new Error("publication bucket requires enabled versioning");
    if (!options.requireObjectLock) return;
    const lock = await this.client.send(new GetObjectLockConfigurationCommand({ Bucket: this.bucket }));
    if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== "Enabled") {
      throw new Error("publication bucket requires Object Lock");
    }
  }

  async listVersions(key: string): Promise<StoredVersion[]> {
    const found: StoredVersion[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (;;) {
      const page = await this.client.send(new ListObjectVersionsCommand({
        Bucket: this.bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker,
      }));
      for (const version of page.Versions ?? []) {
        if (version.Key !== key) continue;
        found.push({ versionId: requireText(version.VersionId, "version ID"), deleteMarker: false, byteLength: Number(version.Size ?? 0) });
      }
      for (const marker of page.DeleteMarkers ?? []) {
        if (marker.Key !== key) continue;
        found.push({ versionId: requireText(marker.VersionId, "delete marker version ID"), deleteMarker: true, byteLength: 0 });
      }
      if (!page.IsTruncated) return found;
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    }
  }

  async headVersion(key: string, versionId: string): Promise<StoredVersionDetail | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }));
      const sha256 = head.Metadata?.sha256;
      return {
        versionId: requireText(head.VersionId, "version ID"),
        byteLength: Number(head.ContentLength ?? -1),
        ...(sha256 && SHA256.test(sha256) ? { sha256 } : {}),
        ...(head.ObjectLockMode ? { objectLockMode: head.ObjectLockMode } : {}),
        ...(head.ObjectLockRetainUntilDate ? { objectLockRetainUntil: head.ObjectLockRetainUntilDate.toISOString() } : {}),
      };
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }

  async putObject(input: Parameters<PublicationStore["putObject"]>[0]): Promise<{ versionId: string }> {
    const result = await conditional(() => this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentLength: input.body.byteLength,
      ContentType: input.contentType,
      ChecksumSHA256: base64(input.sha256),
      Metadata: { sha256: input.sha256 },
      ServerSideEncryption: "AES256",
      IfNoneMatch: "*",
    })));
    return { versionId: requireText(result.VersionId, "version ID") };
  }

  async createMultipart(input: Parameters<PublicationStore["createMultipart"]>[0]): Promise<{ uploadId: string }> {
    const result = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ChecksumAlgorithm: "SHA256",
      Metadata: { sha256: input.sha256 },
      ServerSideEncryption: "AES256",
    }));
    return { uploadId: requireText(result.UploadId, "multipart upload ID") };
  }

  async uploadPart(input: Parameters<PublicationStore["uploadPart"]>[0]) {
    const result = await this.client.send(new UploadPartCommand({
      Bucket: this.bucket,
      Key: input.key,
      UploadId: input.uploadId,
      PartNumber: input.partNumber,
      Body: input.body,
      ContentLength: input.body.byteLength,
      ChecksumSHA256: base64(input.sha256),
    }));
    return {
      etag: requireText(result.ETag, "part ETag"),
      ...(result.ChecksumSHA256 ? { checksumSha256: result.ChecksumSHA256 } : {}),
    };
  }

  async completeMultipart(input: Parameters<PublicationStore["completeMultipart"]>[0]): Promise<{ versionId: string }> {
    const result = await conditional(() => this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: input.key,
      UploadId: input.uploadId,
      MultipartUpload: {
        Parts: input.parts.map((part) => ({
          PartNumber: part.partNumber,
          ETag: part.etag,
          ...(part.checksumSha256 ? { ChecksumSHA256: part.checksumSha256 } : {}),
        })),
      },
      IfNoneMatch: "*",
    })));
    return { versionId: requireText(result.VersionId, "version ID") };
  }

  async abortMultipart(input: { key: string; uploadId: string }): Promise<void> {
    try {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: input.key, UploadId: input.uploadId }));
    } catch (error) {
      // Already completed or aborted: nothing is left to clean up.
      if (nameOf(error) === "NoSuchUpload" || statusOf(error) === 404) return;
      throw error;
    }
  }
}

async function conditional<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const status = statusOf(error);
    if (status === 412 || status === 409 || nameOf(error) === "PreconditionFailed") {
      throw new ConditionalWriteConflict();
    }
    throw error;
  }
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function nameOf(error: unknown): string | undefined {
  return (error as { name?: string } | null)?.name;
}

function base64(hex: string): string {
  if (!SHA256.test(hex)) throw new Error("SHA-256 must be 64 lowercase hex characters");
  return Buffer.from(hex, "hex").toString("base64");
}

function requireText(value: string | undefined, label: string): string {
  if (!value) throw new Error(`S3 returned no ${label}`);
  return value;
}
