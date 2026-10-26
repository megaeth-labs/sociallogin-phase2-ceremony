import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { canonicalize, type JsonValue } from "@moss/phase2-protocol";
import { groth16, wtns } from "snarkjs";

import { SnarkjsPhase2Backend } from "../backend.js";
import { hashRegularFile, sha256Bytes, type FileDigests } from "../hashing.js";
import { runFoundryVerifierTests, type FoundryResult } from "./foundry.js";

export const PROOF_TESTS_TYPE = "moss.phase2.proof-tests.v1" as const;
export const PROOF_INDEX_FILE = "proof-verification-index.json" as const;
export const SOLIDITY_FIXTURE_FILE = "solidity-fixture.json" as const;

/** BN254 scalar (r) and base (q) field moduli, as in the snarkjs Solidity template. */
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const SHA256 = /^[a-f0-9]{64}$/u;
const SILENT = { info() {}, debug() {}, warn() {}, error() {} };

export interface ProofTestOptions {
  finalZkeyPath: string;
  /** The published verification_key.json; the export from the final zkey must equal it. */
  verificationKeyPath: string;
  r1csPath: string;
  wasmPath: string;
  fixtures: Array<{ inputPath: string; expectedPublicPath: string }>;
  /** A directory that must not already exist. */
  outputDir: string;
  proofsPerFixture?: number;
  expectedPublicInputs?: number;
  /** Pins for the recompiled relation; the R1CS must be byte-identical to the ceremony's. */
  expectedR1csSha256?: string;
  expectedWasmSha256?: string;
  /** Recorded as given; describes how the WASM and R1CS were rebuilt. */
  circuitReproduction?: { circomVersion: string; optimization: string; circomBinarySha256?: string };
  /**
   * The published Verifier.sol. When given it must equal the final key's
   * export, and the Foundry harness runs against it on a local EVM.
   */
  solidityVerifierPath?: string;
  forgePath?: string;
  foundryProjectDir?: string;
}

type Digest = Pick<FileDigests, "sha256" | "byteLength">;

export interface ProofTestsV1 {
  schemaVersion: 1;
  type: typeof PROOF_TESTS_TYPE;
  finalZkey: Digest;
  verificationKey: Digest;
  r1cs: Digest;
  wasm: Digest;
  circuitReproduction?: ProofTestOptions["circuitReproduction"];
  toolchain: { snarkjsVersion: "0.7.6"; nodeVersion: string };
  expectedPublicInputs: number;
  fixtures: Array<{
    input: Digest;
    expectedPublic: Digest;
    witness: Digest & { satisfiesR1cs: true };
    proofs: Array<{ proof: JsonValue; publicSignals: string[]; verified: true }>;
    rejected: { modifiedPublicInputs: number; negatedProofA: true };
  }>;
  solidityFixture: Digest & { fileName: typeof SOLIDITY_FIXTURE_FILE };
  solidityTests?: FoundryResult;
  results: { fixtures: number; validProofs: number; rejectedProofs: number; solidityTests: number };
}

interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

/**
 * Proves and verifies with the final key: each fixture's witness must satisfy
 * the exact R1CS, every fresh proof must verify with the published key and
 * reproduce the expected public signals, and every single-signal change and a
 * negated proof point must be rejected. Writes the proofs, a Solidity fixture
 * and a canonical `proof-verification-index.json` to a fresh directory.
 */
export async function runProofTests(options: ProofTestOptions): Promise<ProofTestsV1> {
  const proofsPerFixture = options.proofsPerFixture ?? 2;
  const expectedPublicInputs = options.expectedPublicInputs ?? 20;
  if (!Number.isSafeInteger(proofsPerFixture) || proofsPerFixture < 2 || proofsPerFixture > 16) {
    throw new Error("proofs per fixture must be from 2 through 16");
  }
  if (!Number.isSafeInteger(expectedPublicInputs) || expectedPublicInputs < 1) {
    throw new Error("expected public-input count is invalid");
  }
  if (options.fixtures.length === 0) throw new Error("at least one proof fixture is required");
  for (const pin of [options.expectedR1csSha256, options.expectedWasmSha256]) {
    if (pin !== undefined && !SHA256.test(pin)) throw new Error("artifact pins must be 64 lowercase hex characters");
  }

  const finalZkey = await hashRegularFile(options.finalZkeyPath);
  const verificationKeyBytes = await readFile(options.verificationKeyPath);
  const r1cs = await hashRegularFile(options.r1csPath);
  const wasm = await hashRegularFile(options.wasmPath);
  if (options.expectedR1csSha256 && r1cs.sha256 !== options.expectedR1csSha256) {
    throw new Error("recompiled R1CS is not byte-identical to the ceremony relation");
  }
  if (options.expectedWasmSha256 && wasm.sha256 !== options.expectedWasmSha256) {
    throw new Error("witness WASM does not match its pin");
  }

  const published = JSON.parse(verificationKeyBytes.toString("utf8")) as JsonValue;
  const exported = await new SnarkjsPhase2Backend().exportVerificationKey(options.finalZkeyPath) as JsonValue;
  if (canonicalize(exported) !== canonicalize(published)) {
    throw new Error("verification key exported from the final zkey differs from the published key");
  }
  const solidity = options.solidityVerifierPath === undefined ? undefined : await readFile(options.solidityVerifierPath);
  if (solidity && !solidity.equals(Buffer.from(await new SnarkjsPhase2Backend().exportSolidityVerifier(options.finalZkeyPath), "utf8"))) {
    throw new Error("Verifier.sol is not the pinned snarkjs export of the final zkey");
  }
  const vk = exported as { nPublic?: unknown };
  if (vk.nPublic !== expectedPublicInputs) {
    throw new Error(`verification key has ${String(vk.nPublic)} public inputs, expected ${expectedPublicInputs}`);
  }

  await mkdir(options.outputDir, { recursive: false, mode: 0o755 });
  try {
    const fixtures: ProofTestsV1["fixtures"] = [];
    let solidityFixture: { bytes: Buffer } | undefined;
    for (const [index, fixture] of options.fixtures.entries()) {
      const directory = join(options.outputDir, `fixture-${index + 1}`);
      await mkdir(directory);
      const inputBytes = await readFile(fixture.inputPath);
      const expectedBytes = await readFile(fixture.expectedPublicPath);
      const expected = parseSignals(expectedBytes, expectedPublicInputs);
      const witnessPath = join(directory, "witness.wtns");
      await wtns.calculate(JSON.parse(inputBytes.toString("utf8")), options.wasmPath, witnessPath);
      if (await wtns.check(options.r1csPath, witnessPath, SILENT) !== true) {
        throw new Error(`fixture ${index + 1} witness does not satisfy the R1CS`);
      }
      const witness = await hashRegularFile(witnessPath);

      const proofs: ProofTestsV1["fixtures"][number]["proofs"] = [];
      const seen = new Set<string>();
      let rejectedModified = 0;
      for (let attempt = 0; attempt < proofsPerFixture; attempt += 1) {
        const { proof, publicSignals } = await groth16.prove(options.finalZkeyPath, witnessPath) as {
          proof: Groth16Proof; publicSignals: string[];
        };
        if (publicSignals.length !== expected.length || publicSignals.some((value, i) => value !== expected[i])) {
          throw new Error(`fixture ${index + 1} proof ${attempt + 1} public signals differ from the expected output`);
        }
        if (!await groth16.verify(exported as object, publicSignals, proof)) {
          throw new Error(`fixture ${index + 1} proof ${attempt + 1} did not verify`);
        }
        const key = canonicalize(proof as unknown as JsonValue);
        if (seen.has(key)) throw new Error("prover returned the same proof twice; randomization failed");
        seen.add(key);
        // Every single-signal change and a negated A must be rejected, which
        // shows the key binds each public input and the proof's points.
        for (let i = 0; i < publicSignals.length; i += 1) {
          const modified = [...publicSignals];
          modified[i] = ((BigInt(modified[i]) + 1n) % R).toString();
          if (await groth16.verify(exported as object, modified, proof)) {
            throw new Error(`fixture ${index + 1} accepted a proof with public input ${i} changed`);
          }
          rejectedModified += 1;
        }
        const negated = { ...proof, pi_a: [proof.pi_a[0], ((Q - BigInt(proof.pi_a[1])) % Q).toString(), ...proof.pi_a.slice(2)] };
        if (await groth16.verify(exported as object, publicSignals, negated)) {
          throw new Error(`fixture ${index + 1} accepted a proof with A negated`);
        }
        await writeFile(join(directory, `proof-${attempt + 1}.json`), `${canonicalize(proof as unknown as JsonValue)}\n`);
        await writeFile(join(directory, `public-${attempt + 1}.json`), `${canonicalize(publicSignals)}\n`);
        proofs.push({ proof: proof as unknown as JsonValue, publicSignals, verified: true });
        if (!solidityFixture) solidityFixture = { bytes: await solidityFixtureBytes(proof, publicSignals) };
      }
      fixtures.push({
        input: digest(inputBytes),
        expectedPublic: digest(expectedBytes),
        witness: { sha256: witness.sha256, byteLength: witness.byteLength, satisfiesR1cs: true },
        proofs,
        rejected: { modifiedPublicInputs: rejectedModified, negatedProofA: true },
      });
    }

    await writeFile(join(options.outputDir, SOLIDITY_FIXTURE_FILE), solidityFixture!.bytes);
    const solidityTests = options.solidityVerifierPath === undefined ? undefined : await runFoundryVerifierTests({
      verifierPath: options.solidityVerifierPath,
      fixturePath: join(options.outputDir, SOLIDITY_FIXTURE_FILE),
      ...(options.forgePath ? { forgePath: options.forgePath } : {}),
      ...(options.foundryProjectDir ? { projectDir: options.foundryProjectDir } : {}),
    });
    if (solidityTests && solidityTests.verifier.sha256 !== sha256Bytes(solidity!)) {
      throw new Error("Verifier.sol changed during the Foundry run");
    }
    const result: ProofTestsV1 = {
      schemaVersion: 1,
      type: PROOF_TESTS_TYPE,
      finalZkey: digest(finalZkey),
      verificationKey: digest(verificationKeyBytes),
      r1cs: digest(r1cs),
      wasm: digest(wasm),
      ...(options.circuitReproduction ? { circuitReproduction: options.circuitReproduction } : {}),
      toolchain: { snarkjsVersion: "0.7.6", nodeVersion: process.version },
      expectedPublicInputs,
      fixtures,
      solidityFixture: { fileName: SOLIDITY_FIXTURE_FILE, ...digest(solidityFixture!.bytes) },
      ...(solidityTests ? { solidityTests } : {}),
      results: {
        fixtures: fixtures.length,
        validProofs: fixtures.reduce((total, item) => total + item.proofs.length, 0),
        rejectedProofs: fixtures.reduce((total, item) => total + item.rejected.modifiedPublicInputs + item.proofs.length, 0),
        solidityTests: solidityTests?.tests.length ?? 0,
      },
    };
    await writeFile(
      join(options.outputDir, PROOF_INDEX_FILE),
      canonicalize(result as unknown as JsonValue),
      { flag: "wx", mode: 0o444 },
    );
    return result;
  } catch (error) {
    await rm(options.outputDir, { recursive: true, force: true });
    throw error;
  }
}

/** Calldata words in the order the Solidity verifier takes them (G2 limbs swapped by snarkjs). */
async function solidityFixtureBytes(proof: Groth16Proof, publicSignals: string[]): Promise<Buffer> {
  const calldata = await groth16.exportSolidityCallData(proof as never, publicSignals);
  const [pA, pB, pC, pubSignals] = JSON.parse(`[${calldata}]`) as [string[], string[][], string[], string[]];
  return Buffer.from(`${canonicalize({ pA, pB: pB.flat(), pC, pubSignals })}\n`, "utf8");
}

function parseSignals(bytes: Uint8Array, expectedCount: number): string[] {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!Array.isArray(value) || value.length !== expectedCount ||
      value.some((item) => typeof item !== "string" || !/^(0|[1-9][0-9]*)$/u.test(item) || BigInt(item) >= R)) {
    throw new Error(`expected public output must be ${expectedCount} canonical decimal field elements`);
  }
  return value as string[];
}

function digest(value: Uint8Array | Digest): Digest {
  return value instanceof Uint8Array
    ? { sha256: sha256Bytes(value), byteLength: value.byteLength }
    : { sha256: value.sha256, byteLength: value.byteLength };
}
