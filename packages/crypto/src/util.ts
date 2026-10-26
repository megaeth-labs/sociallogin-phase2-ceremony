import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type OpenFile = typeof fs.promises.open;

const nativeOpen = fs.promises.open.bind(fs.promises) as OpenFile;
const fileHandleScope = new AsyncLocalStorage<Set<FileHandle>>();
let tracksFileHandles = false;

/**
 * Keep native handles opened by snarkjs/fastfile reachable until the wrapper
 * can close them explicitly. snarkjs 0.7.6 leaks handles on several parse and
 * early-return paths (and the PTAU handle on successful `verifyFromInit`).
 * Node 25 reports those GC closes as uncaught ERR_INVALID_STATE errors.
 *
 * The AsyncLocalStorage scope keeps concurrent wrapper calls isolated. Calls
 * to fs.promises.open outside a scoped ceremony operation are delegated
 * unchanged and are not retained.
 */
function installFileHandleTracking(): void {
  if (tracksFileHandles) return;

  fs.promises.open = (async (...args: Parameters<OpenFile>) => {
    const handle = await nativeOpen(...args);
    fileHandleScope.getStore()?.add(handle);
    return handle;
  }) as OpenFile;

  tracksFileHandles = true;
}

async function closeTrackedFileHandles(
  handles: ReadonlySet<FileHandle>,
): Promise<void> {
  const results = await Promise.allSettled(
    Array.from(handles, (handle) => handle.close()),
  );
  const failures = results
    .filter((result): result is PromiseRejectedResult =>
      result.status === "rejected"
    )
    .map((result) => result.reason);

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Failed to close file handles opened by snarkjs",
    );
  }
}

/** Create a temp directory and return helpers for file I/O within it */
export async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  installFileHandleTracking();
  const dir = await mkdtemp(join(tmpdir(), "cabure-"));
  const handles = new Set<FileHandle>();
  try {
    return await fileHandleScope.run(handles, async () => {
      try {
        return await fn(dir);
      } finally {
        await closeTrackedFileHandles(handles);
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write a Uint8Array to a temp file and return the path */
export async function writeTempFile(
  dir: string,
  name: string,
  data: Uint8Array,
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

/** Read a file into a Uint8Array (copied, not a view over the Buffer pool) */
export async function readFileAsBytes(path: string): Promise<Uint8Array> {
  const buf = await readFile(path);
  return new Uint8Array(buf);
}
