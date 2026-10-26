import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  mkdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const CLI_HOME = join(homedir(), ".moss-phase2-ceremony");
const WORK_ROOT = join(CLI_HOME, "work");
const RECEIPTS_ROOT = join(CLI_HOME, "receipts");

export interface DownloadResult {
  path: string;
  byteLength: number;
  sha256: string;
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A retained workspace, named by the UUID the contribution journal records. */
export function contributionWorkspacePath(id: string): string {
  if (!WORKSPACE_ID.test(id)) throw new Error("Contribution workspace id is invalid.");
  return join(WORK_ROOT, id);
}

export async function createContributionWorkspace(): Promise<string> {
  const path = join(WORK_ROOT, randomUUID());
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

export async function requireAvailableDisk(
  path: string,
  minimumBytes: bigint,
): Promise<void> {
  const stats = await statfs(path, { bigint: true });
  const available = stats.bavail * stats.bsize;
  if (available < minimumBytes) {
    throw new Error(
      `Insufficient free disk for contribution: need at least ${formatBigBytes(minimumBytes)}, found ${formatBigBytes(available)}.`,
    );
  }
}

export async function downloadToFile(options: {
  url: string;
  destination: string;
  expectedSha256?: string | null;
  expectedByteLength?: number | null;
  onProgress?: (received: number, total: number | null) => void;
}): Promise<DownloadResult> {
  const artifactUrl = validateArtifactUrl(options.url);
  await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 });
  const partial = `${options.destination}.part`;

  let existing = await fileSize(partial);
  if (
    options.expectedByteLength !== null &&
    options.expectedByteLength !== undefined &&
    existing >= options.expectedByteLength
  ) {
    if (existing === options.expectedByteLength && options.expectedSha256) {
      const complete = await hashFile(partial);
      if (complete.sha256.toLowerCase() === normalizeHash(options.expectedSha256)) {
        await rename(partial, options.destination);
        return { ...complete, path: options.destination };
      }
    }
    await rm(partial, { force: true });
    existing = 0;
  }
  let hasher = createHash("sha256");
  if (existing > 0) {
    await hashInto(partial, hasher);
  }

  const headers = new Headers();
  if (existing > 0) headers.set("Range", `bytes=${existing}-`);

  let response = await fetch(artifactUrl, {
    headers,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });

  if (existing > 0 && response.status === 200) {
    await rm(partial, { force: true });
    existing = 0;
    hasher = createHash("sha256");
    response = await fetch(artifactUrl, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  }

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download predecessor zkey (${response.status}).`);
  }

  if (existing > 0) {
    const contentRange = response.headers.get("content-range");
    if (
      response.status !== 206 ||
      !validContentRange(contentRange, existing, options.expectedByteLength)
    ) {
      throw new Error("Artifact server returned an invalid resume range.");
    }
  }

  const responseLength = parseContentLength(response.headers.get("content-length"));
  const total = options.expectedByteLength ??
    (responseLength === null ? null : existing + responseLength);
  let received = existing;

  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hasher.update(chunk);
      received += chunk.byteLength;
      if (
        options.expectedByteLength !== null &&
        options.expectedByteLength !== undefined &&
        received > options.expectedByteLength
      ) {
        callback(new Error("Predecessor exceeds the declared byte length."));
        return;
      }
      options.onProgress?.(received, total);
      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body as never),
    hashingStream,
    createWriteStream(partial, { flags: existing > 0 ? "a" : "w", mode: 0o600 }),
  );

  const digest = hasher.digest("hex");
  if (
    options.expectedByteLength !== null &&
    options.expectedByteLength !== undefined &&
    received !== options.expectedByteLength
  ) {
    await rm(partial, { force: true });
    throw new Error(
      `Predecessor length mismatch: expected ${options.expectedByteLength}, received ${received}.`,
    );
  }
  if (
    options.expectedSha256 &&
    digest.toLowerCase() !== normalizeHash(options.expectedSha256)
  ) {
    await rm(partial, { force: true });
    throw new Error(
      `Predecessor SHA-256 mismatch: expected ${options.expectedSha256}, received ${digest}.`,
    );
  }

  await rename(partial, options.destination);
  return { path: options.destination, byteLength: received, sha256: digest };
}

export async function hashFile(path: string): Promise<DownloadResult> {
  const hasher = createHash("sha256");
  await hashInto(path, hasher);
  const info = await stat(path);
  return {
    path,
    byteLength: info.size,
    sha256: hasher.digest("hex"),
  };
}

export async function persistReceipt(
  ceremonyId: string,
  sequence: number,
  receipt: unknown,
): Promise<string> {
  await mkdir(RECEIPTS_ROOT, { recursive: true, mode: 0o700 });
  const safeCeremony = ceremonyId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = join(
    RECEIPTS_ROOT,
    `${safeCeremony}-${String(sequence).padStart(6, "0")}.json`,
  );
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

export async function removeContributionWorkspace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function hashInto(
  path: string,
  hasher: ReturnType<typeof createHash>,
): Promise<void> {
  for await (const chunk of createReadStream(path)) {
    hasher.update(chunk as Buffer);
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return 0;
    throw error;
  }
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeHash(value: string): string {
  const normalized = value.toLowerCase();
  return normalized.startsWith("0x") ? normalized.slice(2) : normalized;
}

function validateArtifactUrl(value: string): URL {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.username || url.password || (url.protocol !== "https:" && !localHttp)) {
    throw new Error("Artifact URL must use HTTPS without embedded credentials.");
  }
  return url;
}

function validContentRange(
  value: string | null,
  expectedStart: number,
  expectedTotal: number | null | undefined,
): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value ?? "");
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    Number.isSafeInteger(total) &&
    start === expectedStart &&
    end >= start &&
    end < total &&
    (expectedTotal === null || expectedTotal === undefined || total === expectedTotal)
  );
}

function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

function formatBigBytes(bytes: bigint): string {
  const gib = Number(bytes) / 1024 ** 3;
  return `${gib.toFixed(2)} GiB`;
}
