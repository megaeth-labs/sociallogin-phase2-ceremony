import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export interface FileDigest {
  sha256: string;
  byteLength: number;
  blake2b512?: string;
}

export async function hashFile(path: string, options: { blake2b512?: boolean } = {}): Promise<FileDigest> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || !Number.isSafeInteger(stat.size)) throw new Error("artifact must be a nonempty regular file");
    const sha256 = createHash("sha256");
    const blake2b512 = options.blake2b512 ? createHash("blake2b512") : undefined;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, stat.size - offset), offset);
      if (bytesRead === 0) throw new Error("artifact ended while hashing");
      const chunk = buffer.subarray(0, bytesRead);
      sha256.update(chunk);
      blake2b512?.update(chunk);
      offset += bytesRead;
    }
    return {
      sha256: sha256.digest("hex"),
      byteLength: stat.size,
      ...(blake2b512 === undefined ? {} : { blake2b512: blake2b512.digest("hex") }),
    };
  } finally {
    await handle.close();
  }
}

