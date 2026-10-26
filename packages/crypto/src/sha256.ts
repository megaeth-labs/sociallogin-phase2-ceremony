import { bytesToHexRaw } from "./hex.js";

/**
 * SHA-256 the bytes and return the digest as a 0x-prefixed lowercase hex
 * string.
 *
 * Uses Web Crypto via `globalThis.crypto.subtle`, which is available in
 * Node 20+ and in browser Web Workers, so this function is safe to call
 * from both code paths the package supports.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // TS 5.9 typed Web Crypto's `digest` input as `ArrayBufferView<ArrayBuffer>`,
  // i.e. it disallows views backed by a SharedArrayBuffer. All callers here
  // pass non-shared buffers (filesystem reads, snarkjs outputs, postMessage
  // payloads), so we cast through unknown to bypass the generic narrowing.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return `0x${bytesToHexRaw(new Uint8Array(digest))}`;
}
