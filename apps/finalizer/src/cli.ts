#!/usr/bin/env node
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DrandBeaconResolver } from "./beacon.js";
import {
  EthereumBlockBeaconResolver,
  SourceDispatchingBeaconResolver,
} from "./ethereum-beacon.js";
import { finalizeCeremony } from "./finalize.js";
import { releaseSnarkjsCurve } from "./snarkjs-curve.js";
import type { FinalizeOptions } from "./types.js";

const FLAG_NAMES = new Set([
  "--genesis-zkey",
  "--manifest",
  "--root-key",
  "--root-key-id",
  "--root-key-spki-sha256",
  "--sealed-checkpoint",
  "--sealed-head",
  "--sealed-head-sha256",
  "--sealed-head-byte-length",
  "--r1cs",
  "--ptau",
  "--output-dir",
  "--drand-url",
  "--drand-timeout-ms",
  "--eth-rpc-url",
  "--eth-timeout-ms",
]);

export async function runCli(argv: readonly string[]): Promise<void> {
  const values = parseFlags(argv);
  const drandTimeout = optional(values.single, "--drand-timeout-ms");
  const options: FinalizeOptions = {
    allowRehearsal: values.single.has("--allow-rehearsal"),
    genesisZkeyPath: optional(values.single, "--genesis-zkey") === undefined ? undefined : resolve(required(values.single, "--genesis-zkey")),
    manifestEnvelopePath: resolve(required(values.single, "--manifest")),
    rootPublicKeyPath: resolve(required(values.single, "--root-key")),
    expectedRootKeyId: required(values.single, "--root-key-id"),
    expectedRootKeySpkiSha256: required(
      values.single,
      "--root-key-spki-sha256",
    ),
    sealedCheckpointEnvelopePath: resolve(
      required(values.single, "--sealed-checkpoint"),
    ),
    sealedHeadPath: resolve(required(values.single, "--sealed-head")),
    expectedSealedHeadSha256: required(
      values.single,
      "--sealed-head-sha256",
    ),
    expectedSealedHeadByteLength: positiveInteger(
      required(values.single, "--sealed-head-byte-length"),
      "--sealed-head-byte-length",
    ),
    r1csPath: resolve(required(values.single, "--r1cs")),
    ptauPath: resolve(required(values.single, "--ptau")),
    outputDir: resolve(required(values.single, "--output-dir")),
  };

  const ethTimeout = optional(values.single, "--eth-timeout-ms");
  // Build only the resolvers the operator supplied endpoints for; the signed
  // manifest decides which one is actually used.
  const summary = await finalizeCeremony(options, {
    beaconResolver: new SourceDispatchingBeaconResolver({
      ...(values.drandUrls.length > 0
        ? {
            drand: new DrandBeaconResolver({
              endpoints: values.drandUrls,
              timeoutMs:
                drandTimeout === undefined
                  ? undefined
                  : boundedInteger(drandTimeout, "--drand-timeout-ms", 1_000, 120_000),
            }),
          }
        : {}),
      ...(values.ethRpcUrls.length > 0
        ? {
            "ethereum-block": new EthereumBlockBeaconResolver({
              endpoints: values.ethRpcUrls,
              timeoutMs:
                ethTimeout === undefined
                  ? undefined
                  : boundedInteger(ethTimeout, "--eth-timeout-ms", 1_000, 120_000),
            }),
          }
        : {}),
    }),
  });
  process.stdout.write(
    `${JSON.stringify({
      status: "finalized",
      summaryPath: resolve(options.outputDir, "final-artifacts.json"),
      beaconEvidencePath: resolve(
        options.outputDir,
        summary.outputs.beaconEvidence.fileName,
      ),
      finalZkeySha256: summary.outputs.finalZkey.sha256,
    })}\n`,
  );
}

function parseFlags(argv: readonly string[]): {
  single: Map<string, string>;
  drandUrls: string[];
  ethRpcUrls: string[];
} {
  const single = new Map<string, string>();
  const drandUrls: string[] = [];
  const ethRpcUrls: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === "--allow-rehearsal") {
      if (single.has(flag)) throw new Error("duplicate rehearsal flag");
      single.set(flag, "true");
      index -= 1;
      continue;
    }
    const value = argv[index + 1];
    if (!FLAG_NAMES.has(flag)) throw new Error(`unknown finalizer flag: ${flag}`);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for finalizer flag: ${flag}`);
    }
    if (flag === "--drand-url") {
      drandUrls.push(value);
    } else if (flag === "--eth-rpc-url") {
      ethRpcUrls.push(value);
    } else {
      if (single.has(flag)) throw new Error(`duplicate finalizer flag: ${flag}`);
      single.set(flag, value);
    }
  }
  return { single, drandUrls, ethRpcUrls };
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.length === 0) {
    throw new Error(`required finalizer flag is missing: ${flag}`);
  }
  return value;
}

function optional(
  values: ReadonlyMap<string, string>,
  flag: string,
): string | undefined {
  return values.get(flag);
}

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} exceeds the safe integer range`);
  return parsed;
}

function boundedInteger(
  value: string,
  flag: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = positiveInteger(value, flag);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be from ${minimum} through ${maximum}`);
  }
  return parsed;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  void runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown finalization error";
    process.stderr.write(`Finalization failed: ${message}\n`);
    process.exitCode = 1;
  }).finally(releaseSnarkjsCurve);
}
