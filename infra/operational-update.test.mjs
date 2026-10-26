import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { signEnvelope, MANIFEST_SIGNATURE_DOMAIN } from "../packages/protocol/dist/index.js";

test("offline operator tool signs and verifies bounded updates, rejects commitment edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moss-operations-test-"));
  try {
    const root = generateKeyPairSync("ed25519");
    const manifest = JSON.parse(await readFile(new URL("../ceremonies/company-rehearsal-2026-09-r2/manifest.signed.json", import.meta.url), "utf8")).payload;
    manifest.contributionPolicy.lease.heartbeatSeconds = 300;
    manifest.operationalPolicy = { minHeartbeatGraceSeconds: 30, maxHeartbeatGraceSeconds: 600, allowWebReleaseUpdates: true };
    const files = {
      "manifest.json": JSON.stringify(signEnvelope(manifest, { keyId: "test-root", privateKey: root.privateKey, domain: MANIFEST_SIGNATURE_DOMAIN })),
      "root.pub": root.publicKey.export({ type: "spki", format: "pem" }),
      "root.key": root.privateKey.export({ type: "pkcs8", format: "pem" }),
      "history.json": JSON.stringify({ updates: [] }),
      "change.json": JSON.stringify({ reason: "Queue test", heartbeatGraceSeconds: 120 }),
    };
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, { mode: 0o600 });
    const common = ["--manifest", join(dir, "manifest.json"), "--root-public-key", join(dir, "root.pub"), "--history", join(dir, "history.json")];
    const run = (command, extra = []) => spawnSync(process.execPath, ["infra/operational-update.mjs", command, ...common, ...extra], { encoding: "utf8" });
    const signing = ["--root-private-key", join(dir, "root.key"), "--change", join(dir, "change.json"), "--out", join(dir, "update.json")];
    assert.equal(run("sign", signing).status, 0);
    const update = JSON.parse(await readFile(join(dir, "update.json"), "utf8"));
    assert.equal(update.payload.heartbeatGraceSeconds, 120);
    await writeFile(join(dir, "history.json"), JSON.stringify({ updates: [update] }));
    assert.equal(run("verify").status, 0);
    await writeFile(join(dir, "change.json"), JSON.stringify({ reason: "Forbidden", verifierPolicy: {} }));
    assert.equal(run("sign", signing).status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
