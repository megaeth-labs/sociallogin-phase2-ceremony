import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { hashRegularFile } from "../hashing.js";

const run = promisify(execFile);

/** The four checks the harness must report, by Solidity test name. */
export const SOLIDITY_TESTS = [
  "testAcceptsTheValidProof()",
  "testRejectsEachModifiedPublicInput()",
  "testRejectsTheNegatedProofPoint()",
  "testRejectsAnOutOfFieldPublicInput()",
] as const;
export const SOLC_VERSION = "0.8.28" as const;

export interface FoundryResult {
  forgeVersion: string;
  solcVersion: typeof SOLC_VERSION;
  verifier: { sha256: string; byteLength: number };
  fixture: { sha256: string; byteLength: number };
  harness: { sha256: string; byteLength: number };
  tests: Array<{ name: string; passed: boolean }>;
}

/** apps/finalizer/foundry, from either src/proof-test or dist/proof-test. */
export function defaultFoundryProject(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../foundry");
}

/**
 * Runs the Foundry harness against an exact Verifier.sol in a disposable copy
 * of the project, on Foundry's local EVM only. Any failed, missing or extra
 * test is an error.
 */
export async function runFoundryVerifierTests(input: {
  verifierPath: string;
  fixturePath: string;
  projectDir?: string;
  forgePath?: string;
}): Promise<FoundryResult> {
  const project = input.projectDir ?? defaultFoundryProject();
  const forge = input.forgePath ?? "forge";
  const verifier = await hashRegularFile(input.verifierPath);
  const fixture = await hashRegularFile(input.fixturePath);
  const harnessPath = join(project, "test", "Verifier.t.sol");
  const harness = await hashRegularFile(harnessPath);
  const workspace = await mkdtemp(join(tmpdir(), "moss-foundry-verifier-"));
  try {
    for (const directory of ["src", "test", "fixture"]) await mkdir(join(workspace, directory));
    await copyFile(join(project, "foundry.toml"), join(workspace, "foundry.toml"));
    await copyFile(harnessPath, join(workspace, "test", "Verifier.t.sol"));
    await copyFile(input.verifierPath, join(workspace, "src", "Verifier.sol"));
    await copyFile(input.fixturePath, join(workspace, "fixture", "fixture.json"));
    const copied = await hashRegularFile(join(workspace, "src", "Verifier.sol"));
    if (copied.sha256 !== verifier.sha256) throw new Error("Verifier.sol changed while it was copied");

    const version = (await run(forge, ["--version"])).stdout.split("\n")[0]?.trim() ?? "";
    const output = await run(forge, ["test", "--offline", "--json"], {
      cwd: workspace, maxBuffer: 64 * 1024 * 1024,
    }).then((result) => result.stdout, (error: { stdout?: string; stderr?: string }) => {
      // forge exits non-zero on a failing test; its JSON still says which.
      if (!error.stdout) throw new Error(`forge test failed: ${(error.stderr ?? "").trim().slice(0, 2000)}`);
      return error.stdout;
    });
    const tests = parseForgeJson(output);
    const names = tests.map((test) => test.name).sort();
    if (names.join("\n") !== [...SOLIDITY_TESTS].sort().join("\n")) {
      throw new Error(`Foundry harness ran an unexpected test set: ${names.join(", ")}`);
    }
    const failed = tests.filter((test) => !test.passed);
    if (failed.length > 0) throw new Error(`Foundry verifier tests failed: ${failed.map((test) => test.name).join(", ")}`);
    return { forgeVersion: version, solcVersion: SOLC_VERSION, verifier, fixture, harness, tests };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function parseForgeJson(stdout: string): Array<{ name: string; passed: boolean }> {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("forge produced no JSON test report");
  const report = JSON.parse(stdout.slice(start)) as Record<string, { test_results?: Record<string, { status?: string }> }>;
  return Object.values(report).flatMap((suite) =>
    Object.entries(suite.test_results ?? {}).map(([name, result]) => ({ name, passed: result.status === "Success" })),
  );
}
