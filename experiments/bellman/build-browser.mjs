// Isolated browser bundle: pinned upstream arithmetic, existing OPFS I/O.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../packages/crypto/package.json"));
const { build } = require("esbuild");
const snarkRoot = dirname(dirname(require.resolve("snarkjs")));
const ffRoot = dirname(dirname(require.resolve("ffjavascript")));
if (JSON.parse(await readFile(join(ffRoot, "package.json"), "utf8")).version !== "0.3.1") throw new Error("ffjavascript pin mismatch");
if (JSON.parse(await readFile(join(snarkRoot, "package.json"), "utf8")).version !== "0.7.6") throw new Error("snarkjs pin mismatch");
await build({
  entryPoints: [join(here, "snarkjs-worker.mjs")],
  outfile: join(here, "browser-build/snarkjs-worker.mjs"),
  bundle: true, format: "esm", platform: "browser", target: "es2022",
  conditions: ["browser", "import", "default"],
  define: { "process.browser": "true" },
  plugins: [{ name: "bellman-opfs", setup(build) {
    build.onResolve({ filter: /^prototype-bellman$/ }, () => ({ path: join(snarkRoot, "src/zkey_bellman_contribute.js") }));
    build.onResolve({ filter: /^ffjavascript$/ }, () => ({ path: join(ffRoot, "build/browser.esm.js") }));
    build.onResolve({ filter: /^fastfile$/ }, () => ({ path: join(here, "../../packages/crypto/src/worker/opfs-fastfile.ts") }));
    build.onResolve({ filter: /^(crypto|readline)$/ }, args => args.importer.startsWith(snarkRoot)
      ? { path: join(here, "../../packages/crypto/src/worker/browser-node-shim.ts") } : undefined);
  } }],
});
