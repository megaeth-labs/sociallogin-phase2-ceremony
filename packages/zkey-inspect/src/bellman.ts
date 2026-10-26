import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { sourceFrom, type ByteSource } from "./source.js";

export interface BellmanLayout {
  vectors: Array<{ offset: number; count: number; width: number }>;
  circuitHashOffset: number;
  contributionsOffset: number;
  contributionCount: number;
}

/** Framing only: callers MUST also perform checked curve/pairing verification. */
export async function inspectBellman(source: ByteSource, expectedCount: number): Promise<BellmanLayout> {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > 1_000_000) {
    throw new Error("invalid Bellman contribution count");
  }
  let offset = 576;
  const vectors: BellmanLayout["vectors"] = [];
  for (const width of [64, 64, 64, 64, 64, 128]) {
    const bytes = await source.read(offset, 4);
    const count = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    offset += 4;
    vectors.push({ offset, count, width });
    offset += count * width;
    if (offset > source.byteLength) throw new Error("truncated Bellman vector");
  }
  const circuitHashOffset = offset;
  const bytes = await source.read(offset + 64, 4);
  const contributionCount = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  const contributionsOffset = offset + 68;
  if (contributionCount !== expectedCount
    || contributionsOffset + contributionCount * 384 !== source.byteLength) {
    throw new Error("invalid Bellman contribution framing");
  }
  return { vectors, circuitHashOffset, contributionsOffset, contributionCount };
}

async function equalRange(a: ByteSource, b: ByteSource, offset: number, length: number): Promise<void> {
  for (let cursor = 0; cursor < length; cursor += 65536) {
    const size = Math.min(65536, length - cursor);
    const [left, right] = await Promise.all([a.read(offset + cursor, size), b.read(offset + cursor, size)]);
    if (!Buffer.from(left).equals(Buffer.from(right))) throw new Error("Bellman immutable prefix changed");
  }
}

/** Exact byte prefix + fixed-query checks. Does not establish cryptographic validity. */
export async function inspectBellmanAppend(predecessor: string | ByteSource, candidate: string | ByteSource,
  expectedCount: number): Promise<{ contributionIndex: number; contributionHashBlake2b512: string }> {
  const a = await sourceFrom(predecessor);
  let b: Awaited<ReturnType<typeof sourceFrom>> | undefined;
  try {
    b = await sourceFrom(candidate);
    const before = await inspectBellman(a.source, expectedCount);
    const after = await inspectBellman(b.source, expectedCount + 1);
    if (before.vectors.some((v, i) => v.count !== after.vectors[i]!.count)
      || b.source.byteLength !== a.source.byteLength + 384) throw new Error("Bellman shape changed");
    // alpha/beta/gamma unchanged; delta changes. IC, A, B1, B2 unchanged.
    await equalRange(a.source, b.source, 0, 384);
    for (const index of [0, 3, 4, 5]) {
      const v = before.vectors[index]!;
      await equalRange(a.source, b.source, v.offset, v.count * v.width);
    }
    await equalRange(a.source, b.source, before.circuitHashOffset, 64);
    await equalRange(a.source, b.source, before.contributionsOffset, expectedCount * 384);
    const record = await b.source.read(after.contributionsOffset + expectedCount * 384, 384);
    return { contributionIndex: expectedCount + 1,
      contributionHashBlake2b512: createHash("blake2b512").update(record).digest("hex") };
  } finally {
    if (a.owned) await a.source.close?.();
    if (b?.owned) await b.source.close?.();
  }
}

/**
 * Checked framing, bounded-memory transport normalization for the Rust reader.
 * Only infinity encoding changes (all-zero -> 0x40 then zeroes). Archive/hash
 * the original input, never this temporary decoder representation.
 */
export async function normalizeBellmanForRust(input: string, output: string, count: number): Promise<void> {
  const { source } = await sourceFrom(input);
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const layout = await inspectBellman(source, count);
    destination = await open(output, "wx", 0o600);
    let offset = 0;
    const copy = async (length: number, width = 0) => {
      while (length > 0) {
        const size = Math.min(length, width ? width * 512 : 65536);
        const bytes = await source.read(offset, size);
        if (width) for (let i = 0; i < size; i += width) {
          if (bytes.subarray(i, i + width).every((byte) => byte === 0)) bytes[i] = 0x40;
        }
        await destination!.writeFile(bytes);
        offset += size;
        length -= size;
      }
    };
    for (const width of [64, 64, 128, 128, 64, 128]) await copy(width, width);
    for (const v of layout.vectors) { await copy(4); await copy(v.count * v.width, v.width); }
    await copy(68);
    for (let i = 0; i < count; i++) {
      for (const width of [64, 64, 64, 128]) await copy(width, width);
      await copy(64);
    }
  } catch (error) {
    if (destination) { await destination.close(); destination = undefined; await unlink(output); }
    throw error;
  } finally {
    await source.close?.();
    await destination?.close();
  }
}

/** Reject fields that snarkjs import copies from genesis instead of reading. */
export async function assertBellmanFixedSections(genesis: string, candidate: string, count: number): Promise<void> {
  const a = await sourceFrom(genesis);
  let b: Awaited<ReturnType<typeof sourceFrom>> | undefined;
  try {
    b = await sourceFrom(candidate);
    const before = await inspectBellman(a.source, 0);
    const after = await inspectBellman(b.source, count);
    if (before.vectors.some((v, i) => v.count !== after.vectors[i]!.count)) throw new Error("Bellman shape changed");
    await equalRange(a.source, b.source, 0, 384);
    for (const index of [0, 3, 4, 5]) {
      const v = before.vectors[index]!;
      await equalRange(a.source, b.source, v.offset, v.count * v.width);
    }
    await equalRange(a.source, b.source, before.circuitHashOffset, 64);
  } finally {
    await a.source.close?.();
    await b?.source.close?.();
  }
}
