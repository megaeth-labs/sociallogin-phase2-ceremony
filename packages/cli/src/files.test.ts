import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { downloadToFile } from "./files.js";

const payload = Buffer.from(
  Array.from({ length: 256 * 1024 }, (_value, index) => index % 251),
);
const payloadHash = createHash("sha256").update(payload).digest("hex");

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe("downloadToFile", () => {
  it("streams, hashes, and atomically installs a fresh artifact", async () => {
    const { server, url } = await artifactServer();
    const directory = await mkdtemp(join(tmpdir(), "moss-cli-download-"));
    cleanup.push(() => close(server), () => rm(directory, { recursive: true, force: true }));

    const destination = join(directory, "predecessor.zkey");
    const result = await downloadToFile({
      url,
      destination,
      expectedSha256: payloadHash,
      expectedByteLength: payload.byteLength,
    });

    expect(result.sha256).toBe(payloadHash);
    expect(result.byteLength).toBe(payload.byteLength);
    expect(await readFile(destination)).toEqual(payload);
  });

  it("resumes from an existing partial file with an HTTP range request", async () => {
    const requestedRanges: Array<string | undefined> = [];
    const { server, url } = await artifactServer(requestedRanges);
    const directory = await mkdtemp(join(tmpdir(), "moss-cli-resume-"));
    cleanup.push(() => close(server), () => rm(directory, { recursive: true, force: true }));

    const destination = join(directory, "predecessor.zkey");
    const partialLength = 91_337;
    await writeFile(`${destination}.part`, payload.subarray(0, partialLength));

    await downloadToFile({
      url,
      destination,
      expectedSha256: payloadHash,
      expectedByteLength: payload.byteLength,
    });

    expect(requestedRanges).toEqual([`bytes=${partialLength}-`]);
    expect(await readFile(destination)).toEqual(payload);
  });

  it("rejects bytes that do not match the signed predecessor hash", async () => {
    const { server, url } = await artifactServer();
    const directory = await mkdtemp(join(tmpdir(), "moss-cli-mismatch-"));
    cleanup.push(() => close(server), () => rm(directory, { recursive: true, force: true }));

    await expect(
      downloadToFile({
        url,
        destination: join(directory, "predecessor.zkey"),
        expectedSha256: "00".repeat(32),
        expectedByteLength: payload.byteLength,
      }),
    ).rejects.toThrow("Predecessor SHA-256 mismatch");
  });
});

async function artifactServer(
  requestedRanges: Array<string | undefined> = [],
): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const range = request.headers.range;
    requestedRanges.push(range);
    if (range) {
      const match = /^bytes=(\d+)-$/.exec(range);
      if (!match) {
        response.writeHead(416).end();
        return;
      }
      const offset = Number(match[1]);
      const body = payload.subarray(offset);
      response.writeHead(206, {
        "content-length": body.byteLength,
        "content-range": `bytes ${offset}-${payload.byteLength - 1}/${payload.byteLength}`,
      });
      response.end(body);
      return;
    }

    response.writeHead(200, { "content-length": payload.byteLength });
    response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server port");
  return { server, url: `http://127.0.0.1:${address.port}/artifact.zkey` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
