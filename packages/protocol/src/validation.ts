import { createPublicKey } from "node:crypto";

import type {
  ArtifactRef,
  CeremonyManifestV1,
  ContributionReceiptV1,
  HeadCheckpointV1,
  VerificationReportV1,
  VerifierPolicy,
  VerifierPolicyEvaluation,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const BLAKE2B512 = /^[a-f0-9]{128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export function assertSha256(value: string, label = "sha256"): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be 32-byte lowercase hex without 0x`);
}

export function assertBlake2b512(value: string, label = "blake2b512"): void {
  if (!BLAKE2B512.test(value)) throw new Error(`${label} must be 64-byte lowercase hex without 0x`);
}

export function assertUuid(value: string, label = "id"): void {
  if (!UUID.test(value)) throw new Error(`${label} must be a canonical UUID`);
}

export function assertSafeId(value: string, label = "id"): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
}

export function assertIsoDate(value: string, label: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw new Error(`${label} must be canonical ISO-8601`);
  }
}

export function assertArtifactRef(value: ArtifactRef, label: string, options: { production?: boolean } = {}): void {
  assertSha256(value.sha256, `${label}.sha256`);
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength <= 0) {
    throw new Error(`${label}.byteLength must be a positive safe integer`);
  }
  if (!Array.isArray(value.urls) || value.urls.length === 0) throw new Error(`${label}.urls must not be empty`);
  for (const url of value.urls) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${label}.urls contains an unsupported URL`);
    if (options.production && parsed.protocol !== "https:") throw new Error(`${label}.urls must use HTTPS in production`);
    if (parsed.username || parsed.password || parsed.hash) throw new Error(`${label}.urls contains credentials or a fragment`);
  }
}

export function assertVerifierPolicy(policy: VerifierPolicy, options: { production: boolean }): void {
  if (policy.verificationMethod !== undefined && policy.verificationMethod !== "snarkjs-zkey-v1" && policy.verificationMethod !== "bellman-transition-v1") throw new Error("unsupported verification method");
  const unique = new Set(policy.operatorKeyIds);
  if (unique.size !== policy.operatorKeyIds.length || unique.size === 0) throw new Error("verifier policy operators must be nonempty and unique");
  for (const id of unique) assertSafeId(id, "verifier operator key id");
  if (!Number.isSafeInteger(policy.requiredOperators) || policy.requiredOperators < 1 || policy.requiredOperators > unique.size) {
    throw new Error("verifier policy requiredOperators is invalid");
  }
  if (!Number.isSafeInteger(policy.passesPerOperator) || policy.passesPerOperator < 1) {
    throw new Error("verifier policy passesPerOperator is invalid");
  }
  // One operator is allowed: the signed manifest states how many verify, and
  // clients show it. Every listed operator must still approve.
  if (options.production && policy.requiredOperators !== policy.operatorKeyIds.length) {
    throw new Error("production verifier policy requires unanimity from every listed operator");
  }
}

export function evaluateVerifierPolicy(
  policy: VerifierPolicy,
  reports: readonly VerificationReportV1[],
): VerifierPolicyEvaluation {
  const validPasses = new Map<string, Set<number>>();
  for (const report of reports) {
    if ((report.verificationMethod ?? "snarkjs-zkey-v1") !== (policy.verificationMethod ?? "snarkjs-zkey-v1")) continue;
    if (report.result !== "valid" || !verificationChecksSatisfied(report)) continue;
    if (report.observedContributionName !== (report.verificationMethod === "bellman-transition-v1" ? null : report.expectedContributionName)
      || report.observedContributionHashBlake2b512 !== report.expectedContributionHashBlake2b512
      || report.observedContributionIndex !== report.expectedContributionIndex) continue;
    if (!policy.operatorKeyIds.includes(report.operatorKeyId)) continue;
    let passes = validPasses.get(report.operatorKeyId);
    if (!passes) {
      passes = new Set();
      validPasses.set(report.operatorKeyId, passes);
    }
    passes.add(report.passNumber);
  }
  const acceptedOperators = [...validPasses]
    .filter(([, passes]) => passes.size >= policy.passesPerOperator)
    .map(([operator]) => operator)
    .sort();
  const missingPasses: Record<string, number> = {};
  for (const operator of policy.operatorKeyIds) {
    const count = validPasses.get(operator)?.size ?? 0;
    if (count < policy.passesPerOperator) missingPasses[operator] = policy.passesPerOperator - count;
  }
  return {
    satisfied: acceptedOperators.length >= policy.requiredOperators,
    acceptedOperators,
    missingOperators: Math.max(0, policy.requiredOperators - acceptedOperators.length),
    missingPasses,
  };
}

export function assertManifest(manifest: CeremonyManifestV1, options: { production: boolean; allowRehearsal?: boolean }): void {
  if (manifest.purpose !== undefined && manifest.purpose !== "production" && manifest.purpose !== "rehearsal") {
    throw new Error("manifest purpose is invalid");
  }
  if (manifest.purpose === "rehearsal" && !options.allowRehearsal) {
    throw new Error("rehearsal manifest requires explicit opt-in; it is not a production ceremony");
  }
  if (options.allowRehearsal && manifest.purpose !== "rehearsal") {
    throw new Error("rehearsal mode requires a manifest signed for rehearsal");
  }
  assertExactKeys(manifest as unknown as Record<string, unknown>, ["schemaVersion", ...(manifest.operationalPolicy === undefined ? [] : ["operationalPolicy"]), ...(manifest.purpose === undefined ? [] : ["purpose"]), ...(manifest.publication === undefined ? [] : ["publication"]), ...(manifest.primaryPublication === undefined ? [] : ["primaryPublication"]), "ceremonyId", "slug", "relation", "schedule", "beacon", "coordinatorKeys", "verifierKeys", "verifierPolicy", "contributionPolicy", "webRelease", "cliReleases"], "manifest");
  if (manifest.operationalPolicy !== undefined) {
    const policy = manifest.operationalPolicy;
    assertExactKeys(policy as unknown as Record<string, unknown>, ["minHeartbeatGraceSeconds", "maxHeartbeatGraceSeconds", "allowWebReleaseUpdates", ...(policy?.allowCliReleaseUpdates === undefined ? [] : ["allowCliReleaseUpdates"])], "operationalPolicy");
    if (!Number.isSafeInteger(policy.minHeartbeatGraceSeconds) || !Number.isSafeInteger(policy.maxHeartbeatGraceSeconds)
      || policy.minHeartbeatGraceSeconds < 30 || policy.maxHeartbeatGraceSeconds > 600
      || policy.minHeartbeatGraceSeconds > policy.maxHeartbeatGraceSeconds
      || typeof policy.allowWebReleaseUpdates !== "boolean"
      || (policy.allowCliReleaseUpdates !== undefined && typeof policy.allowCliReleaseUpdates !== "boolean")
      || manifest.contributionPolicy.lease.heartbeatSeconds < policy.minHeartbeatGraceSeconds
      || manifest.contributionPolicy.lease.heartbeatSeconds > policy.maxHeartbeatGraceSeconds
      || policy.maxHeartbeatGraceSeconds * 2 >= manifest.contributionPolicy.lease.absoluteSeconds) {
      throw new Error("Operational policy bounds are invalid");
    }
  }
  if (manifest.primaryPublication !== undefined) {
    if (manifest.publication !== undefined) throw new Error("primary publication excludes witness policy");
    assertExactKeys(manifest.primaryPublication as unknown as Record<string, unknown>, ["archiveBaseUrl"], "primaryPublication");
    const url = new URL(manifest.primaryPublication.archiveBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("primary archive must be a credential-free HTTPS origin");
    }
  }
  if (manifest.publication !== undefined) {
    assertExactKeys(manifest.publication as unknown as Record<string, unknown>, ["witness", "endpoint"], "publication");
    assertExactKeys(manifest.publication.witness as unknown as Record<string, unknown>, ["keyId", "algorithm", "publicKeyPem"], "publication.witness");
    const witnessKey = assertEd25519PublicKey(manifest.publication.witness);
    if ([...manifest.coordinatorKeys, ...manifest.verifierKeys].some((key) => assertEd25519PublicKey(key) === witnessKey)) {
      throw new Error("publication witness must have a distinct public key");
    }
    const endpoint = new URL(manifest.publication.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error("publication endpoint must use credential-free HTTPS");
    }
  }
  assertExactKeys(manifest.relation as unknown as Record<string, unknown>, ["profile", "relationId", "verifierVersion", "proofSystem", "curve", "sourceRepository", "sourceCommit", "sourceClosureSha256", "circomVersion", "snarkjsVersion", "r1cs", "ptau", "genesisZkey", ...(manifest.relation.genesisBellman === undefined ? [] : ["genesisBellman"])], "manifest.relation");
  assertExactKeys(manifest.schedule as unknown as Record<string, unknown>, ["opensAt", "sealsAt"], "manifest.schedule");
  assertExactKeys(
    manifest.beacon as unknown as Record<string, unknown>,
    manifest.beacon.source === "ethereum-block"
      ? ["source", "chainId", "blockNumber", "expectedAt", "derivation", "numIterationsExp", "contributionName"]
      : ["source", "chainHash", "round", "expectedAt", "derivation", "numIterationsExp", "contributionName"],
    "manifest.beacon",
  );
  assertExactKeys(manifest.verifierPolicy as unknown as Record<string, unknown>, ["operatorKeyIds", "requiredOperators", "passesPerOperator", ...(manifest.verifierPolicy.verificationMethod === undefined ? [] : ["verificationMethod"])], "manifest.verifierPolicy");
  assertExactKeys(manifest.contributionPolicy as unknown as Record<string, unknown>, ["targetContributions", "maximumContributions", "maxArtifactByteLength", "requirePinnedClientRelease", "lease", "verifierJobSeconds", "verifierMaxAttempts"], "manifest.contributionPolicy");
  assertExactKeys(manifest.contributionPolicy.lease as unknown as Record<string, unknown>, ["offerSeconds", "absoluteSeconds", "heartbeatSeconds"], "manifest.contributionPolicy.lease");
  if (manifest.schemaVersion !== 1) throw new Error("manifest schemaVersion must be 1");
  assertUuid(manifest.ceremonyId, "ceremonyId");
  assertSafeId(manifest.slug, "slug");
  if (manifest.relation.profile !== "google-rs256-zksync-v3"
    || manifest.relation.relationId !== "google-rs256-zksync-v3-groth16-bn254-2"
    || manifest.relation.verifierVersion !== 4
    || manifest.relation.proofSystem !== "groth16"
    || manifest.relation.curve !== "bn254"
    || manifest.relation.circomVersion !== "2.2.3"
    || manifest.relation.snarkjsVersion !== "0.7.6") {
    throw new Error("manifest relation tuple is unsupported");
  }
  assertSha256(manifest.relation.sourceClosureSha256, "sourceClosureSha256");
  assertExactKeys(manifest.relation.r1cs as unknown as Record<string, unknown>, ["sha256", "byteLength", "urls"], "r1cs");
  assertExactKeys(manifest.relation.ptau as unknown as Record<string, unknown>, ["sha256", "byteLength", "urls", "blake2b512"], "ptau");
  assertExactKeys(manifest.relation.genesisZkey as unknown as Record<string, unknown>, ["sha256", "byteLength", "urls"], "genesisZkey");
  assertArtifactRef(manifest.relation.r1cs, "r1cs", options);
  assertArtifactRef(manifest.relation.ptau, "ptau", options);
  assertArtifactRef(manifest.relation.genesisZkey, "genesisZkey", options);
  assertBlake2b512(manifest.relation.ptau.blake2b512, "ptau.blake2b512");
  if (manifest.verifierPolicy.verificationMethod === "bellman-transition-v1") {
    if (!manifest.relation.genesisBellman) throw new Error("Bellman policy requires a pinned Bellman genesis");
    assertExactKeys(manifest.relation.genesisBellman as unknown as Record<string, unknown>, ["sha256", "byteLength", "urls"], "genesisBellman");
    assertArtifactRef(manifest.relation.genesisBellman, "genesisBellman", options);
    if (manifest.relation.genesisBellman.sha256 === manifest.relation.genesisZkey.sha256) throw new Error("Bellman genesis must be independently pinned");
  } else if (manifest.relation.genesisBellman !== undefined) throw new Error("Bellman genesis requires Bellman verification policy");
  if (options.production) {
    const repository = new URL(manifest.relation.sourceRepository);
    if (repository.protocol !== "https:" || repository.username || repository.password || repository.hash) {
      throw new Error("production source repository must be a credential-free HTTPS URL");
    }
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(manifest.relation.sourceCommit)) {
      throw new Error("production source commit must be a full Git object ID");
    }
  }
  assertIsoDate(manifest.schedule.opensAt, "schedule.opensAt");
  assertIsoDate(manifest.schedule.sealsAt, "schedule.sealsAt");
  if (manifest.schedule.opensAt >= manifest.schedule.sealsAt) throw new Error("manifest schedule must open before it seals");
  assertVerifierPolicy(manifest.verifierPolicy, options);
  const contribution = manifest.contributionPolicy;
  if (!contribution || !Number.isSafeInteger(contribution.targetContributions)
    || contribution.targetContributions < 1
    || !Number.isSafeInteger(contribution.maximumContributions)
    || contribution.maximumContributions !== contribution.targetContributions
    || contribution.maximumContributions > 1_000_000) {
    throw new Error("manifest contribution count policy is invalid");
  }
  if (!Number.isSafeInteger(contribution.maxArtifactByteLength)
    || contribution.maxArtifactByteLength < manifest.relation.genesisZkey.byteLength
    || contribution.maxArtifactByteLength > 1_000_000_000_000) {
    throw new Error("manifest maximum artifact byte length is invalid");
  }
  if (typeof contribution.requirePinnedClientRelease !== "boolean") {
    throw new Error("manifest client release policy is invalid");
  }
  const lease = contribution.lease;
  if (!lease || !Number.isSafeInteger(lease.offerSeconds) || lease.offerSeconds < 30 || lease.offerSeconds > 3_600
    || !Number.isSafeInteger(lease.absoluteSeconds) || lease.absoluteSeconds <= lease.offerSeconds || lease.absoluteSeconds > 86_400
    || !Number.isSafeInteger(lease.heartbeatSeconds) || lease.heartbeatSeconds < 5
    || lease.heartbeatSeconds * 2 >= lease.absoluteSeconds) {
    throw new Error("manifest contribution lease policy is invalid");
  }
  if (!Number.isSafeInteger(contribution.verifierJobSeconds)
    || contribution.verifierJobSeconds < 300 || contribution.verifierJobSeconds > 86_400) {
    throw new Error("manifest verifier job duration is invalid");
  }
  if (!Number.isSafeInteger(contribution.verifierMaxAttempts)
    || contribution.verifierMaxAttempts < 1 || contribution.verifierMaxAttempts > 10) {
    throw new Error("manifest verifier retry policy is invalid");
  }
  if (!Array.isArray(manifest.coordinatorKeys) || manifest.coordinatorKeys.length !== 1
    || !Array.isArray(manifest.verifierKeys) || manifest.verifierKeys.length === 0) {
    throw new Error(
      "manifest must freeze exactly one coordinator key and at least one verifier key",
    );
  }
  const allKeyIds = [...manifest.coordinatorKeys, ...manifest.verifierKeys].map((key) => key.keyId);
  if (new Set(allKeyIds).size !== allKeyIds.length) throw new Error("manifest key IDs must be globally unique");
  const encodedKeys = new Set<string>();
  for (const key of manifest.coordinatorKeys) {
    assertExactKeys(key as unknown as Record<string, unknown>, ["keyId", "algorithm", "publicKeyPem"], `coordinator key ${key.keyId}`);
    const encoded = assertEd25519PublicKey(key);
    if (encodedKeys.has(encoded)) throw new Error("coordinator public keys must be unique");
    encodedKeys.add(encoded);
  }
  const verifierKeyIds = new Set(manifest.verifierKeys.map((key) => key.keyId));
  for (const key of manifest.verifierKeys) {
    assertExactKeys(key as unknown as Record<string, unknown>, ["keyId", "algorithm", "publicKeyPem", "verifierImageDigest"], `verifier key ${key.keyId}`);
    const encoded = assertEd25519PublicKey(key);
    if (encodedKeys.has(encoded)) throw new Error("coordinator and verifier keys must be cryptographically distinct");
    if (encodedKeys.has(`verifier:${encoded}`)) throw new Error("verifier public keys must be unique");
    encodedKeys.add(`verifier:${encoded}`);
    if (!/^sha256:[a-f0-9]{64}$/u.test(key.verifierImageDigest)) {
      throw new Error(`manifest verifier image for ${key.keyId} is not SHA-256 pinned`);
    }
  }
  for (const id of manifest.verifierPolicy.operatorKeyIds) {
    if (!verifierKeyIds.has(id)) throw new Error(`manifest is missing verifier key ${id}`);
  }
  // Keep the signed coordinator policy inside the range the offline finalizer
  // is willing to execute. Accepting a larger value here would let an epoch
  // open successfully but become impossible to finalize with its pinned tool.
  if (manifest.beacon.numIterationsExp < 10 || manifest.beacon.numIterationsExp > 32) {
    throw new Error("beacon numIterationsExp must be between 10 and 32");
  }
  if (manifest.beacon.derivation !== "MOSS_PHASE2_BEACON_V1"
    || !/^[\x20-\x7e]{1,64}$/u.test(manifest.beacon.contributionName)) {
    throw new Error("manifest beacon specification is invalid");
  }
  if (manifest.beacon.source === "drand") {
    if (!Number.isSafeInteger(manifest.beacon.round) || manifest.beacon.round < 1) {
      throw new Error("manifest beacon specification is invalid");
    }
    if (options.production && !/^[a-f0-9]{64}$/u.test(manifest.beacon.chainHash)) {
      throw new Error("production drand chain hash must be 32-byte lowercase hex");
    }
  } else if (manifest.beacon.source === "ethereum-block") {
    if (!Number.isSafeInteger(manifest.beacon.chainId) || manifest.beacon.chainId < 1) {
      throw new Error("manifest beacon specification is invalid");
    }
    if (!Number.isSafeInteger(manifest.beacon.blockNumber) || manifest.beacon.blockNumber < 1) {
      throw new Error("manifest beacon specification is invalid");
    }
    // A single sequencer, or any chain where one party reliably produces the
    // target block, can grind the value at will and is therefore never an
    // acceptable beacon for a ceremony that party could also coordinate.
    // Mainnet is the only chain pinned here.
    if (options.production && manifest.beacon.chainId !== 1) {
      throw new Error("production ethereum-block beacon must use mainnet chain id 1");
    }
  } else {
    throw new Error("manifest beacon specification is invalid");
  }
  assertIsoDate(manifest.beacon.expectedAt, "beacon.expectedAt");
  if (manifest.schedule.sealsAt >= manifest.beacon.expectedAt) throw new Error("ceremony must seal before beacon availability");
  assertRelease(manifest.webRelease, "webRelease", options);
  if (!Array.isArray(manifest.cliReleases) || manifest.cliReleases.length === 0) throw new Error("manifest CLI releases must not be empty");
  const releaseHashes = new Set([manifest.webRelease.sha256]);
  for (const [index, release] of manifest.cliReleases.entries()) {
    assertRelease(release, `cliReleases[${index}]`, options);
    if (releaseHashes.has(release.sha256)) throw new Error("manifest release artifact hashes must be unique");
    releaseHashes.add(release.sha256);
  }
}

export function assertRelease(
  release: import("./types.js").ReleaseRef,
  label: string,
  options: { production: boolean },
): void {
  assertExactKeys(release as unknown as Record<string, unknown>, ["sha256", "byteLength", "urls", "sourceCommit"], label);
  assertArtifactRef(release, label, options);
  if (options.production && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(release.sourceCommit)) {
    throw new Error(`${label}.sourceCommit must be a full Git object ID`);
  }
}

function assertEd25519PublicKey(key: { keyId: string; algorithm: string; publicKeyPem: string }): string {
  assertSafeId(key.keyId, "manifest key id");
  if (key.algorithm !== "Ed25519" || !key.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n")) {
    throw new Error(`manifest key ${key.keyId} is not an Ed25519 public key`);
  }
  let parsed;
  try { parsed = createPublicKey(key.publicKeyPem); }
  catch { throw new Error(`manifest key ${key.keyId} PEM is invalid`); }
  if (parsed.asymmetricKeyType !== "ed25519") throw new Error(`manifest key ${key.keyId} is not Ed25519`);
  return Buffer.from(parsed.export({ type: "spki", format: "der" })).toString("base64");
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
}

export function assertVerificationReport(value: VerificationReportV1, options: { production: boolean }): void {
  const reportKeys = [...(value.verificationMethod === undefined ? [] : ["verificationMethod"]), "schemaVersion", "type", "ceremonyId", "submissionId", "jobId", "jobAttempt", "predecessorSha256", "candidateSha256", "genesisSha256", "expectedContributionName", "expectedContributionHashBlake2b512", "expectedContributionIndex", "observedContributionName", "observedContributionHashBlake2b512", "observedContributionIndex", "operatorKeyId", "verifierImageDigest", "snarkjsVersion", "passNumber", "checks", "result", "startedAt", "completedAt",
    ...(value.errorCode === undefined ? [] : ["errorCode"])];
  assertExactKeys(value as unknown as Record<string, unknown>, reportKeys, "verification report");
  if (value.schemaVersion !== 1 || value.type !== "moss.phase2.verification-report.v1") {
    throw new Error("verification report type is unsupported");
  }
  assertUuid(value.ceremonyId, "ceremonyId");
  assertUuid(value.submissionId, "submissionId");
  assertUuid(value.jobId, "jobId");
  if (!Number.isSafeInteger(value.jobAttempt) || value.jobAttempt < 1) {
    throw new Error("verification report job attempt is invalid");
  }
  assertSha256(value.predecessorSha256, "predecessorSha256");
  assertSha256(value.candidateSha256, "candidateSha256");
  assertSha256(value.genesisSha256, "genesisSha256");
  assertContributionName(value.expectedContributionName, "expectedContributionName");
  assertBlake2b512(value.expectedContributionHashBlake2b512, "expectedContributionHashBlake2b512");
  assertContributionIndex(value.expectedContributionIndex, "expectedContributionIndex");
  if (value.observedContributionName !== null) {
    assertObservedContributionName(value.observedContributionName);
  }
  if (value.observedContributionHashBlake2b512 !== null) {
    assertBlake2b512(value.observedContributionHashBlake2b512, "observedContributionHashBlake2b512");
  }
  if (value.observedContributionIndex !== null) {
    assertContributionIndex(value.observedContributionIndex, "observedContributionIndex");
  }
  assertSafeId(value.operatorKeyId, "operatorKeyId");
  if (options.production && !/^sha256:[a-f0-9]{64}$/u.test(value.verifierImageDigest)) {
    throw new Error("production verification report image is not SHA-256 pinned");
  }
  if (value.snarkjsVersion !== "0.7.6") throw new Error("verification report snarkjs version is unsupported");
  if (!Number.isSafeInteger(value.passNumber) || value.passNumber < 1) throw new Error("verification report pass number is invalid");
  if (value.verificationMethod !== undefined && value.verificationMethod !== "snarkjs-zkey-v1" && value.verificationMethod !== "bellman-transition-v1") throw new Error("unsupported report verification method");
  const expectedChecks = [...(value.verificationMethod === "bellman-transition-v1" ? ["bellmanTransition"] : []), "objectHash", "framing", "exactPrefix", "exactlyOneContribution", "contributionMetadata", "contributionHash", "verifyFromInit"];
  if (!value.checks || Object.keys(value.checks).sort().join(",") !== expectedChecks.sort().join(",")
    || Object.values(value.checks).some((check) => typeof check !== "boolean")) {
    throw new Error("verification report checks are malformed");
  }
  if (value.result !== "valid" && value.result !== "invalid" && value.result !== "error") throw new Error("verification report result is invalid");
  if (value.result === "valid" && (!verificationChecksSatisfied(value) || value.errorCode !== undefined)) {
    throw new Error("valid verification report is internally inconsistent");
  }
  if (value.result === "valid" && (
    value.observedContributionName !== (value.verificationMethod === "bellman-transition-v1" ? null : value.expectedContributionName)
    || value.observedContributionHashBlake2b512 !== value.expectedContributionHashBlake2b512
    || value.observedContributionIndex !== value.expectedContributionIndex
  )) {
    throw new Error("valid verification report contribution metadata does not match its expectation");
  }
  if (value.result !== "valid" && (typeof value.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.errorCode))) {
    throw new Error("failed verification report must include a stable error code");
  }
  assertIsoDate(value.startedAt, "startedAt");
  assertIsoDate(value.completedAt, "completedAt");
  if (value.startedAt > value.completedAt) throw new Error("verification report completes before it starts");
}

function assertContributionName(value: string, label: string): void {
  if (typeof value !== "string" || !/^[\x20-\x7e]{1,64}$/u.test(value)) {
    throw new Error(`${label} must be 1-64 printable ASCII bytes`);
  }
}

function assertObservedContributionName(value: string): void {
  if (typeof value !== "string"
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > 255) {
    throw new Error("observedContributionName is not valid bounded zkey metadata");
  }
}

function assertContributionIndex(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(`${label} must be a positive safe contribution index`);
  }
}

export function assertCheckpoint(value: HeadCheckpointV1): void {
  if (value.schemaVersion !== 1 || value.type !== "moss.phase2.checkpoint.v1") throw new Error("checkpoint type is unsupported");
  assertUuid(value.ceremonyId, "ceremonyId");
  assertSha256(value.headSha256, "headSha256");
  assertSha256(value.eventHash, "eventHash");
  for (const [key, number] of [["revision", value.revision], ["generation", value.generation], ["eventSequence", value.eventSequence], ["headByteLength", value.headByteLength]] as const) {
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`checkpoint ${key} is invalid`);
  }
  assertIsoDate(value.issuedAt, "issuedAt");
  assertIsoDate(value.expiresAt, "expiresAt");
  if (value.issuedAt >= value.expiresAt) throw new Error("checkpoint must expire after issuance");
}

export function assertReceipt(value: ContributionReceiptV1): void {
  assertExactKeys(value as unknown as Record<string, unknown>, ["schemaVersion", "type", "ceremonyId", "relationManifestSha256", "sequence", "generation", "predecessor", "successor", "contributionIndex", "contributionName", "contributionHashBlake2b512", "participantPseudonym", "clientKind", "clientReleaseSha256", "acceptedAt", "transcriptEventHash"], "receipt");
  if (value.clientKind !== "browser" && value.clientKind !== "cli" && value.clientKind !== "other") {
    throw new Error("receipt clientKind is invalid");
  }
  if (value.clientReleaseSha256 !== null) assertSha256(value.clientReleaseSha256, "clientReleaseSha256");
  if (value.schemaVersion !== 1 || value.type !== "moss.phase2.receipt.v1") throw new Error("receipt type is unsupported");
  assertUuid(value.ceremonyId, "ceremonyId");
  assertSha256(value.relationManifestSha256, "relationManifestSha256");
  assertExactKeys(value.predecessor as unknown as Record<string, unknown>, ["sha256", "byteLength", "urls"], "receipt predecessor");
  assertExactKeys(value.successor as unknown as Record<string, unknown>, ["sha256", "byteLength", "urls"], "receipt successor");
  assertArtifactRef(value.predecessor, "predecessor");
  assertArtifactRef(value.successor, "successor");
  assertBlake2b512(value.contributionHashBlake2b512, "contributionHashBlake2b512");
  assertSha256(value.transcriptEventHash, "transcriptEventHash");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new Error("receipt sequence is invalid");
  if (value.generation !== value.contributionIndex || !Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error("receipt generation and contribution index must match");
  if (value.predecessor.sha256 === value.successor.sha256) throw new Error("receipt predecessor and successor must differ");
  if (!/^[\x20-\x7e]{1,64}$/u.test(value.contributionName)) throw new Error("receipt contribution name is invalid");
  if (typeof value.participantPseudonym !== "string" || value.participantPseudonym.length < 1
    || value.participantPseudonym.length > 128 || /[\u0000-\u001f\u007f]/u.test(value.participantPseudonym)) {
    throw new Error("receipt participant pseudonym is invalid");
  }
  assertIsoDate(value.acceptedAt, "acceptedAt");
}

/** Rehearsal changes only the explicitly signed operator minimum, never NODE_ENV. */
export function ceremonyValidationOptions(nodeEnvironment: string | undefined, mode: string | undefined) {
  if (mode !== undefined && mode !== "production" && mode !== "rehearsal") {
    throw new Error("CEREMONY_MODE must be production or rehearsal");
  }
  return { production: (nodeEnvironment ?? "production") === "production", allowRehearsal: mode === "rehearsal" };
}

/** Canonical head format is frozen by the signed verification policy. */
export function contributionGenesis(manifest: CeremonyManifestV1): ArtifactRef {
  if (manifest.verifierPolicy.verificationMethod === "bellman-transition-v1") {
    if (!manifest.relation.genesisBellman) throw new Error("missing Bellman genesis");
    return manifest.relation.genesisBellman;
  }
  return manifest.relation.genesisZkey;
}

export function verificationChecksSatisfied(report: Pick<VerificationReportV1, "verificationMethod" | "checks">): boolean {
  const c = report.checks;
  if (!c || !c.objectHash || !c.framing || !c.exactPrefix || !c.exactlyOneContribution || !c.contributionMetadata || !c.contributionHash) return false;
  if (report.verificationMethod === "bellman-transition-v1") return c.verifyFromInit === false && c.bellmanTransition === true;
  return (report.verificationMethod === undefined || report.verificationMethod === "snarkjs-zkey-v1") && c.verifyFromInit === true && c.bellmanTransition === undefined;
}
