import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CeremonyManifestV1 } from "@moss/phase2-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { resolveCliReleaseSha256 } from "./release.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

/** Write a stand-in bundle and return its path and hash. */
async function bundle(contents: string): Promise<{ path: string; sha256: string }> {
  const dir = await mkdtemp(join(tmpdir(), "moss-cli-release-"));
  directories.push(dir);
  const path = join(dir, "index.js");
  await writeFile(path, contents);
  return { path, sha256: createHash("sha256").update(contents).digest("hex") };
}

function manifest(input: {
  requirePinnedClientRelease: boolean;
  releases: string[];
  allowCliReleaseUpdates?: boolean;
}): CeremonyManifestV1 {
  return {
    ...(input.allowCliReleaseUpdates === undefined ? {} : {
      operationalPolicy: { minHeartbeatGraceSeconds: 30, maxHeartbeatGraceSeconds: 600, allowWebReleaseUpdates: true,
        allowCliReleaseUpdates: input.allowCliReleaseUpdates },
    }),
    contributionPolicy: { requirePinnedClientRelease: input.requirePinnedClientRelease },
    cliReleases: input.releases.map((sha256) => ({
      sha256,
      byteLength: 1,
      urls: [],
      sourceCommit: "0".repeat(40),
    })),
  } as unknown as CeremonyManifestV1;
}

describe("CLI release pinning", () => {
  it("authorizes a build whose own bytes the manifest lists", async () => {
    // The hash describes the file actually executing, so it cannot be
    // embedded at build time: doing so would change the artifact and so change
    // the hash, which never converges.
    const built = await bundle("console.log('authorized build');\n");
    await expect(
      resolveCliReleaseSha256(
        manifest({ requirePinnedClientRelease: true, releases: [built.sha256] }),
        { modulePath: built.path },
      ),
    ).resolves.toBe(built.sha256);
  });

  it("authorizes a later build from verified updates only when the manifest allows it, fetching only when needed", async () => {
    const built = await bundle("console.log('updated build');\n");
    let fetched = 0;
    const updatedReleases = async () => { fetched += 1; return [built.sha256]; };
    await expect(resolveCliReleaseSha256(
      manifest({ requirePinnedClientRelease: true, releases: ["a".repeat(64)], allowCliReleaseUpdates: true }),
      { modulePath: built.path, updatedReleases },
    )).resolves.toBe(built.sha256);
    expect(fetched).toBe(1);
    for (const allowCliReleaseUpdates of [false, undefined]) {
      await expect(resolveCliReleaseSha256(
        manifest({ requirePinnedClientRelease: true, releases: ["a".repeat(64)], allowCliReleaseUpdates }),
        { modulePath: built.path, updatedReleases },
      )).rejects.toThrow(/not authorized/);
    }
    expect(fetched).toBe(1);
    // A build the manifest pins never needs the update history.
    await expect(resolveCliReleaseSha256(
      manifest({ requirePinnedClientRelease: true, releases: [built.sha256], allowCliReleaseUpdates: true }),
      { modulePath: built.path, updatedReleases },
    )).resolves.toBe(built.sha256);
    expect(fetched).toBe(1);
    await expect(resolveCliReleaseSha256(
      manifest({ requirePinnedClientRelease: true, releases: ["a".repeat(64)], allowCliReleaseUpdates: true }),
      { modulePath: built.path, updatedReleases: async () => ["b".repeat(64)] },
    )).rejects.toThrow(/not authorized/);
  });

  it("refuses a build the manifest does not list", async () => {
    const built = await bundle("console.log('unauthorized build');\n");
    await expect(
      resolveCliReleaseSha256(
        manifest({ requirePinnedClientRelease: true, releases: ["a".repeat(64)] }),
        { modulePath: built.path },
      ),
    ).rejects.toThrow(/not authorized by the signed ceremony manifest/u);
  });

  it("notices a single changed byte", async () => {
    const original = await bundle("console.log('authorized build');\n");
    const tampered = await bundle("console.log('authorized buiId');\n");
    await expect(
      resolveCliReleaseSha256(
        manifest({ requirePinnedClientRelease: true, releases: [original.sha256] }),
        { modulePath: tampered.path },
      ),
    ).rejects.toThrow(/not authorized/u);
  });

  it("skips the check when the ceremony does not require a pinned release", async () => {
    const built = await bundle("console.log('dev build');\n");
    await expect(
      resolveCliReleaseSha256(
        manifest({ requirePinnedClientRelease: false, releases: [] }),
        { modulePath: built.path },
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the build cannot read itself", async () => {
    await expect(
      resolveCliReleaseSha256(
        manifest({ requirePinnedClientRelease: true, releases: ["b".repeat(64)] }),
        { modulePath: join(tmpdir(), "moss-cli-release-absent", "index.js") },
      ),
    ).rejects.toThrow(/could not read itself/u);
  });
});
