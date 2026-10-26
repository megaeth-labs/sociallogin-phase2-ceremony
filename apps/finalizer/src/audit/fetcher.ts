import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { ArtifactRef } from "@moss/phase2-protocol";

import type { AuditFetcher } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Reads a local copy of the archive, laid out by URL path (for example a
 * bucket sync): https://archive/evidence/x.json -> <root>/evidence/x.json.
 * Artifacts may also sit at <root>/by-sha256/<sha256>. Query strings such as
 * versionId are ignored; every caller checks content digests instead.
 */
export class DirectoryFetcher implements AuditFetcher {
  readonly kind = "mirror" as const;
  private readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("mirror directory must be an absolute path");
    this.root = resolve(root);
  }

  async fetchBytes(url: string, maxBytes: number): Promise<Buffer> {
    const path = this.pathFor(url);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`mirror is missing ${new URL(url).pathname}`);
    if (info.size > maxBytes) throw new Error("mirrored object exceeds its size limit");
    return await readFile(path);
  }

  async materialize(ref: ArtifactRef): Promise<{ path: string; release(): Promise<void> }> {
    if (!SHA256.test(ref.sha256)) throw new Error("artifact SHA-256 is malformed");
    const candidates = [join(this.root, "by-sha256", ref.sha256), ...ref.urls.map((url) => this.pathFor(url))];
    for (const path of candidates) {
      const info = await stat(path).catch(() => undefined);
      if (info?.isFile()) return { path, release: async () => undefined };
    }
    throw new Error(`mirror is missing artifact ${ref.sha256}`);
  }

  private pathFor(url: string): string {
    const parsed = new URL(url);
    const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/u, "");
    const path = resolve(this.root, relative);
    if (relative.length === 0 || !path.startsWith(this.root + sep)) throw new Error("mirror path escapes its root");
    return path;
  }
}

export interface HttpFetcherOptions {
  timeoutMs?: number;
  attempts?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Credential-free HTTPS with bounded retries. Never follows redirects. */
export class HttpFetcher implements AuditFetcher {
  readonly kind = "https" as const;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpFetcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.attempts = options.attempts ?? 5;
    if (!Number.isSafeInteger(this.attempts) || this.attempts < 1 || this.attempts > 20) throw new Error("HTTP attempts must be 1-20");
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  async fetchBytes(url: string, maxBytes: number): Promise<Buffer> {
    return await this.withRetries(url, async (response) => {
      const declared = Number(response.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(declared) && declared > maxBytes) throw new PermanentError("object exceeds its size limit");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of Readable.fromWeb(response.body as never)) {
        const bytes = Buffer.from(chunk as Uint8Array);
        length += bytes.byteLength;
        if (length > maxBytes) throw new PermanentError("object exceeds its size limit");
        chunks.push(bytes);
      }
      return Buffer.concat(chunks);
    });
  }

  async materialize(ref: ArtifactRef, directory: string): Promise<{ path: string; release(): Promise<void> }> {
    if (!SHA256.test(ref.sha256)) throw new Error("artifact SHA-256 is malformed");
    if (ref.urls.length === 0) throw new Error(`artifact ${ref.sha256} has no URL`);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${ref.sha256}.artifact`);
    const partial = `${path}.part`;
    let lastError: unknown;
    for (const url of ref.urls) {
      try {
        await this.withRetries(url, async (response) => {
          await rm(partial, { force: true });
          const hash = createHash("sha256");
          let length = 0;
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              length += chunk.byteLength;
              if (length > ref.byteLength) { callback(new PermanentError("artifact is longer than its pin")); return; }
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(partial, { flags: "wx", mode: 0o400 }));
          // A truncated or substituted body is retried: a mirror may be mid-repair.
          if (length !== ref.byteLength || hash.digest("hex") !== ref.sha256) throw new Error("downloaded artifact does not match its pin");
        });
        await rename(partial, path);
        return { path, release: async () => { await rm(path, { force: true }); } };
      } catch (error) {
        lastError = error;
        await rm(partial, { force: true });
      }
    }
    throw new Error(`artifact ${ref.sha256} could not be downloaded: ${message(lastError)}`);
  }

  private async withRetries<T>(url: string, consume: (response: Response) => Promise<T>): Promise<T> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new Error("audit downloads require credential-free HTTPS URLs");
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(parsed, {
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok || !response.body) {
          // 404/403 do not heal by waiting; 429 and 5xx may.
          if (response.status !== 429 && response.status < 500) throw new PermanentError(`HTTP ${response.status}`);
          throw new Error(`HTTP ${response.status}`);
        }
        return await consume(response);
      } catch (error) {
        lastError = error;
        if (error instanceof PermanentError || attempt === this.attempts) break;
        await this.sleep(Math.min(60_000, 1_000 * 2 ** (attempt - 1)));
      }
    }
    throw new Error(`${parsed.origin}${parsed.pathname}: ${message(lastError)}`);
  }
}

class PermanentError extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
