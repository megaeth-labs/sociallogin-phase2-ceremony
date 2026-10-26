import { S3Client, GetObjectCommand, PutObjectCommand, GetBucketVersioningCommand, GetObjectLockConfigurationCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ArtifactRef } from "@moss/phase2-protocol";
import type { MirrorArchive } from "./witness.js";

/** Separate account credentials; never reads from the coordinator's buckets directly. */
export class S3MirrorArchive implements MirrorArchive {
  constructor(private readonly client: S3Client, private readonly config: {
    bucket: string; publicBaseUrl: string; retentionUntil: string; artifactOrigins: string[];
  }) {
    const url = new URL(config.publicBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("invalid mirror public origin");
    const until = new Date(config.retentionUntil);
    if (until.toISOString() !== config.retentionUntil || until.valueOf() <= Date.now()) throw new Error("invalid mirror retention horizon");
    if (!config.artifactOrigins.length || config.artifactOrigins.some(origin => new URL(origin).origin !== origin || !origin.startsWith("https://"))) throw new Error("invalid artifact origins");
  }
  async ready(): Promise<void> {
    const versioning = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.config.bucket }));
    const lock = await this.client.send(new GetObjectLockConfigurationCommand({ Bucket: this.config.bucket }));
    if (versioning.Status !== "Enabled" || lock.ObjectLockConfiguration?.ObjectLockEnabled !== "Enabled") throw new Error("mirror requires versioning and Object Lock");
  }
  async read(key: string): Promise<Buffer | null> {
    const value = await this.get(key, 4 * 1024 * 1024, true);
    return value?.bytes ?? null;
  }
  async put(key: string, bytes: Buffer) {
    if (!key.startsWith("evidence/witness/") || !bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error("invalid witness evidence");
    const hash = createHash("sha256").update(bytes).digest("hex");
    return this.write(key, bytes, bytes.length, hash);
  }
  async mirror(artifact: ArtifactRef): Promise<void> {
    if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 || artifact.byteLength > 5 * 1024 ** 3
      || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("invalid mirrored artifact");
    const key = `artifacts/sha256/${artifact.sha256}`;
    const existing = await this.get(key, artifact.byteLength);
    if (existing) {
      if (existing.sha256 !== artifact.sha256 || existing.byteLength !== artifact.byteLength) throw new Error("mirror artifact collision");
      return;
    }
    const url = artifact.urls.map(value => new URL(value)).find(value => value.protocol === "https:" && !value.username && !value.password && !value.hash && this.config.artifactOrigins.includes(value.origin));
    if (!url) throw new Error("artifact has no allowlisted HTTPS source");
    const directory = await mkdtemp(join(tmpdir(), "moss-witness-"));
    try {
      const path = join(directory, "artifact");
      const file = await open(path, "wx", 0o600);
      const hash = createHash("sha256"); let length = 0;
      try {
        const response = await fetch(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30 * 60_000) });
        if (!response.ok || !response.body) throw new Error("artifact download failed");
        const reader = response.body.getReader();
        try {
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            length += part.value.length;
            if (length > artifact.byteLength) throw new Error("artifact exceeds signed size");
            hash.update(part.value); await file.writeFile(part.value);
          }
        } finally { await reader.cancel(); }
      } finally { await file.close(); }
      if (length !== artifact.byteLength || hash.digest("hex") !== artifact.sha256) throw new Error("artifact digest mismatch");
      const body = createReadStream(path);
      try { await this.write(key, body, length, artifact.sha256); } finally { body.destroy(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  private async write(key: string, body: Buffer | Readable, byteLength: number, sha256: string) {
    if (Date.parse(this.config.retentionUntil) <= Date.now()) throw new Error("mirror retention horizon expired");
    let versionId: string | undefined;
    try {
      const result = await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: body,
        ContentLength: byteLength, IfNoneMatch: "*", ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
        ServerSideEncryption: "AES256", ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: new Date(this.config.retentionUntil) }),
        { abortSignal: AbortSignal.timeout(30 * 60_000) });
      versionId = result.VersionId;
    } catch {
      // Lost response or a race: reconcile only independently checked locked bytes.
    }
    const stored = await this.get(key, byteLength, false, versionId);
    if (!stored || stored.sha256 !== sha256 || stored.byteLength !== byteLength) throw new Error("immutable mirror write failed or conflicted");
    const url = new URL(`${this.config.publicBaseUrl.replace(/\/$/, "")}/${key}`);
    url.searchParams.set("versionId", stored.versionId);
    return { sha256, versionId: stored.versionId, url: url.toString() };
  }
  private async get(key: string, limit: number, collect = false, versionId?: string): Promise<{
    bytes?: Buffer; sha256: string; byteLength: number; versionId: string;
  } | null> {
    let response;
    try { response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }), { abortSignal: AbortSignal.timeout(30 * 60_000) }); }
    catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey") return null;
      throw new Error("mirror read failed");
    }
    if (!(response.Body instanceof Readable)) throw new Error("mirror object has no body");
    const stream = response.Body;
    try {
      if (!response.VersionId || response.VersionId === "null" || (versionId && response.VersionId !== versionId)
        || response.ObjectLockMode !== "COMPLIANCE" || !response.ObjectLockRetainUntilDate
        || response.ObjectLockRetainUntilDate < new Date(this.config.retentionUntil)) throw new Error("mirror object is not retention locked");
      const hash = createHash("sha256"), chunks: Buffer[] = []; let length = 0;
      for await (const chunk of stream) {
        length += chunk.length; if (length > limit) throw new Error("mirror object exceeds size bound");
        hash.update(chunk); if (collect) chunks.push(chunk);
      }
      return { ...(collect ? { bytes: Buffer.concat(chunks) } : {}), sha256: hash.digest("hex"), byteLength: length, versionId: response.VersionId };
    } finally { stream.destroy(); }
  }
}
