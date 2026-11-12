#!/usr/bin/env node
// Capture a sealed ceremony's public records into one file the website can
// serve after the coordinator is retired.
//
//   node infra/capture-ceremony-archive.mjs \
//     --coordinator https://coordinator.example --slug my-ceremony \
//     --checkpoint ceremonies/my-ceremony/sealed-checkpoint.signed.json \
//     --updates-url https://archive.example/web-updates/<ceremony id>/operational-updates.json \
//     --out apps/ceremony/public/ceremony-archive.json
//
// The file holds only signed evidence: the root-signed manifest, the
// coordinator-signed sealed checkpoint and every coordinator-signed receipt.
// Nothing in it is trusted because of where it came from. The site checks every
// signature and the unbroken artifact chain from the pinned genesis to the
// sealed head, exactly as it checked the live coordinator. Operational updates
// are not captured: the release that serves this file is authorized by an
// update signed after it was built, so the site reads the signed update list
// from the archive URL given here.

import { readFile, writeFile } from "node:fs/promises";

function fail(message) {
  process.stderr.write(`\ncapture failed: ${message}\n\n`);
  process.exit(1);
}

const FLAGS = new Set(["--coordinator", "--slug", "--checkpoint", "--updates-url", "--out"]);
const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  if (!FLAGS.has(flag) || process.argv[index + 1] === undefined) fail(`unknown or incomplete flag ${flag}`);
  flags.set(flag, process.argv[index + 1]);
}
for (const flag of FLAGS) if (!flags.has(flag)) fail(`missing ${flag}`);

const coordinator = new URL(flags.get("--coordinator"));
const slug = flags.get("--slug");
const updatesUrl = new URL(flags.get("--updates-url"));
if (coordinator.protocol !== "https:" || updatesUrl.protocol !== "https:") fail("URLs must use HTTPS");
if (updatesUrl.search || updatesUrl.hash) fail("the update list URL must name the latest version, not pin one");
const base = `/v1/ceremonies/${encodeURIComponent(slug)}`;

async function json(path) {
  const response = await fetch(new URL(path, coordinator), { headers: { accept: "application/json" } });
  if (!response.ok) fail(`${path} returned ${response.status}`);
  return await response.json();
}

const manifest = await json(`${base}/manifest`);
const checkpoint = JSON.parse(await readFile(flags.get("--checkpoint"), "utf8"));
const sealed = checkpoint.payload;
if (manifest.payload?.slug !== slug) fail("the coordinator manifest names another ceremony");
if (sealed?.ceremonyId !== manifest.payload.ceremonyId || sealed.state !== "SEALED") fail("the checkpoint is not this ceremony's sealed head");

const receipts = [];
while (receipts.length < sealed.generation) {
  const limit = Math.min(50, sealed.generation - receipts.length);
  const page = await json(`${base}/contributions?after=${receipts.length}&limit=${limit}`);
  if (!Array.isArray(page.receipts) || page.receipts.length === 0) fail(`no receipts after ${receipts.length}`);
  for (const receipt of page.receipts.slice(0, limit)) {
    if (receipt.payload?.generation !== receipts.length + 1) fail(`receipt ${receipts.length + 1} is missing or out of order`);
    receipts.push(receipt);
  }
}
const head = receipts.at(-1)?.payload.successor;
if (!head || head.sha256 !== sealed.headSha256 || head.byteLength !== sealed.headByteLength) {
  fail("the receipts do not end at the sealed head");
}

const archive = {
  schemaVersion: 1,
  type: "moss.phase2.ceremony-archive.v1",
  slug,
  ceremonyId: manifest.payload.ceremonyId,
  capturedAt: new Date().toISOString(),
  coordinator: coordinator.origin,
  operationalUpdatesUrl: updatesUrl.toString(),
  manifest,
  checkpoint,
  receipts,
};
await writeFile(flags.get("--out"), `${JSON.stringify(archive, null, 1)}\n`);
process.stdout.write(`captured ${receipts.length} receipts ending at ${sealed.headSha256}\n`);
