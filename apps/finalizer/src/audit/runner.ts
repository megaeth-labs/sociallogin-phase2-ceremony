import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { inspectBellmanAppend, normalizeBellmanForRust } from "@moss/phase2-zkey-inspect";

import { hashRegularFile } from "../hashing.js";
import type { TransitionRunner, TransitionVerdict } from "./types.js";

/**
 * The same checks as the verifier worker's BellmanPassRunner, without a job
 * or receipt in the loop: structural append inspection, disposable
 * Rust-normalized copies, then the pinned native verifier. The identifier it
 * prints is returned for the caller to compare with the signed receipt.
 */
export class NativeBellmanTransitionRunner implements TransitionRunner {
  private constructor(
    private readonly binaryPath: string,
    readonly binarySha256: string,
    private readonly timeoutMs: number,
  ) {}

  static async create(binaryPath: string, timeoutMs = 1_800_000): Promise<NativeBellmanTransitionRunner> {
    if (!isAbsolute(binaryPath)) throw new Error("Bellman verifier requires an absolute binary path");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("invalid Bellman verification timeout");
    const binary = await hashRegularFile(binaryPath).catch(() => {
      throw new Error("Bellman verifier binary is unavailable");
    });
    return new NativeBellmanTransitionRunner(binaryPath, binary.sha256, timeoutMs);
  }

  async run(input: {
    predecessorPath: string;
    candidatePath: string;
    predecessorCount: number;
    scratchDirectory: string;
    signal?: AbortSignal;
  }): Promise<TransitionVerdict> {
    let append: { contributionIndex: number; contributionHashBlake2b512: string };
    try {
      append = await inspectBellmanAppend(input.predecessorPath, input.candidatePath, input.predecessorCount);
    } catch {
      return { valid: false, observedContributionHashBlake2b512: null, observedContributionIndex: null, reason: "BELLMAN_FRAMING_REJECTED" };
    }
    const directory = await mkdtemp(join(input.scratchDirectory, "transition-"));
    try {
      const predecessor = join(directory, "predecessor.params");
      const candidate = join(directory, "candidate.params");
      await normalizeBellmanForRust(input.predecessorPath, predecessor, input.predecessorCount);
      input.signal?.throwIfAborted();
      await normalizeBellmanForRust(input.candidatePath, candidate, input.predecessorCount + 1);
      input.signal?.throwIfAborted();
      const hash = await runNative(this.binaryPath, [predecessor, candidate, String(input.predecessorCount)], this.timeoutMs, input.signal);
      if (hash === null) {
        return { valid: false, observedContributionHashBlake2b512: null, observedContributionIndex: append.contributionIndex, reason: "BELLMAN_REJECTED" };
      }
      if (hash !== append.contributionHashBlake2b512) throw new Error("Bellman verifier hash disagrees with the appended record");
      return { valid: true, observedContributionHashBlake2b512: hash, observedContributionIndex: append.contributionIndex };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function runNative(binary: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"], env: {}, windowsHide: true });
    let stdout = "";
    let failure: Error | undefined;
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
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Exit 1 is a rejection; anything else unexpected is a verifier failure,
      // never acceptance.
      if (failure) reject(failure);
      else if (code === 1 && stdout === "") resolve(null);
      else if (code === 0 && /^[a-f0-9]{128}\n$/u.test(stdout)) resolve(stdout.trim());
      else reject(new Error("Bellman verifier failed"));
    });
  });
}
