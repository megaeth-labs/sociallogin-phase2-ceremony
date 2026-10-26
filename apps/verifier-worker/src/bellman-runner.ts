import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { inspectBellmanAppend, normalizeBellmanForRust } from "@moss/phase2-zkey-inspect";
import type { VerificationPassInput, VerificationPassOutput, VerificationPassRunner } from "./types.js";

/** Binary is part of the pinned worker image; never supplied by a job/client. */
export class BellmanPassRunner implements VerificationPassRunner {
  constructor(private readonly binaryPath: string) {
    if (!isAbsolute(binaryPath)) throw new Error("Bellman verifier requires an absolute binary path");
  }
  async run(input: VerificationPassInput, timeoutMs: number, signal?: AbortSignal): Promise<VerificationPassOutput> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error("invalid Bellman verification timeout");
    const directory = await mkdtemp(join(dirname(input.candidatePath), "bellman-verify-"));
    const invalid: VerificationPassOutput = { result: "invalid", prefixValid: false, verifyFromInit: false,
      bellmanTransition: false, observedContributionName: null, observedContributionHashBlake2b512: null,
      observedContributionIndex: null, errorCode: "BELLMAN_REJECTED" };
    try {
      signal?.throwIfAborted();
      let append;
      try { append = await inspectBellmanAppend(input.predecessorPath, input.candidatePath, input.maxPredecessorContributions); }
      catch { return invalid; }
      const observed = { ...invalid, prefixValid: true,
        observedContributionHashBlake2b512: append.contributionHashBlake2b512,
        observedContributionIndex: append.contributionIndex };
      if (append.contributionHashBlake2b512 !== input.expectedContributionHashBlake2b512) return observed;
      const predecessor = join(directory, "predecessor.params"), candidate = join(directory, "candidate.params");
      await normalizeBellmanForRust(input.predecessorPath, predecessor, input.maxPredecessorContributions);
      signal?.throwIfAborted();
      await normalizeBellmanForRust(input.candidatePath, candidate, input.maxPredecessorContributions + 1);
      signal?.throwIfAborted();
      const hash = await runNative(this.binaryPath, [predecessor, candidate, String(input.maxPredecessorContributions)], timeoutMs, signal);
      if (hash === null) return observed;
      if (hash !== append.contributionHashBlake2b512) throw new Error("Bellman verifier hash disagreement");
      return { result: "valid", prefixValid: true, verifyFromInit: false, bellmanTransition: true,
        observedContributionName: null, observedContributionHashBlake2b512: hash, observedContributionIndex: append.contributionIndex };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

async function runNative(binary: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"], env: {}, windowsHide: true });
    let stdout = "", failure: Error | undefined;
    const abort = () => { failure = new Error("Bellman verification aborted"); child.kill("SIGKILL"); };
    const timer = setTimeout(() => { failure = new Error("Bellman verification timed out"); child.kill("SIGKILL"); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (bytes: Buffer) => {
      if (stdout.length + bytes.length > 129) { failure = new Error("invalid Bellman verifier response"); child.kill("SIGKILL"); }
      else stdout += bytes.toString("ascii");
    });
    child.once("error", () => { failure = new Error("Bellman verifier unavailable"); });
    child.once("close", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code === 1 && stdout === "") resolve(null);
      else if (code === 0 && /^[a-f0-9]{128}\n$/.test(stdout)) resolve(stdout.trim());
      else reject(new Error("Bellman verifier failed"));
    });
  });
}
