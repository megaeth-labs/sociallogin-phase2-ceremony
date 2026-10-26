// Offline transition check. Authenticate the manifest/receipts and compare these
// file digests separately; a valid transition alone does not prove inclusion.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectBellmanAppend } from "../zkey-inspect/dist/index.js";
import { BellmanPassRunner } from "../../apps/verifier-worker/dist/bellman-runner.js";

const [predecessor, candidate, countText, ...extra] = process.argv.slice(2);
const count = Number(countText);
if (!predecessor || !candidate || !/^(0|[1-9][0-9]*)$/.test(countText ?? "") ||
    !Number.isSafeInteger(count) || count > 999999 || extra.length) {
  console.error("Usage: node packages/bellman-verify/verify.mjs PREDECESSOR CANDIDATE PREDECESSOR_COUNT");
  process.exit(2);
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { sha256: hash.digest("hex"), byteLength: (await stat(path)).size };
}
try {
  const predecessorPath = resolve(predecessor), candidatePath = resolve(candidate);
  const before = await Promise.all([digest(predecessorPath), digest(candidatePath)]);
  const append = await inspectBellmanAppend(predecessorPath, candidatePath, count);
  const binary = fileURLToPath(new URL("./target/release/moss-bellman-verify", import.meta.url));
  const result = await new BellmanPassRunner(binary).run({ predecessorPath, candidatePath,
    genesisPath: "", ptauPath: "", expectedContributionName: "",
    expectedContributionHashBlake2b512: append.contributionHashBlake2b512,
    maxPredecessorContributions: count }, 600000);
  const after = await Promise.all([digest(predecessorPath), digest(candidatePath)]);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("files changed");
  if (result.result !== "valid") throw new Error("invalid transition");
  console.log(JSON.stringify({ valid: true, predecessor: before[0], candidate: before[1],
    contributionIndex: append.contributionIndex,
    contributionHashBlake2b512: append.contributionHashBlake2b512 }, null, 2));
} catch {
  console.error("Transition verification failed. Check inputs, count, build and available resources.");
  process.exitCode = 1;
}
