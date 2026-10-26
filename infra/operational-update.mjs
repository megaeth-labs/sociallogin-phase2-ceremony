// Offline root authorization, then explicit submission. Never prints private material.
import { readFile, writeFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { parseArgs } from "node:util";
import { assertManifest, canonicalSha256, MANIFEST_SIGNATURE_DOMAIN, OPERATIONAL_UPDATE_DOMAIN,
  operationalUpdateHash, signEnvelope, verifyEnvelope, verifyOperationalUpdate, verifyOperationalUpdates } from "../packages/protocol/dist/index.js";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(
    ["manifest", "root-public-key", "root-private-key", "history", "change", "out", "coordinator", "slug", "update"].map((name) => [name, { type: "string" }])) });
  const need = (name) => { if (!values[name]) throw Error("missing option"); return values[name]; };
  const json = async (path) => { const bytes = await readFile(path); if (bytes.length > 2_200_000) throw Error("file too large"); return JSON.parse(bytes); };
  if (positionals.length !== 1) throw Error("expected command");
  if (positionals[0] === "verify") {
    const manifest = await json(need("manifest"));
    const root = createPublicKey(await readFile(need("root-public-key")));
    verifyEnvelope(manifest, { publicKey: root, domain: MANIFEST_SIGNATURE_DOMAIN });
    const rehearsal = manifest.payload.purpose === "rehearsal";
    assertManifest(manifest.payload, { production: true, allowRehearsal: rehearsal });
    const { updates } = await json(need("history"));
    verifyOperationalUpdates(updates, manifest, root, rehearsal);
    console.log(`Verified ${updates.length} root-authorized operational updates. Application times and archive metadata are coordinator-reported; signatures authenticate authorization and order.`);
  } else if (positionals[0] === "sign") {
    const manifest = await json(need("manifest"));
    const root = createPublicKey(await readFile(need("root-public-key")));
    verifyEnvelope(manifest, { publicKey: root, domain: MANIFEST_SIGNATURE_DOMAIN });
    const rehearsal = manifest.payload.purpose === "rehearsal";
    assertManifest(manifest.payload, { production: true, allowRehearsal: rehearsal });
    const { updates } = await json(need("history"));
    verifyOperationalUpdates(updates, manifest, root, rehearsal);
    const change = await json(need("change"));
    if (!change || typeof change !== "object" || Object.keys(change).some((key) => !["reason", "heartbeatGraceSeconds", "webRelease", "cliRelease"].includes(key))) throw Error("unsupported change");
    const previous = updates.at(-1);
    const payload = { ...change, schemaVersion: 1, type: "moss.phase2.operational-update.v1",
      ceremonyId: manifest.payload.ceremonyId, manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest.payload),
      sequence: updates.length + 1, previousUpdateSha256: previous ? operationalUpdateHash(previous) : null,
      authorizedAt: new Date().toISOString() };
    const privateKey = createPrivateKey(await readFile(need("root-private-key")));
    const update = signEnvelope(payload, { keyId: manifest.keyId, privateKey, domain: OPERATIONAL_UPDATE_DOMAIN });
    verifyOperationalUpdate(update, manifest, root, previous ?? null, rehearsal);
    verifyOperationalUpdates([...updates, update], manifest, root, rehearsal);
    await writeFile(need("out"), JSON.stringify(update, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`Signed operational update ${payload.sequence}. Review the public output before submitting.`);
  } else if (positionals[0] === "submit") {
    const url = new URL(need("coordinator"));
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw Error("unsafe coordinator URL");
    const update = await json(need("update"));
    const response = await fetch(new URL(`/v1/ceremonies/${encodeURIComponent(need("slug"))}/operational-updates`, url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(update), redirect: "error", signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw Error("update rejected");
    const result = await response.json();
    if (result.sequence !== update.payload.sequence || result.updateSha256 !== operationalUpdateHash(update)) throw Error("update acknowledgement mismatch");
    console.log(`Operational update ${result.sequence} applied. Download the public update history to confirm.`);
  } else throw Error("unknown command");
} catch {
  console.error("Operational update failed. Check command/options, signed history, policy bounds and coordinator availability. Private diagnostics suppressed.");
  process.exitCode = 1;
}
