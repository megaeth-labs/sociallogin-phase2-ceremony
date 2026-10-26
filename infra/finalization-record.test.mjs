import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalSha256, CHECKPOINT_SIGNATURE_DOMAIN, MANIFEST_SIGNATURE_DOMAIN, signEnvelope } from "../packages/protocol/dist/index.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("offline completion record is built from published outputs, root-signed and verified", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moss-finalization-record-test-"));
  try {
    const root = generateKeyPairSync("ed25519");
    const coordinator = generateKeyPairSync("ed25519");
    const manifest = JSON.parse(await readFile(new URL("../ceremonies/company-rehearsal-2026-09-r2/manifest.signed.json", import.meta.url), "utf8")).payload;
    manifest.purpose = "production";
    manifest.coordinatorKeys = [{ keyId: "coordinator-1", algorithm: "Ed25519", publicKeyPem: coordinator.publicKey.export({ type: "spki", format: "pem" }) }];
    const manifestSha256 = canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest);
    const checkpoint = { schemaVersion: 1, type: "moss.phase2.checkpoint.v1", ceremonyId: manifest.ceremonyId, state: "SEALED", revision: 9,
      generation: 3, headSha256: "a".repeat(64), headByteLength: 368_441_500, eventSequence: 6, eventHash: "b".repeat(64),
      issuedAt: "2026-10-02T18:00:01.000Z", expiresAt: "2026-10-02T19:00:01.000Z" };
    const out = join(dir, "finalized");
    await mkdir(out);
    const outputs = { "final.zkey": "final", "verification_key.json": "{}", "Verifier.sol": "contract V {}",
      "sealed-import.zkey": "imported", "ethereum-block-evidence.json": "{\"evidence\":1}\n" };
    for (const [name, text] of Object.entries(outputs)) await writeFile(join(out, name), text);
    const pin = (name) => ({ fileName: name, sha256: sha(outputs[name]), byteLength: Buffer.byteLength(outputs[name]) });
    const summary = { schemaVersion: 1, type: "moss.phase2.final-artifacts.v1", ceremonyId: manifest.ceremonyId,
      authority: { manifestCanonicalPayloadSha256: manifestSha256, sealedEventHash: checkpoint.eventHash, sealedEventSequence: 6, sealedGeneration: 3 },
      inputs: { sealedHead: { sha256: checkpoint.headSha256, byteLength: checkpoint.headByteLength, ordinaryContributionCount: 3 } },
      beacon: { source: "ethereum-block", chainId: 1, blockNumber: manifest.beacon.blockNumber, blockHash: "c".repeat(64), derivation: "MOSS_PHASE2_BEACON_V1",
        beaconHashHex: "d".repeat(64), numIterationsExp: manifest.beacon.numIterationsExp, contributionHashBlake2b512: "e".repeat(128) },
      outputs: { finalZkey: pin("final.zkey"), verificationKey: { ...pin("verification_key.json"), publicInputCount: 20 },
        solidityVerifier: pin("Verifier.sol"), importedSealedZkey: pin("sealed-import.zkey"), beaconEvidence: pin("ethereum-block-evidence.json") } };
    await writeFile(join(out, "final-artifacts.json"), JSON.stringify(summary));
    // Shaped like the outputs of moss-phase2-audit and moss-phase2-proof-test.
    const passed = (items) => ({ result: "passed", items, failures: 0 });
    const audit = JSON.stringify({ schemaVersion: 1, type: "moss.phase2.ceremony-audit.v1", scope: "full", result: "passed",
      ceremonyId: manifest.ceremonyId, manifestSha256,
      sealed: { generation: 3, headSha256: checkpoint.headSha256, headByteLength: checkpoint.headByteLength, eventSequence: 6, eventHash: checkpoint.eventHash },
      counts: { contributions: 3, transitionsReplayed: 3 }, checks: { receipts: passed(3), replay: passed(3) }, failures: [] });
    const digest = (name) => ({ sha256: sha(outputs[name]), byteLength: Buffer.byteLength(outputs[name]) });
    const proofs = JSON.stringify({ schemaVersion: 1, type: "moss.phase2.proof-tests.v1", expectedPublicInputs: 20,
      finalZkey: digest("final.zkey"), verificationKey: digest("verification_key.json"),
      fixtures: [{ witness: { satisfiesR1cs: true }, proofs: [{ verified: true }, { verified: true }],
        rejected: { modifiedPublicInputs: 20, negatedProofA: true } }],
      solidityTests: { verifier: digest("Verifier.sol"), tests: [1, 2, 3, 4].map((n) => ({ name: `t${n}`, passed: true })) },
      results: { fixtures: 1, validProofs: 2, rejectedProofs: 21, solidityTests: 4 } });
    await writeFile(join(dir, "ceremony-audit.json"), audit);
    await writeFile(join(dir, "proof-verification-index.json"), proofs);
    const contents = { ...outputs, "final-artifacts.json": JSON.stringify(summary), "ceremony-audit.json": audit, "proof-verification-index.json": proofs };
    const located = (name, text) => ({ fileName: name, sha256: sha(text), byteLength: Buffer.byteLength(text), versionId: `v${name.length}`,
      url: `https://archive.example/finalization/${manifest.ceremonyId}/sha256/${sha(text)}/${name}?versionId=v${name.length}` });
    const roles = { "final.zkey": "finalZkey", "verification_key.json": "verificationKey", "Verifier.sol": "solidityVerifier",
      "sealed-import.zkey": "importedSealedZkey", "ethereum-block-evidence.json": "beaconEvidence", "final-artifacts.json": "finalizerSummary",
      "ceremony-audit.json": "auditReport", "proof-verification-index.json": "proofEvidence" };
    const index = JSON.stringify({ schemaVersion: 1, type: "moss.phase2.final-publication-index.v1", ceremonyId: manifest.ceremonyId,
      finalizerSummarySha256: sha(contents["final-artifacts.json"]),
      artifacts: Object.fromEntries(Object.entries(contents).map(([name, text]) => [roles[name], located(name, text)])) });
    await writeFile(join(dir, "publication-index.json"), index);
    const indexUrl = located("publication-index.json", index).url;

    const files = {
      "manifest.json": JSON.stringify(signEnvelope(manifest, { keyId: "test-root", privateKey: root.privateKey, domain: MANIFEST_SIGNATURE_DOMAIN })),
      "checkpoint.json": JSON.stringify(signEnvelope(checkpoint, { keyId: "coordinator-1", privateKey: coordinator.privateKey, domain: CHECKPOINT_SIGNATURE_DOMAIN })),
      "root.pub": root.publicKey.export({ type: "spki", format: "pem" }),
      "root.key": root.privateKey.export({ type: "pkcs8", format: "pem" }),
      "other.pub": generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }),
    };
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, { mode: 0o600 });
    const run = (command, extra, rootKey = "root.pub") => spawnSync(process.execPath, ["infra/finalization-record.mjs", command,
      "--manifest", join(dir, "manifest.json"), "--root-public-key", join(dir, rootKey), "--checkpoint", join(dir, "checkpoint.json"), ...extra], { encoding: "utf8" });
    const buildArgs = (target) => ["--finalizer-output", out, "--audit", join(dir, "ceremony-audit.json"),
      "--proof-index", join(dir, "proof-verification-index.json"), "--publication-index", join(dir, "publication-index.json"),
      "--artifact-index-url", indexUrl, "--completed-at", "2026-10-03T00:00:00.000Z", "--out", join(dir, target)];

    const built = run("build", buildArgs("payload.json"));
    assert.equal(built.status, 0, built.stderr);
    const payload = JSON.parse(await readFile(join(dir, "payload.json"), "utf8"));
    assert.equal(payload.type, "moss.phase2.finalization.v1");
    assert.deepEqual(payload.audit, { transitionsReplayed: 3, receiptsChecked: 3 });
    assert.equal(payload.artifacts.artifactIndex.sha256, sha(index));
    assert.equal(payload.artifacts.sealedImport.sha256, sha("imported"));

    const signed = run("sign", ["--record", join(dir, "payload.json"), "--root-private-key", join(dir, "root.key"), "--out", join(dir, "record.json")]);
    assert.equal(signed.status, 0, signed.stderr);
    assert.doesNotMatch(signed.stdout + signed.stderr, /PRIVATE KEY/);
    assert.equal(run("verify", ["--record", join(dir, "record.json")]).status, 0);
    assert.equal(run("verify", ["--record", join(dir, "record.json")], "other.pub").status, 1);
    assert.match(run("sign", ["--record", join(dir, "payload.json"), "--root-private-key", join(dir, "root.key"), "--out", join(dir, "record.json")]).stderr, /already exists/);

    // A local output that differs from what was published is refused.
    await writeFile(join(out, "Verifier.sol"), "contract Changed {}");
    assert.match(run("build", buildArgs("payload-2.json")).stderr, /differs from the local file/);
    await writeFile(join(out, "Verifier.sol"), outputs["Verifier.sol"]);
    // A failed or records-only audit cannot produce a record.
    await writeFile(join(dir, "ceremony-audit.json"), audit.replace('"result":"passed"', '"result":"failed"'));
    assert.match(run("build", buildArgs("payload-3.json")).stderr, /passing full audit/);
    await writeFile(join(dir, "ceremony-audit.json"), audit.replace('"scope":"full"', '"scope":"records"'));
    assert.match(run("build", buildArgs("payload-4.json")).stderr, /passing full audit/);
    await writeFile(join(dir, "ceremony-audit.json"), audit);
    // Proof tests without the Solidity run cannot produce a record.
    const noSolidity = JSON.parse(proofs);
    delete noSolidity.solidityTests;
    await writeFile(join(dir, "proof-verification-index.json"), JSON.stringify(noSolidity));
    assert.match(run("build", buildArgs("payload-5.json")).stderr, /proof tests did not pass/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
