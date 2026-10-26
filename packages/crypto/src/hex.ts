/**
 * Hex encoding helpers shared by the Node and browser-worker entry points.
 *
 * Kept in its own module (rather than util.ts) so the worker bundle does not
 * pull in node:fs/path/os just to get a hex helper.
 */

/**
 * Encode bytes as a 0x-prefixed lowercase hex string.
 *
 * Use this for hash outputs and other values that callers will display or
 * compare as hex. Do NOT use this for snarkjs entropy strings — see
 * `bytesToHexRaw`.
 */
export function toHex(bytes: Uint8Array): string {
  return `0x${bytesToHexRaw(bytes)}`;
}

/**
 * Encode bytes as a lowercase hex string with no `0x` prefix.
 *
 * snarkjs encodes its `entropy` parameter via `TextEncoder` and mixes the
 * resulting bytes into its RNG. The literal `0` and `x` characters of a
 * `0x`-prefixed string would change what snarkjs sees. Both Node and
 * browser code paths must use the same prefix-free encoding so the bytes
 * snarkjs mixes are identical for the same user entropy.
 *
 * The output contribution is non-deterministic regardless: snarkjs also
 * mixes 64 fresh bytes from its own `getRandomBytes` via Blake2b. What
 * this helper guarantees is encoder parity (the input snarkjs sees on
 * each path), not output parity (the contribution snarkjs emits).
 */
export function bytesToHexRaw(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
