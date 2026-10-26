import { zKey } from "snarkjs";

import { AppendExpectationMismatchError, verifyExactlyOneAppend } from "@moss/phase2-zkey-inspect";

import type { VerificationPassInput, VerificationPassOutput } from "./types.js";

const MAX_INPUT_BYTES = 16 * 1024;

// snarkjs contains a few unconditional console.log calls on invalid input.
// Keep stdout as the single machine-readable child protocol channel.
console.log = (...values: unknown[]) => { process.stderr.write(`${values.map(String).join(" ")}\n`); };

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_INPUT_BYTES) throw new Error("child input exceeds limit");
    chunks.push(bytes);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as VerificationPassInput;
  const output = await verify(input);
  await writeOutput(process.stdout, JSON.stringify(output));
}

async function verify(input: VerificationPassInput): Promise<VerificationPassOutput> {
  try {
    const append = await verifyExactlyOneAppend(input.predecessorPath, input.candidatePath, {
      expectedContributionName: input.expectedContributionName,
      expectedContributionHashBlake2b512: input.expectedContributionHashBlake2b512,
      maxPredecessorContributions: input.maxPredecessorContributions,
      kind: "ordinary",
    });
    if (append.contributionIndex !== input.maxPredecessorContributions + 1) {
      return {
        result: "invalid",
        prefixValid: true,
        verifyFromInit: false,
        observedContributionName: append.contributionName,
        observedContributionHashBlake2b512: append.contributionHashBlake2b512,
        observedContributionIndex: append.contributionIndex,
        errorCode: "CANDIDATE_REJECTED",
      };
    }
    const verified = await zKey.verifyFromInit(input.genesisPath, input.ptauPath, input.candidatePath);
    return {
      result: verified ? "valid" : "invalid",
      prefixValid: true,
      verifyFromInit: verified,
      observedContributionName: append.contributionName,
      observedContributionHashBlake2b512: append.contributionHashBlake2b512,
      observedContributionIndex: append.contributionIndex,
      ...(!verified ? { errorCode: "SNARKJS_VERIFY_REJECTED" } : {}),
    };
  } catch (error) {
    const observed = error instanceof AppendExpectationMismatchError ? error.inspection : undefined;
    return {
      result: "invalid",
      prefixValid: observed !== undefined,
      verifyFromInit: false,
      observedContributionName: observed?.contributionName ?? null,
      observedContributionHashBlake2b512: observed?.contributionHashBlake2b512 ?? null,
      observedContributionIndex: observed?.contributionIndex ?? null,
      errorCode: "CANDIDATE_REJECTED",
    };
  }
}

function writeOutput(stream: NodeJS.WriteStream, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(output, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

void main().then(
  () => process.exit(0),
  () => {
    process.stderr.write("verification child failed\n", () => process.exit(1));
  },
);
