// No-contribution round trip. Reports only public hashes, lengths and equality.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeInfinity } from "./encoding.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--production"));
const production = process.argv[2] === "--production";
await mkdir(join(here, "runs"), { recursive: true, mode: 0o700 });
const run = await mkdtemp(join(here, "runs/roundtrip-"));
const fixture = join(root, production ? "artifacts/moonsong-local" : "packages/crypto/tests/fixtures");
const genesis = production ? join(fixture, "genesis.zkey") : join(run, "genesis.zkey");
const r1cs = join(fixture, production ? "circuit.r1cs" : "multiplier.r1cs");
const ptau = join(fixture, production ? "powersoftau.ptau" : "pot_final.ptau");
const report = { production, complete: false, operations: [] };
async function save() { await writeFile(join(run, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); }
async function operation(...args) {
  const result = await new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [join(here, "interop.mjs"), "--operation", JSON.stringify(args)], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolveChild(JSON.parse(output)) : reject(new Error(`${args[0]} failed; details suppressed`)));
  });
  report.operations.push({ operation: args[0], ...result });
  await save();
  console.log(`${args[0]}: passed`);
}
async function hash(path, start, length) {
  const h = createHash("sha256");
  if (length !== 0) for await (const chunk of createReadStream(path, start === undefined ? {} : { start, end: start + length - 1 })) h.update(chunk);
  return h.digest("hex");
}
// Strict framing only. Never prints point/field contents. Payload comparisons
// below are byte comparisons, independent of hash equality and section order.
async function sections(path) {
  const size = (await stat(path)).size;
  const file = await open(path, "r");
  async function read(length, position) {
    const buffer = Buffer.alloc(length);
    assert.equal((await file.read(buffer, 0, length, position)).bytesRead, length);
    return buffer;
  }
  try {
    const header = await read(12, 0);
    assert.equal(header.subarray(0, 4).toString("ascii"), "zkey");
    const count = header.readUInt32LE(8);
    assert.equal(count, 10);
    const entries = [];
    let offset = 12;
    for (let i = 0; i < count; i++) {
      const section = await read(12, offset);
      const id = section.readUInt32LE(0);
      const length = Number(section.readBigUInt64LE(4));
      assert.ok(Number.isSafeInteger(length) && length >= 0 && offset + 12 + length <= size);
      assert.ok(!entries.some(entry => entry.id === id));
      entries.push({ id, offset: offset + 12, byteLength: length });
      offset += 12 + length;
    }
    assert.equal(offset, size);
    return { version: header.readUInt32LE(4), entries };
  } finally { await file.close(); }
}
async function equalRange(a, b, aStart, bStart, length) {
  const [left, right] = await Promise.all([open(a, "r"), open(b, "r")]);
  try {
    const l = Buffer.alloc(1024 * 1024), r = Buffer.alloc(l.length);
    for (let offset = 0; offset < length; offset += l.length) {
      const n = Math.min(l.length, length - offset);
      const [lr, rr] = await Promise.all([left.read(l, 0, n, aStart + offset), right.read(r, 0, n, bStart + offset)]);
      assert.equal(lr.bytesRead, n); assert.equal(rr.bytesRead, n);
      if (!l.subarray(0, n).equals(r.subarray(0, n))) return false;
    }
    return true;
  } finally { await Promise.all([left.close(), right.close()]); }
}
console.log(`Round-trip report: ${join(run, "report.json")}`);
if (production) {
  const { relation } = JSON.parse(await readFile(join(root, "ceremonies/google-rs256-zksync-v3/definition.draft.json"), "utf8"));
  for (const [path, pin] of [[genesis, relation.genesisZkey], [r1cs, relation.r1cs], [ptau, relation.ptau]]) {
    assert.equal((await stat(path)).size, pin.byteLength);
    assert.equal(await hash(path), pin.sha256);
  }
  report.inputPinsVerified = true;
  await save();
  console.log("Production input pins: passed");
} else await operation("newZKey", r1cs, ptau, genesis);
const raw = join(run, "export.params"), normalized = join(run, "normalized.params"), imported = join(run, "roundtrip.zkey");
await operation("exportBellman", genesis, raw);
report.normalization = await normalizeInfinity(raw, normalized);
await save();
await operation("importBellman", genesis, normalized, imported);
if (!production) {
  const rawImported = join(run, "raw-roundtrip.zkey");
  await operation("importBellman", genesis, raw, rawImported);
  const length = (await stat(imported)).size;
  report.normalizationDoesNotChangeImportedBytes = (await stat(rawImported)).size === length
    && await equalRange(imported, rawImported, 0, 0, length);
  assert.equal(report.normalizationDoesNotChangeImportedBytes, true);
}
const [before, after] = await Promise.all([sections(genesis), sections(imported)]);
const inputSize = (await stat(genesis)).size, outputSize = (await stat(imported)).size;
report.original = { byteLength: inputSize, sha256: await hash(genesis), version: before.version, sectionOrder: before.entries.map(s => s.id) };
report.roundtrip = { byteLength: outputSize, sha256: await hash(imported), version: after.version, sectionOrder: after.entries.map(s => s.id) };
report.byteIdentical = inputSize === outputSize && await equalRange(genesis, imported, 0, 0, inputSize);
report.sections = [];
for (const a of before.entries) {
  const b = after.entries.find(entry => entry.id === a.id);
  assert.ok(b);
  report.sections.push({ id: a.id, originalByteLength: a.byteLength, roundtripByteLength: b.byteLength,
    byteIdentical: a.byteLength === b.byteLength && await equalRange(genesis, imported, a.offset, b.offset, a.byteLength) });
}
report.allSectionPayloadsIdentical = report.sections.every(section => section.byteIdentical);
await save();
console.log(JSON.stringify({ byteIdentical: report.byteIdentical, allSectionPayloadsIdentical: report.allSectionPayloadsIdentical, originalSectionOrder: report.original.sectionOrder, roundtripSectionOrder: report.roundtrip.sectionOrder }));
await operation("compareVerificationKeys", genesis, imported);
report.verificationKeysIdentical = true;
await operation("verifyFromR1cs", r1cs, ptau, imported);
report.complete = true;
await save();
// Preserve the negative byte-identity result. Upstream export drops the unused
// final H basis element; import inserts zero before reversing the transform.
// Require all other payloads to match, plus the VK and full R1CS/PTAU checks.
assert.equal(before.version, after.version);
assert.ok(report.sections.filter(section => section.id !== 9).every(section => section.byteIdentical));
console.log("Round-trip measurements complete; see explicit byte-identity result in report.");
