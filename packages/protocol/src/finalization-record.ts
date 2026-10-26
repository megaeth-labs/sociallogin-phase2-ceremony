// Production completion record. Pure on purpose: the website imports this
// module in the browser (`@moss/phase2-protocol/finalization-record`), so it
// must not pull in node:crypto. Signature checks live in finalization-signing.ts
// for Node and in the site's WebCrypto verifier.
import type { CeremonyManifestV1, HeadCheckpointV1 } from "./types.js";

export const FINALIZATION_RECORD_DOMAIN = "MOSS_PHASE2_FINALIZATION_V1";
export const FINALIZATION_RECORD_TYPE = "moss.phase2.finalization.v1";
export const FINALIZATION_PUBLIC_INPUTS = 20;

/** Record key → the file name the finalizer, audit and proof tools emit. */
export const FINALIZATION_ARTIFACT_FILES = {
  finalZkey: "final.zkey",
  verificationKey: "verification_key.json",
  solidityVerifier: "Verifier.sol",
  sealedImport: "sealed-import.zkey",
  beaconEvidence: ["ethereum-block-evidence.json", "drand-evidence.json"],
  finalizerSummary: "final-artifacts.json",
  auditReport: "ceremony-audit.json",
  proofEvidence: "proof-verification-index.json",
  artifactIndex: "publication-index.json",
} as const;
export type FinalizationArtifactKey = keyof typeof FINALIZATION_ARTIFACT_FILES;
export const FINALIZATION_ARTIFACT_KEYS = Object.keys(FINALIZATION_ARTIFACT_FILES) as FinalizationArtifactKey[];

/** An immutable, hash-addressed object version. */
export interface PublishedArtifactV1 {
  sha256: string;
  byteLength: number;
  versionId: string;
  url: string;
}

export type FinalizationBeaconV1 = {
  derivation: "MOSS_PHASE2_BEACON_V1";
  numIterationsExp: number;
  /** The 32 bytes given to the beacon contribution, lowercase hex. */
  beaconHash: string;
  /** snarkjs BLAKE2b-512 hash of the appended beacon contribution. */
  contributionHashBlake2b512: string;
} & (
  | { source: "ethereum-block"; chainId: number; blockNumber: number; blockHash: string }
  | { source: "drand"; chainHash: string; round: number; randomness: string }
);

export interface FinalizationRecordV1 {
  schemaVersion: 1;
  type: typeof FINALIZATION_RECORD_TYPE;
  ceremonyId: string;
  manifestSha256: string;
  sealedCheckpoint: {
    generation: number;
    headSha256: string;
    headByteLength: number;
    eventHash: string;
    eventSequence: number;
  };
  ordinaryContributions: number;
  beaconContributions: 1;
  beacon: FinalizationBeaconV1;
  completedAt: string;
  publicInputs: typeof FINALIZATION_PUBLIC_INPUTS;
  proofTests: { fixtures: number; validProofs: number; solidityTests: number };
  audit: { transitionsReplayed: number; receiptsChecked: number };
  /** sealedImport is present exactly when the manifest uses Bellman transitions. */
  artifacts: Partial<Record<FinalizationArtifactKey, PublishedArtifactV1>> &
    Record<Exclude<FinalizationArtifactKey, "sealedImport">, PublishedArtifactV1>;
}

export interface FinalizationRecordContext {
  manifest: CeremonyManifestV1;
  /** Canonical payload hash under MOSS_PHASE2_MANIFEST_PAYLOAD_V1. */
  manifestSha256: string;
  /** The live, signature-checked coordinator checkpoint. */
  checkpoint: Pick<HeadCheckpointV1, "ceremonyId" | "state" | "generation" | "headSha256" | "headByteLength" | "eventHash" | "eventSequence">;
}

const HEX32 = /^[a-f0-9]{64}$/u;
const HEX64 = /^[a-f0-9]{128}$/u;
const VERSION_ID = /^[A-Za-z0-9._-]{1,1024}$/u;

function fail(message: string): never {
  throw new Error(`finalization record: ${message}`);
}
function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) fail(`${label} has unexpected or missing fields`);
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive integer`);
  return value as number;
}
function hex(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} must be lowercase hex`);
  return value;
}

/** An artifact URL must name one immutable, hash-addressed object version. */
export function assertPublishedArtifact(value: unknown, label: string): asserts value is PublishedArtifactV1 {
  exactKeys(value, ["sha256", "byteLength", "versionId", "url"], label);
  hex(value.sha256, HEX32, `${label}.sha256`);
  positive(value.byteLength, `${label}.byteLength`);
  if (typeof value.versionId !== "string" || !VERSION_ID.test(value.versionId)) fail(`${label}.versionId is invalid`);
  let url: URL;
  try { url = new URL(value.url as string); } catch { fail(`${label}.url is not a URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.searchParams.get("versionId") !== value.versionId || [...url.searchParams.keys()].length !== 1 ||
      !url.pathname.includes(`/sha256/${value.sha256}/`))
    fail(`${label} download is not immutable and hash-pinned`);
}

/**
 * Structural validation plus binding to the signed manifest and the live
 * sealed checkpoint. Call only on a payload whose root signature is verified.
 */
export function assertFinalizationRecord(record: unknown, context: FinalizationRecordContext): FinalizationRecordV1 {
  const { manifest, manifestSha256, checkpoint } = context;
  if (manifest.purpose === "rehearsal") fail("a production record cannot complete a rehearsal");
  exactKeys(record, ["schemaVersion", "type", "ceremonyId", "manifestSha256", "sealedCheckpoint", "ordinaryContributions",
    "beaconContributions", "beacon", "completedAt", "publicInputs", "proofTests", "audit", "artifacts"], "payload");
  if (record.schemaVersion !== 1 || record.type !== FINALIZATION_RECORD_TYPE) fail("unsupported schema");
  if (record.ceremonyId !== manifest.ceremonyId || record.manifestSha256 !== manifestSha256) fail("belongs to a different manifest");

  const sealed = record.sealedCheckpoint;
  exactKeys(sealed, ["generation", "headSha256", "headByteLength", "eventHash", "eventSequence"], "sealedCheckpoint");
  if (checkpoint.ceremonyId !== manifest.ceremonyId || !["SEALED", "FINALIZED"].includes(checkpoint.state) ||
      sealed.generation !== checkpoint.generation || sealed.headSha256 !== checkpoint.headSha256 ||
      sealed.headByteLength !== checkpoint.headByteLength || sealed.eventHash !== checkpoint.eventHash ||
      sealed.eventSequence !== checkpoint.eventSequence)
    fail("does not match the sealed checkpoint");
  const ordinary = positive(record.ordinaryContributions, "ordinaryContributions");
  if (ordinary !== sealed.generation || ordinary > manifest.contributionPolicy.maximumContributions) fail("contribution count does not match the sealed chain");
  if (record.beaconContributions !== 1) fail("exactly one beacon contribution is required");

  const beacon = record.beacon as Record<string, unknown>;
  const spec = manifest.beacon;
  const shared = ["source", "derivation", "numIterationsExp", "beaconHash", "contributionHashBlake2b512"];
  if (spec.source === "ethereum-block") {
    exactKeys(beacon, [...shared, "chainId", "blockNumber", "blockHash"], "beacon");
    if (beacon.source !== spec.source || beacon.chainId !== spec.chainId || beacon.blockNumber !== spec.blockNumber) fail("beacon differs from the manifest commitment");
    hex(beacon.blockHash, HEX32, "beacon.blockHash");
  } else {
    exactKeys(beacon, [...shared, "chainHash", "round", "randomness"], "beacon");
    if (beacon.source !== spec.source || beacon.chainHash !== spec.chainHash || beacon.round !== spec.round) fail("beacon differs from the manifest commitment");
    hex(beacon.randomness, HEX32, "beacon.randomness");
  }
  if (beacon.derivation !== "MOSS_PHASE2_BEACON_V1" || beacon.derivation !== spec.derivation || beacon.numIterationsExp !== spec.numIterationsExp)
    fail("beacon derivation differs from the manifest commitment");
  hex(beacon.beaconHash, HEX32, "beacon.beaconHash");
  hex(beacon.contributionHashBlake2b512, HEX64, "beacon.contributionHashBlake2b512");

  if (typeof record.completedAt !== "string" || !Number.isFinite(Date.parse(record.completedAt)) ||
      new Date(record.completedAt).toISOString() !== record.completedAt) fail("completedAt must be canonical ISO-8601");
  if (Date.parse(record.completedAt) < Date.parse(manifest.schedule.sealsAt)) fail("completedAt predates sealing");
  if (record.publicInputs !== FINALIZATION_PUBLIC_INPUTS) fail("the relation has 20 public inputs");

  exactKeys(record.proofTests, ["fixtures", "validProofs", "solidityTests"], "proofTests");
  positive(record.proofTests.fixtures, "proofTests.fixtures");
  positive(record.proofTests.validProofs, "proofTests.validProofs");
  positive(record.proofTests.solidityTests, "proofTests.solidityTests");
  exactKeys(record.audit, ["transitionsReplayed", "receiptsChecked"], "audit");
  if (record.audit.transitionsReplayed !== ordinary || record.audit.receiptsChecked !== ordinary)
    fail("the audit must replay every transition and check every receipt");

  const bellman = manifest.verifierPolicy.verificationMethod === "bellman-transition-v1";
  const keys = FINALIZATION_ARTIFACT_KEYS.filter((key) => key !== "sealedImport" || bellman);
  exactKeys(record.artifacts, keys, "artifacts");
  for (const key of keys) assertPublishedArtifact(record.artifacts[key], `artifacts.${key}`);
  return record as unknown as FinalizationRecordV1;
}
