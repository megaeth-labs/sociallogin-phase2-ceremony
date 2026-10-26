import { tmpdir } from "node:os";
import { assertBellmanFixedSections } from "@moss/phase2-zkey-inspect";
import { mkdir, mkdtemp, copyFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalize,
  type ArtifactRef,
  type JsonValue,
} from "@moss/phase2-protocol";

import {
  assertBeaconWasFutureAtSeal,
  assertVerifiedBeaconMatchesSpec,
  decodeBeaconHash,
  serializeDrandEvidence,
} from "./beacon.js";
import { serializeEthereumBlockEvidence } from "./ethereum-beacon.js";
import { loadFinalizationAuthority } from "./authority.js";
import { SnarkjsPhase2Backend } from "./backend.js";
import { hashRegularFile } from "./hashing.js";
import type {
  FinalArtifactSummaryV1,
  FinalizeOptions,
  FinalizerDependencies,
} from "./types.js";

const FINAL_ZKEY_FILE = "final.zkey" as const;
const VERIFICATION_KEY_FILE = "verification_key.json" as const;
const SOLIDITY_VERIFIER_FILE = "Verifier.sol" as const;
const DRAND_EVIDENCE_FILE = "drand-evidence.json" as const;
const ETHEREUM_BLOCK_EVIDENCE_FILE = "ethereum-block-evidence.json" as const;
const SUMMARY_FILE = "final-artifacts.json" as const;
const EXPECTED_PUBLIC_INPUTS = 20 as const;

export async function finalizeCeremony(
  options: FinalizeOptions,
  dependencies: FinalizerDependencies,
): Promise<FinalArtifactSummaryV1> {
  const authority = await loadFinalizationAuthority(options);
  const { manifest, checkpoint } = authority;
  const now = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(now.valueOf())) throw new Error("finalizer clock is invalid");
  if (new Date(checkpoint.issuedAt) < new Date(manifest.schedule.sealsAt)) {
    throw new Error("sealed checkpoint predates the manifest sealing time");
  }
  if (now < new Date(checkpoint.issuedAt)) {
    throw new Error("sealed checkpoint issuance is in the future");
  }
  if (now < new Date(manifest.beacon.expectedAt)) {
    throw new Error("precommitted future beacon is not yet eligible for resolution");
  }

  const backend = dependencies.backend ?? new SnarkjsPhase2Backend();
  const backendMetadata = await backend.metadata();

  const r1cs = await hashRegularFile(options.r1csPath);
  assertArtifactMatches(r1cs, manifest.relation.r1cs, "R1CS");
  const ptau = await hashRegularFile(options.ptauPath, { blake2b512: true });
  assertArtifactMatches(ptau, manifest.relation.ptau, "PTAU");
  if (ptau.blake2b512 !== manifest.relation.ptau.blake2b512) {
    throw new Error("PTAU BLAKE2b-512 does not match the signed manifest");
  }
  const sealedHead = await hashRegularFile(options.sealedHeadPath);
  if (
    sealedHead.sha256 !== checkpoint.headSha256 ||
    sealedHead.byteLength !== checkpoint.headByteLength
  ) {
    throw new Error("sealed head bytes do not match the signed checkpoint");
  }

  let importDirectory: string | undefined;
  let workingHeadPath = options.sealedHeadPath;
  let importedSealed: { sha256: string; byteLength: number } | undefined;
  try {
  if (manifest.verifierPolicy.verificationMethod === "bellman-transition-v1") {
    if (!options.genesisZkeyPath || !backend.importBellman || !backend.exportBellman) throw new Error("Bellman finalization requires original genesis zkey and import/export backend");
    const genesis = await hashRegularFile(options.genesisZkeyPath);
    assertArtifactMatches(genesis, manifest.relation.genesisZkey, "original genesis zkey");
    importDirectory = await mkdtemp(join(tmpdir(), "moss-final-import-"));
    const exported = join(importDirectory, "genesis.params");
    await backend.exportBellman(options.genesisZkeyPath, exported);
    assertArtifactMatches(await hashRegularFile(exported), manifest.relation.genesisBellman!, "Bellman genesis export");
    await assertBellmanFixedSections(exported, options.sealedHeadPath, checkpoint.generation);
    workingHeadPath = join(importDirectory, "sealed-import.zkey");
    await backend.importBellman(options.genesisZkeyPath, options.sealedHeadPath, workingHeadPath);
    assertSameDigests(genesis, await hashRegularFile(options.genesisZkeyPath), "original genesis zkey");
    importedSealed = await hashRegularFile(workingHeadPath);
  }
  const headInspection = await backend.inspectSealedHead(
    workingHeadPath,
    checkpoint.generation,
  );
  if (headInspection.contributionCount !== checkpoint.generation) {
    throw new Error("sealed head contribution count does not match checkpoint generation");
  }
  if (headInspection.beaconContributionCount !== 0) {
    throw new Error("sealed head already contains a beacon contribution");
  }
  if (headInspection.nPublic !== EXPECTED_PUBLIC_INPUTS) {
    throw new Error("sealed head does not have the V4 20-public-input relation");
  }
  if (
    !(await backend.verifyFromR1cs(
      options.r1csPath,
      options.ptauPath,
      workingHeadPath,
    ))
  ) {
    throw new Error("sealed head failed verification against the exact R1CS and PTAU");
  }

  const verifiedBeacon = await dependencies.beaconResolver.resolve(
    manifest.beacon,
  );
  assertVerifiedBeaconMatchesSpec(verifiedBeacon, manifest.beacon);
  assertBeaconWasFutureAtSeal(
    verifiedBeacon,
    manifest.schedule.sealsAt,
  );
  // Evidence is serialized by its own source so a third party can reproduce
  // the hash from the published file alone.
  const evidenceBytes =
    verifiedBeacon.source === "ethereum-block"
      ? Buffer.from(serializeEthereumBlockEvidence(verifiedBeacon.evidence), "utf8")
      : serializeDrandEvidence(verifiedBeacon.evidence);
  const evidenceFileName =
    verifiedBeacon.source === "ethereum-block"
      ? ETHEREUM_BLOCK_EVIDENCE_FILE
      : DRAND_EVIDENCE_FILE;
  const beaconHash = decodeBeaconHash(verifiedBeacon.beaconHashHex);

  let outputCreated = false;
  try {
    await mkdir(options.outputDir, { recursive: false, mode: 0o755 });
    outputCreated = true;
    if (importedSealed) {
      assertSameDigests(importedSealed, await hashRegularFile(workingHeadPath), "imported sealed zkey");
      await copyFile(workingHeadPath, join(options.outputDir, "sealed-import.zkey"), 1);
    }
    const finalZkeyPath = join(options.outputDir, FINAL_ZKEY_FILE);
    const verificationKeyPath = join(
      options.outputDir,
      VERIFICATION_KEY_FILE,
    );
    const solidityVerifierPath = join(
      options.outputDir,
      SOLIDITY_VERIFIER_FILE,
    );
    const drandEvidencePath = join(options.outputDir, evidenceFileName);
    const summaryPath = join(options.outputDir, SUMMARY_FILE);

    await writeFile(drandEvidencePath, evidenceBytes, {
      flag: "wx",
      mode: 0o444,
    });

    const beaconResult = await backend.applyBeacon({
      sealedHeadPath: workingHeadPath,
      finalZkeyPath,
      contributionName: manifest.beacon.contributionName,
      beaconHashHex: verifiedBeacon.beaconHashHex,
      numIterationsExp: manifest.beacon.numIterationsExp,
    });
    assertBlake2b512(
      beaconResult.contributionHashBlake2b512,
      "beacon contribution hash",
    );
    const finalZkeyAfterApply = await hashRegularFile(finalZkeyPath);
    if (
      finalZkeyAfterApply.byteLength >
      manifest.contributionPolicy.maxArtifactByteLength
    ) {
      throw new Error("final zkey exceeds the signed artifact-size policy");
    }

    const append = await backend.verifyBeaconAppend({
      sealedHeadPath: workingHeadPath,
      finalZkeyPath,
      expectedContributionName: manifest.beacon.contributionName,
      expectedContributionHashBlake2b512:
        beaconResult.contributionHashBlake2b512,
      expectedBeaconHash: beaconHash,
      expectedBeaconIterationsExp: manifest.beacon.numIterationsExp,
      maxPredecessorContributions: checkpoint.generation,
    });
    if (
      append.predecessorCount !== checkpoint.generation ||
      append.candidateCount !== checkpoint.generation + 1 ||
      append.contributionIndex !== checkpoint.generation + 1 ||
      append.contributionHashBlake2b512 !==
        beaconResult.contributionHashBlake2b512
    ) {
      throw new Error("final zkey is not exactly the expected single beacon append");
    }

    if (
      !(await backend.verifyFromR1cs(
        options.r1csPath,
        options.ptauPath,
        finalZkeyPath,
      ))
    ) {
      throw new Error("final zkey failed verification against the exact R1CS and PTAU");
    }

    const verificationKey = await backend.exportVerificationKey(finalZkeyPath);
    const verificationKeyJson = canonicalVerificationKey(verificationKey);
    const solidityVerifier = normalizeSolidity(
      await backend.exportSolidityVerifier(finalZkeyPath),
    );
    await writeFile(verificationKeyPath, verificationKeyJson, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await writeFile(solidityVerifierPath, solidityVerifier, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });

    const [r1csAfter, ptauAfter, sealedHeadAfter] = await Promise.all([
      hashRegularFile(options.r1csPath),
      hashRegularFile(options.ptauPath, { blake2b512: true }),
      hashRegularFile(options.sealedHeadPath),
    ]);
    assertSameDigests(r1cs, r1csAfter, "R1CS");
    assertSameDigests(ptau, ptauAfter, "PTAU");
    assertSameDigests(sealedHead, sealedHeadAfter, "sealed head");

    const [
      finalZkey,
      verificationKeyOutput,
      solidityVerifierOutput,
      drandEvidenceOutput,
    ] =
      await Promise.all([
        hashRegularFile(finalZkeyPath),
        hashRegularFile(verificationKeyPath),
        hashRegularFile(solidityVerifierPath),
        hashRegularFile(drandEvidencePath),
      ]);
    assertSameDigests(
      finalZkeyAfterApply,
      finalZkey,
      "final zkey",
    );
    if (drandEvidenceOutput.sha256 !== verifiedBeacon.evidenceSha256) {
      throw new Error("written drand evidence does not match the verified evidence hash");
    }

    const beaconFields = {
      derivation: verifiedBeacon.derivation,
      beaconHashHex: verifiedBeacon.beaconHashHex,
      evidenceSha256: verifiedBeacon.evidenceSha256,
      resolverId: verifiedBeacon.verifier.id,
      resolverVersion: verifiedBeacon.verifier.version,
      numIterationsExp: manifest.beacon.numIterationsExp,
      contributionName: manifest.beacon.contributionName,
      contributionHashBlake2b512: beaconResult.contributionHashBlake2b512,
    } as const;
    // Built per source so the summary records exactly what was precommitted
    // and nothing that does not apply to it.
    const beaconSummary: FinalArtifactSummaryV1["beacon"] =
      verifiedBeacon.source === "ethereum-block"
        ? {
            ...beaconFields,
            source: "ethereum-block",
            chainId: verifiedBeacon.chainId,
            blockNumber: verifiedBeacon.blockNumber,
            blockHash: verifiedBeacon.blockHash,
            verificationMethod: verifiedBeacon.verifier.method,
          }
        : {
            ...beaconFields,
            source: "drand",
            chainHash: verifiedBeacon.chainHash,
            round: verifiedBeacon.round,
            verificationMethod: verifiedBeacon.verifier.method,
          };
    const summary: FinalArtifactSummaryV1 = {
      schemaVersion: 1,
      type: "moss.phase2.final-artifacts.v1",
      ceremonyId: manifest.ceremonyId,
      relationId: manifest.relation.relationId,
      authority: {
        manifestEnvelopeSha256: authority.manifestEnvelopeSha256,
        manifestCanonicalPayloadSha256:
          authority.manifestCanonicalPayloadSha256,
        manifestRootKeyId: authority.manifestRootKeyId,
        manifestRootKeySpkiSha256:
          authority.manifestRootKeySpkiSha256,
        sealedCheckpointEnvelopeSha256:
          authority.checkpointEnvelopeSha256,
        sealedCheckpointSignerKeyId: authority.checkpointSignerKeyId,
        sealedEventHash: checkpoint.eventHash,
        sealedEventSequence: checkpoint.eventSequence,
        sealedGeneration: checkpoint.generation,
      },
      inputs: {
        r1cs: { sha256: r1cs.sha256, byteLength: r1cs.byteLength },
        ptau: {
          sha256: ptau.sha256,
          blake2b512: ptau.blake2b512!,
          byteLength: ptau.byteLength,
        },
        sealedHead: {
          sha256: sealedHead.sha256,
          byteLength: sealedHead.byteLength,
          ordinaryContributionCount: headInspection.contributionCount,
        },
      },
      beacon: beaconSummary,
      toolchain: backendMetadata,
      outputs: {
        ...(importedSealed ? { importedSealedZkey: { fileName: "sealed-import.zkey" as const, ...importedSealed } } : {}),
        finalZkey: {
          fileName: FINAL_ZKEY_FILE,
          sha256: finalZkey.sha256,
          byteLength: finalZkey.byteLength,
        },
        verificationKey: {
          fileName: VERIFICATION_KEY_FILE,
          sha256: verificationKeyOutput.sha256,
          byteLength: verificationKeyOutput.byteLength,
          publicInputCount: EXPECTED_PUBLIC_INPUTS,
        },
        solidityVerifier: {
          fileName: SOLIDITY_VERIFIER_FILE,
          sha256: solidityVerifierOutput.sha256,
          byteLength: solidityVerifierOutput.byteLength,
        },
        beaconEvidence: {
          fileName: evidenceFileName,
          sha256: drandEvidenceOutput.sha256,
          byteLength: drandEvidenceOutput.byteLength,
        },
      },
    };
    await writeFile(
      summaryPath,
      `${canonicalize(summary as unknown as JsonValue)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o644 },
    );
    return summary;
  } catch (error) {
    if (outputCreated) {
      try {
        await rm(options.outputDir, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "finalization failed and partial-output cleanup also failed",
        );
      }
    }
    throw error;
  }
  } finally { if (importDirectory) await rm(importDirectory, { recursive: true, force: true }); }
}

function assertArtifactMatches(
  actual: { sha256: string; byteLength: number },
  expected: ArtifactRef,
  label: string,
): void {
  if (
    actual.sha256 !== expected.sha256 ||
    actual.byteLength !== expected.byteLength
  ) {
    throw new Error(`${label} does not match the signed manifest`);
  }
}

function assertSameDigests(
  before: { sha256: string; byteLength: number; blake2b512?: string },
  after: { sha256: string; byteLength: number; blake2b512?: string },
  label: string,
): void {
  if (
    before.sha256 !== after.sha256 ||
    before.byteLength !== after.byteLength ||
    before.blake2b512 !== after.blake2b512
  ) {
    throw new Error(`${label} changed during finalization`);
  }
}

function canonicalVerificationKey(value: unknown): string {
  if (!isRecord(value)) throw new Error("verification key must be an object");
  if (
    value.protocol !== "groth16" ||
    value.curve !== "bn128" ||
    value.nPublic !== EXPECTED_PUBLIC_INPUTS ||
    !Array.isArray(value.IC) ||
    value.IC.length !== EXPECTED_PUBLIC_INPUTS + 1
  ) {
    throw new Error("verification key does not match Groth16 BN254 with 20 public inputs");
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error("verification key is not JSON serializable");
  }
  if (json === undefined) throw new Error("verification key is not JSON serializable");
  const parsed = JSON.parse(json) as JsonValue;
  return `${canonicalize(parsed)}\n`;
}

function normalizeSolidity(value: string): string {
  if (value.includes("\0")) throw new Error("Solidity verifier contains NUL bytes");
  return value.endsWith("\n") ? value : `${value}\n`;
}

function assertBlake2b512(value: string, label: string): void {
  if (!/^[a-f0-9]{128}$/u.test(value)) {
    throw new Error(`${label} must be lowercase BLAKE2b-512 hex`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
