import { sha256 } from "@noble/hashes/sha256";
const STORAGE_HEADROOM_BYTES = 64 * 1024 * 1024;

export interface BrowserContributionCapabilities {
  /** True when all required APIs and (when supplied) storage are available. */
  supported: boolean;
  /** Stable machine-readable reasons to select the CLI fallback. */
  reasons: string[];
  secureContext: boolean;
  opfs: boolean;
  syncAccessHandles: boolean;
  streamingFetch: boolean;
  webCrypto: boolean;
  quotaBytes?: number;
  usageBytes?: number;
  availableBytes?: number;
  requiredBytes?: number;
  persisted?: boolean;
  hardwareConcurrency?: number;
  deviceMemoryGiB?: number;
}

export interface BrowserContributionCapacityOptions {
  /** Exact predecessor zkey size supplied by the ceremony coordinator. */
  inputSizeBytes?: number;
  /** Set when the predecessor is already resident in OPFS. */
  inputAlreadyInOpfs?: boolean;
}

/**
 * Conservative space reservation for one contribution.
 *
 * A downloaded predecessor and the new zkey coexist during computation. The
 * output is slightly larger due to its extra transcript entry, so fixed
 * headroom is reserved in addition to one or two input-sized files.
 */
export function requiredBrowserContributionBytes(
  inputSizeBytes: number,
  inputAlreadyInOpfs = false,
): number {
  if (!Number.isSafeInteger(inputSizeBytes) || inputSizeBytes <= 0) {
    throw new Error("browser contribution: input size must be a positive integer");
  }
  return (
    inputSizeBytes * (inputAlreadyInOpfs ? 1 : 2) + STORAGE_HEADROOM_BYTES
  );
}

/** Detect whether this browser can safely enter the OPFS contribution path. */
export async function getBrowserContributionCapabilities(
  options: BrowserContributionCapacityOptions = {},
): Promise<BrowserContributionCapabilities> {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const storage = nav?.storage;
  const secureContext = globalThis.isSecureContext === true;
  const opfs = typeof storage?.getDirectory === "function";
  const fileHandlePrototype = (
    globalThis as typeof globalThis & {
      FileSystemFileHandle?: { prototype?: Record<string, unknown> };
    }
  ).FileSystemFileHandle?.prototype;
  const syncAccessHandles =
    typeof fileHandlePrototype?.createSyncAccessHandle === "function" ||
    (secureContext && opfs && await probeWorkerSyncAccess());
  const streamingFetch =
    typeof fetch === "function" && typeof ReadableStream !== "undefined";
  const webCrypto =
    typeof globalThis.crypto?.getRandomValues === "function" &&
    typeof globalThis.crypto?.subtle !== "undefined";

  const reasons: string[] = [];
  if (!secureContext) reasons.push("secure-context-required");
  if (!opfs) reasons.push("opfs-unavailable");
  if (!syncAccessHandles) reasons.push("opfs-sync-access-unavailable");
  if (!streamingFetch) reasons.push("streaming-fetch-unavailable");
  if (!webCrypto) reasons.push("web-crypto-unavailable");

  let quotaBytes: number | undefined;
  let usageBytes: number | undefined;
  let availableBytes: number | undefined;
  if (typeof storage?.estimate === "function") {
    try {
      const estimate = await storage.estimate();
      quotaBytes = estimate.quota;
      usageBytes = estimate.usage;
      if (quotaBytes !== undefined && usageBytes !== undefined) {
        availableBytes = Math.max(0, quotaBytes - usageBytes);
      }
    } catch {
      reasons.push("storage-estimate-failed");
    }
  } else if (options.inputSizeBytes !== undefined) {
    reasons.push("storage-estimate-unavailable");
  }

  let requiredBytes: number | undefined;
  if (options.inputSizeBytes !== undefined) {
    requiredBytes = requiredBrowserContributionBytes(
      options.inputSizeBytes,
      options.inputAlreadyInOpfs,
    );
    if (availableBytes === undefined) {
      if (
        !reasons.includes("storage-estimate-failed") &&
        !reasons.includes("storage-estimate-unavailable")
      ) {
        reasons.push("storage-estimate-unavailable");
      }
    } else if (availableBytes < requiredBytes) {
      reasons.push("insufficient-opfs-quota");
    }
  }

  let persisted: boolean | undefined;
  if (typeof storage?.persisted === "function") {
    try {
      persisted = await storage.persisted();
    } catch {
      // Persistence lowers eviction risk but is not a correctness dependency.
    }
  }

  const navigatorWithMemory = nav as
    | (Navigator & { deviceMemory?: number })
    | undefined;

  return {
    supported: reasons.length === 0,
    reasons,
    secureContext,
    opfs,
    syncAccessHandles,
    streamingFetch,
    webCrypto,
    quotaBytes,
    usageBytes,
    availableBytes,
    requiredBytes,
    persisted,
    hardwareConcurrency: nav?.hardwareConcurrency,
    deviceMemoryGiB: navigatorWithMemory?.deviceMemory,
  };
}

/** The synchronous OPFS API is worker-only; Window prototypes cannot detect it. */
async function probeWorkerSyncAccess(): Promise<boolean> {
  if (typeof Worker === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const source = `
    (async () => {
      let root, fileName, access, supported = false;
      try {
        root = await navigator.storage.getDirectory();
        fileName = "moss-capability-" + crypto.randomUUID();
        const file = await root.getFileHandle(fileName, { create: true });
        access = await file.createSyncAccessHandle();
        access.close(); access = undefined;
        supported = true;
      } catch {} finally {
        try { if (access) access.close(); } catch { supported = false; }
        try { if (root && fileName) await root.removeEntry(fileName); } catch { supported = false; }
      }
      postMessage(supported);
    })();
  `;
  let url: string | undefined;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    worker = new Worker(url);
    return await new Promise<boolean>((resolve) => {
      worker!.onmessage = (event: MessageEvent<unknown>) => resolve(event.data === true);
      worker!.onerror = (event) => { event.preventDefault(); resolve(false); };
      timer = setTimeout(() => resolve(false), 10_000);
    });
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    worker?.terminate();
    if (url !== undefined) URL.revokeObjectURL(url);
  }
}

/**
 * Ask the browser for durable storage. Call from a user gesture before
 * starting; browsers may ignore or deny the request without prompting.
 */
export async function requestPersistentBrowserStorage(): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.storage?.persist !== "function"
  ) {
    return false;
  }
  return navigator.storage.persist();
}

/** Remove a retained worker output after the coordinator has uploaded it. */
export async function removeBrowserContributionFile(
  fileName: string,
): Promise<void> {
  if (!/^cabure-phase2-[0-9a-f-]+\.zkey$/.test(fileName)) {
    throw new Error("browser contribution: refusing to remove an unknown entry");
  }
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(fileName);
}

/** Incremental recovery validation; never loads a complete artifact into RAM. */
export async function hashBrowserArtifact(blob: Blob): Promise<string> {
  const hash = sha256.create();
  const reader = blob.stream().getReader();
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; hash.update(chunk.value); }
  } finally { reader.releaseLock(); }
  return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
