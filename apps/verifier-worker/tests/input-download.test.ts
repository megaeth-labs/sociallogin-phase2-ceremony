import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { downloadPinnedInput } from "../src/input-download.js";
it("promotes only exact pinned input bytes and removes interrupted/invalid downloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moss-download-test-"));
  const bytes = Buffer.from("synthetic input fixture");
  const artifact = { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, urls: ["https://archive.example/input"] };
  const input = { artifact, destination: join(dir, "input"), allowedOrigins: new Set(["https://archive.example"]) };
  try {
    await downloadPinnedInput({ ...input, fetcher: async () => new Response(bytes) });
    expect(await readFile(input.destination)).toEqual(bytes);
    await expect(downloadPinnedInput({ ...input, fetcher: async () => new Response("wrong content") })).rejects.toThrow(/pin/);
    expect(await readFile(input.destination)).toEqual(bytes);
    expect(await readdir(dir)).toEqual(["input"]);
    await expect(downloadPinnedInput({ ...input, allowedOrigins: new Set() })).rejects.toThrow(/allowlist/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
