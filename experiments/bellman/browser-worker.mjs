import init, { contribute_with_entropy } from "/wasm/moss_bellman_wasm_prototype.js";

self.onmessage = async () => {
  try {
    const wasm = await init();
    const response = await fetch("/input");
    if (!response.ok) throw new Error("download failed");
    const input = new Uint8Array(await response.arrayBuffer());
    self.postMessage({ stage: "computing", inputBytes: input.byteLength });
    const entropy = crypto.getRandomValues(new Uint8Array(64));
    const start = performance.now();
    const output = contribute_with_entropy(input, entropy);
    const metrics = {
      computeMilliseconds: Math.round(performance.now() - start),
      wasmMemoryBytes: wasm.memory.buffer.byteLength,
      inputBytes: input.byteLength,
      outputBytes: output.byteLength,
    };
    entropy.fill(0); // Best effort only; not a secure-erasure guarantee.
    // Avoid retaining the WASM heap plus input/output buffers while fetch copies
    // an in-memory request body. Spool to disk, then let the UI kill this worker.
    self.postMessage({ stage: "writing-output", ...metrics });
    const directory = await navigator.storage.getDirectory();
    const fileName = `bellman-prototype-${crypto.randomUUID()}.params`;
    const handle = await directory.getFileHandle(fileName, { create: true });
    const file = await handle.createSyncAccessHandle();
    try {
      for (let offset = 0; offset < output.byteLength;) {
        const written = file.write(output.subarray(offset, offset + 4 * 1024 * 1024), { at: offset });
        if (written <= 0) throw new Error("OPFS write failed");
        offset += written;
      }
      file.flush();
    } finally { file.close(); }
    self.postMessage({ stage: "output-ready", fileName, metrics });
  } catch {
    self.postMessage({ ok: false });
  }
};
