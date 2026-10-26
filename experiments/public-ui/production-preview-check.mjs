// Requires a completed web production build. Starts a disposable loopback server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const app = fileURLToPath(new URL("../../apps/ceremony/", import.meta.url));
const require = createRequire(
  new URL("../../apps/ceremony/package.json", import.meta.url),
);
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
// env sets only this public mode; inherited secrets are never read or logged.
const server = spawn(
  "/usr/bin/env",
  [
    "NODE_ENV=production",
    process.execPath,
    require.resolve("next/dist/bin/next"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  { cwd: app, stdio: "ignore" },
);
let exited = false;
server.on("exit", () => {
  exited = true;
});
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    assert.equal(exited, false, "production test server exited");
    try {
      ready =
        (
          await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(1000),
          })
        ).status === 200;
    } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/preview`)).status, 404);
  console.log(
    "Passed: production dashboard responds; simulated preview returns 404.",
  );
} finally {
  server.kill("SIGTERM");
}
