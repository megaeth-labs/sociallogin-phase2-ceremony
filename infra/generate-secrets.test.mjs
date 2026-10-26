import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const run = (args) => spawnSync(process.execPath, ["infra/generate-secrets.mjs", ...args], { encoding: "utf8" });

test("generates a usable key set without printing private material", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moss-secrets-test-"));
  try {
    const out = join(dir, "set");
    const result = run(["--out", out, "--with-root"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY/);

    const summary = JSON.parse(await readFile(join(out, "public.json"), "utf8"));
    assert.deepEqual(Object.keys(summary.keys), ["manifestRoot", "coordinator", "verifier", "participantJwt"]);
    for (const [name, key] of [["manifest-root", summary.keys.manifestRoot], ["coordinator-1", summary.keys.coordinator],
      ["verifier-a", summary.keys.verifier], ["participant-jwt", summary.keys.participantJwt]]) {
      const privateKey = createPrivateKey(await readFile(join(out, `${name}.key`)));
      const publicKey = createPublicKey(await readFile(join(out, `${name}.pub`)));
      const signature = sign(null, Buffer.from("probe"), privateKey);
      assert.ok(verify(null, Buffer.from("probe"), publicKey, signature), name);
      assert.equal(createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex"), key.spkiSha256);
      assert.match(result.stdout, new RegExp(key.spkiSha256));
      assert.equal((await stat(join(out, `${name}.key`))).mode & 0o777, 0o600);
    }

    const tokenText = await readFile(join(out, "verifier-a.token"), "utf8");
    assert.match(tokenText, /^[A-Za-z0-9_-]{64}$/);
    assert.deepEqual(JSON.parse(await readFile(join(out, "coordinator-verifier-tokens.json"), "utf8")), { "verifier-a": tokenText });
    // The site requires exactly 43 base64url characters (32 bytes).
    assert.match(await readFile(join(out, "participant-id-derivation.key"), "utf8"), /^[A-Za-z0-9_-]{43}$/);
    for (const name of summary.secrets) assert.equal((await stat(join(out, name))).mode & 0o777, 0o600, name);
    assert.equal((await stat(out)).mode & 0o777, 0o700);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("omits the root key by default and never writes into a used directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moss-secrets-test-"));
  try {
    const out = join(dir, "set");
    const result = run(["--out", out]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /generate it offline/);
    assert.ok(!(await readdir(out)).some((name) => name.startsWith("manifest-root")));

    await writeFile(join(dir, "marker"), "x");
    assert.match(run(["--out", dir]).stderr, /not empty/);
    assert.match(run(["--out", join(dir, "bad"), "--verifier-key-id", "../x"]).stderr, /invalid key ID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
