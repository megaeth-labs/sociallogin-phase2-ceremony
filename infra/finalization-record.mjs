#!/usr/bin/env node
// Build, sign and verify the production completion record.
//
// The coordinator stays SEALED after the ceremony closes; nothing online holds
// the root key. Completion is instead this offline, root-signed record. It
// binds the sealed checkpoint to the finalizer's outputs, the full audit and
// the proof tests, and pins every published file by hash and immutable object
// version. The website verifies it against the live sealed checkpoint and ships
// it in a root-authorized web release (operational update).
//
// Requires `pnpm build` first; it imports the built protocol package.
//
//   node infra/finalization-record.mjs build \
//     --manifest manifest.signed.json --root-public-key root.pub \
//     --checkpoint sealed-checkpoint.signed.json \
//     --finalizer-output finalized/ \
//     --audit ceremony-audit.json --proof-index proof-verification-index.json \
//     --publication-index publication-index.json \
//     --artifact-index-url 'https://archive.example/finalization/.../sha256/<hex>/publication-index.json?versionId=...' \
//     --out finalization.payload.json
//
//   node infra/finalization-record.mjs sign  ... --record finalization.payload.json --root-private-key root.key --out finalization.signed.json
//   node infra/finalization-record.mjs verify ... --record finalization.signed.json

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  assertFinalizationRecord, assertManifest, canonicalSha256, CHECKPOINT_SIGNATURE_DOMAIN, FINALIZATION_ARTIFACT_FILES,
  FINALIZATION_RECORD_DOMAIN, MANIFEST_SIGNATURE_DOMAIN, signEnvelope, verifyEnvelope, verifyFinalizationRecord,
} from "../packages/protocol/dist/index.js";

const OPTIONS = ["manifest", "root-public-key", "root-private-key", "checkpoint", "finalizer-output", "audit", "proof-index",
  "publication-index", "artifact-index-url", "completed-at", "record", "out"];

function fail(message) {
  process.stderr.write(`\nfinalization record failed: ${message}\n\n`);
  process.exit(1);
}

const json = async (path, limit = 4_000_000) => {
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error(`${basename(path)} is too large`);
  return JSON.parse(bytes);
};

async function sha256File(path) {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); byteLength += chunk.length; }
  return { sha256: hash.digest("hex"), byteLength };
}

/** Authenticate the manifest with the out-of-band root key and the checkpoint with a manifest coordinator key. */
async function authority(values, need) {
  const manifest = await json(need("manifest"));
  const root = createPublicKey(await readFile(need("root-public-key")));
  verifyEnvelope(manifest, { publicKey: root, domain: MANIFEST_SIGNATURE_DOMAIN });
  if (manifest.payload.purpose === "rehearsal") throw new Error("rehearsals use the rehearsal completion record");
  assertManifest(manifest.payload, { production: true });
  const envelope = await json(need("checkpoint"));
  const key = manifest.payload.coordinatorKeys.find((item) => item.keyId === envelope.keyId);
  if (!key) throw new Error("checkpoint signer is not a manifest coordinator key");
  const checkpoint = verifyEnvelope(envelope, { publicKey: createPublicKey(key.publicKeyPem), domain: CHECKPOINT_SIGNATURE_DOMAIN });
  if (checkpoint.ceremonyId !== manifest.payload.ceremonyId || checkpoint.state !== "SEALED") throw new Error("checkpoint is not this ceremony's sealed checkpoint");
  const manifestSha256 = canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest.payload);
  return { manifest, root, checkpoint, manifestSha256 };
}

// Record artifact keys whose publication-index role has a different name.
const PUBLISHED_ROLES = { sealedImport: "importedSealedZkey" };

/** Reads a `moss.phase2.final-publication-index.v1` written by `moss-phase2-publish`. */
function publishedLocations(index, ceremonyId, summarySha256) {
  if (index?.schemaVersion !== 1 || index.type !== "moss.phase2.final-publication-index.v1" ||
      index.ceremonyId !== ceremonyId || index.finalizerSummarySha256 !== summarySha256 ||
      !index.artifacts || typeof index.artifacts !== "object") {
    throw new Error("publication index is not this ceremony's final publication index");
  }
  const byKey = new Map();
  for (const [role, file] of Object.entries(index.artifacts)) {
    byKey.set(role, { fileName: file?.fileName, sha256: file?.sha256, byteLength: file?.byteLength, versionId: file?.versionId, url: file?.url });
  }
  return byKey;
}

async function build(values, need) {
  const { manifest, checkpoint, manifestSha256 } = await authority(values, need);
  const outputDir = resolve(need("finalizer-output"));
  const summary = await json(join(outputDir, FINALIZATION_ARTIFACT_FILES.finalizerSummary));
  if (summary.type !== "moss.phase2.final-artifacts.v1" || summary.ceremonyId !== manifest.payload.ceremonyId ||
      summary.authority.manifestCanonicalPayloadSha256 !== manifestSha256 ||
      summary.authority.sealedEventHash !== checkpoint.eventHash || summary.authority.sealedEventSequence !== checkpoint.eventSequence ||
      summary.authority.sealedGeneration !== checkpoint.generation ||
      summary.inputs.sealedHead.sha256 !== checkpoint.headSha256 || summary.inputs.sealedHead.byteLength !== checkpoint.headByteLength)
    throw new Error("finalizer summary does not match the manifest and sealed checkpoint");

  const audit = await json(need("audit"));
  if (basename(need("audit")) !== FINALIZATION_ARTIFACT_FILES.auditReport) throw new Error(`audit report must be named ${FINALIZATION_ARTIFACT_FILES.auditReport}`);
  // A records-only audit can also pass; only a full replay counts here.
  const sealed = audit.sealed;
  if (audit.schemaVersion !== 1 || audit.type !== "moss.phase2.ceremony-audit.v1" || audit.scope !== "full" ||
      audit.result !== "passed" || audit.failures?.length !== 0 || audit.checks?.replay?.result !== "passed" ||
      audit.ceremonyId !== manifest.payload.ceremonyId || audit.manifestSha256 !== manifestSha256 ||
      sealed?.generation !== checkpoint.generation || sealed.headSha256 !== checkpoint.headSha256 ||
      sealed.headByteLength !== checkpoint.headByteLength || sealed.eventHash !== checkpoint.eventHash ||
      sealed.eventSequence !== checkpoint.eventSequence)
    throw new Error("audit report is not a passing full audit of this sealed ceremony");
  const proofs = await json(need("proof-index"));
  if (basename(need("proof-index")) !== FINALIZATION_ARTIFACT_FILES.proofEvidence) throw new Error(`proof index must be named ${FINALIZATION_ARTIFACT_FILES.proofEvidence}`);
  // The proof test only writes its index when every check passed; this
  // re-checks that it ran against these outputs with the Solidity tests.
  const sameDigest = (a, b) => a?.sha256 === b?.sha256 && a?.byteLength === b?.byteLength;
  if (proofs.schemaVersion !== 1 || proofs.type !== "moss.phase2.proof-tests.v1" || proofs.expectedPublicInputs !== 20 ||
      !sameDigest(proofs.finalZkey, summary.outputs.finalZkey) || !sameDigest(proofs.verificationKey, summary.outputs.verificationKey) ||
      !Array.isArray(proofs.fixtures) || proofs.fixtures.length < 1 ||
      proofs.fixtures.some((fixture) => fixture.witness?.satisfiesR1cs !== true || fixture.proofs?.length < 1 ||
        fixture.proofs.some((proof) => proof.verified !== true) ||
        fixture.rejected?.modifiedPublicInputs !== 20 || fixture.rejected.negatedProofA !== true) ||
      !sameDigest(proofs.solidityTests?.verifier, summary.outputs.solidityVerifier) ||
      !(proofs.solidityTests.tests?.length >= 1) || proofs.solidityTests.tests.some((test) => test.passed !== true))
    throw new Error("proof tests did not pass against this final key");

  const evidenceName = summary.outputs.beaconEvidence.fileName;
  const local = {
    finalZkey: join(outputDir, FINALIZATION_ARTIFACT_FILES.finalZkey),
    verificationKey: join(outputDir, FINALIZATION_ARTIFACT_FILES.verificationKey),
    solidityVerifier: join(outputDir, FINALIZATION_ARTIFACT_FILES.solidityVerifier),
    ...(summary.outputs.importedSealedZkey ? { sealedImport: join(outputDir, FINALIZATION_ARTIFACT_FILES.sealedImport) } : {}),
    beaconEvidence: join(outputDir, evidenceName),
    finalizerSummary: join(outputDir, FINALIZATION_ARTIFACT_FILES.finalizerSummary),
    auditReport: resolve(need("audit")),
    proofEvidence: resolve(need("proof-index")),
  };
  const summaryDigest = await sha256File(local.finalizerSummary);
  const locations = publishedLocations(await json(need("publication-index")), manifest.payload.ceremonyId, summaryDigest.sha256);
  const artifacts = {};
  for (const [key, path] of Object.entries(local)) {
    const digest = await sha256File(path);
    const published = locations.get(PUBLISHED_ROLES[key] ?? key);
    if (!published || published.fileName !== basename(path)) throw new Error(`publication index does not list ${basename(path)}`);
    if (published.sha256 !== digest.sha256 || published.byteLength !== digest.byteLength) throw new Error(`published ${basename(path)} differs from the local file`);
    artifacts[key] = { sha256: published.sha256, byteLength: published.byteLength, versionId: published.versionId, url: published.url };
  }
  for (const [key, output] of [["finalZkey", "finalZkey"], ["verificationKey", "verificationKey"], ["solidityVerifier", "solidityVerifier"],
    ["beaconEvidence", "beaconEvidence"], ["sealedImport", "importedSealedZkey"]]) {
    const pinned = summary.outputs[output];
    if (pinned && (artifacts[key].sha256 !== pinned.sha256 || artifacts[key].byteLength !== pinned.byteLength)) throw new Error(`${key} differs from the finalizer summary`);
  }
  const indexPath = need("publication-index");
  if (basename(indexPath) !== FINALIZATION_ARTIFACT_FILES.artifactIndex) throw new Error(`publication index must be named ${FINALIZATION_ARTIFACT_FILES.artifactIndex}`);
  const indexUrl = new URL(need("artifact-index-url"));
  artifacts.artifactIndex = { ...(await sha256File(indexPath)), versionId: indexUrl.searchParams.get("versionId"), url: indexUrl.href };

  const b = summary.beacon;
  const shared = { derivation: b.derivation, numIterationsExp: b.numIterationsExp, beaconHash: b.beaconHashHex, contributionHashBlake2b512: b.contributionHashBlake2b512 };
  const beacon = b.source === "ethereum-block"
    ? { source: b.source, chainId: b.chainId, blockNumber: b.blockNumber, blockHash: b.blockHash, ...shared }
    : { source: b.source, chainHash: b.chainHash, round: b.round, randomness: (await json(local.beaconEvidence)).beacon.randomness, ...shared };
  const payload = {
    schemaVersion: 1, type: "moss.phase2.finalization.v1", ceremonyId: manifest.payload.ceremonyId, manifestSha256,
    sealedCheckpoint: { generation: checkpoint.generation, headSha256: checkpoint.headSha256, headByteLength: checkpoint.headByteLength,
      eventHash: checkpoint.eventHash, eventSequence: checkpoint.eventSequence },
    ordinaryContributions: checkpoint.generation, beaconContributions: 1, beacon,
    completedAt: values["completed-at"] ?? new Date().toISOString(), publicInputs: 20,
    proofTests: { fixtures: proofs.results?.fixtures, validProofs: proofs.results?.validProofs, solidityTests: proofs.results?.solidityTests },
    audit: { transitionsReplayed: audit.counts?.transitionsReplayed, receiptsChecked: audit.checks?.receipts?.items },
    artifacts,
  };
  assertFinalizationRecord(payload, { manifest: manifest.payload, manifestSha256, checkpoint });
  await writeFile(resolve(need("out")), `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx", mode: 0o444 });
  process.stdout.write(`${JSON.stringify({ status: "built", out: resolve(need("out")), ordinaryContributions: payload.ordinaryContributions,
    finalZkeySha256: artifacts.finalZkey.sha256 }, null, 2)}\n`);
}

async function sign(values, need) {
  const { manifest, root, checkpoint } = await authority(values, need);
  const payload = await json(need("record"));
  let privateKey;
  try { privateKey = createPrivateKey(await readFile(need("root-private-key"), "utf8")); }
  catch { fail("could not load the manifest root key as a PKCS#8 PEM private key"); }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("the manifest root key must be Ed25519");
  const envelope = signEnvelope(payload, { keyId: manifest.keyId, privateKey, domain: FINALIZATION_RECORD_DOMAIN });
  // Verify against the out-of-band public key, so a wrong private key fails here, not on the site.
  verifyFinalizationRecord(envelope, manifest, root, checkpoint);
  await writeFile(resolve(need("out")), `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o444 });
  // Public material only. The private key is never printed, logged or copied.
  process.stdout.write(`${JSON.stringify({ status: "signed", out: resolve(need("out")), keyId: envelope.keyId,
    recordSha256: canonicalSha256(FINALIZATION_RECORD_DOMAIN, envelope.payload) }, null, 2)}\n`);
}

async function verify(values, need) {
  const { manifest, root, checkpoint } = await authority(values, need);
  const record = verifyFinalizationRecord(await json(need("record")), manifest, root, checkpoint);
  process.stdout.write(`${JSON.stringify({ status: "verified", ceremonyId: record.ceremonyId,
    ordinaryContributions: record.ordinaryContributions, finalZkeySha256: record.artifacts.finalZkey.sha256 }, null, 2)}\n`);
}

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: Object.fromEntries(OPTIONS.map((name) => [name, { type: "string" }])) });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const { values, positionals } = parsed;
const need = (name) => { if (!values[name]) throw new Error(`missing --${name}`); return values[name]; };
const commands = { build, sign, verify };
if (positionals.length !== 1 || !commands[positionals[0]]) fail("expected one command: build, sign or verify");
try {
  await commands[positionals[0]](values, need);
} catch (error) {
  fail(error?.code === "EEXIST" ? "the output file already exists; refusing to overwrite it" : error instanceof Error ? error.message : String(error));
}
