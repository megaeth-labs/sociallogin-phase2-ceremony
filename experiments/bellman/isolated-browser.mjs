// Optional automation using an independently installed playwright-core 1.56.1.
// Run: node isolated-browser.mjs LOOPBACK_URL /absolute/path/to/playwright-core/index.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const url = new URL(process.argv[2]);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.protocol, "http:");
const { chromium } = await import(pathToFileURL(process.argv[3]).href);
const server = await chromium.launchServer({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const browser = await chromium.connect(server.wsEndpoint());
let peakBrowserTreeRssKiB = 0;
let samples = 0;
// Sample only PID/PPID/RSS, never process arguments or environment. This sums
// browser + descendant RSS (shared pages may be counted multiple times).
const timer = setInterval(() => {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    const pids = new Set([server.process().pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [pid, parent] of rows) if (pids.has(parent) && !pids.has(pid)) { pids.add(pid); changed = true; }
    }
    peakBrowserTreeRssKiB = Math.max(peakBrowserTreeRssKiB, rows.reduce((sum, [pid, , rss]) => sum + (pids.has(pid) ? rss : 0), 0));
    samples++;
  } catch { /* Measurement failure is reported through sample count. */ }
}, 500);
try {
  const page = await browser.newPage();
  const crashed = new Promise((_, reject) => page.once("crash", () => {
    console.log("Isolated browser renderer crashed");
    reject(new Error("renderer crash"));
  }));
  await page.goto(url.href);
  console.log(JSON.stringify({ browserVersion: browser.version() }));
  await Promise.race([crashed, page.waitForFunction(() => window.result !== null, null, { timeout: 30 * 60 * 1000 })]);
  const result = await page.evaluate(() => window.result);
  const report = { ...result, browserVersion: browser.version(), peakBrowserTreeRssKiB, rssSamples: samples };
  console.log(JSON.stringify(report));
  if (process.argv[4]) await writeFile(process.argv[4], JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  assert.equal(result.ok, true);
} finally {
  clearInterval(timer);
  await browser.close();
  await server.close();
}
