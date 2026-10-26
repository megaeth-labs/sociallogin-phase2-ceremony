import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { LocalArtifactStore } from "../src/index.js";

describe("LocalArtifactStore", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("stays promotable after an interrupted publish and refuses a corrupt canonical", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-phase2-storage-"));
    roots.push(root);
    const store = new LocalArtifactStore(root, { allowDevelopmentOnly: true });
    const grant = await store.createUpload({
      ceremonyId: "ceremony", leaseId: "lease", uploadId: "upload",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), maxByteLength: 100,
    });
    const quarantine = await store.ingestLocalUpload!({
      grant, body: Readable.from([Buffer.from("candidate")]), maxByteLength: 100,
    });
    const completed = await store.completeUpload({
      grant, expectedSha256: quarantine.sha256, expectedByteLength: 9,
    });

    const canonical = await store.promoteImmutable({ ceremonyId: "ceremony", generation: 1, quarantine: completed });

    // Publishing through a temporary means an interrupted copy can never leave
    // a short file at the content-addressed canonical path. Were one to exist,
    // every retry would re-hash it, mismatch and rethrow, wedging this head
    // permanently — and because recoverVerifiedSubmission runs before every
    // verifier job claim, that would halt the whole ceremony.
    const leftovers = (await readdir(join(root, "canonical", "ceremony", "sha256")))
      .filter((entry) => entry.endsWith(".partial"));
    expect(leftovers).toEqual([]);

    // Replay is idempotent: the canonical path is content-addressed, so a
    // repeated promotion of identical bytes is a no-op rather than an error.
    const replayed = await store.promoteImmutable({ ceremonyId: "ceremony", generation: 1, quarantine: completed });
    expect(replayed.objectKey).toBe(canonical.objectKey);
    expect(await readFile(join(root, canonical.objectKey), "utf8")).toBe("candidate");

    // A canonical file that does not match its own content address is never
    // silently accepted or overwritten.
    await writeFile(join(root, canonical.objectKey), "corrupt");
    await expect(store.promoteImmutable({
      ceremonyId: "ceremony", generation: 1, quarantine: completed,
    })).rejects.toThrow();
  });

  it("hashes a bounded quarantine upload and promotes it without overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-phase2-storage-"));
    roots.push(root);
    const store = new LocalArtifactStore(root, { allowDevelopmentOnly: true });
    const grant = await store.createUpload({
      ceremonyId: "ceremony", leaseId: "lease", uploadId: "upload",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), maxByteLength: 100,
    });
    const quarantine = await store.ingestLocalUpload!({
      grant, body: Readable.from([Buffer.from("candidate")]), maxByteLength: 100,
    });
    expect(quarantine.sha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(store.completeUpload({
      grant, expectedSha256: "0".repeat(64), expectedByteLength: 9,
    })).rejects.toThrow(/differs/u);
    const completed = await store.completeUpload({
      grant, expectedSha256: quarantine.sha256, expectedByteLength: 9,
    });
    const canonical = await store.promoteImmutable({ ceremonyId: "ceremony", generation: 1, quarantine: completed });
    expect(canonical.immutable).toBe(true);
    expect(await readFile(join(root, canonical.objectKey), "utf8")).toBe("candidate");
    const range = await store.openCanonical!(canonical, {
      start: 1,
      endInclusive: 4,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of range) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("andi");
    await expect(store.promoteImmutable({ ceremonyId: "ceremony", generation: 1, quarantine: completed })).resolves.toMatchObject({ sha256: completed.sha256 });
  });

  it("removes an oversized partial upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-phase2-storage-"));
    roots.push(root);
    const store = new LocalArtifactStore(root, { allowDevelopmentOnly: true });
    const grant = await store.createUpload({
      ceremonyId: "ceremony", leaseId: "lease", uploadId: "big",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), maxByteLength: 2,
    });
    await expect(store.ingestLocalUpload!({
      grant, body: Readable.from([Buffer.from("too large")]), maxByteLength: 2,
    })).rejects.toThrow(/maximum/u);
  });

  it("rejects the filesystem root as a storage root", () => {
    expect(() => new LocalArtifactStore("/", { allowDevelopmentOnly: true })).toThrow(/filesystem root/u);
  });
});
