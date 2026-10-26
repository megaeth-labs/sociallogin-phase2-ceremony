import type { EntropySource } from "./types.js";

const SEED_LENGTH = 64; // 512 bits

/**
 * HKDF-SHA256: stretch input keying material into a fixed-length seed.
 *
 * Uses Web Crypto via the global `crypto.subtle`, which is available in
 * Node 20+ and in browser Web Workers, so this function is safe to call
 * from both code paths the package supports.
 *
 * @param ikm - input keying material (CSPRNG output mixed with user entropy)
 * @param info - optional domain-separation label (e.g. a circuit id)
 * @param length - output length in bytes (default 64)
 * @returns Derived seed as Uint8Array
 */
export async function deriveSeed(
  ikm: Uint8Array,
  info: Uint8Array = new Uint8Array(),
  length = SEED_LENGTH,
): Promise<Uint8Array> {
  // TS 5.9 typed Web Crypto's inputs as `ArrayBufferView<ArrayBuffer>`, i.e.
  // it disallows views backed by a SharedArrayBuffer. All callers here pass
  // non-shared buffers, so we cast through unknown to bypass the narrowing.
  const key = await crypto.subtle.importKey(
    "raw",
    ikm as unknown as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: info as unknown as BufferSource,
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Generate entropy by combining CSPRNG output with optional additional sources.
 *
 * In browser contexts, mouse/click entropy should be collected and passed
 * as additional sources. In CLI contexts, system CSPRNG is the primary source.
 *
 * @param sources - Optional additional entropy sources to mix in
 * @returns Combined entropy as Uint8Array
 */
export async function generateEntropy(
  sources?: EntropySource[],
): Promise<Uint8Array> {
  // Start with CSPRNG
  const csprng = new Uint8Array(SEED_LENGTH);
  crypto.getRandomValues(csprng);

  if (!sources || sources.length === 0) {
    return csprng;
  }

  // Mix additional entropy sources via HKDF
  const ikm = concat(csprng, ...sources.map((s) => s.data));
  return deriveSeed(ikm);
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
