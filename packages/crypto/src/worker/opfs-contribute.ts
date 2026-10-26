import bellmanContribute from "@cabure/snarkjs-bellman-contribute";
import { buildBn128 } from "ffjavascript";
import phase2Contribute, {
  type SnarkjsContributionLogger,
} from "@cabure/snarkjs-phase2-contribute";

import { bytesToHexRaw } from "../hex.js";
import {
  forceCloseOpfsDescriptor,
  type OpfsFastFileDescriptor,
} from "./opfs-fastfile.js";

export interface OpfsContributionResult {
  /** snarkjs's Blake2b contribution identifier. */
  contributionHash: string;
}

export type OpfsComputeProgress = (percent: number) => void;

function progressLogger(onProgress?: OpfsComputeProgress):
  | SnarkjsContributionLogger
  | undefined {
  if (!onProgress) return undefined;

  return {
    debug(message: string) {
      // snarkjs 0.7.6 emits `Applying key: L Section: i/n` and the same for H.
      // Map the two transformed sections to the middle 90% of this stage.
      const match = /^Applying key: (L|H) Section: (\d+)\/(\d+)$/.exec(
        message,
      );
      if (!match) return;
      const completed = Number(match[2]);
      const total = Number(match[3]);
      if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) {
        return;
      }
      const sectionStart = match[1] === "L" ? 5 : 50;
      onProgress(
        Math.min(95, sectionStart + Math.floor((completed / total) * 45)),
      );
    },
    // Circuit/contribution hashes are returned through typed fields; avoid
    // logging transcript material from the worker.
    info() {},
  };
}

/**
 * Apply the unmodified snarkjs 0.7.6 Phase 2 arithmetic with OPFS-backed I/O.
 *
 * The input and output handles remain on disk for the entire operation. Only
 * snarkjs's bounded point batches and this adapter's I/O pages enter JS memory.
 */
export async function contributeOpfsFiles(
  previousZkey: FileSystemFileHandle,
  newZkey: FileSystemFileHandle,
  entropy: Uint8Array,
  name = "contributor",
  onProgress?: OpfsComputeProgress,
): Promise<OpfsContributionResult> {
  if (entropy.length === 0) {
    throw new Error("contributeOpfsFiles: entropy must not be empty");
  }

  if (await previousZkey.isSameEntry(newZkey)) {
    throw new Error("contributeOpfsFiles: input and output must be different files");
  }

  const previousDescriptor: OpfsFastFileDescriptor = {
    type: "opfs",
    handle: previousZkey,
  };
  const newDescriptor: OpfsFastFileDescriptor = {
    type: "opfs",
    handle: newZkey,
  };

  try {
    const contributionHash = await phase2Contribute(
      previousDescriptor,
      newDescriptor,
      name,
      bytesToHexRaw(entropy),
      progressLogger(onProgress),
    );
    return { contributionHash: `0x${bytesToHexRaw(contributionHash)}` };
  } finally {
    // zkey_contribute closes both descriptors on its success path but not all
    // exception paths. Always release OPFS locks so cleanup/fallback can run.
    forceCloseOpfsDescriptor(previousDescriptor);
    forceCloseOpfsDescriptor(newDescriptor);
  }
}


/** Same pinned arithmetic as the measured Bellman prototype, using OPFS I/O. */
export async function contributeBellmanOpfsFiles(previous: FileSystemFileHandle, next: FileSystemFileHandle,
  entropy: Uint8Array): Promise<OpfsContributionResult> {
  if (entropy.length === 0 || await previous.isSameEntry(next)) throw new Error("invalid Bellman contribution input");
  const input: OpfsFastFileDescriptor = { type: "opfs", handle: previous };
  const output: OpfsFastFileDescriptor = { type: "opfs", handle: next };
  const curve = await buildBn128();
  try {
    const hash = await bellmanContribute(curve, input, output, bytesToHexRaw(entropy));
    return { contributionHash: `0x${bytesToHexRaw(hash)}` };
  } finally {
    forceCloseOpfsDescriptor(input); forceCloseOpfsDescriptor(output);
    await curve.terminate?.();
  }
}
