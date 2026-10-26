import { readFile, stat } from "node:fs/promises";

/** File mounts locally, server-only environment injection on Vercel. Never log values. */
export async function readServerMaterial(name: string, secret: boolean): Promise<string> {
  const inline = process.env[name];
  const path = process.env[`${name}_FILE`];
  if ((inline !== undefined) === (path !== undefined)) {
    throw new Error(`Configure exactly one of ${name} or ${name}_FILE.`);
  }
  if (inline !== undefined) {
    if (!inline || Buffer.byteLength(inline) > 65536) throw new Error(`${name} has invalid size.`);
    return inline;
  }
  const metadata = await stat(path!);
  if (!metadata.isFile() || metadata.size > 65536 || (secret && (metadata.mode & 0o077) !== 0)) {
    throw new Error(`${name}_FILE has unsafe permissions, type or size.`);
  }
  return readFile(path!, "utf8");
}
