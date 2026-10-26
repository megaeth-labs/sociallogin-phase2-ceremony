import { build } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const snarkjsMain = fileURLToPath(import.meta.resolve("snarkjs"));
const snarkjsRoot = dirname(snarkjsMain);
const snarkjsPackage = JSON.parse(
  readFileSync(join(snarkjsRoot, "package.json"), "utf8"),
);
if (snarkjsPackage.version !== "0.7.6") {
  throw new Error(
    `Browser contribution build requires exact snarkjs 0.7.6; found ${snarkjsPackage.version}`,
  );
}

const snarkjsPhase2Source = join(snarkjsRoot, "src/zkey_contribute.js");
const opfsBinFileUtils = resolve("src/worker/opfs-binfileutils.ts");
const browserNodeShim = resolve("src/worker/browser-node-shim.ts");

/**
 * Bundle the exact pinned snarkjs arithmetic and replace only the binary-file
 * utility layer with our bounded-memory OPFS adapter.
 */
const opfsSnarkjsPlugin = {
  name: "opfs-snarkjs-phase2",
  setup(build) {
    build.onResolve({ filter: /^@cabure\/snarkjs-bellman-contribute$/ }, () => ({ path: join(snarkjsRoot, "src/zkey_bellman_contribute.js") }));
    build.onResolve({ filter: /^fastfile$/ }, () => ({ path: resolve("src/worker/opfs-fastfile.ts") }));
    build.onResolve(
      { filter: /^@cabure\/snarkjs-phase2-contribute$/ },
      () => ({ path: snarkjsPhase2Source }),
    );
    build.onResolve({ filter: /^@iden3\/binfileutils$/ }, () => ({
      path: opfsBinFileUtils,
    }));
    build.onResolve({ filter: /^(crypto|readline)$/ }, (args) => {
      if (args.importer.startsWith(snarkjsRoot)) return { path: browserNodeShim };
      return undefined;
    });
  },
};

// Emit declarations
execSync("npx tsc --emitDeclarationOnly", { stdio: "inherit" });

const shared = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  external: ["snarkjs"],
  platform: "node",
  target: "es2022",
  sourcemap: true,
};

// ESM
await build({
  ...shared,
  format: "esm",
  outfile: "dist/esm/index.js",
});

// CJS
await build({
  ...shared,
  format: "cjs",
  outfile: "dist/cjs/index.cjs",
});

// Browser capability and OPFS helpers. Keep this as a narrow subpath so a
// client bundle never resolves the Node-oriented root entrypoint.
await build({
  entryPoints: ["src/browserContribution.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/browser/index.js",
  sourcemap: true,
});

await build({
  entryPoints: ["src/browserContribution.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: "dist/browser/index.cjs",
  sourcemap: true,
});

// Worker bundle (browser target). The legacy small-file path keeps snarkjs
// external. The OPFS path bundles the pinned contribution source through the
// plugin above so its file I/O can be replaced without forking its arithmetic.
await build({
  entryPoints: ["src/worker/contribute.worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/worker/contribute.worker.js",
  sourcemap: true,
  external: ["snarkjs"],
  conditions: ["browser", "import", "default"],
  define: { "process.browser": "true" },
  plugins: [opfsSnarkjsPlugin],
});

// Protocol bundle – ESM (browser target)
await build({
  entryPoints: ["src/worker/protocol.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: "dist/worker/protocol.js",
  sourcemap: true,
});

// Protocol bundle – CJS
await build({
  entryPoints: ["src/worker/protocol.ts"],
  bundle: true,
  format: "cjs",
  platform: "neutral",
  target: "es2022",
  outfile: "dist/worker/protocol.cjs",
  sourcemap: true,
});

// Entropy bundle – ESM (browser-safe, neutral platform)
// The shared HKDF primitive consumed by generated projects' browser hooks.
await build({
  entryPoints: ["src/entropy.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: "dist/entropy/index.js",
  sourcemap: true,
});

// Entropy bundle – CJS
await build({
  entryPoints: ["src/entropy.ts"],
  bundle: true,
  format: "cjs",
  platform: "neutral",
  target: "es2022",
  outfile: "dist/entropy/index.cjs",
  sourcemap: true,
});

// Copy .d.ts → .d.cts for CJS consumers
copyFileSync("dist/esm/index.d.ts", "dist/cjs/index.d.cts");
copyFileSync(
  "dist/esm/browserContribution.d.ts",
  "dist/browser/index.d.cts",
);
copyFileSync("dist/esm/worker/protocol.d.ts", "dist/worker/protocol.d.cts");
copyFileSync("dist/esm/entropy.d.ts", "dist/entropy/index.d.cts");

console.log("Build complete: ESM + CJS + Worker");
