#!/usr/bin/env node
// Sign a production ceremony manifest with the manifest root key.
//
// The signature is the anchor for the whole ceremony: contributors pin this
// key's fingerprint out of band, and every other trust decision — coordinator
// receipts, verifier reports, artifact pins, the beacon commitment, release
// allowlists — chains from the manifest it signs. So the point of this tool is
// less the signing, which is one call, than refusing to sign a manifest that
// would not survive production validation. A manifest is signed once, before
// the ceremony opens, and cannot be revised afterwards without abandoning the
// epoch.
//
// Requires `pnpm build` first; it imports the built protocol package.
//
//   node infra/sign-manifest.mjs \
//     --manifest ceremony-manifest.json \
//     --root-key manifest-root.key \
//     --key-id moss-phase2-root-1 \
//     --out manifest-envelope.json

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const protocol = await import(
  join(HERE, "..", "packages", "protocol", "dist", "index.js")
).catch(() => {
  throw new Error("run `pnpm build` first: this tool uses the built protocol package");
});
const {
  MANIFEST_SIGNATURE_DOMAIN,
  assertManifest,
  canonicalSha256,
  signEnvelope,
  verifyEnvelope,
} = protocol;

const FLAGS = new Set(["--manifest", "--root-key", "--key-id", "--out"]);

function parseFlags(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === "--allow-rehearsal") {
      if (values.has(flag)) throw new Error("duplicate rehearsal flag");
      values.set(flag, true); index -= 1; continue;
    }
    const value = argv[index + 1];
    if (!FLAGS.has(flag)) throw new Error(`unknown flag: ${flag}`);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    if (values.has(flag)) throw new Error(`duplicate flag: ${flag}`);
    values.set(flag, value);
  }
  for (const flag of FLAGS) {
    if (!values.has(flag)) throw new Error(`missing required flag: ${flag}`);
  }
  return values;
}

// An operator needs to see what is wrong with their manifest, not a stack
// trace through the validator.
function fail(message) {
  process.stderr.write(`\nmanifest signing failed: ${message}\n\n`);
  process.exit(1);
}

let flags;
try {
  flags = parseFlags(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const manifestPath = resolve(flags.get("--manifest"));
const outPath = resolve(flags.get("--out"));
const keyId = flags.get("--key-id");

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  fail(`could not read ${manifestPath}: ${error instanceof Error ? error.message : error}`);
}

// Validate before touching the key. Every production rule the coordinator,
// verifiers and finalizer will later enforce is checked here, while the
// manifest can still be edited.
try {
  assertManifest(manifest, { production: true, allowRehearsal: flags.has("--allow-rehearsal") });
  if (!manifest.publication && !manifest.primaryPublication) throw new Error("hosted manifest requires a signed publication policy (primaryPublication or a witness)");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

let privateKey;
try {
  privateKey = createPrivateKey(await readFile(flags.get("--root-key"), "utf8"));
} catch {
  // Never echo anything derived from the key file.
  fail("could not load the manifest root key as a PKCS#8 PEM private key");
}
if (privateKey.asymmetricKeyType !== "ed25519") {
  fail("the manifest root key must be Ed25519");
}
const publicKey = createPublicKey(privateKey);

const envelope = signEnvelope(manifest, {
  keyId,
  privateKey,
  domain: MANIFEST_SIGNATURE_DOMAIN,
});
// Verify what was produced rather than assuming it; a manifest that cannot be
// verified would only be discovered by contributors.
verifyEnvelope(envelope, { publicKey, domain: MANIFEST_SIGNATURE_DOMAIN });

// wx: never overwrite a manifest that may already have been published.
try {
  await writeFile(outPath, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o444,
  });
} catch (error) {
  fail(
    error?.code === "EEXIST"
      ? `${outPath} already exists; refusing to overwrite a manifest that may already be published`
      : `could not write ${outPath}: ${error instanceof Error ? error.message : error}`,
  );
}

const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const spkiSha256 = createHash("sha256")
  .update(publicKey.export({ type: "spki", format: "der" }))
  .digest("hex");

// Public material only. The private key is never printed, logged or copied.
process.stdout.write(`${JSON.stringify({
  status: "signed",
  envelopePath: outPath,
  keyId,
  rootKeySpkiSha256: spkiSha256,
  manifestCanonicalSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest),
  ceremonyId: manifest.ceremonyId,
  slug: manifest.slug,
  opensAt: manifest.schedule.opensAt,
  sealsAt: manifest.schedule.sealsAt,
  beaconSource: manifest.beacon.source,
}, null, 2)}\n`)

process.stderr.write(
  [
    "",
    "Publish the fingerprint below through a channel independent of the",
    "coordinator. Contributors pin it, and it is what makes a substituted",
    "manifest detectable:",
    "",
    `  key id      ${keyId}`,
    `  SPKI SHA-256 ${spkiSha256}`,
    "",
    "Public key to distribute:",
    "",
    publicKeyPem,
    "Take the root private key offline now. It signs once, and a manifest",
    "cannot be revised without abandoning this ceremony epoch.",
    "",
  ].join("\n"),
);
