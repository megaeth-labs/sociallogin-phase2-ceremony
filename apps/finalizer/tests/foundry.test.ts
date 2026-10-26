import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SnarkjsPhase2Backend } from "../src/backend.js";
import { runFoundryVerifierTests, SOLIDITY_TESTS } from "../src/proof-test/foundry.js";
import { runProofTests } from "../src/proof-test/proof-test.js";
import { buildTinyCeremony, CIRCUIT } from "./proof-fixture.js";

const hasForge = (() => {
  try {
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasForge)("Foundry tests of the exported Solidity verifier", () => {
  let workspace: string;
  let verifierPath: string;
  let fixturePath: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "moss-foundry-test-"));
    await buildTinyCeremony(workspace);
    verifierPath = join(workspace, "Verifier.sol");
    await writeFile(verifierPath, await new SnarkjsPhase2Backend().exportSolidityVerifier(join(workspace, "final.zkey")));
  }, 120_000);
  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("runs all four Solidity checks and records them in the proof index", async () => {
    const outputDir = join(workspace, "proofs");
    const result = await runProofTests({
      finalZkeyPath: join(workspace, "final.zkey"),
      verificationKeyPath: join(workspace, "verification_key.json"),
      r1csPath: join(CIRCUIT, "circuit.r1cs"),
      wasmPath: join(CIRCUIT, "circuit.wasm"),
      fixtures: [{ inputPath: join(CIRCUIT, "input.json"), expectedPublicPath: join(workspace, "expected.json") }],
      outputDir,
      expectedPublicInputs: 4,
      solidityVerifierPath: verifierPath,
    });
    fixturePath = join(outputDir, "solidity-fixture.json");
    expect(result.results.solidityTests).toBe(4);
    expect(result.solidityTests?.solcVersion).toBe("0.8.28");
    expect(result.solidityTests?.tests.map((test) => test.name).sort()).toEqual([...SOLIDITY_TESTS].sort());
    expect(result.solidityTests?.tests.every((test) => test.passed)).toBe(true);
  }, 180_000);

  it("refuses a Verifier.sol that is not the final key's export", async () => {
    const other = join(workspace, "Other.sol");
    await writeFile(other, `${await readFile(verifierPath, "utf8")}\n`);
    await expect(runProofTests({
      finalZkeyPath: join(workspace, "final.zkey"),
      verificationKeyPath: join(workspace, "verification_key.json"),
      r1csPath: join(CIRCUIT, "circuit.r1cs"),
      wasmPath: join(CIRCUIT, "circuit.wasm"),
      fixtures: [{ inputPath: join(CIRCUIT, "input.json"), expectedPublicPath: join(workspace, "expected.json") }],
      outputDir: join(workspace, "unused"),
      expectedPublicInputs: 4,
      solidityVerifierPath: other,
    })).rejects.toThrow("not the pinned snarkjs export");
  });

  it("fails when a verifier accepts what it should reject", async () => {
    const lax = join(workspace, "Lax.sol");
    const source = await readFile(verifierPath, "utf8");
    // Report every pairing as valid; the rejection tests must catch it.
    await writeFile(lax, source.replace("mstore(0, isValid)", "mstore(0, 1)"));
    await expect(runFoundryVerifierTests({ verifierPath: lax, fixturePath }))
      .rejects.toThrow(/Foundry verifier tests failed: .*testRejects/);
  }, 120_000);
});
