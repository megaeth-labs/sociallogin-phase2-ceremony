import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runProofTests, type ProofTestOptions } from "../src/proof-test/proof-test.js";
import { buildTinyCeremony, CIRCUIT, EXPECTED } from "./proof-fixture.js";

describe("proof tests against a final key", () => {
  let workspace: string;
  let runs = 0;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "moss-proof-test-"));
    await buildTinyCeremony(workspace);
  }, 120_000);
  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const options = (extra: Partial<ProofTestOptions> = {}): ProofTestOptions => ({
    finalZkeyPath: join(workspace, "final.zkey"),
    verificationKeyPath: join(workspace, "verification_key.json"),
    r1csPath: join(CIRCUIT, "circuit.r1cs"),
    wasmPath: join(CIRCUIT, "circuit.wasm"),
    fixtures: [{ inputPath: join(CIRCUIT, "input.json"), expectedPublicPath: join(workspace, "expected.json") }],
    outputDir: join(workspace, `out-${runs++}`),
    expectedPublicInputs: 4,
    expectedR1csSha256: "33807cbd74e3d84b3ae85bab09cc9bb0a57ec18f5665ee50655defc75bb277b9",
    ...extra,
  });

  it("proves, verifies and rejects every modified signal and a negated point", async () => {
    const run = options({ circuitReproduction: { circomVersion: "2.2.3", optimization: "O2" } });
    const result = await runProofTests(run);
    expect(result.results).toEqual({ fixtures: 1, validProofs: 2, rejectedProofs: 10, solidityTests: 0 });
    expect(result.fixtures[0].rejected).toEqual({ modifiedPublicInputs: 8, negatedProofA: true });
    expect(result.fixtures[0].proofs.map((proof) => proof.publicSignals)).toEqual([EXPECTED, EXPECTED]);
    const index = JSON.parse(await readFile(join(run.outputDir, "proof-verification-index.json"), "utf8"));
    expect(index).toEqual(JSON.parse(JSON.stringify(result)));
    expect(index.type).toBe("moss.phase2.proof-tests.v1");
    const fixture = JSON.parse(await readFile(join(run.outputDir, "solidity-fixture.json"), "utf8"));
    expect(fixture.pB).toHaveLength(4);
    expect(fixture.pubSignals.map((value: string) => BigInt(value).toString())).toEqual(EXPECTED);
  }, 120_000);

  it("rejects proofs whose public output differs from the fixture, and leaves no output", async () => {
    const expected = join(workspace, "wrong-expected.json");
    await writeFile(expected, JSON.stringify(["1", "1", "2", "3"]));
    const run = options({ fixtures: [{ inputPath: join(CIRCUIT, "input.json"), expectedPublicPath: expected }] });
    await expect(runProofTests(run)).rejects.toThrow("public signals differ");
    await expect(stat(run.outputDir)).rejects.toThrow();
  }, 60_000);

  it("requires the published verification key to be the final key's export", async () => {
    const published = JSON.parse(await readFile(join(workspace, "verification_key.json"), "utf8"));
    published.IC[1][0] = published.IC[2][0];
    const vkPath = join(workspace, "other-vk.json");
    await writeFile(vkPath, JSON.stringify(published));
    await expect(runProofTests(options({ verificationKeyPath: vkPath }))).rejects.toThrow("differs from the published key");
  });

  it("requires the recompiled R1CS to match the ceremony relation", async () => {
    await expect(runProofTests(options({ expectedR1csSha256: "0".repeat(64) }))).rejects.toThrow("not byte-identical");
  });

  it("expects the ceremony's 20 public inputs by default", async () => {
    await expect(runProofTests({ ...options(), expectedPublicInputs: undefined })).rejects.toThrow("has 4 public inputs, expected 20");
  });
});
