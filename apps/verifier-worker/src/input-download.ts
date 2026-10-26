import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArtifactRef } from "@moss/phase2-protocol";

/** Download only a root-authenticated pin; stage privately and rename after hashing. */
export async function downloadPinnedInput(input: {
  artifact: ArtifactRef; destination: string; allowedOrigins: ReadonlySet<string>;
  fetcher?: typeof fetch;
}): Promise<void> {
  const url = new URL(input.artifact.urls[0]!);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !input.allowedOrigins.has(url.origin)) {
    throw new Error("pinned input URL is outside the HTTPS allowlist");
  }
  await mkdir(dirname(input.destination), { recursive: true, mode: 0o700 });
  const temporary = `${input.destination}.${randomUUID()}.partial`;
  const response = await (input.fetcher ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(3600000) });
  if (!response.ok || !response.body) throw new Error("pinned input download failed");
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== input.artifact.byteLength) {
    await response.body.cancel();
    throw new Error("pinned input declared size differs from manifest");
  }
  const hash = createHash("sha256");
  let length = 0;
  try {
    await pipeline(Readable.fromWeb(response.body as never), new Transform({
      transform(chunk: Buffer, _encoding, done) {
        length += chunk.length;
        if (length > input.artifact.byteLength) return done(new Error("pinned input exceeds manifest size"));
        hash.update(chunk); done(null, chunk);
      },
    }), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    if (length !== input.artifact.byteLength || hash.digest("hex") !== input.artifact.sha256) {
      throw new Error("downloaded input does not match signed artifact pin");
    }
    await rename(temporary, input.destination);
  } finally { await rm(temporary, { force: true }); }
}
