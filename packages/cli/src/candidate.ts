import { stat } from "node:fs/promises";
import { join } from "node:path";

import { inspectBellmanAppend } from "@moss/phase2-zkey-inspect/bellman";

import type { ContributionFormat } from "./contribution.js";
import { contributionWorkspacePath, hashFile, type DownloadResult } from "./files.js";
import type { ContributionJournalV1 } from "./journal.js";
import type { LeaseResponse } from "./types.js";

/**
 * Require the successor to be the predecessor with exactly one appended
 * 384-byte Bellman record, every fixed section unchanged, and snarkjs's
 * returned identifier equal to the BLAKE2b-512 of that record. This is the
 * structural check the browser and verifier also run; the verifier's pairing
 * checks remain the cryptographic authority.
 */
export async function checkBellmanAppend(input: {
  predecessorPath: string;
  successorPath: string;
  baseGeneration: number;
  contributionHashBlake2b512: string;
}): Promise<void> {
  let appended: Awaited<ReturnType<typeof inspectBellmanAppend>>;
  try {
    appended = await inspectBellmanAppend(input.predecessorPath, input.successorPath, input.baseGeneration);
  } catch (error) {
    throw new Error(`Bellman contribution output is malformed: ${error instanceof Error ? error.message : "inspection failed"}.`);
  }
  if (
    appended.contributionIndex !== input.baseGeneration + 1 ||
    appended.contributionHashBlake2b512 !== input.contributionHashBlake2b512
  ) {
    throw new Error("Bellman contribution identifier does not match the appended record.");
  }
}

export interface SavedCandidate {
  workspace: string;
  predecessor: DownloadResult;
  successor: DownloadResult;
  contributionHashBlake2b512: string;
}

/**
 * Find a contribution this client already computed for the active lease, so a
 * restart re-uploads it instead of drawing new randomness and recomputing.
 * Returns null unless the journal, both retained files and the lease agree.
 */
export async function savedCandidate(input: {
  journal: ContributionJournalV1;
  lease: LeaseResponse;
  manifestSha256: string;
  participantName: string;
  format: ContributionFormat;
}): Promise<SavedCandidate | null> {
  const { journal, lease, format } = input;
  const evidence = journal.evidence;
  if (!journal.workspaceId || !evidence || journal.leaseId !== lease.leaseId) return null;
  if (
    evidence.manifestSha256 !== input.manifestSha256 ||
    evidence.predecessorSha256 !== lease.predecessor.sha256 ||
    evidence.predecessorByteLength !== lease.predecessor.byteLength ||
    evidence.contributionName !== lease.expectedContributionName ||
    evidence.baseGeneration !== lease.baseGeneration ||
    evidence.participantPseudonym !== input.participantName
  ) {
    return null;
  }
  const workspace = contributionWorkspacePath(journal.workspaceId);
  const extension = format === "bellman" ? "params" : "zkey";
  const predecessorPath = join(workspace, `predecessor.${extension}`);
  const successorPath = join(workspace, `successor.${extension}`);
  if (!(await isFile(predecessorPath)) || !(await isFile(successorPath))) return null;
  const [predecessor, successor] = await Promise.all([hashFile(predecessorPath), hashFile(successorPath)]);
  if (
    predecessor.sha256 !== evidence.predecessorSha256 ||
    predecessor.byteLength !== evidence.predecessorByteLength ||
    successor.sha256 !== evidence.successorSha256 ||
    successor.byteLength !== evidence.successorByteLength
  ) {
    return null;
  }
  if (format === "bellman") {
    await checkBellmanAppend({
      predecessorPath,
      successorPath,
      baseGeneration: lease.baseGeneration,
      contributionHashBlake2b512: evidence.contributionHashBlake2b512,
    });
  }
  return { workspace, predecessor, successor, contributionHashBlake2b512: evidence.contributionHashBlake2b512 };
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}
