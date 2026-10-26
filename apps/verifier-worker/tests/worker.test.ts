import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VERIFICATION_REPORT_SIGNATURE_DOMAIN, verifyEnvelope } from "@moss/phase2-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { hashFile } from "../src/hashing.js";
import type { VerificationPassRunner } from "../src/types.js";
import { verifyLocalJob } from "../src/worker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("verifyLocalJob", () => {
  it.each([{ passesPerOperator: 1, bellman: false }, { passesPerOperator: 2, bellman: false }, { passesPerOperator: 1, bellman: true }])("signs isolated successful passes: %j", async ({ passesPerOperator, bellman }) => {
    const directory = await mkdtemp(join(tmpdir(), "phase2-worker-"));
    temporaryDirectories.push(directory);
    const paths = {
      predecessor: join(directory, "predecessor.zkey"),
      candidate: join(directory, "candidate.zkey"),
      genesis: join(directory, "genesis.zkey"),
      ptau: join(directory, "powers.ptau"),
    };
    await Promise.all([
      writeFile(paths.predecessor, "predecessor"),
      writeFile(paths.candidate, "candidate"),
      writeFile(paths.genesis, "genesis"),
      writeFile(paths.ptau, "ptau"),
    ]);
    const [predecessor, candidate, genesis, ptau] = await Promise.all(Object.values(paths).map((path) => hashFile(path)));
    let calls = 0;
    const runner: VerificationPassRunner = {
      async run() {
        calls += 1;
        return {
          result: "valid",
          prefixValid: true,
          verifyFromInit: !bellman,
          ...(bellman ? { bellmanTransition: true } : {}),
          observedContributionName: bellman ? null : "participant-1",
          observedContributionHashBlake2b512: "a".repeat(128),
          observedContributionIndex: 1,
        };
      },
    };
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const result = await verifyLocalJob({
      job: {
        schemaVersion: 1,
        type: "moss.phase2.verification-job.v1",
        jobId: "11111111-1111-4111-8111-111111111111",
        attempt: 1,
        leaseExpiresAt: "2030-01-01T00:00:00.000Z",
        ceremonyId: "22222222-2222-4222-8222-222222222222",
        submissionId: "33333333-3333-4333-8333-333333333333",
        predecessor: { ...predecessor, urls: ["https://example.test/predecessor"], downloadUrl: "https://example.test/predecessor" },
        candidate: { ...candidate, urls: ["https://example.test/candidate"], downloadUrl: "https://example.test/candidate" },
        genesisSha256: genesis.sha256,
        ptauSha256: ptau.sha256,
        expectedContributionName: "participant-1",
        expectedContributionHashBlake2b512: "a".repeat(128),
        maxPredecessorContributions: 0,
      },
      predecessorPath: paths.predecessor,
      candidatePath: paths.candidate,
      genesisPath: paths.genesis,
      ptauPath: paths.ptau,
    }, runner, {
      verificationMethod: bellman ? "bellman-transition-v1" : undefined,
      operatorKeyId: "operator-1",
      privateKey,
      verifierImageDigest: `sha256:${"b".repeat(64)}`,
      passesPerOperator,
      passTimeoutMs: 30_000,
      production: true,
      trustedArtifactValidation: { genesisSha256: genesis.sha256, ptauSha256: ptau.sha256 },
    });
    expect(calls).toBe(passesPerOperator);
    expect(result.valid).toBe(true);
    expect(result.reports).toHaveLength(passesPerOperator);
    for (const envelope of result.reports) {
      const report = verifyEnvelope(envelope as never, { publicKey, domain: VERIFICATION_REPORT_SIGNATURE_DOMAIN }) as { result: string };
      expect(report.result).toBe("valid");
      expect(envelope.payload.jobId).toBe("11111111-1111-4111-8111-111111111111");
      expect(envelope.payload.jobAttempt).toBe(1);
      expect(envelope.payload.expectedContributionIndex).toBe(1);
      expect(envelope.payload.observedContributionName).toBe(bellman ? null : "participant-1");
      expect(envelope.payload.checks.verifyFromInit).toBe(!bellman);
    }
  });

  it("does not invoke verification when a pinned artifact hash differs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "phase2-worker-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artifact");
    await writeFile(path, "artifact");
    const digest = await hashFile(path);
    const { privateKey } = generateKeyPairSync("ed25519");
    let called = false;
    const result = await verifyLocalJob({
      job: {
        schemaVersion: 1,
        type: "moss.phase2.verification-job.v1",
        jobId: "11111111-1111-4111-8111-111111111111",
        attempt: 1,
        leaseExpiresAt: "2030-01-01T00:00:00.000Z",
        ceremonyId: "22222222-2222-4222-8222-222222222222",
        submissionId: "33333333-3333-4333-8333-333333333333",
        predecessor: { ...digest, urls: ["https://example.test/a"], downloadUrl: "https://example.test/a" },
        candidate: { ...digest, sha256: "f".repeat(64), urls: ["https://example.test/b"], downloadUrl: "https://example.test/b" },
        genesisSha256: digest.sha256,
        ptauSha256: digest.sha256,
        expectedContributionName: "participant-1",
        expectedContributionHashBlake2b512: "a".repeat(128),
        maxPredecessorContributions: 0,
      },
      predecessorPath: path,
      candidatePath: path,
      genesisPath: path,
      ptauPath: path,
    }, { async run() { called = true; throw new Error("must not run"); } }, {
      operatorKeyId: "operator-1",
      privateKey,
      verifierImageDigest: `sha256:${"b".repeat(64)}`,
      passesPerOperator: 1,
      passTimeoutMs: 30_000,
      production: true,
      trustedArtifactValidation: { genesisSha256: digest.sha256, ptauSha256: digest.sha256 },
    });
    expect(called).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.reports[0].payload.errorCode).toBe("ARTIFACT_HASH_MISMATCH");
  });
});
