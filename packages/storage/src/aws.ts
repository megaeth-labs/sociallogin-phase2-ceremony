import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, HeadObjectCommand, GetObjectCommand,
  PutObjectCommand, GetBucketVersioningCommand, GetObjectLockConfigurationCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { S3ArtifactClient } from "./types.js";

type ObjectInfo = NonNullable<Awaited<ReturnType<S3ArtifactClient["headVersion"]>>>;

/** AWS implementation. No metadata/ETag/composite checksum is treated as a content hash. */
export class AwsS3ArtifactClient implements S3ArtifactClient {
  private readonly verifiedVersionDigests = new Map<string, Promise<string>>();
  constructor(private readonly client: S3Client, private readonly options: {
    quarantineBucket: string;
    archiveBucket: string;
    retentionUntil: string;
    maxArtifactByteLength: number;
    now?: () => number;
    presign?: typeof getSignedUrl;
  }) {
    const until = new Date(options.retentionUntil);
    if (!Number.isFinite(until.valueOf()) || until.toISOString() !== options.retentionUntil
      || until.valueOf() <= this.now()) throw new Error("S3 retention horizon must be a future canonical date");
    if (!Number.isSafeInteger(options.maxArtifactByteLength) || options.maxArtifactByteLength < 1
      || options.maxArtifactByteLength > 5 * 1024 ** 3) throw new Error("S3 artifact limit exceeds conditional single-PUT promotion capacity");
    if (!options.quarantineBucket || !options.archiveBucket || options.quarantineBucket === options.archiveBucket) {
      throw new Error("S3 quarantine and archive must be distinct buckets");
    }
  }

  async assertConfiguration(): Promise<void> {
    for (const bucket of [this.options.quarantineBucket, this.options.archiveBucket]) {
      const result = await this.client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      if (result.Status !== "Enabled") throw new Error("S3 artifact buckets require enabled versioning");
    }
    const lock = await this.client.send(new GetObjectLockConfigurationCommand({ Bucket: this.options.archiveBucket }));
    if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== "Enabled") {
      throw new Error("S3 archive requires Object Lock");
    }
  }

  async createMultipartUpload(input: Parameters<S3ArtifactClient["createMultipartUpload"]>[0]) {
    this.assertBucket(input.bucket, "quarantine");
    this.uploadLifetime(input.expiresAt);
    if (input.maxByteLength > this.options.maxArtifactByteLength || input.maxByteLength < 1) {
      throw new Error("upload exceeds configured artifact limit");
    }
    const result = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: input.bucket, Key: input.key, ContentType: "application/octet-stream",
      ServerSideEncryption: "AES256",
    }));
    if (!result.UploadId) throw new Error("S3 did not return a multipart ID");
    // Parts are authorized individually through the authenticated coordinator.
    return { uploadId: result.UploadId };
  }

  async signedUploadPartUrls(input: Parameters<S3ArtifactClient["signedUploadPartUrls"]>[0]) {
    this.assertBucket(input.bucket, "quarantine");
    const expiresIn = this.uploadLifetime(input.expiresAt);
    if (!input.partNumbers.length || input.partNumbers.length > 1000
      || new Set(input.partNumbers).size !== input.partNumbers.length
      || input.partNumbers.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 10000)) {
      throw new Error("invalid multipart part numbers");
    }
    return await Promise.all(input.partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await this.presign(new UploadPartCommand({ Bucket: input.bucket, Key: input.key,
        UploadId: input.uploadId, PartNumber: partNumber }), expiresIn),
    })));
  }

  async completeMultipartUpload(input: Parameters<S3ArtifactClient["completeMultipartUpload"]>[0]) {
    this.assertBucket(input.bucket, "quarantine");
    if (!input.parts.length || input.parts.length > 10000
      || input.parts.some((part, index) => part.partNumber !== index + 1 || !part.etag)) {
      throw new Error("multipart completion must contain ordered contiguous parts");
    }
    const result = await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: input.bucket, Key: input.key, UploadId: input.uploadId,
      MultipartUpload: { Parts: input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
    }));
    return { versionId: requireVersion(result.VersionId) };
  }

  async headVersion(input: Parameters<S3ArtifactClient["headVersion"]>[0]): Promise<ObjectInfo | null> {
    this.assertBucket(input.bucket);
    let head;
    try {
      head = await this.client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.key,
        ...(input.versionId ? { VersionId: requireVersion(input.versionId) } : {}) }));
    } catch (error) {
      if (status(error) === 404) return null;
      throw error;
    }
    const versionId = requireVersion(head.VersionId);
    if (input.versionId && input.versionId !== versionId) throw new Error("S3 returned a different object version");
    const byteLength = this.assertLength(head.ContentLength);
    // A version ID names immutable bytes. Recheck HEAD/retention each time,
    // but do not stream a 368 MB artifact on every dashboard poll. The cache
    // contains only digests computed from full exact-version reads, never ETags.
    const cacheKey = JSON.stringify([input.bucket, input.key, versionId, byteLength]);
    let digest = this.verifiedVersionDigests.get(cacheKey);
    if (!digest) {
      digest = this.hashExactVersion({ ...input, versionId }, byteLength);
      if (this.verifiedVersionDigests.size >= 128) {
        this.verifiedVersionDigests.delete(this.verifiedVersionDigests.keys().next().value!);
      }
      this.verifiedVersionDigests.set(cacheKey, digest);
    }
    let checksumSha256: string;
    try { checksumSha256 = await digest; }
    catch (error) {
      if (this.verifiedVersionDigests.get(cacheKey) === digest) this.verifiedVersionDigests.delete(cacheKey);
      throw error;
    }
    return { versionId, byteLength, checksumSha256,
      objectLockMode: head.ObjectLockMode,
      objectLockRetainUntil: head.ObjectLockRetainUntilDate?.toISOString() };
  }

  private async hashExactVersion(input: { bucket: string; key: string; versionId: string }, byteLength: number): Promise<string> {
    const body = await this.openVersion(input);
    const hash = createHash("sha256");
    let read = 0;
    try {
      for await (const chunk of body) {
        read += chunk.length;
        if (read > byteLength) throw new Error("S3 object exceeds its declared length");
        hash.update(chunk);
      }
    } finally { body.destroy(); }
    if (read !== byteLength) throw new Error("S3 object is truncated");
    return hash.digest("hex");
  }

  async copyImmutable(input: Parameters<S3ArtifactClient["copyImmutable"]>[0]) {
    this.assertBucket(input.sourceBucket, "quarantine");
    this.assertBucket(input.destinationBucket, "archive");
    if (!/^[a-f0-9]{64}$/u.test(input.sha256)) throw new Error("invalid promotion SHA-256");
    const destination = { bucket: input.destinationBucket, key: input.destinationKey };
    const existing = await this.headVersion(destination);
    if (existing) return this.assertLocked(existing, input.sha256);
    const source = await this.headVersion({ bucket: input.sourceBucket, key: input.sourceKey,
      versionId: requireVersion(input.sourceVersionId) });
    if (!source || source.checksumSha256 !== input.sha256) throw new Error("promotion source content does not match");
    const body = await this.openVersion({ bucket: input.sourceBucket, key: input.sourceKey, versionId: input.sourceVersionId });
    let versionId: string | undefined;
    try {
      // CopyObject has no destination create-if-absent guarantee. Stream an
      // exact source version into conditional PUT instead. S3 checks this full
      // SHA-256 and atomically refuses a second writer to the canonical key.
      const result = await this.client.send(new PutObjectCommand({
        Bucket: input.destinationBucket, Key: input.destinationKey, Body: body,
        ContentLength: source.byteLength, ContentType: "application/octet-stream",
        IfNoneMatch: "*", ChecksumAlgorithm: "SHA256",
        ChecksumSHA256: Buffer.from(input.sha256, "hex").toString("base64"),
        ServerSideEncryption: "AES256", ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: new Date(this.options.retentionUntil),
      }));
      versionId = requireVersion(result.VersionId);
    } catch (error) {
      // Covers 412 races and ambiguous completion (response lost after PUT).
      // Only a fully checked locked object can turn an error into success.
      const recovered = await this.headVersion(destination).catch(() => null);
      if (!recovered) throw error;
      return this.assertLocked(recovered, input.sha256, source.byteLength);
    } finally { body.destroy(); }
    const copied = await this.headVersion({ ...destination, versionId });
    if (!copied) throw new Error("canonical object missing after promotion");
    return this.assertLocked(copied, input.sha256, source.byteLength);
  }

  async signedDownloadUrl(input: Parameters<S3ArtifactClient["signedDownloadUrl"]>[0]) {
    this.assertBucket(input.bucket);
    if (!Number.isSafeInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > 3600) {
      throw new Error("invalid download URL lifetime");
    }
    return this.presign(new GetObjectCommand({ Bucket: input.bucket, Key: input.key,
      VersionId: requireVersion(input.versionId) }), input.expiresInSeconds);
  }

  async openVersion(input: { bucket: string; key: string; versionId: string;
    range?: { start: number; endInclusive: number } }): Promise<Readable> {
    this.assertBucket(input.bucket);
    const result = await this.client.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key,
      VersionId: requireVersion(input.versionId),
      ...(input.range ? { Range: `bytes=${input.range.start}-${input.range.endInclusive}` } : {}) }));
    if (!(result.Body instanceof Readable)) throw new Error("S3 did not return a readable object");
    if (result.VersionId !== input.versionId) {
      result.Body.destroy();
      throw new Error("S3 returned a different download version");
    }
    return result.Body;
  }

  async publishBytes(key: string, bytes: Buffer): Promise<{ versionId: string; sha256: string }> {
    if (!key.startsWith("evidence/") || bytes.length < 1 || bytes.length > 4 * 1024 * 1024) {
      throw new Error("invalid evidence publication");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const target = { bucket: this.options.archiveBucket, key };
    let versionId: string | undefined;
    try {
      const result = await this.client.send(new PutObjectCommand({ Bucket: target.bucket, Key: key,
        Body: bytes, ContentLength: bytes.length, ContentType: "application/json", IfNoneMatch: "*",
        ChecksumAlgorithm: "SHA256", ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
        ServerSideEncryption: "AES256", ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: new Date(this.options.retentionUntil) }));
      versionId = requireVersion(result.VersionId);
    } catch (error) {
      const recovered = await this.headVersion(target).catch(() => null);
      if (!recovered) throw error;
      return { versionId: this.assertLocked(recovered, sha256, bytes.length).versionId, sha256 };
    }
    const stored = await this.headVersion({ ...target, versionId });
    if (!stored) throw new Error("published evidence not found");
    return { versionId: this.assertLocked(stored, sha256, bytes.length).versionId, sha256 };
  }

  private assertLocked(value: ObjectInfo, sha256: string, byteLength?: number) {
    if (value.checksumSha256 !== sha256 || (byteLength !== undefined && value.byteLength !== byteLength)
      || value.objectLockMode !== "COMPLIANCE" || !value.objectLockRetainUntil
      || value.objectLockRetainUntil < this.options.retentionUntil) {
      throw new Error("canonical S3 object fails content or retention verification");
    }
    return { ...value, objectLockMode: value.objectLockMode, objectLockRetainUntil: value.objectLockRetainUntil };
  }
  private assertLength(value: number | undefined): number {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > this.options.maxArtifactByteLength) {
      throw new Error("S3 artifact length is outside configured bounds");
    }
    return value!;
  }
  private assertBucket(value: string, kind?: "archive" | "quarantine") {
    const allowed = kind === "archive" ? [this.options.archiveBucket] : kind === "quarantine"
      ? [this.options.quarantineBucket] : [this.options.archiveBucket, this.options.quarantineBucket];
    if (!allowed.includes(value)) throw new Error("S3 bucket is not configured for this operation");
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private uploadLifetime(expiresAt: string): number {
    const seconds = Math.floor((Date.parse(expiresAt) - this.now()) / 1000);
    if (!Number.isFinite(seconds) || seconds < 1) throw new Error("upload grant expired");
    return Math.min(seconds, 900);
  }
  private presign(command: GetObjectCommand | UploadPartCommand, expiresIn: number) {
    const sign = this.options.presign ?? getSignedUrl;
    return command instanceof GetObjectCommand
      ? sign(this.client, command, { expiresIn })
      : sign(this.client, command, { expiresIn });
  }
}

function requireVersion(value: string | undefined): string {
  if (!value || value === "null") throw new Error("S3 object requires a non-null version ID");
  return value;
}
function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/** Uses the standard AWS role/SSO credential chain, never static keys in configuration. */
export function createAwsArtifactClient(options: {
  region: string; quarantineBucket: string; archiveBucket: string;
  retentionUntil: string; maxArtifactByteLength: number;
}) {
  return new AwsS3ArtifactClient(new S3Client({ region: options.region,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" }), options);
}
