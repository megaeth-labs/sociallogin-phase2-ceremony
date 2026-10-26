export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CeremonyState =
  | "DRAFT"
  | "PREPARING"
  | "PREPARED"
  | "OPEN"
  | "PAUSED"
  | "SEALED"
  | "WAITING_FOR_BEACON"
  | "FINALIZING"
  | "FINALIZED"
  | "CANCELLED"
  | "ABORTED";

export type LeaseState =
  | "OFFERED"
  | "ACTIVE"
  | "SUBMITTED"
  | "VERIFYING"
  | "ACCEPTED"
  | "EXPIRED"
  | "REJECTED"
  | "STALE"
  | "CANCELLED";

export interface ArtifactRef {
  sha256: string;
  byteLength: number;
  urls: string[];
}

export interface PublicKeyRef {
  keyId: string;
  algorithm: "Ed25519";
  publicKeyPem: string;
}

export interface VerifierKeyRef extends PublicKeyRef {
  verifierImageDigest: string;
}

export interface ReleaseRef extends ArtifactRef {
  sourceCommit: string;
}

interface BeaconSpecBase {
  /** Earliest instant the source can produce the precommitted value. */
  expectedAt: string;
  derivation: "MOSS_PHASE2_BEACON_V1";
  /**
   * Exponent for the 2^N sequential SHA-256 iterations snarkjs applies to the
   * beacon value. Larger values add a delay to evaluating candidate beacons;
   * the production default of 10 does not provide a meaningful grinding delay.
   * This value is immutable once committed in the signed manifest.
   */
  numIterationsExp: number;
  contributionName: string;
}

export interface DrandBeaconSpec extends BeaconSpecBase {
  source: "drand";
  chainHash: string;
  round: number;
}

/**
 * A precommitted future Ethereum block. Unbiasable in practice because the
 * proposer must publish within a slot while a single evaluation of the delay
 * function above takes far longer, so they can neither compare candidates nor
 * decide whether withholding the slot would help.
 */
export interface EthereumBlockBeaconSpec extends BeaconSpecBase {
  source: "ethereum-block";
  chainId: number;
  blockNumber: number;
}

export type BeaconSpec = DrandBeaconSpec | EthereumBlockBeaconSpec;

export type VerificationMethod = "snarkjs-zkey-v1" | "bellman-transition-v1";

export interface VerifierPolicy {
  /** Omitted only for legacy zkey epochs. */
  verificationMethod?: VerificationMethod;
  operatorKeyIds: string[];
  requiredOperators: number;
  passesPerOperator: number;
}

export interface ContributionPolicy {
  targetContributions: number;
  maximumContributions: number;
  maxArtifactByteLength: number;
  requirePinnedClientRelease: boolean;
  lease: {
    offerSeconds: number;
    absoluteSeconds: number;
    heartbeatSeconds: number;
  };
  verifierJobSeconds: number;
  verifierMaxAttempts: number;
}

export interface CeremonyManifestV1 {
  operationalPolicy?: import("./operational-updates.js").OperationalPolicy;
  schemaVersion: 1;
  /** Omitted in legacy production manifests. Rehearsal requires explicit reader opt-in. */
  purpose?: "production" | "rehearsal";
  publication?: { witness: PublicKeyRef; endpoint: string };
  /** Explicit single-archive rehearsal policy; never an independent witness claim. */
  primaryPublication?: { archiveBaseUrl: string };
  ceremonyId: string;
  slug: string;
  relation: {
    profile: "google-rs256-zksync-v3";
    relationId: "google-rs256-zksync-v3-groth16-bn254-2";
    verifierVersion: 4;
    proofSystem: "groth16";
    curve: "bn254";
    sourceRepository: string;
    sourceCommit: string;
    sourceClosureSha256: string;
    circomVersion: "2.2.3";
    snarkjsVersion: "0.7.6";
    r1cs: ArtifactRef;
    ptau: ArtifactRef & { blake2b512: string };
    genesisZkey: ArtifactRef;
    /** Separately pinned export; original zkey remains required for final import. */
    genesisBellman?: ArtifactRef;
  };
  schedule: {
    opensAt: string;
    sealsAt: string;
  };
  beacon: BeaconSpec;
  coordinatorKeys: PublicKeyRef[];
  verifierKeys: VerifierKeyRef[];
  verifierPolicy: VerifierPolicy;
  contributionPolicy: ContributionPolicy;
  webRelease: ReleaseRef;
  cliReleases: ReleaseRef[];
}

export interface HeadCheckpointV1 {
  schemaVersion: 1;
  type: "moss.phase2.checkpoint.v1";
  ceremonyId: string;
  state: CeremonyState;
  revision: number;
  generation: number;
  headSha256: string;
  headByteLength: number;
  eventSequence: number;
  eventHash: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ContributionReceiptV1 {
  schemaVersion: 1;
  type: "moss.phase2.receipt.v1";
  ceremonyId: string;
  relationManifestSha256: string;
  sequence: number;
  generation: number;
  predecessor: ArtifactRef;
  successor: ArtifactRef;
  contributionIndex: number;
  contributionName: string;
  contributionHashBlake2b512: string;
  participantPseudonym: string;
  /**
   * Which client produced the contribution, and the release hash it reported.
   * Public so the release allowlist is auditable from the transcript, and so
   * an auditor can tell how many contributions depended on the served web
   * bundle — the one path whose code sits inside the trust boundary. For the
   * browser, clientReleaseSha256 is a label rather than evidence; the web
   * release is verified out of band against its published asset manifest.
   */
  clientKind: "browser" | "cli" | "other";
  clientReleaseSha256: string | null;
  acceptedAt: string;
  transcriptEventHash: string;
}

export interface VerificationChecks {
  objectHash: boolean;
  framing: boolean;
  exactPrefix: boolean;
  exactlyOneContribution: boolean;
  contributionMetadata: boolean;
  contributionHash: boolean;
  verifyFromInit: boolean;
  bellmanTransition?: boolean;
}

export interface VerificationReportV1 {
  verificationMethod?: VerificationMethod;
  schemaVersion: 1;
  type: "moss.phase2.verification-report.v1";
  ceremonyId: string;
  submissionId: string;
  jobId: string;
  jobAttempt: number;
  predecessorSha256: string;
  candidateSha256: string;
  genesisSha256: string;
  expectedContributionName: string;
  expectedContributionHashBlake2b512: string;
  expectedContributionIndex: number;
  observedContributionName: string | null;
  observedContributionHashBlake2b512: string | null;
  observedContributionIndex: number | null;
  operatorKeyId: string;
  verifierImageDigest: string;
  snarkjsVersion: "0.7.6";
  passNumber: number;
  checks: VerificationChecks;
  result: "valid" | "invalid" | "error";
  startedAt: string;
  completedAt: string;
  errorCode?: string;
}

export interface SignedEnvelope<T> {
  schemaVersion: 1;
  keyId: string;
  payload: T;
  signature: string;
}

export interface TranscriptEventV1 {
  schemaVersion: 1;
  ceremonyId: string;
  sequence: number;
  previousEventHash: string;
  eventType: string;
  payload: JsonValue;
  createdAt: string;
}

export interface VerifierPolicyEvaluation {
  satisfied: boolean;
  acceptedOperators: string[];
  missingOperators: number;
  missingPasses: Record<string, number>;
}
