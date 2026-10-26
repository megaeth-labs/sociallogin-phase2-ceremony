import * as snarkjs from "snarkjs";
import type { BeaconResult } from "./types.js";
import { withTempDir, writeTempFile, readFileAsBytes } from "./util.js";
import { toHex } from "./hex.js";
import { sha256Hex } from "./sha256.js";

const DEFAULT_NUM_ITERATIONS_EXP = 10;
const MIN_BEACON_BYTES = 32;
const MAX_BEACON_BYTES = 255;
const MIN_NUM_ITERATIONS_EXP = 10;
const MAX_NUM_ITERATIONS_EXP = 32;

/**
 * Apply a public randomness beacon to finalize the ceremony.
 *
 * The beacon must be a value that no participant could have predicted or
 * influenced before the ceremony's contribution window closed. Caburé
 * ceremonies use the next Ethereum beacon-chain RANDAO reveal as the
 * canonical source; that is the only blessed beacon for this project.
 * Self-generated random bytes are NOT a valid beacon: the whole point of
 * the beacon is independent public verifiability.
 *
 * Input validation is intentionally a strict subset of snarkjs's bounds:
 *
 * - `beaconHash` must be 32 to 255 bytes. snarkjs rejects everything below 32
 *   and everything 256 or above; we enforce the same window before any I/O.
 * - `numIterationsExp` must be in `[10, 32]`. snarkjs accepts up to 63, but
 *   2^32 SHA-256 iterations already pushes finalization into hours of CPU.
 *   The default of 10 (1024 iterations) is what most ceremonies use.
 *
 * @param zkey - The last contributed zkey.
 * @param beaconHash - Hex-encoded beacon value, with or without `0x` prefix.
 *                    Must be 32 to 255 bytes (64 to 510 hex digits).
 * @param numIterationsExp - Exponent for 2^N SHA-256 iterations
 *                           (default: 10, yields 1024 iterations).
 *                           Must be an integer in `[10, 32]`.
 * @returns The finalized zkey, snarkjs's beacon contribution hash
 *          (Blake2b over the beacon contribution's public key), and SHA-256
 *          of the finalized zkey binary.
 */
export async function applyBeacon(
  zkey: Uint8Array,
  beaconHash: string,
  numIterationsExp: number = DEFAULT_NUM_ITERATIONS_EXP,
): Promise<BeaconResult> {
  const validatedHex = validateBeaconHash(beaconHash);
  validateNumIterationsExp(numIterationsExp);

  return withTempDir(async (dir) => {
    const zkeyPath = await writeTempFile(dir, "last.zkey", zkey);
    const finalPath = `${dir}/final.zkey`;

    const result = await snarkjs.zKey.beacon(
      zkeyPath,
      finalPath,
      "beacon",
      validatedHex,
      numIterationsExp,
    );

    // snarkjs returns false on validation failures it catches itself, and
    // the contribution hash bytes on success.
    if (result === false) {
      throw new Error("applyBeacon: snarkjs rejected the beacon parameters");
    }
    const contributionHashBytes = result as Uint8Array;

    const finalZkey = await readFileAsBytes(finalPath);
    const zkeyHash = await sha256Hex(finalZkey);

    return {
      zkey: finalZkey,
      contributionHash: toHex(contributionHashBytes),
      zkeyHash,
    };
  });
}

function validateBeaconHash(beaconHash: string): string {
  if (typeof beaconHash !== "string") {
    throw new TypeError("applyBeacon: beaconHash must be a string");
  }

  const hex = beaconHash.startsWith("0x") ? beaconHash.slice(2) : beaconHash;

  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("applyBeacon: beaconHash must be a hex string");
  }
  if (hex.length % 2 !== 0) {
    throw new Error(
      "applyBeacon: beaconHash must have an even number of hex digits",
    );
  }
  if (hex.length < MIN_BEACON_BYTES * 2) {
    throw new Error(
      `applyBeacon: beaconHash must be at least ${MIN_BEACON_BYTES} bytes ` +
        `(${MIN_BEACON_BYTES * 2} hex digits); received ${hex.length / 2} bytes`,
    );
  }
  if (hex.length > MAX_BEACON_BYTES * 2) {
    throw new Error(
      `applyBeacon: beaconHash must be at most ${MAX_BEACON_BYTES} bytes ` +
        `(${MAX_BEACON_BYTES * 2} hex digits); received ${hex.length / 2} bytes`,
    );
  }

  return hex;
}

function validateNumIterationsExp(numIterationsExp: number): void {
  if (
    !Number.isInteger(numIterationsExp) ||
    numIterationsExp < MIN_NUM_ITERATIONS_EXP ||
    numIterationsExp > MAX_NUM_ITERATIONS_EXP
  ) {
    throw new RangeError(
      `applyBeacon: numIterationsExp must be an integer in ` +
        `[${MIN_NUM_ITERATIONS_EXP}, ${MAX_NUM_ITERATIONS_EXP}]; ` +
        `received ${numIterationsExp}`,
    );
  }
}
