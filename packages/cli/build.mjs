import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

// The release hash is deliberately not injected here. It is the hash of the
// artifact this build produces, so embedding it would change the artifact and
// therefore the hash, which never converges. src/release.ts reads the built
// bundle back at run time instead.
//
// The contribution worker, which generates the secret, is a separate file the
// release pin would not otherwise cover. It is built first and its hash is
// embedded in index.js, so the pinned index.js also pins the worker.

await build({
  entryPoints: ["src/contribution-worker.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  outfile: "dist/contribution-worker.js",
  sourcemap: true,
  external: ["snarkjs"],
});
const workerSha256 = createHash("sha256")
  .update(await readFile("dist/contribution-worker.js"))
  .digest("hex");

await build({
  define: { __MOSS_CONTRIBUTION_WORKER_SHA256__: JSON.stringify(workerSha256) },
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  outfile: "dist/index.js",
  sourcemap: true,
  external: ["snarkjs"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
});

console.log("Build complete: dist/index.js");
