import { describe, expect, it } from "vitest";
import { inspectBellman, inspectBellmanAppend, MemoryByteSource } from "../src/index.js";

// Structural fixtures deliberately contain no valid curve points. These tests
// establish framing only, never cryptographic acceptance.
function fixture(count: number): Buffer {
  const bytes = Buffer.alloc(576 + 6 * 4 + 64 + 4 + count * 384);
  bytes.writeUInt32BE(count, 576 + 24 + 64);
  return bytes;
}
describe("Bellman framing", () => {
  it("bounds counts and rejects trailing/truncated data", async () => {
    await expect(inspectBellman(new MemoryByteSource(fixture(0)), 0)).resolves.toMatchObject({ contributionCount: 0 });
    for (const bytes of [fixture(1), fixture(0).subarray(0, -1), Buffer.concat([fixture(0), Buffer.of(0)])]) {
      await expect(inspectBellman(new MemoryByteSource(bytes), 0)).rejects.toThrow();
    }
    const huge = fixture(0); huge.writeUInt32BE(0xffffffff, 576);
    await expect(inspectBellman(new MemoryByteSource(huge), 0)).rejects.toThrow();
    await expect(inspectBellman(new MemoryByteSource(fixture(0)), -1)).rejects.toThrow();
  });
  it("requires exactly one append and preserves fixed points and transcript prefix", async () => {
    const before = fixture(1), after = fixture(2);
    const check = (candidate: Buffer, count = 1) => inspectBellmanAppend(new MemoryByteSource(before), new MemoryByteSource(candidate), count);
    await expect(check(after)).resolves.toMatchObject({ contributionIndex: 2 });
    await expect(check(before)).rejects.toThrow();
    await expect(check(fixture(3))).rejects.toThrow();
    for (const offset of [0, 200, 576 + 24, 576 + 24 + 68]) {
      const bad = Buffer.from(after); bad[offset] = 1;
      await expect(check(bad)).rejects.toThrow();
    }
  });
});
