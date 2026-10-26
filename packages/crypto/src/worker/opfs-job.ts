import { sha256 } from "@noble/hashes/sha256";

import {
  getBrowserContributionCapabilities,
  type BrowserContributionCapabilities,
} from "../browserContribution.js";
import { bytesToHexRaw } from "../hex.js";
import type { OpfsZkeySource } from "./protocol.js";
import { contributeOpfsFiles, contributeBellmanOpfsFiles } from "./opfs-contribute.js";

export class BrowserContributionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserContributionError";
  }
}

export type OpfsJobStage = "download" | "validate" | "compute" | "hash";
export type OpfsJobProgress = (stage: OpfsJobStage, percent: number) => void;

export interface OpfsJobResult {
  outputFile: FileSystemFileHandle;
  outputFileName: string;
  outputSize: number;
  contributionHash: string;
  zkeyHash: string;
}

function expectedHash(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new BrowserContributionError(
      "INVALID_ARTIFACT_METADATA",
      "Expected zkey SHA-256 must be 0x-prefixed 32-byte hex",
    );
  }
  return normalized;
}

function expectedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BrowserContributionError(
      "INVALID_ARTIFACT_METADATA",
      "Expected zkey size must be a positive integer",
    );
  }
  return value;
}

function randomJobId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHexRaw(bytes);
}

async function sha256File(
  handle: FileSystemFileHandle,
  onProgress?: (percent: number) => void,
): Promise<{ hash: string; size: number }> {
  const file = await handle.getFile();
  const hasher = sha256.create();
  const reader = file.stream().getReader();
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      read += value.byteLength;
      onProgress?.(
        file.size === 0 ? 100 : Math.min(99, Math.floor((read / file.size) * 100)),
      );
    }
  } finally {
    reader.releaseLock();
  }
  onProgress?.(100);
  return {
    hash: `0x${bytesToHexRaw(hasher.digest())}`,
    size: file.size,
  };
}

function validateDownloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value, globalThis.location?.href);
  } catch {
    throw new BrowserContributionError(
      "INVALID_ARTIFACT_URL",
      "The predecessor zkey URL is invalid",
    );
  }
  if (url.username || url.password) {
    throw new BrowserContributionError(
      "INVALID_ARTIFACT_URL",
      "Artifact URLs must not contain embedded credentials",
    );
  }
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp) {
    throw new BrowserContributionError(
      "INVALID_ARTIFACT_URL",
      "Artifact URL must use HTTPS (HTTP is allowed only on localhost)",
    );
  }
  return url;
}

async function downloadToOpfs(
  source: Extract<OpfsZkeySource, { kind: "download" }>,
  destination: FileSystemFileHandle,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const size = expectedSize(source.expectedSize);
  const expected = expectedHash(source.expectedSha256);
  const url = validateDownloadUrl(source.url);
  const response = await fetch(url, {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok || !response.body) {
    throw new BrowserContributionError(
      "ARTIFACT_DOWNLOAD_FAILED",
      `Could not download predecessor zkey (HTTP ${response.status})`,
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== size) {
    throw new BrowserContributionError(
      "ARTIFACT_SIZE_MISMATCH",
      "Predecessor zkey Content-Length does not match ceremony metadata",
    );
  }

  const hasher = sha256.create();
  const reader = response.body.getReader();
  const writer = await destination.createWritable({ keepExistingData: false });
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > size) {
        throw new BrowserContributionError(
          "ARTIFACT_SIZE_MISMATCH",
          "Downloaded predecessor zkey is larger than ceremony metadata",
        );
      }
      hasher.update(value);
      await writer.write(value);
      onProgress?.(Math.min(99, Math.floor((received / size) * 100)));
    }
    if (received !== size) {
      throw new BrowserContributionError(
        "ARTIFACT_SIZE_MISMATCH",
        "Downloaded predecessor zkey size does not match ceremony metadata",
      );
    }
    const actual = `0x${bytesToHexRaw(hasher.digest())}`;
    if (actual !== expected) {
      throw new BrowserContributionError(
        "ARTIFACT_HASH_MISMATCH",
        "Downloaded predecessor zkey SHA-256 does not match ceremony metadata",
      );
    }
    await writer.close();
    onProgress?.(100);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await writer.abort().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function assertCapabilities(capabilities: BrowserContributionCapabilities): void {
  if (!capabilities.supported) {
    throw new BrowserContributionError(
      "BROWSER_CONTRIBUTION_UNAVAILABLE",
      `Browser contribution unavailable: ${capabilities.reasons.join(", ")}`,
    );
  }
}

/** Run one complete bounded-memory contribution inside a dedicated worker. */
export async function runOpfsContributionJob(
  source: OpfsZkeySource,
  entropy: Uint8Array,
  name: string,
  onProgress?: OpfsJobProgress,
  artifactFormat: "zkey" | "bellman" = "zkey",
  overrideFailedCheck = false,
): Promise<OpfsJobResult> {
  if (artifactFormat !== "zkey" && artifactFormat !== "bellman") throw new Error("unsupported contribution format");
  const size = expectedSize(source.expectedSize);
  const hash = expectedHash(source.expectedSha256);
  if (!overrideFailedCheck) assertCapabilities(
    await getBrowserContributionCapabilities({
      inputSizeBytes: size,
      inputAlreadyInOpfs: source.kind === "opfs",
    }),
  );

  const root = await navigator.storage.getDirectory();
  const jobId = randomJobId();
  const inputFileName = `cabure-phase2-${jobId}.input.zkey`;
  const outputFileName = `cabure-phase2-${jobId}.zkey`;
  let temporaryInput = false;
  let outputCreated = false;

  try {
    let inputFile: FileSystemFileHandle;
    if (source.kind === "download") {
      inputFile = await root.getFileHandle(inputFileName, { create: true });
      temporaryInput = true;
      await downloadToOpfs(source, inputFile, (percent) =>
        onProgress?.("download", percent),
      );
    } else {
      inputFile = source.file;
      if (
        typeof (
          inputFile as FileSystemFileHandle & {
            createSyncAccessHandle?: unknown;
          }
        ).createSyncAccessHandle !== "function"
      ) {
        throw new BrowserContributionError(
          "INPUT_NOT_IN_OPFS",
          "The supplied predecessor handle is not an OPFS sync-access file",
        );
      }
      const actual = await sha256File(inputFile, (percent) =>
        onProgress?.("validate", percent),
      );
      if (actual.size !== size) {
        throw new BrowserContributionError(
          "ARTIFACT_SIZE_MISMATCH",
          "OPFS predecessor zkey size does not match ceremony metadata",
        );
      }
      if (actual.hash !== hash) {
        throw new BrowserContributionError(
          "ARTIFACT_HASH_MISMATCH",
          "OPFS predecessor zkey SHA-256 does not match ceremony metadata",
        );
      }
    }

    const outputFile = await root.getFileHandle(outputFileName, { create: true });
    outputCreated = true;
    onProgress?.("compute", 0);
    const contribution = artifactFormat === "bellman"
      ? await contributeBellmanOpfsFiles(inputFile, outputFile, entropy)
      : await contributeOpfsFiles(
      inputFile,
      outputFile,
      entropy,
      name,
      (percent) => onProgress?.("compute", percent),
    );
    onProgress?.("compute", 100);

    // A cloned OPFS input handle can still be retained by another same-origin
    // context. Re-hash it after computation to detect any change across the
    // validation/contribution window before accepting the result locally.
    if (source.kind === "opfs") {
      const after = await sha256File(inputFile, (percent) =>
        onProgress?.("validate", percent),
      );
      if (after.size !== size || after.hash !== hash) {
        throw new BrowserContributionError(
          "INPUT_CHANGED_DURING_CONTRIBUTION",
          "The predecessor zkey changed while the contribution was running",
        );
      }
    }

    const output = await sha256File(outputFile, (percent) =>
      onProgress?.("hash", percent),
    );
    if (output.size <= size || (artifactFormat === "bellman" && output.size !== size + 384)) {
      throw new BrowserContributionError(
        "INVALID_CONTRIBUTION_OUTPUT",
        "Contribution output did not append a transcript entry",
      );
    }

    if (temporaryInput) {
      await root.removeEntry(inputFileName);
      temporaryInput = false;
    }

    return {
      outputFile,
      outputFileName,
      outputSize: output.size,
      contributionHash: contribution.contributionHash,
      zkeyHash: output.hash,
    };
  } catch (error) {
    if (outputCreated) await root.removeEntry(outputFileName).catch(() => undefined);
    throw error;
  } finally {
    if (temporaryInput) await root.removeEntry(inputFileName).catch(() => undefined);
  }
}
