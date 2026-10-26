// Isolated research harness. No coordinator, credentials, or live state access.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, stat, writeFile, copyFile, truncate, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeInfinity } from "./encoding.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const require = createRequire(join(root, "packages/crypto/package.json"));
const { zKey } = require("snarkjs");
const rust = join(here, "target/release/moss-bellman-prototype");

// Each JS operation gets a fresh process: timings and maxRSS do not accumulate
// across operations. Only measurements, never library output, reach the report.
if (process.argv[2] === "--operation") {
  const [operation, ...args] = JSON.parse(process.argv[3]);
  const start = performance.now();
  try {
    let result;
    if (operation === "compareVerificationKeys") {
      assert.deepEqual(await zKey.exportVerificationKey(args[0]), await zKey.exportVerificationKey(args[1]));
      result = true;
    } else if (operation === "append") {
      const { verifyExactlyOneAppend } = await import("../../packages/zkey-inspect/dist/index.js");
      result = await verifyExactlyOneAppend(args[0], args[1], {
        expectedContributionName: args[2], maxPredecessorContributions: 10,
      });
      assert.equal(result.candidateCount, Number(args[3]));
    } else if (operation === "bellmanContribute") {
      const { buildBn128 } = require("ffjavascript");
      const curve = await buildBn128();
      result = await zKey.bellmanContribute(curve, ...args, randomBytes(64).toString("hex"));
    } else if (operation === "contribute") {
      result = await zKey.contribute(...args, randomBytes(64).toString("hex"));
    } else {
      result = await zKey[operation](...args);
    }
    assert.notEqual(result, false);
    assert.notEqual(result, -1);
    process.stdout.write(JSON.stringify({ milliseconds: Math.round(performance.now() - start), maxRssKiB: process.resourceUsage().maxRSS }));
    process.exit(0);
  } catch {
    // Errors from third-party parsers may contain data; do not forward them.
    process.exit(1);
  }
}

const rows = [];
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--production"), "usage: node interop.mjs [--production]");
const production = process.argv[2] === "--production";
async function record(row) {
  rows.push(row);
  // Preserve completed measurements even if a long run is interrupted.
  await writeFile(join(run, "progress.json"), JSON.stringify({ complete: false, production, rows }, null, 2) + "\n", { mode: 0o600 });
}
async function child(command, args, capture = false) {
  const start = performance.now();
  return await new Promise((resolveChild, reject) => {
    const p = spawn(command, args, { stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"] });
    let stdout = "";
    let diagnostic = "";
    p.stderr.on("data", (chunk) => {
      // Only our wrapper's fixed diagnostic categories; no parser details.
      for (const line of chunk.toString().split("\n")) {
        if (/^Bellman (I\/O failure: [A-Za-z]+|invalid contribution|synthesis failure)$/.test(line)) diagnostic = line;
      }
    });
    p.stdout?.on("data", (chunk) => { stdout += chunk; });
    p.once("error", reject);
    p.once("close", (code) => resolveChild({ code, stdout, diagnostic, milliseconds: Math.round(performance.now() - start) }));
  });
}
async function js(operation, args, reject = false) {
  const result = await child(process.execPath, [fileURLToPath(import.meta.url), "--operation", JSON.stringify([operation, ...args])], true);
  assert.equal(result.code === 0, !reject, `${operation}: unexpected acceptance/rejection`);
  await record({ operation, expectedRejection: reject, ...(reject ? {} : JSON.parse(result.stdout)) });
  console.log(`${operation}: ${reject ? "rejected as expected" : "passed"}`);
}
async function native(operation, input, output, reject = false) {
  const result = await child(rust, [operation, input, output]);
  // A signal/crash must never count as successful negative verification.
  assert.equal(result.code, reject ? 1 : 0, `Rust ${operation}: unexpected exit status (${result.diagnostic})`);
  await record({ operation: `rust-${operation}`, expectedRejection: reject, milliseconds: result.milliseconds });
  console.log(`rust-${operation}: ${reject ? "rejected as expected" : "passed"}`);
}

await mkdir(join(here, "runs"), { recursive: true, mode: 0o700 });
const run = await mkdtemp(join(here, "runs/interop-"));
const fixture = join(root, production ? "artifacts/moonsong-local" : "packages/crypto/tests/fixtures");
const r1cs = join(fixture, production ? "circuit.r1cs" : "multiplier.r1cs");
const ptau = join(fixture, production ? "powersoftau.ptau" : "pot_final.ptau");
const key = (i) => production && i === 0 ? join(fixture, "genesis.zkey") : join(run, `${i}.zkey`);
const params = (i) => join(run, `${i}.params`);
if (production) {
  const { relation } = JSON.parse(await readFile(join(root, "ceremonies/google-rs256-zksync-v3/definition.draft.json"), "utf8"));
  for (const [label, path, pin] of [["genesis", key(0), relation.genesisZkey], ["r1cs", r1cs, relation.r1cs], ["ptau", ptau, relation.ptau]]) {
    assert.equal((await stat(path)).size, pin.byteLength, `${label} length mismatch`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    assert.equal(hash.digest("hex"), pin.sha256, `${label} pin mismatch`);
    console.log(`${label}: pinned bytes confirmed`);
  }
} else await js("newZKey", [r1cs, ptau, key(0)]);
await js("exportBellman", [key(0), join(run, "raw-0.params")]);
await record({ operation: "normalize-0", ...await normalizeInfinity(join(run, "raw-0.params"), params(0)) });
for (let i = 1; i <= 3; i++) {
  if (i === 2) {
    const raw = join(run, `raw-${i}.params`);
    await js("bellmanContribute", [params(i - 1), raw]);
    await record({ operation: `normalize-${i}`, ...await normalizeInfinity(raw, params(i)) });
  }
  else await native("contribute", params(i - 1), params(i));
  await native("verify", params(i - 1), params(i));
  await js("importBellman", [key(i - 1), params(i), key(i), `prototype-${i}`]);
  await js("append", [key(i - 1), key(i), `prototype-${i}`, String(i)]);
  await js("verifyFromInit", [key(0), ptau, key(i)]);
}
// Resume the ordinary zkey client, then verify its exported result with Rust.
await js("contribute", [key(3), key(4), "prototype-4"]);
await js("exportBellman", [key(4), join(run, "raw-4.params")]);
await record({ operation: "normalize-4", ...await normalizeInfinity(join(run, "raw-4.params"), params(4)) });
await native("verify", params(3), params(4));
await js("append", [key(3), key(4), "prototype-4", "4"]);
await js("verifyFromR1cs", [r1cs, ptau, key(4)]);
// Negative controls: unchanged input, skipped predecessor, wrong lease name,
// reversed chain, and truncated transport must not be accepted.
await native("verify", params(1), params(1), true);
await native("verify", params(0), params(2), true);
await native("verify", params(2), params(1), true);
await js("append", [key(1), key(1), "prototype-1", "1"], true);
await js("append", [key(0), key(2), "prototype-2", "2"], true);
await js("append", [key(1), key(2), "wrong-name", "2"], true);
const truncated = join(run, "truncated.params");
await copyFile(params(1), truncated);
await truncate(truncated, (await stat(truncated)).size - 1);
await native("verify", params(0), truncated, true);

const report = {
  complete: true,
  scope: production ? "production-sized native experiment; not ceremony acceptance" : "synthetic fixture; not browser or production acceptance",
  rustRevision: "f10c8a41ae019fb68c66fae0276159900b3a128c",
  snarkjs: "0.7.6",
  sizes: { zkey: (await stat(key(0))).size, bellman: (await stat(params(0))).size },
  rows,
};
await writeFile(join(run, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(`Passed mixed implementation chain and negative controls. Measurements: ${join(run, "report.json")}`);
