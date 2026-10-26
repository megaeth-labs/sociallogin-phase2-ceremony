import { randomBytes } from "node:crypto";

import * as snarkjs from "snarkjs";

import type { ContributionFormat } from "./contribution.js";

interface ContributionWorkerInput {
  predecessorPath: string;
  successorPath: string;
  contributionName: string;
  format: ContributionFormat;
}

interface Bn128Curve {
  terminate?: () => Promise<void>;
}

// @types/snarkjs omits the Bellman entry points that snarkjs 0.7.6 exports.
const bellman = snarkjs as unknown as {
  curves: { getCurveFromName(name: "bn128"): Promise<Bn128Curve> };
  zKey: {
    bellmanContribute(
      curve: Bn128Curve,
      challengeFileName: string,
      responseFileName: string,
      entropy: string,
    ): Promise<Uint8Array>;
  };
};

process.once("message", async (value: unknown) => {
  try {
    const input = parseInput(value);
    const entropy = randomBytes(64);
    try {
      // snarkjs mixes its own CSPRNG bytes with this non-empty local entropy.
      // The temporary string cannot be proven erased by JavaScript and is never logged.
      const contributionHash = input.format === "bellman"
        ? await bellmanContribution(input, entropy)
        : await snarkjs.zKey.contribute(
          input.predecessorPath,
          input.successorPath,
          input.contributionName,
          entropy.toString("hex"),
        );
      process.send?.({
        ok: true,
        contributionHashBlake2b512: Buffer.from(contributionHash).toString("hex"),
      });
    } finally {
      entropy.fill(0);
    }
  } catch (error) {
    process.send?.({
      ok: false,
      error: error instanceof Error ? error.message : "snarkjs contribution failed",
    });
  }
});

/**
 * The same pinned snarkjs 0.7.6 arithmetic the browser worker runs
 * (`zkey_bellman_contribute.js` on a BN254 curve). Bellman files carry no
 * contributor name; the signed receipt does.
 */
async function bellmanContribution(input: ContributionWorkerInput, entropy: Buffer): Promise<Uint8Array> {
  const curve = await bellman.curves.getCurveFromName("bn128");
  try {
    return await bellman.zKey.bellmanContribute(
      curve,
      input.predecessorPath,
      input.successorPath,
      entropy.toString("hex"),
    );
  } finally {
    await curve.terminate?.();
  }
}

function parseInput(value: unknown): ContributionWorkerInput {
  if (!value || typeof value !== "object") throw new Error("Contribution process input is invalid.");
  const input = value as Record<string, unknown>;
  if (
    typeof input.predecessorPath !== "string" ||
    typeof input.successorPath !== "string" ||
    typeof input.contributionName !== "string" ||
    input.contributionName.length < 1 ||
    input.contributionName.length > 64 ||
    /[^\x20-\x7e]/u.test(input.contributionName) ||
    (input.format !== "zkey" && input.format !== "bellman")
  ) {
    throw new Error("Contribution process input is invalid.");
  }
  return input as unknown as ContributionWorkerInput;
}
