import contribute from "prototype-bellman";
import { buildBn128 } from "ffjavascript";
import { forceCloseOpfsDescriptor } from "../../packages/crypto/src/worker/opfs-fastfile.ts";

self.onmessage = async () => {
  let curve, previous, next, directory, inputName;
  try {
    directory = await navigator.storage.getDirectory();
    inputName = `bellman-input-${crypto.randomUUID()}.params`;
    const fileName = `bellman-output-${crypto.randomUUID()}.params`;
    previous = { type: "opfs", handle: await directory.getFileHandle(inputName, { create: true }) };
    next = { type: "opfs", handle: await directory.getFileHandle(fileName, { create: true }) };
    const response = await fetch("/input");
    if (!response.ok || !response.body) throw new Error("download failed");
    const access = await previous.handle.createSyncAccessHandle();
    let inputBytes = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.byteLength;) {
          const count = access.write(value.subarray(offset), { at: inputBytes });
          if (count <= 0) throw new Error("OPFS write failed");
          offset += count;
          inputBytes += count;
        }
      }
      access.flush();
    } finally { access.close(); }
    self.postMessage({ stage: "computing", inputBytes });
    // Includes curve/worker initialization; Rust's existing timer excludes init.
    const start = performance.now();
    curve = await buildBn128();
    const entropy = crypto.getRandomValues(new Uint8Array(64));
    try {
      await contribute(curve, previous, next,
        Array.from(entropy, byte => byte.toString(16).padStart(2, "0")).join(""));
    } finally { entropy.fill(0); } // Best effort, not secure erasure.
    const metrics = {
      computeMilliseconds: Math.round(performance.now() - start),
      // This is ONLY the controlling WASM instance; other workers have heaps.
      wasmMemoryBytes: curve.tm.memory.buffer.byteLength,
      inputBytes,
      outputBytes: (await next.handle.getFile()).size,
      concurrency: curve.tm.concurrency,
    };
    await curve.terminate();
    curve = undefined;
    await directory.removeEntry(inputName);
    inputName = undefined;
    self.postMessage({ stage: "output-ready", fileName, metrics });
  } catch {
    self.postMessage({ ok: false });
  } finally {
    if (previous) forceCloseOpfsDescriptor(previous);
    if (next) forceCloseOpfsDescriptor(next);
    if (curve) await curve.terminate();
    if (directory && inputName) await directory.removeEntry(inputName).catch(() => {});
  }
};
