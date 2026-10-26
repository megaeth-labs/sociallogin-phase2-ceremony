import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeInfinity } from "./encoding.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../packages/crypto/tests/fixtures");
const rust = join(here, "target/release/moss-bellman-prototype");
function operation(...args) {
  execFileSync(process.execPath, [join(here, "interop.mjs"), "--operation", JSON.stringify(args)], { stdio: "ignore" });
}
async function setup(t, flags = []) {
  await mkdir(join(here, "runs"), { recursive: true, mode: 0o700 });
  const run = await mkdtemp(join(here, "runs/http-test-"));
  t.after(() => rm(run, { recursive: true, force: true }));
  operation("newZKey", join(fixtures, "multiplier.r1cs"), join(fixtures, "pot_final.ptau"), join(run, "0.zkey"));
  operation("exportBellman", join(run, "0.zkey"), join(run, "raw.params"));
  await normalizeInfinity(join(run, "raw.params"), join(run, "0.params"));
  const candidate = join(run, "candidate.params");
  // Also proves the native binary works; missing/broken tooling cannot make
  // the invalid-candidate test pass merely by failing to start verification.
  execFileSync(rust, ["contribute", join(run, "0.params"), candidate], { stdio: "ignore" });
  const server = spawn(process.execPath, [join(here, "browser-server.mjs"), run, ...flags], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => server.kill("SIGTERM"));
  const origin = await new Promise((resolveOrigin, reject) => {
    let text = "";
    server.stdout.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/Prototype only: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolveOrigin(match[1]);
    });
    server.once("error", reject);
    server.once("exit", () => reject(new Error("test server exited")));
  });
  return { origin, candidate };
}
async function status(origin) {
  const response = await fetch(`${origin}/status`);
  assert.equal(response.status, 200);
  return (await response.json()).state;
}
async function terminal(origin) {
  for (let i = 0; i < 100; i++) {
    const state = await status(origin);
    if (["verified", "failed"].includes(state)) return state;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error("verification did not finish");
}

test("upload is asynchronous; only successful verification yields verified status", { timeout: 30000 }, async (t) => {
  const { origin, candidate } = await setup(t);
  assert.equal(await status(origin), "waiting");
  const forbidden = await fetch(`${origin}/output`, { method: "POST", headers: { Origin: "http://untrusted.invalid" }, body: "invalid" });
  assert.equal(forbidden.status, 403);
  assert.equal(await status(origin), "waiting");
  const response = await fetch(`${origin}/output`, {
    method: "POST", headers: { Origin: origin }, body: createReadStream(candidate), duplex: "half",
  });
  assert.equal(response.status, 202);
  await response.text();
  assert.equal(await terminal(origin), "verified");
  const duplicate = await fetch(`${origin}/output`, { method: "POST", headers: { Origin: origin }, body: "invalid" });
  assert.equal(duplicate.status, 403);
});

test("a correctly sized invalid candidate fails verification after upload", { timeout: 30000 }, async (t) => {
  const { origin, candidate } = await setup(t);
  const response = await fetch(`${origin}/output`, {
    method: "POST", headers: { Origin: origin }, body: Buffer.alloc((await stat(candidate)).size),
  });
  assert.equal(response.status, 202);
  await response.text();
  assert.equal(await terminal(origin), "failed");
});

test("an oversized upload cannot leave status waiting or become verified", { timeout: 30000 }, async (t) => {
  const { origin, candidate } = await setup(t);
  try {
    const response = await fetch(`${origin}/output`, {
      method: "POST", headers: { Origin: origin }, body: Buffer.alloc((await stat(candidate)).size + 1),
    });
    assert.equal(response.status, 500);
  } catch (error) {
    // Node may destroy an oversized request's socket while rejecting its body.
    assert.equal(error.name, "TypeError");
  }
  assert.equal(await terminal(origin), "failed");
});

// Run build-browser.mjs before this test: the comparison route must serve the
// isolated browser bundle, and must not expand the server's file exposure.
test("snarkjs mode serves only the fixed comparison worker route", { timeout: 30000 }, async (t) => {
  const { origin } = await setup(t, ["--snarkjs"]);
  const worker = await fetch(`${origin}/worker.mjs`);
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get("content-type"), /javascript/);
  assert.match(await worker.text(), /buildBn128/);
  assert.equal((await fetch(`${origin}/snarkjs-worker.mjs`)).status, 404);
  assert.equal((await fetch(`${origin}/package.json`)).status, 404);
});
