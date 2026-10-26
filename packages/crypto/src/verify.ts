import * as snarkjs from "snarkjs";
import { withTempDir, writeTempFile } from "./util.js";

/**
 * Verify a single contribution against the original circuit (r1cs) and
 * Powers of Tau.
 *
 * Confirms `zkey` is a valid contribution chain extending the genesis
 * derivable from `(r1cs, ptau)`. It does NOT confirm `zkey` is the next
 * contribution in any specific chain; use `verifyChain` for that.
 *
 * Returns `false` for any malformed input. snarkjs throws on parse errors;
 * we catch and map to `false` so the `Promise<boolean>` signature holds.
 *
 * @param r1cs - R1CS circuit definition.
 * @param ptau - Powers of Tau ceremony output.
 * @param zkey - The zkey to verify.
 * @returns `true` if valid, `false` otherwise.
 */
export async function verify(
  r1cs: Uint8Array,
  ptau: Uint8Array,
  zkey: Uint8Array,
): Promise<boolean> {
  try {
    return await withTempDir(async (dir) => {
      const r1csPath = await writeTempFile(dir, "circuit.r1cs", r1cs);
      const ptauPath = await writeTempFile(dir, "pot.ptau", ptau);
      const zkeyPath = await writeTempFile(dir, "circuit.zkey", zkey);

      return await snarkjs.zKey.verifyFromR1cs(r1csPath, ptauPath, zkeyPath);
    });
  } catch {
    return false;
  }
}

/**
 * Verify the full contribution chain embedded inside `latestZkey`, rooted at
 * `initialZkey`.
 *
 * snarkjs records the entire contribution transcript inside every zkey file,
 * so verifying the latest zkey against the genesis is equivalent to verifying
 * every intermediate contribution. Intermediate zkeys do not need to be
 * supplied.
 *
 * `initialZkey` is taken as trusted: this function does NOT confirm
 * `initialZkey` is the canonical genesis for any particular `r1cs`. Callers
 * that need to bind the chain to a specific circuit should use
 * `verifyChainForCircuit` instead (or hash-pin `initialZkey` against a
 * known-good value before calling this).
 *
 * If `latestZkey` is byte-equal to `initialZkey` (no contributions yet) the
 * function returns `true` without invoking snarkjs.
 *
 * Returns `false` for any malformed input. Same total-function pattern as
 * `verify`.
 *
 * @param ptau - Powers of Tau ceremony output.
 * @param initialZkey - The genesis zkey, taken as trusted.
 * @param latestZkey - The most recently contributed zkey.
 * @returns true if every contribution embedded in `latestZkey` is valid and
 *          the chain reaches `initialZkey` at its base.
 */
export async function verifyChain(
  ptau: Uint8Array,
  initialZkey: Uint8Array,
  latestZkey: Uint8Array,
): Promise<boolean> {
  if (bytesEqual(latestZkey, initialZkey)) {
    return true;
  }

  try {
    return await withTempDir(async (dir) => {
      const ptauPath = await writeTempFile(dir, "pot.ptau", ptau);
      const initPath = await writeTempFile(dir, "genesis.zkey", initialZkey);
      const zkeyPath = await writeTempFile(dir, "latest.zkey", latestZkey);

      return await snarkjs.zKey.verifyFromInit(initPath, ptauPath, zkeyPath);
    });
  } catch {
    return false;
  }
}

/**
 * Verify the full contribution chain AND bind it to a specific circuit.
 *
 * Composition of `verify(r1cs, ptau, initialZkey)` then
 * `verifyChain(ptau, initialZkey, latestZkey)`. Use this instead of
 * `verifyChain` alone when you need to confirm both that the genesis
 * matches the expected circuit AND that the chain extends that genesis.
 *
 * Closes the empty-chain shortcut in `verifyChain`: when `latestZkey` is
 * byte-equal to `initialZkey`, that shortcut returns `true` without
 * invoking snarkjs, so untrusted garbage as both arguments would pass.
 * Here, the shortcut only fires after `initialZkey` is validated against
 * the circuit.
 *
 * Returns `false` on any failure mode (total by composition of `verify`
 * and `verifyChain`).
 *
 * @param r1cs - R1CS circuit definition.
 * @param ptau - Powers of Tau ceremony output.
 * @param initialZkey - The genesis zkey (validated against `r1cs` here).
 * @param latestZkey - The most recently contributed zkey.
 * @returns true if `initialZkey` is a valid genesis for `(r1cs, ptau)` and
 *          the chain in `latestZkey` reaches `initialZkey`.
 */
export async function verifyChainForCircuit(
  r1cs: Uint8Array,
  ptau: Uint8Array,
  initialZkey: Uint8Array,
  latestZkey: Uint8Array,
): Promise<boolean> {
  const initialValid = await verify(r1cs, ptau, initialZkey);
  if (!initialValid) return false;

  if (bytesEqual(initialZkey, latestZkey)) return true;

  return verifyChain(ptau, initialZkey, latestZkey);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
