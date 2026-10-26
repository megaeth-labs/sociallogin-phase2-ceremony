import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { AwsS3ArtifactClient } from "../src/aws.js";

const bytes = Buffer.from("synthetic fixture, not ceremony material");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const until = "2030-01-01T00:00:00.000Z";
function fixture() {
  let archived = false;
  const calls: Array<{ name: string; input: any }> = [];
  const send = vi.fn(async (command: any): Promise<any> => {
    const name = command.constructor.name;
    const input = command.input;
    calls.push({ name, input });
    switch (name) {
      case "GetBucketVersioningCommand": return { Status: "Enabled" };
      case "GetObjectLockConfigurationCommand": return { ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } };
      case "HeadObjectCommand":
        if (input.Bucket === "archive" && !archived) throw { $metadata: { httpStatusCode: 404 } };
        return { VersionId: input.Bucket === "archive" ? "dest-v1" : "source-v1", ContentLength: bytes.length,
          // Deliberately bogus metadata and composite checksum must be ignored.
          Metadata: { sha256: "f".repeat(64) }, ChecksumSHA256: "not-a-full-file-hash-2",
          ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: new Date(until) };
      case "GetObjectCommand": return { VersionId: input.VersionId, Body: Readable.from([bytes]) };
      case "PutObjectCommand":
        for await (const _ of input.Body) { /* consume streaming body */ }
        archived = true;
        return { VersionId: "dest-v1" };
      case "CreateMultipartUploadCommand": return { UploadId: "test-upload" };
      case "CompleteMultipartUploadCommand": return { VersionId: "source-v1" };
      default: throw new Error(`unexpected command ${name}`);
    }
  });
  const presign = vi.fn(async (_client: any, _command: any, _options: any) => "https://example.invalid/test");
  const adapter = new AwsS3ArtifactClient({ send } as unknown as S3Client, {
    quarantineBucket: "quarantine", archiveBucket: "archive", retentionUntil: until,
    maxArtifactByteLength: 1000, now: () => Date.parse("2029-01-01T00:00:00.000Z"), presign,
  });
  return { adapter, send, calls, presign, setArchived: () => { archived = true; } };
}
const promotion = { sourceBucket: "quarantine", sourceKey: "candidate", sourceVersionId: "source-v1",
  destinationBucket: "archive", destinationKey: "canonical", sha256 };

describe("AWS artifact adapter", () => {
  it("hashes actual version-pinned bytes, ignoring metadata and multipart checksums", async () => {
    const f = fixture();
    const head = await f.adapter.headVersion({ bucket: "quarantine", key: "candidate" });
    expect(head?.checksumSha256).toBe(sha256);
    expect(f.calls.find((c) => c.name === "GetObjectCommand")?.input.VersionId).toBe("source-v1");
  });
  it("shares verified immutable reads across polling but refreshes retention metadata", async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 5 }, () => f.adapter.headVersion({ bucket: "quarantine", key: "candidate", versionId: "source-v1" })));
    expect(f.calls.filter(c => c.name === "GetObjectCommand")).toHaveLength(1);
    expect(f.calls.filter(c => c.name === "HeadObjectCommand")).toHaveLength(5);
    f.send.mockResolvedValueOnce({ VersionId: "source-v1", ContentLength: bytes.length, ObjectLockMode: "GOVERNANCE" });
    expect((await f.adapter.headVersion({ bucket: "quarantine", key: "candidate", versionId: "source-v1" }))?.objectLockMode).toBe("GOVERNANCE");
    await f.adapter.headVersion({ bucket: "quarantine", key: "different-key", versionId: "source-v1" });
    expect(f.calls.filter(c => c.name === "GetObjectCommand")).toHaveLength(2);
  });
  it("never reuses a failed read or a digest for a different version", async () => {
    const f = fixture();
    f.send.mockResolvedValueOnce({ VersionId: "source-v1", ContentLength: bytes.length })
      .mockResolvedValueOnce({ VersionId: "source-v1", Body: Readable.from([bytes.subarray(1)]) });
    await expect(f.adapter.headVersion({ bucket: "quarantine", key: "candidate" })).rejects.toThrow(/truncated/);
    expect((await f.adapter.headVersion({ bucket: "quarantine", key: "candidate" }))?.checksumSha256).toBe(sha256);
    const original = f.send.getMockImplementation()!;
    const changed = Buffer.from("a distinct immutable object version");
    f.send.mockImplementation(async (command: any) => {
      if (command.constructor.name === "HeadObjectCommand") return { VersionId: "source-v2", ContentLength: changed.length };
      if (command.constructor.name === "GetObjectCommand") return { VersionId: "source-v2", Body: Readable.from([changed]) };
      return original(command);
    });
    expect((await f.adapter.headVersion({ bucket: "quarantine", key: "candidate" }))?.checksumSha256).toBe(createHash("sha256").update(changed).digest("hex"));
  });
  it("rejects unversioned, truncated, oversized and substituted reads", async () => {
    for (const head of [ { VersionId: "null", ContentLength: bytes.length },
      { VersionId: "source-v1", ContentLength: bytes.length + 1 },
      { VersionId: "source-v1", ContentLength: 1001 },
      { VersionId: "other", ContentLength: bytes.length } ]) {
      const f = fixture();
      f.send.mockResolvedValueOnce(head);
      await expect(f.adapter.headVersion({ bucket: "quarantine", key: "candidate", versionId: "source-v1" })).rejects.toThrow();
    }
  });
  it("requires versioning and Object Lock at startup", async () => {
    const f = fixture();
    await f.adapter.assertConfiguration();
    f.send.mockResolvedValueOnce({ Status: "Suspended" });
    await expect(f.adapter.assertConfiguration()).rejects.toThrow(/versioning/);
    f.send.mockResolvedValueOnce({ Status: "Enabled" }).mockResolvedValueOnce({ Status: "Enabled" }).mockResolvedValueOnce({});
    await expect(f.adapter.assertConfiguration()).rejects.toThrow(/Object Lock/);
  });
  it("promotes with conditional PUT, full SHA256 and retention; retries reuse the same version", async () => {
    const f = fixture();
    const first = await f.adapter.copyImmutable(promotion);
    const second = await f.adapter.copyImmutable(promotion);
    expect(second.versionId).toBe(first.versionId);
    const puts = f.calls.filter((c) => c.name === "PutObjectCommand");
    expect(puts).toHaveLength(1);
    expect(puts[0].input).toMatchObject({ IfNoneMatch: "*", ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: new Date(until) });
  });
  it("reconciles an ambiguous PUT only against matching locked bytes", async () => {
    const f = fixture();
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (command: any) => {
      const result = await original(command);
      if (command.constructor.name === "PutObjectCommand") throw new Error("response lost");
      return result;
    });
    expect((await f.adapter.copyImmutable(promotion)).versionId).toBe("dest-v1");
    await expect(f.adapter.copyImmutable({ ...promotion, sha256: "f".repeat(64) })).rejects.toThrow(/content/);
  });
  it("does not accept missing/short retention when recovering an existing object", async () => {
    const f = fixture(); f.setArchived();
    f.send.mockResolvedValueOnce({ VersionId: "dest-v1", ContentLength: bytes.length, ObjectLockMode: "GOVERNANCE" });
    await expect(f.adapter.copyImmutable(promotion)).rejects.toThrow(/retention/);
  });
  it("bounds upload authorization by lease expiration and requires exact-version downloads", async () => {
    const f = fixture();
    await f.adapter.signedUploadPartUrls({ bucket: "quarantine", key: "candidate", uploadId: "test", partNumbers: [1], expiresAt: "2029-01-01T00:00:10.000Z" });
    expect(f.presign.mock.calls[0][2]).toEqual({ expiresIn: 10 });
    await expect(f.adapter.signedUploadPartUrls({ bucket: "quarantine", key: "candidate", uploadId: "test", partNumbers: [1], expiresAt: "2028-01-01T00:00:00.000Z" })).rejects.toThrow(/expired/);
    await expect(f.adapter.signedDownloadUrl({ bucket: "archive", key: "canonical", expiresInSeconds: 60 })).rejects.toThrow(/version/);
    await expect(f.adapter.headVersion({ bucket: "unapproved", key: "candidate" })).rejects.toThrow(/bucket/);
  });
  it("rejects missing or reordered multipart completion parts", async () => {
    const f = fixture();
    await expect(f.adapter.completeMultipartUpload({ bucket: "quarantine", key: "candidate", uploadId: "test", parts: [{ partNumber: 2, etag: "part" }] })).rejects.toThrow(/contiguous/);
  });
});
