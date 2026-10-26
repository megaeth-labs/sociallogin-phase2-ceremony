import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inspectBellman, MemoryByteSource } from "@moss/phase2-zkey-inspect";
import { beforeAll, describe, expect, it } from "vitest";

import { auditCeremony } from "../../src/audit/audit.js";
import { DirectoryFetcher } from "../../src/audit/fetcher.js";
import { NativeBellmanTransitionRunner } from "../../src/audit/runner.js";
import { REPLAY_STATE_FILE, type TransitionRunner } from "../../src/audit/types.js";
import { createAuditFixture, NATIVE_VERIFIER, type AuditFixture } from "./fixture.js";

const native = existsSync(NATIVE_VERIFIER);

/** Wraps the native runner to count calls and observe concurrency. */
function counting(inner: TransitionRunner, options: { binarySha256?: string; abortAfter?: number; controller?: AbortController } = {}) {
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const runner: TransitionRunner = {
    binarySha256: options.binarySha256 ?? inner.binarySha256,
    async run(input) {
      stats.calls += 1;
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        await new Promise((done) => setTimeout(done, 5));
        const verdict = await inner.run(input);
        if (options.abortAfter !== undefined && stats.calls >= options.abortAfter) options.controller?.abort();
        return verdict;
      } finally {
        stats.inFlight -= 1;
      }
    },
  };
  return { runner, stats };
}

async function audit(fixture: AuditFixture, runner?: TransitionRunner, extra: { workDir?: string; jobs?: number; chunkSize?: number; signal?: AbortSignal; scope?: "full" | "records" } = {}) {
  const options = { ...fixture.options(extra.workDir), jobs: extra.jobs, chunkSize: extra.chunkSize, scope: extra.scope ?? "full" };
  return await auditCeremony(options, { fetcher: new DirectoryFetcher(fixture.mirror), runner, signal: extra.signal });
}

describe.skipIf(!native)("ceremony audit with the native Bellman verifier", () => {
  let runner: NativeBellmanTransitionRunner;
  beforeAll(async () => { runner = await NativeBellmanTransitionRunner.create(NATIVE_VERIFIER, 60_000); });

  it("passes a valid sealed chain and writes a deterministic report", async () => {
    const fixture = await createAuditFixture({ contributions: 4 });
    const first = await audit(fixture, runner);
    expect(first.report.failures).toEqual([]);
    expect(first.report.result).toBe("passed");
    expect(first.report.scope).toBe("full");
    expect(first.report.type).toBe("moss.phase2.ceremony-audit.v1");
    expect(first.report.counts).toMatchObject({ contributions: 4, publicationBundles: 5, verifierReports: 4, operationalUpdates: 1,
      transitionsReplayed: 4, browserContributions: 3, cliContributions: 1, distinctParticipants: 2 });
    expect(Object.values(first.report.checks).every((check) => check.result === "passed")).toBe(true);
    expect(first.report.transitions.map((entry) => entry.result)).toEqual(["valid", "valid", "valid", "valid"]);
    expect(first.report.toolchain.bellmanVerifier.binarySha256).toBe(runner.binarySha256);
    expect(first.report.sealed?.generation).toBe(4);

    // A fresh, independent run reproduces the exact bytes.
    const second = await audit(fixture, runner, { workDir: join(fixture.root, "work-2") });
    expect(second.reportSha256).toBe(first.reportSha256);
    expect(await readFile(second.reportPath)).toEqual(await readFile(first.reportPath));
    const run = JSON.parse(await readFile(first.runPath, "utf8"));
    expect(run.auditSha256).toBe(first.reportSha256);
    expect(run.transitions).toHaveLength(4);
  });

  it("fails when an archived snapshot byte changes after signing", async () => {
    const fixture = await createAuditFixture();
    const path = join(fixture.mirror, fixture.paths.artifacts[2]!);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(path, bytes);
    const { report } = await audit(fixture, runner);
    expect(report.result).toBe("failed");
    expect(report.failures).toContainEqual({ check: "replay", generation: 2, message: "transition replay error: successor bytes do not match the signed receipt" });
    expect(report.failures).toContainEqual({ check: "replay", generation: 3, message: "transition replay error: predecessor bytes do not match the signed receipt" });
    expect(report.transitions[0]!.result).toBe("valid");
  });

  it("rejects a cryptographically invalid transition even when every record agrees", async () => {
    const tampered = await createAuditFixture({ hooks: { params: (generation, bytes) => generation === 2 ? corruptH(bytes, 2) : bytes } });
    const { report } = await audit(tampered, runner);
    expect(report.checks.receipts.result).toBe("passed");
    expect(report.checks.verifierReports.result).toBe("passed");
    expect(report.checks.replay.result).toBe("failed");
    expect(report.transitions[1]).toMatchObject({ generation: 2, result: "invalid" });
    expect(report.failures.some((failure) => failure.generation === 2 && failure.message.startsWith("transition rejected by the native verifier"))).toBe(true);
  });

  it("fails a receipt signed by a key the manifest does not authorize", async () => {
    const fixture = await createAuditFixture({ hooks: { receiptSigner: (generation) => generation === 2 ? "rogue" : "coordinator" } });
    const { report } = await audit(fixture, runner);
    expect(report.result).toBe("failed");
    expect(report.failures).toContainEqual({ check: "receipts", generation: 2, message: "receipt signature is invalid" });
    expect(report.failures).toContainEqual({ check: "replay", generation: 2, message: "transition not replayed: no authenticated receipt" });
    expect(report.transitions[1]!.result).toBe("not-run");
  });

  it("fails a broken transcript hash chain", async () => {
    const fixture = await createAuditFixture({ hooks: { event: (generation, event) => {
      if (generation === 2) event.previousEventHash = "7".repeat(64);
    } } });
    const { report } = await audit(fixture, runner);
    expect(report.failures).toContainEqual({ check: "transcript", generation: 2, message: "transcript event does not link to the previous event" });
    expect(report.result).toBe("failed");
  });

  it("fails a missing evidence bundle and a missing archived checkpoint", async () => {
    const fixture = await createAuditFixture();
    await rm(join(fixture.mirror, fixture.paths.bundles[1]!));
    await rm(join(fixture.mirror, fixture.paths.checkpoints[2]!));
    const { report } = await audit(fixture, runner);
    expect(report.failures.some((failure) => failure.check === "publications" && failure.generation === 1 && failure.message.startsWith("mirror is missing"))).toBe(true);
    expect(report.failures.some((failure) => failure.check === "archivedCheckpoints" && failure.generation === 2)).toBe(true);
    expect(report.failures).toContainEqual({ check: "replay", generation: 1, message: "transition not replayed: no authenticated receipt" });
    expect(report.result).toBe("failed");
  });

  it("fails when a publication record is omitted from the supplied list", async () => {
    const fixture = await createAuditFixture();
    const options = fixture.options();
    options.publications.splice(2, 1);
    const { report } = await auditCeremony(options, { fetcher: new DirectoryFetcher(fixture.mirror), runner });
    expect(report.failures).toContainEqual({ check: "publications", generation: 2, message: "publication record is missing" });
  });

  it("fails a verifier report produced under a different method", async () => {
    const fixture = await createAuditFixture({ hooks: { report: (generation, report) => {
      if (generation !== 3) return;
      report.verificationMethod = "snarkjs-zkey-v1";
      delete report.checks.bellmanTransition;
      report.checks.verifyFromInit = true;
      // Otherwise internally consistent, so only the method binding can fail.
      report.observedContributionName = report.expectedContributionName;
    } } });
    const { report } = await audit(fixture, runner);
    expect(report.failures).toContainEqual({ check: "verifierReports", generation: 3, message: "verifier report method differs from the signed policy" });
  });

  it("fails when the verified identifier differs from the signed claim", async () => {
    const fixture = await createAuditFixture({ hooks: { claimedHash: (generation, actual) => generation === 2 ? "8".repeat(128) : actual } });
    const { report } = await audit(fixture, runner);
    expect(report.checks.receipts.result).toBe("passed");
    expect(report.failures).toContainEqual({ check: "replay", generation: 2, message: "verified contribution identifier differs from the signed receipt" });
    expect(report.transitions[1]).toMatchObject({ result: "invalid", expectedContributionHashBlake2b512: "8".repeat(128) });
  });

  it("resumes an interrupted replay without repeating finished transitions", async () => {
    const fixture = await createAuditFixture({ contributions: 5 });
    const workDir = join(fixture.root, "resume");
    const controller = new AbortController();
    const interrupted = counting(runner, { abortAfter: 2, controller });
    const first = await audit(fixture, interrupted.runner, { workDir, signal: controller.signal, chunkSize: 100 });
    expect(first.report.result).toBe("failed");
    expect(first.report.failures.some((failure) => failure.message === "transition replay was interrupted")).toBe(true);
    const state = (await readFile(join(workDir, REPLAY_STATE_FILE), "utf8")).trim().split("\n");
    expect(state).toHaveLength(2);

    const resumed = counting(runner);
    const second = await audit(fixture, resumed.runner, { workDir });
    expect(second.report.result).toBe("passed");
    expect(resumed.stats.calls).toBe(3);
    expect(second.run.transitions.filter((entry) => entry.resumed).map((entry) => entry.generation)).toEqual([1, 2]);

    // The deterministic report does not depend on how the work was split.
    const fresh = await audit(fixture, runner, { workDir: join(fixture.root, "fresh") });
    expect(second.reportSha256).toBe(fresh.reportSha256);

    // A different verifier binary invalidates earlier results.
    const other = counting(runner, { binarySha256: "9".repeat(64) });
    await audit(fixture, other.runner, { workDir });
    expect(other.stats.calls).toBe(5);
  });

  it("replays in parallel across jobs", async () => {
    const fixture = await createAuditFixture({ contributions: 8 });
    const parallel = counting(runner);
    const { report } = await audit(fixture, parallel.runner, { jobs: 3, chunkSize: 2 });
    expect(report.result).toBe("passed");
    expect(parallel.stats.calls).toBe(8);
    expect(parallel.stats.maxInFlight).toBeGreaterThan(1);
    expect(report.transitions.map((entry) => entry.generation)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("ceremony records audit", () => {
  it("passes records-only scope without a native verifier and marks replay not run", async () => {
    const fixture = await createAuditFixture();
    const { report } = await audit(fixture, undefined, { scope: "records" });
    expect(report.result).toBe("passed");
    expect(report.scope).toBe("records");
    expect(report.checks.replay.result).toBe("not-run");
    expect(report.transitions).toEqual([]);
  });

  it("never passes a full audit without a native verifier", async () => {
    const fixture = await createAuditFixture();
    const { report } = await audit(fixture, undefined);
    expect(report.result).toBe("failed");
    expect(report.failures).toContainEqual({ check: "replay", generation: null, message: "no native transition verifier was configured" });
  });

  it("fails closed when the operational update history is not supplied", async () => {
    const fixture = await createAuditFixture();
    const options = { ...fixture.options(), operationalUpdates: null, scope: "records" as const };
    const { report } = await auditCeremony(options, { fetcher: new DirectoryFetcher(fixture.mirror) });
    expect(report.failures).toContainEqual({ check: "operationalUpdates", generation: null, message: "operational update history was not supplied" });
    // Without the update, the newer website release (generation 2) and CLI release (generation 3) are unauthorized.
    expect(report.failures.filter((failure) => failure.check === "clientReleases").map((failure) => failure.generation)).toEqual([2, 3]);
  });

  it("fails a receipt list that disagrees with the archive", async () => {
    const fixture = await createAuditFixture();
    const receipts = structuredClone(fixture.receipts);
    receipts[1]!.payload.participantPseudonym = "someone-else";
    const options = { ...fixture.options(), receipts, scope: "records" as const };
    const { report } = await auditCeremony(options, { fetcher: new DirectoryFetcher(fixture.mirror) });
    expect(report.failures).toContainEqual({ check: "receipts", generation: 2, message: "archived receipt differs from the coordinator's receipt list" });
  });

  it("reports an authority failure without trusting any record", async () => {
    const fixture = await createAuditFixture();
    const options = { ...fixture.options(), expectedRootKeySpkiSha256: "0".repeat(64), scope: "records" as const };
    const { report } = await auditCeremony(options, { fetcher: new DirectoryFetcher(fixture.mirror) });
    expect(report.result).toBe("failed");
    expect(report.ceremonyId).toBeNull();
    expect(report.failures).toEqual([{ check: "authority", generation: null, message: "manifest root public key does not match the expected fingerprint" }]);
    expect(report.checks.receipts.result).toBe("not-run");
  });
});

/** Flips one byte inside the first H-query element, keeping the file framed. */
async function corruptH(bytes: Buffer, count: number): Promise<Buffer> {
  const layout = await inspectBellman(new MemoryByteSource(bytes), count);
  const copy = Buffer.from(bytes);
  copy[layout.vectors[1]!.offset + 10] ^= 0x01;
  return copy;
}
