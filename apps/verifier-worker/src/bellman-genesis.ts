import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "./hashing.js";
import type { ArtifactRef } from "@moss/phase2-protocol";

/** Independently bind Bellman genesis to the already hash-checked original zkey. */
export async function verifyBellmanGenesis(genesisPath: string, expected: ArtifactRef, workRoot: string, timeoutMs: number): Promise<void> {
  const directory = await mkdtemp(join(workRoot, "bellman-genesis-"));
  try {
    const output = join(directory, "genesis.params");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./bellman-genesis-child.js", import.meta.url)), genesisPath, output],
        { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Bellman genesis export failed")); });
      child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("Bellman genesis export failed")); });
    });
    const actual = await hashFile(output);
    if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) throw new Error("Bellman genesis is not the exact pinned zkey export");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
