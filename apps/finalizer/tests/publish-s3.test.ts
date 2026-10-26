import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { AwsPublicationStore } from "../src/publish/s3.js";
import { ConditionalWriteConflict } from "../src/publish/types.js";

type Sent = { name: string; input: Record<string, unknown> };

function client(respond: (command: Sent) => unknown): { client: S3Client; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    client: {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const entry = { name: command.constructor.name, input: command.input };
        sent.push(entry);
        return respond(entry);
      },
    } as unknown as S3Client,
  };
}

const failure = (name: string, httpStatusCode: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
const SHA = "ab".repeat(32);

describe("AWS publication store", () => {
  it("writes only when the key is empty, with a whole-object SHA-256 checksum", async () => {
    const { client: s3, sent } = client(() => ({ VersionId: "v1" }));
    const store = new AwsPublicationStore(s3, "archive");
    await expect(store.putObject({ key: "k", body: new Uint8Array([1]), sha256: SHA, contentType: "application/json" }))
      .resolves.toEqual({ versionId: "v1" });
    expect(sent[0]).toMatchObject({
      name: "PutObjectCommand",
      input: { Bucket: "archive", Key: "k", IfNoneMatch: "*", ChecksumSHA256: Buffer.from(SHA, "hex").toString("base64"), Metadata: { sha256: SHA } },
    });
  });

  it("maps precondition failures to a conditional conflict", async () => {
    const { client: s3 } = client(() => { throw failure("PreconditionFailed", 412); });
    const store = new AwsPublicationStore(s3, "archive");
    await expect(store.putObject({ key: "k", body: new Uint8Array([1]), sha256: SHA, contentType: "x" }))
      .rejects.toBeInstanceOf(ConditionalWriteConflict);
    await expect(store.completeMultipart({ key: "k", uploadId: "u", parts: [{ partNumber: 1, etag: "e" }] }))
      .rejects.toBeInstanceOf(ConditionalWriteConflict);
  });

  it("lists every version and delete marker at the exact key across pages", async () => {
    let page = 0;
    const { client: s3 } = client(() => (page++ === 0
      ? { IsTruncated: true, NextKeyMarker: "k", NextVersionIdMarker: "v1",
          Versions: [{ Key: "k", VersionId: "v1", Size: 3 }, { Key: "k2", VersionId: "x", Size: 1 }] }
      : { IsTruncated: false, DeleteMarkers: [{ Key: "k", VersionId: "d1" }] }));
    await expect(new AwsPublicationStore(s3, "archive").listVersions("k")).resolves.toEqual([
      { versionId: "v1", deleteMarker: false, byteLength: 3 },
      { versionId: "d1", deleteMarker: true, byteLength: 0 },
    ]);
  });

  it("reads retention and the recorded digest, and treats a missing version as absent", async () => {
    const until = new Date("2036-01-01T00:00:00.000Z");
    const { client: s3 } = client((command) => {
      if (command.input.VersionId === "gone") throw failure("NotFound", 404);
      return { VersionId: "v1", ContentLength: 9, Metadata: { sha256: SHA }, ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: until };
    });
    const store = new AwsPublicationStore(s3, "archive");
    await expect(store.headVersion("k", "v1")).resolves.toEqual({
      versionId: "v1", byteLength: 9, sha256: SHA, objectLockMode: "COMPLIANCE", objectLockRetainUntil: until.toISOString(),
    });
    await expect(store.headVersion("k", "gone")).resolves.toBeNull();
  });

  it("treats aborting an already finished upload as done", async () => {
    const { client: s3 } = client(() => { throw failure("NoSuchUpload", 404); });
    await expect(new AwsPublicationStore(s3, "archive").abortMultipart({ key: "k", uploadId: "u" })).resolves.toBeUndefined();
  });

  it("refuses an unversioned bucket and, when retention is required, one without Object Lock", async () => {
    const unversioned = client(() => ({ Status: "Suspended" }));
    await expect(new AwsPublicationStore(unversioned.client, "archive").assertConfiguration({ requireObjectLock: false }))
      .rejects.toThrow("enabled versioning");
    const unlocked = client((command) => command.name === "GetBucketVersioningCommand" ? { Status: "Enabled" } : {});
    await expect(new AwsPublicationStore(unlocked.client, "archive").assertConfiguration({ requireObjectLock: true }))
      .rejects.toThrow("Object Lock");
  });
});
