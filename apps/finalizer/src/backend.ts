import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { zKey } from "snarkjs";

import {
  inspectBn254Groth16Zkey,
  sourceFrom,
  verifyExactlyOneAppend,
} from "@moss/phase2-zkey-inspect";

import { sha256Bytes } from "./hashing.js";
import type {
  BackendMetadata,
  Phase2Backend,
  SealedHeadInspection,
} from "./types.js";

type OpenFile = typeof fs.promises.open;

const nativeOpen = fs.promises.open.bind(fs.promises) as OpenFile;
const fileHandleScope = new AsyncLocalStorage<Set<FileHandle>>();
let tracksFileHandles = false;

export class SnarkjsPhase2Backend implements Phase2Backend {
  private metadataPromise: Promise<
    BackendMetadata & { solidityTemplate: string }
  > | undefined;

  async importBellman(genesisPath: string, bellmanPath: string, outputPath: string): Promise<void> {
    await assertPathAbsent(outputPath);
    const result = await withTrackedSnarkjsHandles(() => zKey.importBellman(genesisPath, bellmanPath, outputPath));
    if (result === false) throw new Error("sealed Bellman import failed");
  }
  async exportBellman(zkeyPath: string, outputPath: string): Promise<void> {
    await assertPathAbsent(outputPath);
    await withTrackedSnarkjsHandles(() => zKey.exportBellman(zkeyPath, outputPath));
  }
  async metadata(): Promise<BackendMetadata> {
    const { solidityTemplate: _template, ...metadata } =
      await this.loadMetadata();
    return metadata;
  }

  async inspectSealedHead(
    sealedHeadPath: string,
    maxContributions: number,
  ): Promise<SealedHeadInspection> {
    if (!Number.isSafeInteger(maxContributions) || maxContributions < 0) {
      throw new Error("sealed head contribution bound is invalid");
    }
    const handle = await sourceFrom(sealedHeadPath);
    try {
      const inspected = await inspectBn254Groth16Zkey(handle.source, {
        maxContributions,
      });
      return {
        contributionCount: inspected.contributions.length,
        beaconContributionCount: inspected.contributions.filter(
          (contribution) => contribution.type === 1,
        ).length,
        nPublic: inspected.nPublic,
      };
    } finally {
      if (handle.owned) await handle.source.close?.();
    }
  }

  async verifyFromR1cs(
    r1csPath: string,
    ptauPath: string,
    zkeyPath: string,
  ): Promise<boolean> {
    await this.loadMetadata();
    return await withTrackedSnarkjsHandles(async () =>
      await zKey.verifyFromR1cs(r1csPath, ptauPath, zkeyPath),
    );
  }

  async applyBeacon(input: {
    sealedHeadPath: string;
    finalZkeyPath: string;
    contributionName: string;
    beaconHashHex: string;
    numIterationsExp: number;
  }): Promise<{ contributionHashBlake2b512: string }> {
    await this.loadMetadata();
    await assertPathAbsent(input.finalZkeyPath);
    const result = await withTrackedSnarkjsHandles(async () =>
      await zKey.beacon(
        input.sealedHeadPath,
        input.finalZkeyPath,
        input.contributionName,
        input.beaconHashHex,
        input.numIterationsExp,
      ),
    );
    if (!(result instanceof Uint8Array) || result.byteLength !== 64) {
      throw new Error("snarkjs did not return a canonical beacon contribution hash");
    }
    return {
      contributionHashBlake2b512: Buffer.from(result).toString("hex"),
    };
  }

  async verifyBeaconAppend(input: {
    sealedHeadPath: string;
    finalZkeyPath: string;
    expectedContributionName: string;
    expectedContributionHashBlake2b512: string;
    expectedBeaconHash: Uint8Array;
    expectedBeaconIterationsExp: number;
    maxPredecessorContributions: number;
  }) {
    const inspected = await verifyExactlyOneAppend(
      input.sealedHeadPath,
      input.finalZkeyPath,
      {
        expectedContributionName: input.expectedContributionName,
        expectedContributionHashBlake2b512:
          input.expectedContributionHashBlake2b512,
        expectedBeaconHash: input.expectedBeaconHash,
        expectedBeaconIterationsExp: input.expectedBeaconIterationsExp,
        maxPredecessorContributions: input.maxPredecessorContributions,
        kind: "beacon",
      },
    );
    if (inspected.contributionType !== 1) {
      throw new Error("final zkey did not append a beacon contribution");
    }
    return {
      predecessorCount: inspected.predecessorCount,
      candidateCount: inspected.candidateCount,
      contributionIndex: inspected.contributionIndex,
      contributionHashBlake2b512:
        inspected.contributionHashBlake2b512,
      csHash: inspected.csHash,
    };
  }

  async exportVerificationKey(finalZkeyPath: string): Promise<unknown> {
    await this.loadMetadata();
    return await withTrackedSnarkjsHandles(async () =>
      await zKey.exportVerificationKey(finalZkeyPath),
    );
  }

  async exportSolidityVerifier(finalZkeyPath: string): Promise<string> {
    const { solidityTemplate } = await this.loadMetadata();
    const source = await withTrackedSnarkjsHandles(async () =>
      await zKey.exportSolidityVerifier(finalZkeyPath, {
        groth16: solidityTemplate,
      }),
    );
    if (typeof source !== "string" || source.length === 0) {
      throw new Error("snarkjs returned an invalid Solidity verifier");
    }
    return source;
  }

  private loadMetadata(): Promise<
    BackendMetadata & { solidityTemplate: string }
  > {
    this.metadataPromise ??= loadPinnedSnarkjsMetadata().catch(
      (error: unknown) => {
        this.metadataPromise = undefined;
        throw error;
      },
    );
    return this.metadataPromise;
  }
}

async function loadPinnedSnarkjsMetadata(): Promise<
  BackendMetadata & { solidityTemplate: string }
> {
  const snarkjsRoot = dirname(fileURLToPath(import.meta.resolve("snarkjs")));
  const packageJson = JSON.parse(
    await readFile(join(snarkjsRoot, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (packageJson.version !== "0.7.6") {
    throw new Error(
      `finalizer requires exact snarkjs 0.7.6; found ${String(packageJson.version)}`,
    );
  }
  const solidityTemplate = await readFile(
    join(snarkjsRoot, "templates", "verifier_groth16.sol.ejs"),
    "utf8",
  );
  if (solidityTemplate.length === 0) {
    throw new Error("pinned snarkjs Groth16 Solidity template is empty");
  }
  return {
    snarkjsVersion: "0.7.6",
    solidityTemplate,
    solidityTemplateSha256: sha256Bytes(solidityTemplate),
  };
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("final zkey output path already exists");
}

function installFileHandleTracking(): void {
  if (tracksFileHandles) return;
  fs.promises.open = (async (...args: Parameters<OpenFile>) => {
    const handle = await nativeOpen(...args);
    fileHandleScope.getStore()?.add(handle);
    return handle;
  }) as OpenFile;
  tracksFileHandles = true;
}

async function withTrackedSnarkjsHandles<T>(
  operation: () => Promise<T>,
): Promise<T> {
  installFileHandleTracking();
  const handles = new Set<FileHandle>();
  return await fileHandleScope.run(handles, async () => {
    let value: T | undefined;
    let operationError: unknown;
    let succeeded = false;
    try {
      value = await operation();
      succeeded = true;
    } catch (error) {
      operationError = error;
    }

    const closeResults = await Promise.allSettled(
      Array.from(handles, (handle) => handle.close()),
    );
    const closeErrors = closeResults
      .filter((result): result is PromiseRejectedResult =>
        result.status === "rejected"
      )
      .map((result) => result.reason);

    if (!succeeded) {
      if (closeErrors.length > 0) {
        throw new AggregateError(
          [operationError, ...closeErrors],
          "snarkjs operation and explicit file-handle cleanup failed",
        );
      }
      throw operationError;
    }
    if (closeErrors.length > 0) {
      throw new AggregateError(
        closeErrors,
        "explicit snarkjs file-handle cleanup failed",
      );
    }
    return value as T;
  });
}
