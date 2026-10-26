import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import type { VerificationArtifact, VerificationJobV1 } from "./types.js";

export interface MaterializedArtifacts {
  directory: string;
  predecessorPath: string;
  candidatePath: string;
  cleanup(): Promise<void>;
}

export async function materializeJobArtifacts(
  job: VerificationJobV1,
  options: {
    workRoot: string;
    allowedOrigins: ReadonlySet<string>;
    allowedFileRoot?: string;
    production: boolean;
    signal?: AbortSignal;
  },
): Promise<MaterializedArtifacts> {
  const root = resolve(options.workRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "job-"));
  try {
    const predecessorPath = join(directory, "predecessor.zkey");
    const candidatePath = join(directory, "candidate.zkey");
    await downloadArtifact(job.predecessor, predecessorPath, options);
    await downloadArtifact(job.candidate, candidatePath, options);
    return {
      directory,
      predecessorPath,
      candidatePath,
      cleanup: async () => { await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function downloadArtifact(
  artifact: VerificationArtifact,
  destination: string,
  options: {
    allowedOrigins: ReadonlySet<string>;
    allowedFileRoot?: string;
    production: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  options.signal?.throwIfAborted();
  const url = new URL(artifact.downloadUrl);
  let source: Readable;
  if (url.protocol === "file:") {
    if (options.production || !options.allowedFileRoot) throw new Error("file artifact downloads are development-only");
    const root = await realpath(options.allowedFileRoot);
    const path = await realpath(url);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("artifact file is outside the allowlisted root");
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== artifact.byteLength) throw new Error("artifact file length does not match the job");
    source = createReadStream(path);
  } else {
    if (!options.allowedOrigins.has(url.origin)) throw new Error("artifact download origin is not allowlisted");
    const timeout = AbortSignal.timeout(30 * 60 * 1_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    const response = await fetch(url, { method: "GET", redirect: "error", signal });
    if (!response.ok || response.body === null) throw new Error(`artifact download failed with status ${response.status}`);
    const responseUrl = new URL(response.url);
    if (!options.allowedOrigins.has(responseUrl.origin)) throw new Error("artifact response origin is not allowlisted");
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== artifact.byteLength) {
      throw new Error("artifact response length does not match the job");
    }
    source = Readable.fromWeb(response.body as never);
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteLength += chunk.byteLength;
      if (byteLength > artifact.byteLength) return callback(new Error("artifact download exceeds declared length"));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const destinationStream = createWriteStream(destination, {
    flags: "wx",
    mode: 0o600,
  });
  if (options.signal) {
    await pipeline(source, meter, destinationStream, { signal: options.signal });
  } else {
    await pipeline(source, meter, destinationStream);
  }
  if (byteLength !== artifact.byteLength) throw new Error("artifact download is truncated");
  if (hash.digest("hex") !== artifact.sha256) throw new Error("artifact download hash does not match the job");
  if (basename(destination) !== "predecessor.zkey" && basename(destination) !== "candidate.zkey") {
    throw new Error("artifact destination is invalid");
  }
}
