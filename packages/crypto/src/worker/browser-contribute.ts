/**
 * Browser-side contribute helper. Called by `contribute.worker.ts` from inside
 * the Web Worker, but exported separately so it can be exercised directly by
 * Node tests without needing a real Worker runtime.
 *
 * Uses snarkjs's memFS (`{ type: "mem" }`) for I/O, so no temp files are
 * created on disk. snarkjs is dynamically imported so the bundler resolves
 * to the consumer's snarkjs build at runtime.
 */
import type { ContributionResult } from "../types.js";
import { bytesToHexRaw } from "../hex.js";
import { sha256Hex } from "../sha256.js";

export async function browserContribute(
  prevZkey: Uint8Array,
  entropy: Uint8Array,
  name: string,
): Promise<ContributionResult> {
  if (entropy.length === 0) {
    // Empty entropy would encode to "" and trigger snarkjs's interactive
    // fallback path, which in a Web Worker has nowhere to read from and
    // would hang. Reject explicitly. Mirrors the check in `contribute.ts`.
    throw new Error("browserContribute: entropy must not be empty");
  }

  const snarkjs = await import("snarkjs");

  const prevFile = { type: "mem" as const, data: prevZkey };
  const newFile = { type: "mem" as const };

  // Use the prefix-free hex encoding shared with the Node `contribute()` so
  // both code paths feed identical bytes into snarkjs's RNG mixing for the
  // same user entropy. The output contribution is non-deterministic either
  // way (snarkjs mixes its own getRandomBytes via Blake2b), but a `0x`
  // prefix here would change snarkjs's input on one path only, which is the
  // drift the shared encoder guards against.
  const entropyHex = bytesToHexRaw(entropy);

  const contributionHashBytes: Uint8Array = await snarkjs.zKey.contribute(
    prevFile,
    newFile,
    name,
    entropyHex,
  );

  const zkey = (newFile as { type: "mem"; data?: Uint8Array }).data;
  if (!zkey) {
    throw new Error("snarkjs contribute produced no output data");
  }

  const zkeyHash = await sha256Hex(zkey);

  return {
    zkey,
    contributionHash: `0x${bytesToHexRaw(contributionHashBytes)}`,
    zkeyHash,
  };
}
