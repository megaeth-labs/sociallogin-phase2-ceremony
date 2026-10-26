import { describe, expect, it } from "vitest";

import {
  S3ArtifactStore,
  type S3ArtifactClient,
} from "../src/index.js";

const SHA = "a".repeat(64);
const RETENTION = "2030-01-01T00:00:00.000Z";

describe("S3ArtifactStore", () => {
  it("separates public and provider upload IDs and pins the completed version", async () => {
    const client = new FakeClient();
    const store = new S3ArtifactStore(client, "quarantine", "archive", {
      production: true,
      minimumRetentionUntil: RETENTION,
    });
    const grant = await store.createUpload({
      ceremonyId: "ceremony",
      leaseId: "lease",
      uploadId: "public-upload",
      expiresAt: "2029-01-01T00:00:00.000Z",
      maxByteLength: 10,
    });
    expect(grant.uploadId).toBe("public-upload");
    expect(grant.backendUploadId).toBe("provider-upload");

    const artifact = await store.completeUpload({
      grant,
      expectedSha256: SHA,
      expectedByteLength: 9,
      multipartParts: [{ partNumber: 1, etag: "etag" }],
    });
    expect(artifact.versionId).toBe("quarantine-version");
    expect(client.completedWith).toBe("provider-upload");
    expect(client.lastHeadVersion).toBe("quarantine-version");
  });

  it("reconciles a lost multipart response only for matching immutable bytes", async () => {
    const client = new FakeClient();
    client.failCompletion = true;
    const store = new S3ArtifactStore(client, "quarantine", "archive", {
      production: false,
    });
    const grant = await store.createUpload({
      ceremonyId: "ceremony",
      leaseId: "lease",
      uploadId: "public-upload",
      expiresAt: "2029-01-01T00:00:00.000Z",
      maxByteLength: 10,
    });
    await expect(store.completeUpload({
      grant,
      expectedSha256: SHA,
      expectedByteLength: 9,
      multipartParts: [{ partNumber: 1, etag: "etag" }],
    })).resolves.toMatchObject({ versionId: "quarantine-version", sha256: SHA });
  });

  it("requires sufficient COMPLIANCE retention and version-pins downloads", async () => {
    const client = new FakeClient();
    const store = new S3ArtifactStore(client, "quarantine", "archive", {
      production: true,
      minimumRetentionUntil: RETENTION,
    });
    const quarantine = {
      backend: "s3" as const,
      objectKey: "quarantine/c/l/u.zkey",
      versionId: "quarantine-version",
      sha256: SHA,
      byteLength: 9,
    };
    const canonical = await store.promoteImmutable({
      ceremonyId: "ceremony",
      generation: 1,
      quarantine,
    });
    expect(canonical).toMatchObject({ immutable: true, versionId: "archive-version" });

    await expect(store.downloadUrl(canonical, 60)).resolves.toBe("https://download.test/object");
    expect(client.lastDownloadVersion).toBe("archive-version");
    expect(client.lastHeadVersion).toBe("archive-version");

    client.retainUntil = "2029-12-31T23:59:59.000Z";
    await expect(store.promoteImmutable({
      ceremonyId: "ceremony",
      generation: 1,
      quarantine,
    })).rejects.toThrow(/retention ends before/i);
  });
});

class FakeClient implements S3ArtifactClient {
  failCompletion = false;
  completedWith?: string;
  lastHeadVersion?: string;
  lastDownloadVersion?: string;
  retainUntil = "2031-01-01T00:00:00.000Z";

  async createMultipartUpload() {
    return { uploadId: "provider-upload", uploadUrl: "https://upload.test/object" };
  }

  async signedUploadPartUrls() {
    return [{ partNumber: 1, url: "https://upload.test/part" }];
  }

  async completeMultipartUpload(input: { uploadId: string }) {
    this.completedWith = input.uploadId;
    if (this.failCompletion) throw new Error("response lost");
    return { versionId: "quarantine-version" };
  }

  async headVersion(input: { bucket: string; key: string; versionId?: string }) {
    this.lastHeadVersion = input.versionId;
    const archive = input.bucket === "archive";
    const archiveVersion = input.versionId ?? "newer-logical-key-version";
    return {
      versionId: archive ? archiveVersion : "quarantine-version",
      byteLength: 9,
      checksumSha256: archive && input.versionId === undefined
        ? "b".repeat(64)
        : SHA,
      objectLockMode: archive ? "COMPLIANCE" : undefined,
      objectLockRetainUntil: archive ? this.retainUntil : undefined,
    };
  }

  async copyImmutable() {
    return {
      versionId: "archive-version",
      objectLockMode: "COMPLIANCE",
      objectLockRetainUntil: this.retainUntil,
      checksumSha256: SHA,
      byteLength: 9,
    };
  }

  async signedDownloadUrl(input: { versionId?: string }) {
    this.lastDownloadVersion = input.versionId;
    return "https://download.test/object";
  }
}
