import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  MemoryByteSource,
  inspectBn254Groth16Zkey,
  verifyExactlyOneAppend,
} from "@moss/phase2-zkey-inspect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Closes the one load-bearing assumption in the append argument.
 *
 * verifyExactlyOneAppend compares only section 2's leading header fields and
 * section 10. It never byte-compares sections 3 through 9 — the IC, the
 * coefficients, and the A/B1/B2/C/H point vectors — against the predecessor.
 * Acceptance is therefore sound only if snarkjs's verifyFromInit covers those
 * cryptographically against the initial key.
 *
 * Both halves of that division of labour are asserted here, so a later change
 * to either check cannot silently leave the gap uncovered.
 *
 * snarkjs runs in a child process, as it does in production
 * (`src/verify-child.ts`): it leaves file handles open, which Node now treats
 * as a fatal error when they are collected.
 */

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../packages/crypto/tests/fixtures");
const R1CS = join(FIXTURES, "multiplier.r1cs");
const PTAU = join(FIXTURES, "pot_final.ptau");

const RUNNER = `
const snarkjs = require("snarkjs");
const [mode, a, b, c, d] = process.argv.slice(2);
(async () => {
  if (mode === "setup") {
    await snarkjs.zKey.newZKey(a, b, c);
    process.stdout.write("ok");
  } else if (mode === "contribute") {
    await snarkjs.zKey.contribute(a, b, c, d);
    process.stdout.write("ok");
  } else {
    let verdict;
    try {
      verdict = await snarkjs.zKey.verifyFromInit(a, b, c);
    } catch {
      verdict = false;
    }
    process.stdout.write(verdict === true ? "true" : "false");
  }
})().then(() => process.exit(0), () => process.exit(1));
`;

let workspace: string;
let runnerPath: string;
let genesisPath: string;
let candidatePath: string;

async function runner(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [runnerPath, ...args], {
    cwd: HERE,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** True only when snarkjs accepts the candidate as an append to the genesis. */
async function verifyFromInit(candidate: string): Promise<boolean> {
  return (await runner("verify", genesisPath, PTAU, candidate)) === "true";
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "moss-verify-coverage-"));
  runnerPath = join(workspace, "runner.cjs");
  await writeFile(runnerPath, RUNNER);
  genesisPath = join(workspace, "genesis.zkey");
  candidatePath = join(workspace, "candidate.zkey");
  await runner("setup", R1CS, PTAU, genesisPath);
  await runner(
    "contribute",
    genesisPath,
    candidatePath,
    "lease-0001",
    randomBytes(64).toString("hex"),
  );
}, 180_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Flip one bit inside a section body and write the result to a new file. */
async function mutateSection(sectionId: number): Promise<string> {
  const bytes = new Uint8Array(await readFile(candidatePath));
  const inspection = await inspectBn254Groth16Zkey(
    new MemoryByteSource(bytes),
    { maxContributions: 8 },
  );
  const section = inspection.sections.get(sectionId);
  if (!section || section.byteLength === 0) {
    throw new Error(`fixture has no bytes in section ${sectionId}`);
  }
  const mutated = bytes.slice();
  mutated[section.offset + Math.floor(section.byteLength / 2)] ^= 0x01;
  const path = join(workspace, `mutated-${sectionId}.zkey`);
  await writeFile(path, mutated);
  return path;
}

describe("verifyFromInit covers the sections the append check does not", () => {
  it("accepts the unmodified append", async () => {
    expect(await verifyFromInit(candidatePath)).toBe(true);
  }, 120_000);

  // Sections 3-9 hold everything verifyExactlyOneAppend leaves to snarkjs.
  for (const sectionId of [3, 4, 5, 6, 7, 8, 9]) {
    it(`rejects a mutated section ${sectionId}`, async () => {
      expect(await verifyFromInit(await mutateSection(sectionId))).toBe(false);
    }, 120_000);
  }

  it("shows the append check alone does not catch it", async () => {
    // The point of the division of labour: a mutation in the point vectors
    // leaves the contribution section byte-identical, so framing validation
    // passes and only verifyFromInit rejects. Both checks are load-bearing, and
    // dropping either would open a hole the other does not cover.
    const mutatedPath = await mutateSection(5);
    await expect(
      verifyExactlyOneAppend(genesisPath, mutatedPath, {
        expectedContributionName: "lease-0001",
        maxPredecessorContributions: 8,
      }),
    ).resolves.toMatchObject({
      predecessorCount: 0,
      candidateCount: 1,
      contributionName: "lease-0001",
    });
    expect(await verifyFromInit(mutatedPath)).toBe(false);
  }, 120_000);
});
