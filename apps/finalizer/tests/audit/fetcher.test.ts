import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DirectoryFetcher, HttpFetcher } from "../../src/audit/fetcher.js";

const bytes = Buffer.from("immutable archived artifact");
const ref = { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, urls: ["https://archive.example/a.bin?versionId=1"] };

function scripted(responses: Array<() => Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push(String(input));
    expect(init?.redirect).toBe("error");
    const next = responses.shift();
    if (!next) throw new Error("no scripted response");
    return next();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("HttpFetcher", () => {
  it("retries transient failures with backoff and then hash-checks the download", async () => {
    const { fetchImpl, calls } = scripted([
      () => new Response("busy", { status: 503 }),
      () => { throw new TypeError("socket hang up"); },
      () => new Response(bytes),
    ]);
    const delays: number[] = [];
    const fetcher = new HttpFetcher({ fetch: fetchImpl, attempts: 3, sleep: async (ms) => { delays.push(ms); } });
    const directory = await mkdtemp(join(tmpdir(), "moss-audit-http-"));
    const artifact = await fetcher.materialize(ref, directory);
    expect(await readFile(artifact.path)).toEqual(bytes);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1_000, 2_000]);
    await artifact.release();
  });

  it("does not retry a permanent HTTP error", async () => {
    const { fetchImpl, calls } = scripted([() => new Response("missing", { status: 404 })]);
    const fetcher = new HttpFetcher({ fetch: fetchImpl, attempts: 5, sleep: async () => undefined });
    await expect(fetcher.fetchBytes("https://archive.example/x.json", 100)).rejects.toThrow("HTTP 404");
    expect(calls).toHaveLength(1);
  });

  it("rejects a substituted artifact even when the server keeps sending it", async () => {
    const { fetchImpl } = scripted([() => new Response("other bytes"), () => new Response("other bytes")]);
    const fetcher = new HttpFetcher({ fetch: fetchImpl, attempts: 2, sleep: async () => undefined });
    await expect(fetcher.materialize(ref, await mkdtemp(join(tmpdir(), "moss-audit-http-")))).rejects.toThrow("could not be downloaded");
  });

  it("bounds small objects and refuses non-HTTPS URLs", async () => {
    const { fetchImpl } = scripted([() => new Response("x".repeat(101))]);
    const fetcher = new HttpFetcher({ fetch: fetchImpl, attempts: 1 });
    await expect(fetcher.fetchBytes("https://archive.example/big.json", 100)).rejects.toThrow("size limit");
    await expect(fetcher.fetchBytes("http://archive.example/x.json", 100)).rejects.toThrow("credential-free HTTPS");
    await expect(fetcher.fetchBytes("https://user:pass@archive.example/x.json", 100)).rejects.toThrow("credential-free HTTPS");
  });
});

describe("DirectoryFetcher", () => {
  it("keeps lookups inside the mirror root", async () => {
    const fetcher = new DirectoryFetcher(await mkdtemp(join(tmpdir(), "moss-audit-mirror-")));
    await expect(fetcher.fetchBytes("https://archive.example/a%2F..%2F..%2F..%2Fetc%2Fpasswd", 100)).rejects.toThrow("escapes its root");
    await expect(fetcher.materialize(ref)).rejects.toThrow("mirror is missing artifact");
  });
});
