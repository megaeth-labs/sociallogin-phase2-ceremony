import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ContributionJournalV1 } from "./journal.js";
import type { LeaseResponse } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const workerUrl = new URL("../dist/contribution-worker.js", import.meta.url);
const repositoryRoot = join(packageRoot, "../..");
const nativeVerifier = join(repositoryRoot, "packages/bellman-verify/target/release/moss-bellman-verify");
const verifierWorkerDist = join(repositoryRoot, "apps/verifier-worker/dist");

let home: string;
let fixtures: string;
// Imported after HOME points at a temporary directory: the CLI fixes its
// workspace root from the home directory when the module loads.
let files: typeof import("./files.js");
let contribution: typeof import("./contribution.js");
let candidate: typeof import("./candidate.js");

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "moss-cli-bellman-home-"));
  process.env.HOME = home;
  fixtures = await mkdtemp(join(tmpdir(), "moss-cli-bellman-fixtures-"));
  execFileSync(process.execPath, [join(packageRoot, "build.mjs")], { cwd: packageRoot, stdio: "ignore" });
  execFileSync(process.execPath, [join(packageRoot, "tests/generate-bellman-genesis.mjs"), fixtures], { stdio: "ignore" });
  files = await import("./files.js");
  contribution = await import("./contribution.js");
  candidate = await import("./candidate.js");
}, 120_000);

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(fixtures, { recursive: true, force: true });
});

async function contribute(directory: string, format: "zkey" | "bellman") {
  const extension = format === "bellman" ? "params" : "zkey";
  const predecessorPath = join(directory, `predecessor.${extension}`);
  const successorPath = join(directory, `successor.${extension}`);
  await copyFile(join(fixtures, `genesis.${extension}`), predecessorPath);
  const contributionHashBlake2b512 = await contribution.computeContribution({
    predecessorPath,
    successorPath,
    contributionName: "participant-1",
    format,
  }, workerUrl);
  return { predecessorPath, successorPath, contributionHashBlake2b512 };
}

describe("Bellman CLI contributions", () => {
  it("appends exactly one 384-byte record whose hash is the submitted identifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moss-cli-bellman-"));
    try {
      const result = await contribute(directory, "bellman");
      expect(result.contributionHashBlake2b512).toMatch(/^[a-f0-9]{128}$/u);
      const [before, after] = await Promise.all([stat(result.predecessorPath), stat(result.successorPath)]);
      expect(after.size).toBe(before.size + 384);
      await candidate.checkBellmanAppend({ ...result, baseGeneration: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!existsSync(nativeVerifier) || !existsSync(verifierWorkerDist))(
    "passes the native transition verifier with the same identifier",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "moss-cli-bellman-native-"));
      try {
        const result = await contribute(directory, "bellman");
        const verified = spawnSync(process.execPath, [
          join(repositoryRoot, "packages/bellman-verify/verify.mjs"),
          result.predecessorPath,
          result.successorPath,
          "0",
        ], { encoding: "utf8", env: { ...process.env, BELLMAN_VERIFIER_PATH: nativeVerifier } });
        expect(verified.status, verified.stderr).toBe(0);
        expect(verified.stdout).toContain(result.contributionHashBlake2b512);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("rejects a wrong length, a changed fixed section and a mismatched identifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moss-cli-bellman-reject-"));
    try {
      const result = await contribute(directory, "bellman");
      const changed = join(directory, "changed.params");

      await copyFile(result.successorPath, changed);
      await truncate(changed, (await stat(changed)).size - 1);
      await expect(candidate.checkBellmanAppend({ ...result, successorPath: changed, baseGeneration: 0 }))
        .rejects.toThrow(/malformed/u);

      const bytes = await readFile(result.successorPath);
      bytes[10] ^= 0xff;
      await writeFile(changed, bytes);
      await expect(candidate.checkBellmanAppend({ ...result, successorPath: changed, baseGeneration: 0 }))
        .rejects.toThrow(/malformed/u);

      await expect(candidate.checkBellmanAppend({
        ...result,
        contributionHashBlake2b512: "0".repeat(128),
        baseGeneration: 0,
      })).rejects.toThrow(/identifier/u);

      await expect(candidate.checkBellmanAppend({ ...result, baseGeneration: 1 }))
        .rejects.toThrow(/malformed/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("reuses a retained, matching contribution after a restart and ignores a changed one", async () => {
    const workspace = await files.createContributionWorkspace();
    const workspaceId = workspace.split("/").pop()!;
    const result = await contribute(workspace, "bellman");
    const predecessor = await files.hashFile(result.predecessorPath);
    const successor = await files.hashFile(result.successorPath);
    const lease = {
      leaseId: "lease-1",
      state: "ACTIVE",
      baseGeneration: 0,
      expectedContributionName: "participant-1",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      predecessor: { sha256: predecessor.sha256, byteLength: predecessor.byteLength, downloadUrl: "https://artifacts.example/0.params" },
    } as unknown as LeaseResponse;
    const journal = {
      schemaVersion: 1,
      ceremonyUrl: "https://coordinator.example/v1/ceremonies/test",
      ceremonyId: "test",
      participantId: "00000000-0000-4000-8000-000000000000",
      leaseId: "lease-1",
      workspaceId,
      evidence: {
        manifestSha256: "a".repeat(64),
        predecessorSha256: predecessor.sha256,
        predecessorByteLength: predecessor.byteLength,
        successorSha256: successor.sha256,
        successorByteLength: successor.byteLength,
        contributionHashBlake2b512: result.contributionHashBlake2b512,
        contributionName: "participant-1",
        baseGeneration: 0,
        participantPseudonym: "participant-1",
      },
      updatedAt: new Date().toISOString(),
    } satisfies ContributionJournalV1;
    const input = { journal, lease, manifestSha256: "a".repeat(64), participantName: "participant-1", format: "bellman" as const };

    const saved = await candidate.savedCandidate(input);
    expect(saved?.successor.sha256).toBe(successor.sha256);
    expect(saved?.contributionHashBlake2b512).toBe(result.contributionHashBlake2b512);

    expect(await candidate.savedCandidate({ ...input, lease: { ...lease, leaseId: "lease-2" } })).toBeNull();
    expect(await candidate.savedCandidate({ ...input, manifestSha256: "b".repeat(64) })).toBeNull();

    const bytes = await readFile(result.successorPath);
    bytes[bytes.length - 1] ^= 0x01;
    await writeFile(result.successorPath, bytes);
    expect(await candidate.savedCandidate(input)).toBeNull();
    await files.removeContributionWorkspace(workspace);
    expect(await candidate.savedCandidate(input)).toBeNull();
  }, 60_000);

  it("keeps computing zkey contributions for zkey epochs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moss-cli-zkey-"));
    try {
      await mkdir(directory, { recursive: true });
      const result = await contribute(directory, "zkey");
      expect(result.contributionHashBlake2b512).toMatch(/^[a-f0-9]{128}$/u);
      const [before, after] = await Promise.all([stat(result.predecessorPath), stat(result.successorPath)]);
      expect(after.size).toBeGreaterThan(before.size);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("contribution worker integrity", () => {
  it("refuses a worker whose hash differs from the embedded release value", async () => {
    await expect(contribution.assertContributionWorker(workerUrl, "0".repeat(64))).rejects.toThrow(/differs from this CLI release/);
  });

  it("embeds the built worker's hash in the pinned bundle", async () => {
    const workerSha256 = createHash("sha256").update(await readFile(workerUrl)).digest("hex");
    expect(await readFile(new URL("../dist/index.js", import.meta.url), "utf8")).toContain(`"${workerSha256}"`);
    await expect(contribution.assertContributionWorker(workerUrl, workerSha256)).resolves.toBeUndefined();
  });
});
