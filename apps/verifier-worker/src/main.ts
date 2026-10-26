import { BellmanPassRunner } from "./bellman-runner.js";
import { verifyBellmanGenesis } from "./bellman-genesis.js";
import { downloadPinnedInput } from "./input-download.js";
import { ceremonyValidationOptions, contributionGenesis } from "@moss/phase2-protocol";
import { createPrivateKey } from "node:crypto";
import { readFile, stat, mkdir } from "node:fs/promises";

import { inspectBn254Groth16Zkey, FileByteSource } from "@moss/phase2-zkey-inspect";

import { CoordinatorClient } from "./client.js";
import { hashFile } from "./hashing.js";
import { IsolatedPassRunner } from "./pass-runner.js";
import { startJobHeartbeat } from "./job-heartbeat.js";
import { loadVerifiedManifest, assertOperatorKey } from "./manifest.js";
import { materializeJobArtifacts } from "./materialize.js";
import { verifyLocalJob } from "./worker.js";

async function main(): Promise<void> {
  const nodeEnvironment = process.env.NODE_ENV ?? "production";
  if (nodeEnvironment !== "production" && nodeEnvironment !== "development" && nodeEnvironment !== "test") {
    throw new Error("NODE_ENV must be production, development, or test");
  }
  const production = nodeEnvironment === "production";
  const configuration = loadConfiguration(production);
  const [privateKeyPem, token, loaded] = await Promise.all([
    readSecretFile(configuration.privateKeyFile),
    readSecretFile(configuration.internalTokenFile),
    loadVerifiedManifest({
      envelopePath: configuration.manifestEnvelopePath,
      rootPublicKeyPath: configuration.manifestRootPublicKeyFile,
      ...ceremonyValidationOptions(nodeEnvironment, process.env.CEREMONY_MODE),
    }),
  ]);
  const privateKey = createPrivateKey(privateKeyPem);
  assertOperatorKey(loaded.manifest, configuration.operatorKeyId, privateKey, configuration.verifierImageDigest);
  if (configuration.passesPerOperator !== loaded.manifest.verifierPolicy.passesPerOperator) {
    throw new Error("worker pass count does not match the signed manifest policy");
  }
  if (process.env.DOWNLOAD_PINNED_INPUTS === "true") {
    // These URLs are inside the verified root-signed manifest, not job claims.
    await downloadPinnedInput({ artifact: loaded.manifest.relation.genesisZkey,
      destination: configuration.genesisZkeyPath, allowedOrigins: configuration.allowedArtifactOrigins });
    await downloadPinnedInput({ artifact: loaded.manifest.relation.ptau,
      destination: configuration.ptauPath, allowedOrigins: configuration.allowedArtifactOrigins });
  }
  const [genesis, ptau] = await Promise.all([
    hashFile(configuration.genesisZkeyPath),
    hashFile(configuration.ptauPath, { blake2b512: true }),
  ]);
  if (genesis.sha256 !== loaded.manifest.relation.genesisZkey.sha256
    || genesis.byteLength !== loaded.manifest.relation.genesisZkey.byteLength) {
    throw new Error("local genesis zkey does not match the signed manifest");
  }
  if (ptau.sha256 !== loaded.manifest.relation.ptau.sha256
    || ptau.byteLength !== loaded.manifest.relation.ptau.byteLength
    || ptau.blake2b512 !== loaded.manifest.relation.ptau.blake2b512) {
    throw new Error("local ptau does not match the signed manifest");
  }
  const genesisSource = await FileByteSource.open(configuration.genesisZkeyPath);
  try { await inspectBn254Groth16Zkey(genesisSource, { maxContributions: 0 }); }
  finally { await genesisSource.close(); }

  const client = new CoordinatorClient(
    configuration.coordinatorUrl,
    token.trim(),
    configuration.operatorKeyId,
    configuration.maxArtifactByteLength,
  );
  const canonicalGenesis = contributionGenesis(loaded.manifest);
  const bellman = loaded.manifest.verifierPolicy.verificationMethod === "bellman-transition-v1";
  if (bellman) {
    await mkdir(configuration.workRoot, { recursive: true, mode: 0o700 });
    await verifyBellmanGenesis(configuration.genesisZkeyPath, canonicalGenesis, configuration.workRoot, configuration.passTimeoutMs);
  }
  const runner = bellman ? new BellmanPassRunner(requiredEnv("BELLMAN_VERIFIER_PATH")) : new IsolatedPassRunner();
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  process.stdout.write(`verifier worker ${configuration.operatorKeyId} ready\n`);

  while (!stop.signal.aborted) {
    try {
      const job = await client.claim(stop.signal);
      if (job === null) {
        await delay(configuration.pollIntervalMs, stop.signal);
        continue;
      }
      if (job.ceremonyId !== loaded.manifest.ceremonyId
        || job.genesisSha256 !== canonicalGenesis.sha256
        || job.ptauSha256 !== ptau.sha256) {
        throw new Error("claimed job does not match the signed manifest");
      }
      const heartbeat = await startJobHeartbeat({
        client,
        jobId: job.jobId,
        intervalMs: Math.max(
          1_000,
          Math.floor(
            loaded.manifest.contributionPolicy.verifierJobSeconds * 1_000 / 3,
          ),
        ),
        serviceSignal: stop.signal,
      });
      try {
        const artifacts = await materializeJobArtifacts(job, {
          workRoot: configuration.workRoot,
          allowedOrigins: configuration.allowedArtifactOrigins,
          allowedFileRoot: configuration.allowedArtifactFileRoot,
          production,
          signal: heartbeat.signal,
        });
        try {
          const result = await verifyLocalJob({
            job,
            predecessorPath: artifacts.predecessorPath,
            candidatePath: artifacts.candidatePath,
            genesisPath: configuration.genesisZkeyPath,
            ptauPath: configuration.ptauPath,
          }, runner, {
            verificationMethod: loaded.manifest.verifierPolicy.verificationMethod,
            operatorKeyId: configuration.operatorKeyId,
            privateKey,
            verifierImageDigest: configuration.verifierImageDigest,
            passesPerOperator: configuration.passesPerOperator,
            passTimeoutMs: configuration.passTimeoutMs,
            production,
            signal: heartbeat.signal,
            trustedArtifactValidation: {
              genesisSha256: canonicalGenesis.sha256,
              ptauSha256: ptau.sha256,
            },
          });
          for (const report of result.reports) {
            heartbeat.assertHealthy();
            await client.report(report, heartbeat.signal);
          }
        } finally {
          await artifacts.cleanup();
        }
      } finally {
        await heartbeat.stop();
      }
    } catch (error) {
      if (stop.signal.aborted) break;
      process.stderr.write(`verifier worker cycle failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
      await delay(configuration.pollIntervalMs, stop.signal).catch(() => undefined);
    }
  }
}

function loadConfiguration(production: boolean) {
  const passesPerOperator = integerEnv("VERIFIER_PASSES_PER_OPERATOR", 1);
  const maxArtifactByteLength = integerEnv("MAX_ARTIFACT_BYTE_LENGTH", 2 * 1024 * 1024 * 1024);
  const allowedArtifactOrigins = new Set((process.env.VERIFIER_ALLOWED_ARTIFACT_ORIGINS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean).map((value) => new URL(value).origin));
  if (production && allowedArtifactOrigins.size === 0) throw new Error("production requires at least one allowlisted artifact origin");
  const coordinatorUrl = requiredEnv("COORDINATOR_URL");
  if (production && new URL(coordinatorUrl).protocol !== "https:") throw new Error("production coordinator URL must use HTTPS");
  if (production && [...allowedArtifactOrigins].some((origin) => new URL(origin).protocol !== "https:")) {
    throw new Error("production artifact origins must use HTTPS");
  }
  if (production && process.env.VERIFIER_ALLOWED_ARTIFACT_FILE_ROOT !== undefined) {
    throw new Error("production verifier cannot allow file artifact URLs");
  }
  return {
    coordinatorUrl,
    internalTokenFile: requiredEnv("INTERNAL_VERIFIER_BEARER_TOKEN_FILE"),
    operatorKeyId: requiredEnv("VERIFIER_OPERATOR_KEY_ID"),
    privateKeyFile: requiredEnv("VERIFIER_PRIVATE_KEY_FILE"),
    verifierImageDigest: requiredEnv("VERIFIER_IMAGE_DIGEST"),
    passesPerOperator,
    workRoot: requiredEnv("VERIFIER_WORK_ROOT"),
    genesisZkeyPath: requiredEnv("GENESIS_ZKEY_PATH"),
    ptauPath: requiredEnv("PTAU_PATH"),
    manifestEnvelopePath: requiredEnv("CEREMONY_MANIFEST_ENVELOPE_PATH"),
    manifestRootPublicKeyFile: requiredEnv("MANIFEST_ROOT_PUBLIC_KEY_FILE"),
    allowedArtifactOrigins,
    allowedArtifactFileRoot: process.env.VERIFIER_ALLOWED_ARTIFACT_FILE_ROOT,
    maxArtifactByteLength,
    passTimeoutMs: integerEnv("VERIFY_PASS_TIMEOUT_MS", 60 * 60 * 1_000),
    pollIntervalMs: integerEnv("POLL_INTERVAL_MS", 5_000),
  };
}

async function readSecretFile(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("secret path must be a regular file");
  if ((metadata.mode & 0o077) !== 0) throw new Error("secret file permissions must not grant group or other access");
  return await readFile(path, "utf8");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

void main().catch((error) => {
  process.stderr.write(`verifier worker failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
