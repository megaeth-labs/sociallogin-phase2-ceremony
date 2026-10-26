#!/usr/bin/env node
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PROOF_INDEX_FILE, runProofTests } from "./proof-test.js";
import { releaseSnarkjsCurve } from "../snarkjs-curve.js";

const SINGLE = new Set([
  "--final-zkey",
  "--verification-key",
  "--r1cs",
  "--wasm",
  "--output-dir",
  "--proofs-per-fixture",
  "--public-inputs",
  "--expected-r1cs-sha256",
  "--expected-wasm-sha256",
  "--circom-version",
  "--circom-optimization",
  "--circom-binary-sha256",
  "--solidity-verifier",
  "--forge",
]);
const REPEATED = new Set(["--input", "--expected-public"]);

export async function runProofTestCli(argv: readonly string[]): Promise<void> {
  const { single, repeated } = parseFlags(argv);
  const inputs = repeated.get("--input") ?? [];
  const expected = repeated.get("--expected-public") ?? [];
  if (inputs.length === 0 || inputs.length !== expected.length) {
    throw new Error("give each --input fixture exactly one --expected-public file, in the same order");
  }
  const circomVersion = single.get("--circom-version");
  const optimization = single.get("--circom-optimization");
  if ((circomVersion === undefined) !== (optimization === undefined)) {
    throw new Error("--circom-version and --circom-optimization go together");
  }
  const outputDir = resolve(required(single, "--output-dir"));
  const result = await runProofTests({
    finalZkeyPath: resolve(required(single, "--final-zkey")),
    verificationKeyPath: resolve(required(single, "--verification-key")),
    r1csPath: resolve(required(single, "--r1cs")),
    wasmPath: resolve(required(single, "--wasm")),
    fixtures: inputs.map((input, index) => ({ inputPath: resolve(input), expectedPublicPath: resolve(expected[index]) })),
    outputDir,
    ...(single.has("--proofs-per-fixture") ? { proofsPerFixture: integer(single.get("--proofs-per-fixture")!) } : {}),
    ...(single.has("--public-inputs") ? { expectedPublicInputs: integer(single.get("--public-inputs")!) } : {}),
    ...(single.has("--expected-r1cs-sha256") ? { expectedR1csSha256: single.get("--expected-r1cs-sha256")! } : {}),
    ...(single.has("--expected-wasm-sha256") ? { expectedWasmSha256: single.get("--expected-wasm-sha256")! } : {}),
    ...(single.has("--solidity-verifier") ? { solidityVerifierPath: resolve(single.get("--solidity-verifier")!) } : {}),
    ...(single.has("--forge") ? { forgePath: single.get("--forge")! } : {}),
    ...(circomVersion && optimization ? {
      circuitReproduction: {
        circomVersion,
        optimization,
        ...(single.has("--circom-binary-sha256") ? { circomBinarySha256: single.get("--circom-binary-sha256")! } : {}),
      },
    } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    indexPath: resolve(outputDir, PROOF_INDEX_FILE),
    results: result.results,
  })}\n`);
}

function parseFlags(argv: readonly string[]) {
  const single = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!SINGLE.has(flag) && !REPEATED.has(flag)) throw new Error(`unknown proof-test flag: ${flag}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for proof-test flag: ${flag}`);
    if (REPEATED.has(flag)) {
      repeated.set(flag, [...(repeated.get(flag) ?? []), value]);
    } else {
      if (single.has(flag)) throw new Error(`duplicate proof-test flag: ${flag}`);
      single.set(flag, value);
    }
  }
  return { single, repeated };
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new Error(`required proof-test flag is missing: ${flag}`);
  return value;
}

function integer(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("expected a positive integer");
  return Number(value);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  void runProofTestCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`Proof test failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }).finally(releaseSnarkjsCurve);
}
