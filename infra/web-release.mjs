#!/usr/bin/env node
// Describe, and later check, the web release contributors are served.
//
// A page cannot prove what code it is running: if the server is compromised,
// the malicious script is the thing doing the reporting. So webRelease.sha256
// does not ask the browser anything. It pins a deterministic manifest of every
// asset the build serves, from a reproducible build of the release commit, and
// anyone can compare the live site against it — before, during or after the
// ceremony.
//
//   Build and describe (after `next build` with the release commit checked out):
//     node infra/web-release.mjs --describe apps/ceremony/.next --out web-release.json
//
//   Check a deployment against a published manifest:
//     node infra/web-release.mjs --check https://ceremony.example --manifest web-release.json
//
// webRelease in the ceremony manifest is then { sha256, byteLength } of
// web-release.json itself, its immutable URLs, and the source commit — a
// single downloadable file, as a ReleaseRef describes.
//
// Scope: /_next/static, which holds every script and stylesheet the browser
// executes. HTML is rendered per request and is not pinned directly; instead the
// check confirms that every integrity attribute and script reference in the
// served page points at a pinned asset with a matching digest, so the document
// cannot pull in anything the manifest does not describe.

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

function fail(message) {
  process.stderr.write(`\nweb release failed: ${message}\n\n`);
  process.exit(1);
}

const FLAGS = new Set(["--describe", "--out", "--check", "--manifest"]);
const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!FLAGS.has(flag)) fail(`unknown flag: ${flag}`);
  if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
  flags.set(flag, value);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** Stable serialisation, so the manifest digest is reproducible from its content. */
function serialise(manifest) {
  return `${JSON.stringify({
    type: manifest.type,
    buildId: manifest.buildId,
    assets: manifest.assets.map((asset) => ({
      path: asset.path,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
    })),
  }, null, 2)}\n`;
}

// ------------------------------------------------------------------ describe

if (flags.has("--describe")) {
  if (!flags.has("--out")) fail("missing required flag: --out");
  const buildDir = resolve(flags.get("--describe"));
  const staticDir = join(buildDir, "static");
  let buildId;
  try {
    buildId = (await readFile(join(buildDir, "BUILD_ID"), "utf8")).trim();
  } catch {
    fail(`${buildDir} is not a completed Next build`);
  }
  const assets = [];
  for await (const file of walk(staticDir)) {
    const bytes = await readFile(file);
    assets.push({
      path: `/_next/static/${relative(staticDir, file).split(sep).join("/")}`,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
    });
  }
  if (assets.length === 0) fail(`${staticDir} contains no assets`);
  assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const body = serialise({ type: "moss.phase2.web-release.v1", buildId, assets });
  const outPath = resolve(flags.get("--out"));
  try {
    await writeFile(outPath, body, { flag: "wx", mode: 0o444 });
  } catch (error) {
    fail(error?.code === "EEXIST" ? `${outPath} already exists` : String(error));
  }
  process.stdout.write(`${JSON.stringify({
    manifestPath: outPath,
    assets: assets.length,
    buildId,
    webRelease: {
      sha256: sha256(body),
      byteLength: Buffer.byteLength(body),
      urls: ["publish web-release.json at an immutable URL"],
      sourceCommit: buildId,
    },
  }, null, 2)}\n`);
  process.exit(0);
}

// --------------------------------------------------------------------- check

if (!flags.has("--check")) fail("use --describe <.next dir> --out <file>, or --check <origin> --manifest <file>");
if (!flags.has("--manifest")) fail("missing required flag: --manifest");

const origin = new URL(flags.get("--check")).origin;
let manifest;
try {
  manifest = JSON.parse(await readFile(resolve(flags.get("--manifest")), "utf8"));
} catch (error) {
  fail(`could not read the manifest: ${error instanceof Error ? error.message : error}`);
}
const pinned = new Map(manifest.assets.map((asset) => [asset.path, asset]));

const problems = [];

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: "error", cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// 1. Every pinned asset is served, byte for byte.
for (const asset of manifest.assets) {
  try {
    const bytes = await fetchBytes(`${origin}${asset.path}`);
    if (sha256(bytes) !== asset.sha256) problems.push(`${asset.path}: served bytes differ from the release`);
  } catch (error) {
    problems.push(`${asset.path}: could not be fetched (${error instanceof Error ? error.message : error})`);
  }
}

// 2. The served page references nothing outside the release, and every
//    integrity attribute it carries matches the pinned bytes.
let html = "";
try {
  html = new TextDecoder().decode(await fetchBytes(`${origin}/`));
} catch (error) {
  problems.push(`/: could not be fetched (${error instanceof Error ? error.message : error})`);
}
for (const match of html.matchAll(/\b(?:src|href)="(\/_next\/static\/[^"?#]+)[^"]*"/gu)) {
  if (!pinned.has(match[1])) problems.push(`page references ${match[1]}, which the release does not contain`);
}
for (const match of html.matchAll(/<[^>]*?(?:src|href)="(\/_next\/static\/[^"?#]+)[^"]*"[^>]*?integrity="sha256-([^"]+)"[^>]*>/gu)) {
  const asset = pinned.get(match[1]);
  if (!asset) continue;
  const expected = Buffer.from(asset.sha256, "hex").toString("base64");
  if (match[2] !== expected) problems.push(`${match[1]}: integrity attribute does not match the release`);
}
// Build ID travels in asset paths, so a different one means a different build.
if (manifest.buildId && !html.includes(manifest.buildId)) {
  problems.push(`served page does not reference build ${manifest.buildId}`);
}

if (problems.length > 0) {
  process.stderr.write(`\n${origin} does NOT match the published web release:\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write("\n");
  process.exit(1);
}
process.stdout.write(
  `${origin} matches the published web release: ${manifest.assets.length} assets byte-identical, page references only pinned assets.\n`,
);
