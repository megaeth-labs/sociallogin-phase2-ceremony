import * as snarkjs from "snarkjs";
import type { ContributionResult } from "./types.js";
import { withTempDir, writeTempFile, readFileAsBytes } from "./util.js";
import { toHex, bytesToHexRaw } from "./hex.js";
import { sha256Hex } from "./sha256.js";

/**
 * Apply a contribution to a zkey using the provided entropy.
 *
 * The new zkey extends the previous one with a fresh trapdoor derived from
 * `entropy` plus snarkjs's own `getRandomBytes(64)`, mixed via Blake2b.
 *
 * Toxic-waste hygiene
 * -------------------
 * After the call returns (success or failure), the input `entropy` buffer is
 * filled with zeros. This is best-effort, not a security guarantee:
 *
 * - snarkjs's `zKey.contribute` accepts entropy only as a string. The bytes
 *   are encoded as hex and pass through immutable JS strings inside this
 *   function and inside snarkjs. Strings cannot be reliably zeroed in V8;
 *   they live in the heap until garbage collection (and even then are not
 *   guaranteed to be wiped).
 * - snarkjs internally mixes the user's entropy with 64 fresh random bytes
 *   via Blake2b before deriving the trapdoor, so leaking only the user
 *   entropy does not by itself reconstruct the trapdoor.
 *
 * For maximum hygiene, run this function in a short-lived process or
 * dedicated worker that exits or is terminated immediately after the result
 * is consumed; the OS will reclaim and reuse the memory pages. See the
 * package README for details.
 *
 * Note: this function MUTATES the input `entropy` buffer (zeroes it on
 * return). Callers must not reuse the buffer after the call.
 *
 * @param prevZkey - The current zkey to contribute to.
 * @param entropy - Random entropy bytes (will be zeroed on return).
 * @param name - Optional contributor name (default: "contributor").
 * @returns The new zkey, snarkjs's contribution hash (Blake2b over the
 *          contribution's public key), and SHA-256 of the new zkey binary.
 */
export async function contribute(
  prevZkey: Uint8Array,
  entropy: Uint8Array,
  name: string = "contributor",
): Promise<ContributionResult> {
  if (entropy.length === 0) {
    // Empty entropy would encode to "" and trigger snarkjs's interactive
    // fallback path, which silently asks for entropy on stdin. Reject it
    // explicitly so callers see a clean error instead of a hang.
    throw new Error("contribute: entropy must not be empty");
  }

  // snarkjs encodes the entropy string via TextEncoder and mixes the bytes
  // into the contribution. We use a prefix-free hex encoding so this Node
  // path produces the same contribution as the browser worker for identical
  // entropy bytes. Do NOT use the 0x-prefixed `toHex` here.
  const entropyHex = bytesToHexRaw(entropy);

  try {
    return await withTempDir(async (dir) => {
      const prevPath = await writeTempFile(dir, "prev.zkey", prevZkey);
      const newPath = `${dir}/new.zkey`;

      const contributionHashBytes: Uint8Array = await snarkjs.zKey.contribute(
        prevPath,
        newPath,
        name,
        entropyHex,
      );

      const zkey = await readFileAsBytes(newPath);
      const zkeyHash = await sha256Hex(zkey);
      return {
        zkey,
        contributionHash: toHex(contributionHashBytes),
        zkeyHash,
      };
    });
  } finally {
    entropy.fill(0);
  }
}
