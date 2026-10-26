#!/usr/bin/env node
// Assemble a signable ceremony manifest from the pinned relation definition
// plus the operating decisions that only an operator can make.
//
// The definition under ceremonies/ records what the relation *is* — circuit
// source, compiler profile, artifact hashes. The manifest is what contributors
// verify against, so it additionally carries the schedule, the beacon
// commitment, the key set, the policy and the release allowlist. Nothing
// converted one to the other, leaving the manifest to be hand-written against
// a TypeScript interface.
//
// Write a starting point, fill in the decisions, then build:
//
//   node infra/build-manifest.mjs --definition <draft.json> --template inputs.json
//   node infra/build-manifest.mjs --definition <draft.json> --inputs inputs.json \
//     --out ceremony-manifest.json
//
// Requires `pnpm build`. Output is validated under production rules, so this
// refuses to emit a manifest that `sign:manifest` would reject.

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { assertManifest } = await import(
  join(HERE, "..", "packages", "protocol", "dist", "index.js")
).catch(() => {
  throw new Error("run `pnpm build` first: this tool uses the built protocol package");
});

function fail(message) {
  process.stderr.write(`\nmanifest assembly failed: ${message}\n\n`);
  process.exit(1);
}

const FLAGS = new Set(["--definition", "--inputs", "--out", "--template"]);
const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  if (flag === "--allow-rehearsal") {
    if (flags.has(flag)) fail("duplicate rehearsal flag");
    flags.set(flag, true); index -= 1; continue;
  }
  const value = process.argv[index + 1];
  if (!FLAGS.has(flag)) fail(`unknown flag: ${flag}`);
  if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
  flags.set(flag, value);
}
if (!flags.has("--definition")) fail("missing required flag: --definition");

let definition;
try {
  definition = JSON.parse(await readFile(resolve(flags.get("--definition")), "utf8"));
} catch (error) {
  fail(`could not read the definition: ${error instanceof Error ? error.message : error}`);
}
const relation = definition.relation ?? {};

// ---------------------------------------------------------------- template

if (flags.has("--template")) {
  const seals = new Date(Date.now() + 14 * 86_400_000);
  const template = {
    _README: [
      "Every value here is a decision the relation definition cannot make for you.",
      "Replace each REPLACE_ME before building. Key files are read from disk, so",
      "public keys are never pasted into this file.",
    ],
    purpose: flags.has("--allow-rehearsal") ? "rehearsal" : "production",
    publication: { endpoint: "https://REPLACE_ME/witness", witness: { keyId: "witness-1", publicKeyFile: "./keys/witness-1.pub" } },
    slug: "REPLACE_ME-ceremony-slug",
    ceremonyId: randomUUID(),
    schedule: {
      opensAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      sealsAt: seals.toISOString(),
    },
    beacon: {
      _note: "Precommit a mainnet block after sealsAt. Exponent 10 uses 1,024 sequential hashes; it does not provide a meaningful proposer-grinding delay. Soundness still requires an honest ordinary contributor. Freeze this value when signing.",
      source: "ethereum-block",
      chainId: 1,
      blockNumber: 0,
      expectedAt: new Date(seals.getTime() + 86_400_000).toISOString(),
      numIterationsExp: 10,
      contributionName: "final",
    },
    artifactUrls: {
      _note: "Immutable URLs you host. The definition pins hashes; these say where the bytes live.",
      r1cs: ["https://REPLACE_ME/circuit.r1cs"],
      ptau: ["https://REPLACE_ME/powersOfTau28_hez_final_24.ptau"],
      genesisZkey: ["https://REPLACE_ME/genesis.zkey"],
    },
    coordinatorKeys: [
      { keyId: "coordinator-1", publicKeyFile: "./keys/coordinator-1.pub" },
    ],
    verifierKeys: [
      {
        _note: "Add a second, independently administered operator for independent verification; every listed operator must approve.",
        keyId: "verifier-a",
        publicKeyFile: "./keys/verifier-a.pub",
        verifierImageDigest: "sha256:REPLACE_ME",
      },
    ],
    verifierPolicy: { requiredOperators: 1, passesPerOperator: 1 },
    contributionPolicy: {
      _note: "maximumContributions must equal targetContributions; there is no overshoot allowance.",
      targetContributions: 25,
      maxArtifactByteLength: 600_000_000,
      requirePinnedClientRelease: true,
      lease: { offerSeconds: 120, heartbeatSeconds: 300, absoluteSeconds: 5400 },
      verifierJobSeconds: 1800,
      verifierMaxAttempts: 3,
    },
    operationalPolicy: { minHeartbeatGraceSeconds: 30, maxHeartbeatGraceSeconds: 600, allowWebReleaseUpdates: true, allowCliReleaseUpdates: true },
    webRelease: {
      _note: "sha256 and byteLength of the published build; sourceCommit is the full Git object ID.",
      sha256: "REPLACE_ME",
      byteLength: 0,
      urls: ["https://REPLACE_ME/web-release.tar.gz"],
      sourceCommit: "REPLACE_ME",
    },
    cliReleases: [
      {
        _note: "sha256 of dist/index.js — the CLI hashes itself at run time and must find its own hash here.",
        sha256: "REPLACE_ME",
        byteLength: 0,
        urls: ["https://REPLACE_ME/moss-phase2-cli.js"],
        sourceCommit: "REPLACE_ME",
      },
    ],
  };
  if (flags.has("--allow-rehearsal")) {
    template.contributionPolicy.targetContributions = 3;
  }
  const path = resolve(flags.get("--template"));
  try {
    await writeFile(path, `${JSON.stringify(template, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    fail(
      error?.code === "EEXIST"
        ? `${path} already exists`
        : `could not write ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
  process.stderr.write(`\nwrote ${path}\nReplace every REPLACE_ME, then build the manifest.\n\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- assemble

if (!flags.has("--inputs")) fail("missing required flag: --inputs (or --template to start one)");
if (!flags.has("--out")) fail("missing required flag: --out");

let inputs;
try {
  inputs = JSON.parse(await readFile(resolve(flags.get("--inputs")), "utf8"));
} catch (error) {
  fail(`could not read the inputs: ${error instanceof Error ? error.message : error}`);
}

/** Strip the annotation keys the template carries for the operator's benefit. */
const clean = (value) =>
  Array.isArray(value)
    ? value.map(clean)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !key.startsWith("_"))
            .map(([key, inner]) => [key, clean(inner)]),
        )
      : value;

const decisions = clean(inputs);

const placeholders = JSON.stringify(decisions).match(/REPLACE_ME/gu);
if (placeholders) fail(`${placeholders.length} REPLACE_ME placeholder(s) remain in the inputs`);

async function publicKeyPem(file, label) {
  try {
    return await readFile(resolve(dirname(resolve(flags.get("--inputs"))), file), "utf8");
  } catch {
    fail(`could not read the ${label} public key at ${file}`);
  }
}

// The definition pins the bytes; the inputs say where they are served from.
function artifact(source, urls, label) {
  if (!source || typeof source.sha256 !== "string" || typeof source.byteLength !== "number") {
    fail(`the definition has no resolved ${label} sha256 and byteLength; that launch blocker is still open`);
  }
  if (!Array.isArray(urls) || urls.length === 0) fail(`no ${label} URLs supplied in the inputs`);
  return { sha256: source.sha256, byteLength: source.byteLength, urls };
}

const circuit = relation.circuitSource ?? {};
if (typeof circuit.recursiveIncludeClosureSha256 !== "string") {
  fail(
    "the definition's recursiveIncludeClosureSha256 is still unresolved, and the manifest cannot pin the relation without it; complete that launch blocker first",
  );
}

const manifest = {
  schemaVersion: 1,
  purpose: decisions.purpose ?? "production",
  ...(decisions.operationalPolicy ? { operationalPolicy: decisions.operationalPolicy } : {}),
  ...(decisions.primaryPublication ? { primaryPublication: decisions.primaryPublication } : {}),
  ...(decisions.publication ? { publication: {
    endpoint: decisions.publication.endpoint,
    witness: { keyId: decisions.publication.witness.keyId, algorithm: "Ed25519",
      publicKeyPem: await publicKeyPem(decisions.publication.witness.publicKeyFile, "witness") },
  } } : {}),
  ceremonyId: decisions.ceremonyId,
  slug: decisions.slug,
  relation: {
    profile: relation.profile,
    relationId: relation.relationId,
    verifierVersion: relation.verifierVersion,
    proofSystem: relation.proofSystem,
    curve: relation.curve,
    sourceRepository: circuit.upstreamRepository,
    sourceCommit: circuit.upstreamCommit,
    sourceClosureSha256: circuit.recursiveIncludeClosureSha256,
    circomVersion: circuit.circomVersion,
    snarkjsVersion: relation.snarkjsVersion,
    r1cs: artifact(relation.r1cs, decisions.artifactUrls?.r1cs, "r1cs"),
    ptau: {
      ...artifact(relation.ptau, decisions.artifactUrls?.ptau, "ptau"),
      blake2b512: relation.ptau?.blake2b512,
    },
    ...(decisions.genesisBellman ? { genesisBellman: artifact(decisions.genesisBellman, decisions.genesisBellman.urls, "genesis Bellman") } : {}),
    genesisZkey: artifact(
      relation.genesisZkey,
      decisions.artifactUrls?.genesisZkey,
      "genesis zkey",
    ),
  },
  schedule: decisions.schedule,
  beacon: { ...decisions.beacon, derivation: "MOSS_PHASE2_BEACON_V1" },
  coordinatorKeys: await Promise.all(
    (decisions.coordinatorKeys ?? []).map(async (key) => ({
      keyId: key.keyId,
      algorithm: "Ed25519",
      publicKeyPem: await publicKeyPem(key.publicKeyFile, `coordinator key ${key.keyId}`),
    })),
  ),
  verifierKeys: await Promise.all(
    (decisions.verifierKeys ?? []).map(async (key) => ({
      keyId: key.keyId,
      algorithm: "Ed25519",
      publicKeyPem: await publicKeyPem(key.publicKeyFile, `verifier key ${key.keyId}`),
      verifierImageDigest: key.verifierImageDigest,
    })),
  ),
  verifierPolicy: {
    ...(decisions.verifierPolicy?.verificationMethod ? { verificationMethod: decisions.verifierPolicy.verificationMethod } : {}),
    operatorKeyIds: (decisions.verifierKeys ?? []).map((key) => key.keyId),
    requiredOperators: decisions.verifierPolicy?.requiredOperators,
    passesPerOperator: decisions.verifierPolicy?.passesPerOperator,
  },
  contributionPolicy: {
    ...decisions.contributionPolicy,
    // Equal by construction; the validator rejects any other relationship and
    // making an operator state the same number twice only invites a mismatch.
    maximumContributions: decisions.contributionPolicy?.targetContributions,
  },
  webRelease: decisions.webRelease,
  cliReleases: decisions.cliReleases,
};

// Fail here rather than at signing time, while the inputs are still in hand.
try {
  if (!manifest.publication && !manifest.primaryPublication) throw new Error("hosted manifest requires a signed publication policy (primaryPublication or a witness)");
  assertManifest(manifest, { production: true, allowRehearsal: flags.has("--allow-rehearsal") });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const outPath = resolve(flags.get("--out"));
try {
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o444 });
} catch (error) {
  fail(
    error?.code === "EEXIST"
      ? `${outPath} already exists; refusing to overwrite`
      : `could not write ${outPath}: ${error instanceof Error ? error.message : error}`,
  );
}

const blockers = Array.isArray(definition.launchBlockers) ? definition.launchBlockers : [];
process.stderr.write(
  [
    "",
    `wrote ${outPath} — valid under production rules.`,
    "",
    blockers.length
      ? `The definition still lists ${blockers.length} launch blocker(s). A valid manifest is not a ready ceremony:`
      : "The definition lists no remaining launch blockers.",
    ...blockers.map((blocker) => `  - ${blocker}`),
    "",
    "Next: pnpm sign:manifest --manifest <this file> --root-key <root key> --key-id <id> --out manifest-envelope.json",
    "",
  ].join("\n"),
);
