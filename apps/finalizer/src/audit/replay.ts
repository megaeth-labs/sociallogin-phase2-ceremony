import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactRef } from "@moss/phase2-protocol";

import { hashRegularFile } from "../hashing.js";
import type { ChainLink, Findings } from "./records.js";
import type { AuditFetcher, AuditTransition, TransitionRunner } from "./types.js";

export interface ReplayOptions {
  links: ChainLink[];
  sealedGeneration: number;
  fetcher: AuditFetcher;
  runner: TransitionRunner;
  workDir: string;
  statePath: string;
  jobs: number;
  chunkSize: number;
  signal?: AbortSignal;
  onTransition?: (entry: { generation: number; result: AuditTransition["result"]; seconds: number | null }) => void;
}

export interface ReplayResult {
  transitions: AuditTransition[];
  timings: Array<{ generation: number; seconds: number | null; resumed: boolean }>;
}

interface StateEntry {
  v: 1;
  generation: number;
  predecessorSha256: string;
  successorSha256: string;
  contributionHashBlake2b512: string;
  verifierSha256: string | null;
  result: "valid";
}

/**
 * Replays every predecessor -> successor transition with the native verifier.
 * Valid results are appended to a local state file keyed by both artifact
 * hashes, the expected identifier and the verifier binary, so an interrupted
 * run resumes without repeating finished work. Workers take contiguous
 * chunks so each artifact is fetched about once and at most two artifacts
 * (plus two normalized copies) sit on disk per worker.
 */
export async function replayTransitions(options: ReplayOptions, findings: Findings): Promise<ReplayResult> {
  if (!Number.isSafeInteger(options.jobs) || options.jobs < 1 || options.jobs > 64) throw new Error("jobs must be 1-64");
  if (!Number.isSafeInteger(options.chunkSize) || options.chunkSize < 1) throw new Error("chunk size must be positive");
  const state = await loadState(options.statePath, options.runner.binarySha256);
  const writer = new StateWriter(options.statePath);
  const byGeneration = new Map(options.links.map((link) => [link.generation, link]));
  const transitions = new Map<number, AuditTransition>();
  const timings = new Map<number, { seconds: number | null; resumed: boolean }>();
  const pending: ChainLink[] = [];

  for (let generation = 1; generation <= options.sealedGeneration; generation += 1) {
    findings.item("replay");
    const link = byGeneration.get(generation);
    if (!link || !link.authenticated) {
      findings.fail("replay", generation, "transition not replayed: no authenticated receipt");
      transitions.set(generation, {
        generation, predecessorSha256: link?.predecessor.sha256 ?? "", successorSha256: link?.successor.sha256 ?? "",
        expectedContributionHashBlake2b512: link?.contributionHashBlake2b512 ?? "",
        observedContributionHashBlake2b512: null, result: "not-run",
      });
      timings.set(generation, { seconds: null, resumed: false });
      continue;
    }
    const saved = state.get(generation);
    if (saved && saved.predecessorSha256 === link.predecessor.sha256 && saved.successorSha256 === link.successor.sha256
      && saved.contributionHashBlake2b512 === link.contributionHashBlake2b512) {
      transitions.set(generation, transition(link, link.contributionHashBlake2b512, "valid"));
      timings.set(generation, { seconds: null, resumed: true });
      continue;
    }
    pending.push(link);
  }

  const chunks: ChainLink[][] = [];
  for (const link of pending) {
    const last = chunks.at(-1);
    if (last && last.length < options.chunkSize && last.at(-1)!.generation + 1 === link.generation) last.push(link);
    else chunks.push([link]);
  }

  let next = 0;
  const worker = async (index: number) => {
    const scratch = join(options.workDir, "scratch", `worker-${index}`);
    await mkdir(scratch, { recursive: true });
    for (;;) {
      if (options.signal?.aborted) return;
      const chunk = chunks[next++];
      if (!chunk) return;
      let carried: { ref: ArtifactRef; path: string; release(): Promise<void> } | undefined;
      try {
        for (const link of chunk) {
          if (options.signal?.aborted) return;
          const started = performance.now();
          let predecessor = carried && carried.ref.sha256 === link.predecessor.sha256 ? carried : undefined;
          if (!predecessor && carried) { await carried.release(); carried = undefined; }
          let successor: typeof carried;
          try {
            predecessor ??= { ref: link.predecessor, ...(await options.fetcher.materialize(link.predecessor, scratch)) };
            successor = { ref: link.successor, ...(await options.fetcher.materialize(link.successor, scratch)) };
            await assertDigests(predecessor.path, link.predecessor, "predecessor");
            await assertDigests(successor.path, link.successor, "successor");
            const verdict = await options.runner.run({
              predecessorPath: predecessor.path, candidatePath: successor.path,
              predecessorCount: link.generation - 1, scratchDirectory: scratch, signal: options.signal,
            });
            // The verifier must not have touched its inputs, and neither may anything else.
            await assertDigests(predecessor.path, link.predecessor, "predecessor");
            await assertDigests(successor.path, link.successor, "successor");
            const observed = verdict.observedContributionHashBlake2b512;
            let result: AuditTransition["result"] = "valid";
            if (!verdict.valid) {
              result = "invalid";
              findings.fail("replay", link.generation, `transition rejected by the native verifier (${verdict.reason ?? "BELLMAN_REJECTED"})`);
            } else if (observed !== link.contributionHashBlake2b512 || verdict.observedContributionIndex !== link.generation) {
              result = "invalid";
              findings.fail("replay", link.generation, "verified contribution identifier differs from the signed receipt");
            }
            transitions.set(link.generation, transition(link, observed, result));
            const seconds = Math.round(performance.now() - started) / 1_000;
            timings.set(link.generation, { seconds, resumed: false });
            if (result === "valid") {
              await writer.append({
                v: 1, generation: link.generation, predecessorSha256: link.predecessor.sha256,
                successorSha256: link.successor.sha256, contributionHashBlake2b512: link.contributionHashBlake2b512,
                verifierSha256: options.runner.binarySha256, result: "valid",
              });
            }
            options.onTransition?.({ generation: link.generation, result, seconds });
          } catch (error) {
            if (options.signal?.aborted) return;
            findings.fail("replay", link.generation, `transition replay error: ${error instanceof Error ? error.message : "unknown error"}`);
            transitions.set(link.generation, transition(link, null, "not-run"));
            timings.set(link.generation, { seconds: null, resumed: false });
            options.onTransition?.({ generation: link.generation, result: "not-run", seconds: null });
          }
          if (predecessor && predecessor !== successor) await predecessor.release();
          carried = successor;
        }
      } finally {
        await carried?.release();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(options.jobs, Math.max(chunks.length, 1)) }, (_, index) => worker(index)));
  } finally {
    await writer.close();
  }

  for (let generation = 1; generation <= options.sealedGeneration; generation += 1) {
    if (!transitions.has(generation)) {
      // Only reachable when aborted: say so rather than imply a pass.
      const link = byGeneration.get(generation)!;
      findings.fail("replay", generation, "transition replay was interrupted");
      transitions.set(generation, transition(link, null, "not-run"));
      timings.set(generation, { seconds: null, resumed: false });
    }
  }
  const ordered = [...transitions.values()].sort((a, b) => a.generation - b.generation);
  return {
    transitions: ordered,
    timings: ordered.map(({ generation }) => ({ generation, ...timings.get(generation)! })),
  };
}

function transition(link: ChainLink, observed: string | null, result: AuditTransition["result"]): AuditTransition {
  return {
    generation: link.generation,
    predecessorSha256: link.predecessor.sha256,
    successorSha256: link.successor.sha256,
    expectedContributionHashBlake2b512: link.contributionHashBlake2b512,
    observedContributionHashBlake2b512: observed,
    result,
  };
}

async function assertDigests(path: string, ref: ArtifactRef, label: string): Promise<void> {
  const digests = await hashRegularFile(path);
  if (digests.sha256 !== ref.sha256 || digests.byteLength !== ref.byteLength) {
    throw new Error(`${label} bytes do not match the signed receipt`);
  }
}

async function loadState(path: string, verifierSha256: string | null): Promise<Map<number, StateEntry>> {
  const entries = new Map<number, StateEntry>();
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: StateEntry;
    try { entry = JSON.parse(line) as StateEntry; } catch { continue; } // a torn final line after a crash
    if (entry?.v !== 1 || entry.result !== "valid" || !Number.isSafeInteger(entry.generation)) continue;
    // A different verifier binary invalidates earlier work.
    if (entry.verifierSha256 !== verifierSha256) continue;
    entries.set(entry.generation, entry);
  }
  return entries;
}

/** Serialized, synced appends so concurrent workers never interleave lines. */
class StateWriter {
  private queue: Promise<void> = Promise.resolve();
  private handle: Promise<Awaited<ReturnType<typeof open>>> | undefined;

  constructor(private readonly path: string) {}

  append(entry: StateEntry): Promise<void> {
    const run = this.queue.then(async () => {
      this.handle ??= open(this.path, "a", 0o600);
      const handle = await this.handle;
      await handle.write(`${JSON.stringify(entry)}\n`);
      await handle.datasync();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.queue;
    if (this.handle) await (await this.handle).close();
  }
}
