import { open, unlink } from "node:fs/promises";

// snarkjs 0.7.6/wasmcurves emits all-zero uncompressed infinity; the pinned
// Rust pairing implementation requires 0x40 followed by zeroes. This adapter
// changes ONLY that encoding, preserving point order and transcript bytes.
// It is a transport experiment, not a point/subgroup/contribution validator.
export async function normalizeInfinity(input, output, target = "rust") {
  if (!["rust", "snarkjs"].includes(target)) throw new Error("unknown encoding");
  const src = await open(input, "r");
  let dst;
  let converted = 0;
  try {
    dst = await open(output, "wx", 0o600);
    const size = (await src.stat()).size;
    let position = 0;
    async function transfer(length, pointSize = 0) {
      if (length > size - position) throw new Error("truncated Bellman data");
      while (length > 0) {
        const batch = Math.min(length, pointSize ? pointSize * 512 : 65536);
        const bytes = Buffer.alloc(batch);
        let read = 0;
        while (read < batch) {
          const result = await src.read(bytes, read, batch - read, position + read);
          if (result.bytesRead === 0) throw new Error("truncated Bellman data");
          read += result.bytesRead;
        }
        if (pointSize) {
          for (let offset = 0; offset < batch; offset += pointSize) {
            const expected = target === "rust" ? 0 : 0x40;
            if (bytes[offset] === expected && bytes.subarray(offset + 1, offset + pointSize).every((b) => b === 0)) {
              bytes[offset] = target === "rust" ? 0x40 : 0;
              converted++;
            }
          }
        }
        await dst.writeFile(bytes);
        position += batch;
        length -= batch;
      }
    }
    async function count() {
      const bytes = Buffer.alloc(4);
      const read = await src.read(bytes, 0, 4, position);
      if (read.bytesRead !== 4) throw new Error("missing Bellman count");
      await transfer(4);
      return bytes.readUInt32BE();
    }
    for (const width of [64, 64, 128, 128, 64, 128]) await transfer(width, width);
    for (const width of [64, 64, 64, 64, 64, 128]) await transfer((await count()) * width, width);
    await transfer(64); // csHash, opaque
    const contributions = await count();
    if (contributions * 384 !== size - position) throw new Error("invalid Bellman contribution framing");
    for (let i = 0; i < contributions; i++) {
      for (const width of [64, 64, 64, 128]) await transfer(width, width);
      await transfer(64); // transcript digest, opaque
    }
    if (position !== size) throw new Error("trailing Bellman data");
    return { converted };
  } catch (error) {
    if (dst) {
      await dst.close();
      dst = undefined;
      await unlink(output);
    }
    throw error;
  } finally {
    await src.close();
    await dst?.close();
  }
}
