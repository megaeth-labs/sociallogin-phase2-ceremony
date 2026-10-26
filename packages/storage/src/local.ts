import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, rm, stat } from "node:fs/promises";
import { parse, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import type {
  ArtifactStore,
  CanonicalArtifact,
  QuarantineArtifact,
  UploadGrant,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Development/test adapter. Production must use immutable object storage. */
export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly root: string, options: { allowDevelopmentOnly: true }) {
    if (options.allowDevelopmentOnly !== true) throw new Error("local artifact storage is development-only");
    const resolved = resolve(root);
    if (resolved === parse(resolved).root) throw new Error("artifact root cannot be filesystem root");
  }

  async createUpload(input: {
    ceremonyId: string; leaseId: string; uploadId: string; expiresAt: string; maxByteLength: number;
  }): Promise<UploadGrant> {
    for (const [label, value] of [["ceremonyId", input.ceremonyId], ["leaseId", input.leaseId], ["uploadId", input.uploadId]] as const) {
      if (!SAFE_COMPONENT.test(value)) throw new Error(`${label} is unsafe`);
    }
    if (!Number.isSafeInteger(input.maxByteLength) || input.maxByteLength <= 0) throw new Error("maxByteLength is invalid");
    const objectKey = `quarantine/${input.ceremonyId}/${input.leaseId}/${input.uploadId}.zkey`;
    const path = this.safePath(objectKey);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    return { uploadId: input.uploadId, objectKey, expiresAt: input.expiresAt, method: "local-proxy" };
  }

  async ingestLocalUpload(input: {
    grant: UploadGrant; body: Readable; maxByteLength: number;
  }): Promise<QuarantineArtifact> {
    if (input.grant.method !== "local-proxy") throw new Error("upload grant is not local");
    if (Date.now() >= Date.parse(input.grant.expiresAt)) throw new Error("upload grant has expired");
    const path = this.safePath(input.grant.objectKey);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.partial`;
    const handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let byteLength = 0;
    try {
      for await (const value of input.body) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        byteLength += chunk.byteLength;
        if (byteLength > input.maxByteLength) throw new Error("upload exceeds maximum byte length");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0) throw new Error("upload write made no progress");
          offset += bytesWritten;
        }
      }
      if (byteLength === 0) throw new Error("upload is empty");
      await handle.sync();
      await handle.close();
      await link(temporary, path);
      await rm(temporary);
      const artifact: QuarantineArtifact = {
        backend: "local",
        objectKey: input.grant.objectKey,
        versionId: randomUUID(),
        sha256: hash.digest("hex"),
        byteLength,
      };
      return artifact;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async createUploadParts(): Promise<Array<{ partNumber: number; url: string }>> {
    throw new Error("local artifact uploads use one coordinator-proxied body, not multipart URLs");
  }

  async completeUpload(input: {
    grant: UploadGrant; expectedSha256: string; expectedByteLength: number;
  }): Promise<QuarantineArtifact> {
    const actual = await hashFile(this.safePath(input.grant.objectKey));
    if (actual.sha256 !== input.expectedSha256 || actual.byteLength !== input.expectedByteLength) {
      throw new Error("uploaded artifact hash or byte length differs from submission");
    }
    return {
      backend: "local", objectKey: input.grant.objectKey,
      versionId: actual.sha256, sha256: actual.sha256, byteLength: actual.byteLength,
    };
  }

  async promoteImmutable(input: {
    ceremonyId: string; generation: number; quarantine: QuarantineArtifact;
  }): Promise<CanonicalArtifact> {
    if (input.quarantine.backend !== "local") throw new Error("cannot promote a non-local artifact");
    if (!SHA256.test(input.quarantine.sha256)) throw new Error("artifact SHA-256 is invalid");
    const source = this.safePath(input.quarantine.objectKey);
    const actual = await hashFile(source);
    if (actual.sha256 !== input.quarantine.sha256 || actual.byteLength !== input.quarantine.byteLength) {
      throw new Error("quarantine artifact changed before promotion");
    }
    const objectKey = `canonical/${input.ceremonyId}/sha256/${input.quarantine.sha256}.zkey`;
    const destination = this.safePath(objectKey);
    const directory = resolve(destination, "..");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Publish by linking a fully written temporary into place, as
    // ingestLocalUpload does. Copying straight to the canonical path leaves a
    // short file there when the copy is interrupted — ENOSPC is plausible,
    // since quarantine and canonical each keep a full copy of every generation
    // and nothing collects quarantine. Because the path is content-addressed,
    // every later attempt would then hit EEXIST, re-hash the partial file,
    // mismatch and rethrow, wedging promotion for this head permanently.
    const temporary = `${destination}.${randomUUID()}.partial`;
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      const handle = await open(temporary, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, destination);
      // Make the new name itself durable, not just its contents.
      await syncDirectory(directory);
    } catch (error) {
      // Content addressing makes a correct existing file proof that a
      // concurrent or replayed promotion already succeeded.
      const existing = await hashFile(destination).catch(() => null);
      if (
        !existing ||
        existing.sha256 !== input.quarantine.sha256 ||
        existing.byteLength !== input.quarantine.byteLength
      ) {
        throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      backend: "local",
      objectKey,
      versionId: input.quarantine.sha256,
      sha256: input.quarantine.sha256,
      byteLength: input.quarantine.byteLength,
      immutable: true,
    };
  }

  async findCanonical(ceremonyId: string, sha256: string): Promise<CanonicalArtifact | null> {
    if (!SHA256.test(sha256)) throw new Error("artifact SHA-256 is invalid");
    if (!SAFE_COMPONENT.test(ceremonyId)) throw new Error("ceremonyId is unsafe");
    const objectKey = `canonical/${ceremonyId}/sha256/${sha256}.zkey`;
    const path = this.safePath(objectKey);
    const entry = await stat(path).catch(() => null);
    if (!entry?.isFile()) return null;
    const actual = await hashFile(path);
    if (actual.sha256 !== sha256) throw new Error("canonical artifact bytes do not match their content address");
    return { backend: "local", objectKey, versionId: sha256, sha256, byteLength: actual.byteLength, immutable: true };
  }

  async statCanonical(artifact: CanonicalArtifact): Promise<CanonicalArtifact | null> {
    if (artifact.backend !== "local" || artifact.versionId !== artifact.sha256) {
      throw new Error("local canonical artifact pin is invalid");
    }
    const path = this.safePath(artifact.objectKey);
    const entry = await stat(path).catch(() => null);
    if (!entry?.isFile()) return null;
    const actual = await hashFile(path);
    if (actual.sha256 !== artifact.sha256 || actual.byteLength !== artifact.byteLength) {
      throw new Error("local canonical artifact differs from its persisted pin");
    }
    return artifact;
  }

  async openCanonical(
    artifact: CanonicalArtifact,
    range?: { start: number; endInclusive: number },
  ): Promise<Readable> {
    const match = await this.statCanonical(artifact);
    if (!match) throw new Error("canonical artifact not found");
    return createReadStream(this.safePath(match.objectKey), range ? {
      start: range.start,
      end: range.endInclusive,
    } : undefined);
  }

  async openQuarantine(artifact: QuarantineArtifact): Promise<Readable> {
    if (artifact.backend !== "local") throw new Error("artifact is not local");
    const path = this.safePath(artifact.objectKey);
    const actual = await hashFile(path);
    if (actual.sha256 !== artifact.sha256 || actual.byteLength !== artifact.byteLength) {
      throw new Error("quarantine artifact no longer matches its immutable reference");
    }
    return createReadStream(path);
  }

  async quarantineDownloadUrl(artifact: QuarantineArtifact): Promise<string> {
    if (artifact.backend !== "local") throw new Error("artifact is not local");
    return new URL(`file://${this.safePath(artifact.objectKey)}`).toString();
  }

  async downloadUrl(artifact: CanonicalArtifact): Promise<string> {
    const match = await this.statCanonical(artifact);
    if (!match) throw new Error("canonical artifact not found");
    return new URL(`file://${this.safePath(match.objectKey)}`).toString();
  }

  private safePath(objectKey: string): string {
    const root = resolve(this.root);
    const path = resolve(root, objectKey);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("artifact object key escapes storage root");
    return path;
  }
}

async function hashFile(path: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    byteLength += chunk.byteLength;
  }
  return { sha256: hash.digest("hex"), byteLength };
}

/**
 * fsync a directory so a newly linked name survives power loss. Not every
 * platform or filesystem permits opening a directory for this, and failing to
 * harden durability is never a reason to fail a promotion that has otherwise
 * succeeded, so this is best effort.
 */
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync();
  } catch {
    // Directory fsync is unsupported here; the link itself is already made.
  } finally {
    await handle.close();
  }
}
