import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BLAKE2B512 = /^[a-f0-9]{128}$/u;

// Embedded by build.mjs; absent when the sources run unbundled under tests.
declare const __MOSS_CONTRIBUTION_WORKER_SHA256__: string | undefined;
const EMBEDDED_WORKER_SHA256 =
  typeof __MOSS_CONTRIBUTION_WORKER_SHA256__ === "string" ? __MOSS_CONTRIBUTION_WORKER_SHA256__ : undefined;

/** Refuse a worker file that differs from the one this pinned build was made with. */
export async function assertContributionWorker(workerUrl: URL, expectedSha256 = EMBEDDED_WORKER_SHA256): Promise<void> {
  if (expectedSha256 === undefined) return;
  const actual = createHash("sha256").update(await readFile(fileURLToPath(workerUrl))).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error("The contribution worker differs from this CLI release. Reinstall the published release.");
  }
}

/** The signed verification method decides the artifact format, never the file. */
export type ContributionFormat = "zkey" | "bellman";

export async function computeContribution(input: {
  predecessorPath: string;
  successorPath: string;
  contributionName: string;
  format: ContributionFormat;
}, workerUrl = new URL("./contribution-worker.js", import.meta.url)): Promise<string> {
  await assertContributionWorker(workerUrl);
  const worker = fork(workerUrl, [], {
    env: {},
    serialization: "json",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        reject(new Error(`Contribution process exited before returning a result (code ${code}).`));
      });
      worker.send(input, (error) => {
        if (error) reject(error);
      });
    });
    if (!result || typeof result !== "object") throw new Error("Contribution worker returned an invalid result.");
    const response = result as { ok?: unknown; contributionHashBlake2b512?: unknown; error?: unknown };
    if (response.ok !== true) {
      throw new Error(typeof response.error === "string" ? response.error : "Contribution worker failed.");
    }
    if (
      typeof response.contributionHashBlake2b512 !== "string" ||
      !BLAKE2B512.test(response.contributionHashBlake2b512)
    ) {
      throw new Error("Contribution worker returned an invalid contribution hash.");
    }
    return response.contributionHashBlake2b512;
  } finally {
    try { worker.disconnect(); } catch { /* already disconnected */ }
    worker.kill("SIGTERM");
  }
}
