// Loopback-only disposable test server. Fixed routes; never serves the repo.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const run = resolve(process.argv[2] ?? "");
assert.ok(run.startsWith(join(here, "runs") + sep), "provide an interop run directory under experiments/bellman/runs");
const input = join(run, "0.params");
const expected = (await stat(input)).size + 384;
const output = join(run, "browser.params");
const imported = join(run, "browser.zkey");
const flags = process.argv.slice(3);
assert.ok(flags.every(flag => ["--production", "--snarkjs"].includes(flag)), "usage: node browser-server.mjs RUN_DIRECTORY [--production] [--snarkjs]");
const production = flags.includes("--production");
const snarkjs = flags.includes("--snarkjs");
const genesis = production ? resolve(here, "../../artifacts/moonsong-local/genesis.zkey") : join(run, "0.zkey");
const ptau = resolve(here, production ? "../../artifacts/moonsong-local/powersoftau.ptau" : "../../packages/crypto/tests/fixtures/pot_final.ptau");
const staticFiles = new Map([
  ["/worker.mjs", [join(here, snarkjs ? "browser-build/snarkjs-worker.mjs" : "browser-worker.mjs"), "text/javascript"]],
  ["/wasm/moss_bellman_wasm_prototype.js", [join(here, "wasm/pkg/moss_bellman_wasm_prototype.js"), "text/javascript"]],
  ["/wasm/moss_bellman_wasm_prototype_bg.wasm", [join(here, "wasm/pkg/moss_bellman_wasm_prototype_bg.wasm"), "application/wasm"]],
  ["/input", [input, "application/octet-stream"]],
]);
async function checked(command, args) {
  await new Promise((resolveChild, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveChild() : reject(new Error("verification failed")));
  });
}
async function js(...args) {
  await checked(process.execPath, [join(here, "interop.mjs"), "--operation", JSON.stringify(args)]);
}
let attempted = false;
let verificationState = "waiting";
let origin;
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><meta charset="utf-8"><title>Bellman worker prototype</title>
<h1>Isolated Bellman browser test</h1><p id="status">Running synthetic or pinned-artifact experiment…</p>
<script type="module">
window.result = null;
const worker = new Worker('/worker.mjs', { type: 'module' });
worker.onmessage = async ({data}) => {
  if (data.stage === 'output-ready') {
    worker.terminate();
    window.progress = {stage: 'uploading-and-verifying', ...data.metrics};
    document.querySelector('#status').textContent = JSON.stringify(window.progress);
    try {
      const directory = await navigator.storage.getDirectory();
      const handle = await directory.getFileHandle(data.fileName);
      const file = await handle.getFile();
      const response = await fetch('/output', {method:'POST', headers:{'Content-Type':'application/octet-stream', 'X-Prototype-Metrics':JSON.stringify(data.metrics)}, body:file});
      if (!response.ok) throw new Error('verification failed');
      await response.text();
      for (;;) {
        const status = await fetch('/status').then(response => response.json());
        if (status.state === 'verified') break;
        if (status.state === 'failed') throw new Error('verification failed');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      let cleanupCompleted = true;
      try { await directory.removeEntry(data.fileName); } catch { cleanupCompleted = false; }
      window.result = {ok:true, cleanupCompleted, ...data.metrics};
    } catch (error) { window.result = {ok:false, errorName:error.name}; }
    document.querySelector('#status').textContent = JSON.stringify(window.result);
  } else {
    document.querySelector('#status').textContent = JSON.stringify(data);
    if ('ok' in data) { window.result = data; worker.terminate(); }
    else { window.progress = data; }
  }
};
worker.onerror = () => { window.result = {ok:false}; document.querySelector('#status').textContent = 'Worker failed'; worker.terminate(); };
worker.postMessage({});
</script>`);
    } else if (req.method === "GET" && req.url === "/status") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ state: verificationState }));
    } else if (req.method === "GET" && staticFiles.has(req.url)) {
      const [path, mime] = staticFiles.get(req.url);
      res.setHeader("Content-Type", mime);
      res.setHeader("Content-Length", (await stat(path)).size);
      const stream = createReadStream(path);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    } else if (req.method === "POST" && req.url === "/output") {
      if (req.headers.origin !== origin || attempted) { res.writeHead(403).end(); return; }
      attempted = true;
      // Untrusted telemetry is kept separate from cryptographic acceptance.
      let browserMetrics = null;
      const metricsHeader = req.headers["x-prototype-metrics"];
      if (typeof metricsHeader === "string" && metricsHeader.length < 512) {
        const parsed = JSON.parse(metricsHeader);
        const names = ["computeMilliseconds", "wasmMemoryBytes", "inputBytes", "outputBytes"];
        if (names.every((key) => Number.isSafeInteger(parsed[key]) && parsed[key] >= 0)) {
          browserMetrics = Object.fromEntries(names.map((key) => [key, parsed[key]]));
          browserMetrics.engine = snarkjs ? "snarkjs-opfs" : "rust-wasm";
          if (Number.isSafeInteger(parsed.concurrency) && parsed.concurrency > 0) browserMetrics.concurrency = parsed.concurrency;
          await writeFile(join(run, "browser-metrics.json"), JSON.stringify(browserMetrics) + "\n");
        }
      }
      let length = 0;
      const file = await open(output, "wx", 0o600);
      try {
        for await (const chunk of req) {
          length += chunk.length;
          if (length > expected) throw new Error("oversized upload");
          await file.writeFile(chunk);
        }
        assert.equal(length, expected);
      } finally { await file.close(); }
      verificationState = "verifying";
      res.writeHead(202).end("uploaded; verification pending");
      // Do not hold the upload response open for multi-minute conversion work.
      void (async () => {
        try {
          await checked(join(here, "target/release/moss-bellman-prototype"), ["verify", input, output]);
          await js("importBellman", genesis, output, imported, "browser-prototype");
          await js("append", genesis, imported, "browser-prototype", "1");
          await js("verifyFromInit", genesis, ptau, imported);
          await writeFile(join(run, "browser-verification.json"), JSON.stringify({ rustTransition: true, exactAppend: true, snarkjsFromInit: true, browserMetrics }) + "\n");
          verificationState = "verified";
          console.log("Browser output passed Rust transition, exact append, and snarkjs verification.");
        } catch {
          verificationState = "failed";
          console.log("Browser output failed verification (details suppressed).");
        }
      })();
    } else { res.writeHead(404).end(); }
  } catch {
    if (req.method === "POST" && req.url === "/output" && attempted) verificationState = "failed";
    console.log("Browser test request failed (details suppressed).");
    res.writeHead(500).end("test failed");
  }
});
server.listen(0, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`Prototype only: ${origin}`);
});
