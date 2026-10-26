import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const snarkjsRoot = dirname(fileURLToPath(import.meta.resolve("snarkjs")));
const snarkjsSourceRoot = resolve(snarkjsRoot, "src");
const opfsBinFileUtils = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "src/worker/opfs-binfileutils.ts",
);
const virtualRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".vitest-opfs-snarkjs",
);

// Give the differential test an isolated copy of the pinned snarkjs source
// graph. Only that graph gets OPFS binfileutils; stock snarkjs remains intact.
const opfsSnarkjsTestPlugin = {
  name: "opfs-snarkjs-test-source",
  enforce: "pre" as const,
  resolveId(source: string, importer?: string) {
    if (source === "@cabure/snarkjs-bellman-contribute") return resolve(virtualRoot, "zkey_bellman_contribute.js");
    if (source === "@cabure/snarkjs-phase2-contribute") {
      return resolve(virtualRoot, "zkey_contribute.js");
    }
    if (!importer?.startsWith(virtualRoot)) return undefined;
    if (source === "fastfile") return resolve(dirname(opfsBinFileUtils), "opfs-fastfile.ts");
    if (source === "@iden3/binfileutils") return opfsBinFileUtils;
    if (source.startsWith(".")) {
      return resolve(dirname(importer), source);
    }
    return undefined;
  },
  load(id: string) {
    if (!id.startsWith(virtualRoot)) return undefined;
    const relative = id.slice(virtualRoot.length + 1);
    return readFileSync(resolve(snarkjsSourceRoot, relative), "utf8");
  },
};

export default defineConfig({
  plugins: [opfsSnarkjsTestPlugin],
  test: {
    globals: true,
    testTimeout: 60_000,
  },
});
