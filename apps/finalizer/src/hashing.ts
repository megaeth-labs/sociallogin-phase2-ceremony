import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export interface FileDigests {
  sha256: string;
  byteLength: number;
  blake2b512?: string;
}

export async function hashRegularFile(
  path: string,
  options: { blake2b512?: boolean } = {},
): Promise<FileDigests> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("artifact path must reference a regular file");
    if (before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("artifact byte length is invalid");
    }

    const sha256 = createHash("sha256");
    const blake2b512 = options.blake2b512
      ? createHash("blake2b512")
      : undefined;
    let byteLength = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (!Number.isSafeInteger(byteLength)) {
        throw new Error("artifact byte length exceeds the safe integer range");
      }
      sha256.update(bytes);
      blake2b512?.update(bytes);
    }

    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      BigInt(byteLength) !== before.size
    ) {
      throw new Error("artifact changed while it was being hashed");
    }

    return {
      sha256: sha256.digest("hex"),
      byteLength,
      ...(blake2b512
        ? { blake2b512: blake2b512.digest("hex") }
        : {}),
    };
  } finally {
    await handle.close();
  }
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
