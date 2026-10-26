import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeInfinity } from "./encoding.mjs";

// Fabricated framing fixtures, not cryptographic artifacts.
function fixture(marker = 0, fill = 0) {
  const chunks = [];
  function point(width) {
    const bytes = Buffer.alloc(width, fill);
    bytes[0] = marker;
    chunks.push(bytes);
  }
  function count(n) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(n);
    chunks.push(bytes);
  }
  for (const width of [64, 64, 128, 128, 64, 128]) point(width);
  for (const width of [64, 64, 64, 64, 64, 128]) {
    count(2);
    point(width); point(width);
  }
  chunks.push(Buffer.alloc(64));
  count(1);
  for (const width of [64, 64, 64, 128]) point(width);
  chunks.push(Buffer.alloc(64));
  return Buffer.concat(chunks);
}

test("normalizes only infinity point encodings and round-trips opaque digests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bellman-encoding-test-"));
  try {
    const input = join(dir, "input"), output = join(dir, "output"), back = join(dir, "back");
    await writeFile(input, fixture());
    assert.deepEqual(await normalizeInfinity(input, output), { converted: 22 });
    assert.deepEqual(await readFile(output), fixture(0x40));
    await normalizeInfinity(output, back, "snarkjs");
    assert.deepEqual(await readFile(back), fixture());
    await assert.rejects(normalizeInfinity(input, output), /EEXIST/);
    assert.deepEqual(await readFile(output), fixture(0x40));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("preserves nonzero points without claiming to validate them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bellman-encoding-test-"));
  try {
    const input = join(dir, "input"), output = join(dir, "output");
    await writeFile(input, fixture(0, 1));
    assert.deepEqual(await normalizeInfinity(input, output), { converted: 0 });
    assert.deepEqual(await readFile(output), fixture(0, 1));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rejects truncation, impossible array counts, and trailing bytes; removes partial outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bellman-encoding-test-"));
  try {
    const oversized = fixture();
    oversized.writeUInt32BE(0xffffffff, 576);
    for (const [i, bytes] of [fixture().subarray(0, 575), fixture().subarray(0, -1), Buffer.concat([fixture(), Buffer.of(0)]), oversized].entries()) {
      const input = join(dir, `input-${i}`), output = join(dir, `output-${i}`);
      await writeFile(input, bytes);
      await assert.rejects(normalizeInfinity(input, output));
      await assert.rejects(access(output));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
