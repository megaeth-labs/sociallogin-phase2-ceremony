#!/usr/bin/env node
// Compute the recursive Circom include-closure digest for a relation.
//
// The vendored-file hash covers only the .circom files copied into the MOSS
// tree. The circuit also includes @zk-email/circuits and circomlib, and those
// include further files recursively — which is where most of the constraint
// generating logic actually lives: RSA verification, SHA-256, Poseidon,
// base64. Those bytes are pinned by nothing stronger than a version in a
// lockfile, so a reproducer has to trust that the registry serves today what it
// served when the relation was compiled.
//
// This digest pins them. It is the source-side counterpart of the R1CS hash:
// the R1CS says what the compiler produced, the closure says what it was
// produced from.
//
//   node infra/circuit-closure.mjs \
//     --circuit ../moss-zk/circuits/zksync-social-login-v3/jwt-tx-validation.circom \
//     --library ../moss-zk/node_modules
//
// Scheme, so anyone can reproduce it independently:
//
//   1. Start at the entry circuit and follow every `include` transitively.
//      Each specifier resolves against the including file's directory first,
//      then each --library root in order, matching circom. A bare specifier is
//      not necessarily a package path: circomlib's own sources include their
//      siblings that way.
//   2. Label each file by the root it physically belongs to, not by how it was
//      spelled at the include site — `circuit/<path>` under the entry
//      circuit's directory, otherwise its path within a --library root. A file
//      reached two ways is therefore recorded once, and the digest does not
//      depend on checkout paths.
//   3. Sort by label, and digest the concatenation of
//      `<label> LF <sha256 of the file's raw bytes> LF`.
//
// Raw bytes are hashed with no normalisation: whitespace and comments are part
// of the source identity.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

function fail(message) {
  process.stderr.write(`\ninclude-closure failed: ${message}\n\n`);
  process.exit(1);
}

const FLAGS = new Set(["--circuit", "--library", "--json"]);
const libraries = [];
const single = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!FLAGS.has(flag)) fail(`unknown flag: ${flag}`);
  if (flag === "--json") {
    single.set(flag, value ?? "");
    index -= 1;
    continue;
  }
  if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
  if (flag === "--library") libraries.push(resolve(value));
  else single.set(flag, value);
}
if (!single.has("--circuit")) fail("missing required flag: --circuit");

const entry = resolve(single.get("--circuit"));
const circuitRoot = dirname(entry);

/** `include "x";` — circom takes a single quoted specifier per statement. */
const INCLUDE = /^\s*include\s+"([^"]+)"\s*;/gmu;

async function isFile(path) {
  return await stat(path).then((entry) => entry.isFile()).catch(() => false);
}

/**
 * Resolve one specifier the way circom does: relative to the including file
 * first, then each --library root. A bare specifier is not necessarily a
 * package path — circomlib's own sources include siblings that way.
 */
async function resolveInclude(specifier, fromFile) {
  const withExtension = specifier.endsWith(".circom") ? specifier : `${specifier}.circom`;
  const candidates = [
    resolve(dirname(fromFile), withExtension),
    ...libraries.map((library) => join(library, withExtension)),
  ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  fail(
    `${label(fromFile)} includes ${specifier}, which was not found beside it or in any --library root`,
  );
}

/**
 * Label a file by the root it belongs to, not by how it was spelled at the
 * include site, so the same file reached two ways is recorded once and the
 * digest does not depend on checkout paths.
 */
function label(path) {
  const within = (root) => {
    const rel = relative(root, path);
    return rel && !rel.startsWith("..") && !rel.startsWith(sep) ? rel.split(sep).join("/") : null;
  };
  const inCircuit = within(circuitRoot);
  if (inCircuit) return `circuit/${inCircuit}`;
  for (const library of libraries) {
    const inLibrary = within(library);
    if (inLibrary) return inLibrary;
  }
  fail(`${path} lies outside the circuit tree and every --library root`);
}

const seen = new Map();
const queue = [entry];
while (queue.length > 0) {
  const path = queue.pop();
  const name = label(path);
  if (seen.has(name)) continue;
  let source;
  try {
    source = await readFile(path);
  } catch {
    fail(`could not read ${path}`);
  }
  seen.set(name, createHash("sha256").update(source).digest("hex"));
  for (const match of source.toString("utf8").matchAll(INCLUDE)) {
    queue.push(await resolveInclude(match[1], path));
  }
}

const files = [...seen.entries()]
  .map(([label, sha256]) => ({ label, sha256 }))
  .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

const digest = createHash("sha256");
for (const file of files) digest.update(`${file.label}\n${file.sha256}\n`);
const closureSha256 = digest.digest("hex");

if (single.has("--json")) {
  process.stdout.write(`${JSON.stringify({
    recursiveIncludeClosureSha256: closureSha256,
    fileCount: files.length,
    scheme: "sha256 over sorted `<label> LF <sha256(file bytes)> LF`",
    files,
  }, null, 2)}\n`);
} else {
  for (const file of files) {
    process.stdout.write(`${file.sha256}  ${file.label}\n`);
  }
  process.stdout.write(`\n${files.length} files\nrecursiveIncludeClosureSha256: ${closureSha256}\n`);
}
