import type { ArtifactRef } from "@moss/phase2-protocol";

export const CEREMONY_AUDIT_TYPE = "moss.phase2.ceremony-audit.v1" as const;
export const CEREMONY_AUDIT_FILE = "ceremony-audit.json" as const;
export const CEREMONY_AUDIT_RUN_FILE = "ceremony-audit-run.json" as const;
export const REPLAY_STATE_FILE = "replay-state.jsonl" as const;

/** Stable names; a completion record may require every one of them to pass. */
export const AUDIT_CHECKS = [
  "authority",
  "operationalUpdates",
  "publications",
  "archivedCheckpoints",
  "receipts",
  "transcript",
  "verifierReports",
  "clientReleases",
  "artifactLinkage",
  "replay",
] as const;
export type AuditCheckName = (typeof AUDIT_CHECKS)[number];

export interface AuditFailure {
  check: AuditCheckName;
  /** Contribution generation (publication sequence), when the failure is per item. */
  generation: number | null;
  message: string;
}

export interface AuditCheckResult {
  result: "passed" | "failed" | "not-run";
  /** Items examined by this check, for example receipts or transitions. */
  items: number;
  failures: number;
}

export interface AuditTransition {
  generation: number;
  predecessorSha256: string;
  successorSha256: string;
  /** Receipt-claimed identifier the replay had to reproduce. */
  expectedContributionHashBlake2b512: string;
  /** What the native verifier printed; null when it rejected or did not run. */
  observedContributionHashBlake2b512: string | null;
  result: "valid" | "invalid" | "not-run";
}

export interface AuditToolchain {
  node: string;
  platform: string;
  auditor: { package: "@moss/phase2-finalizer"; version: string };
  protocolVersion: string | null;
  zkeyInspectVersion: string | null;
  /** snarkjs is not executed by the audit; recorded for the finalizer that follows it. */
  snarkjsVersion: string | null;
  bellmanVerifier: {
    binarySha256: string | null;
    /** MystenLabs/phase2-bn254 revision from the adjacent Cargo.lock, if present. */
    phase2Bn254Revision: string | null;
  };
}

/**
 * The deterministic audit. It holds no wall-clock time, host path or resume
 * information, so independent runs over the same records with the same
 * toolchain produce identical canonical bytes.
 */
export interface CeremonyAuditReportV1 {
  schemaVersion: 1;
  type: typeof CEREMONY_AUDIT_TYPE;
  /** "full" replays every transition; "records" checks only signed records. */
  scope: "full" | "records";
  result: "passed" | "failed";
  ceremonyId: string | null;
  /** canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", payload): the receipts' relationManifestSha256. */
  manifestSha256: string | null;
  manifestEnvelopeSha256: string | null;
  rootKeyId: string | null;
  rootKeySpkiSha256: string | null;
  purpose: "production" | "rehearsal" | null;
  verificationMethod: string | null;
  sealed: {
    generation: number;
    headSha256: string;
    headByteLength: number;
    eventSequence: number;
    eventHash: string;
    checkpointEnvelopeSha256: string;
    checkpointSignerKeyId: string;
  } | null;
  genesis: { sha256: string; byteLength: number } | null;
  counts: {
    contributions: number;
    distinctParticipants: number;
    publicationBundles: number;
    verifierReports: number;
    operationalUpdates: number;
    browserContributions: number;
    cliContributions: number;
    otherContributions: number;
    transitionsReplayed: number;
  };
  checks: Record<AuditCheckName, AuditCheckResult>;
  transitions: AuditTransition[];
  failures: AuditFailure[];
  toolchain: AuditToolchain;
}

/** Non-deterministic companion file: timings and resume details. */
export interface CeremonyAuditRunV1 {
  schemaVersion: 1;
  type: "moss.phase2.ceremony-audit-run.v1";
  auditSha256: string;
  auditByteLength: number;
  startedAt: string;
  finishedAt: string;
  jobs: number;
  source: "mirror" | "https";
  transitions: Array<{ generation: number; seconds: number | null; resumed: boolean }>;
}

/** Where records and artifacts come from. Callers always re-hash what is returned. */
export interface AuditFetcher {
  readonly kind: "mirror" | "https";
  /** A small object by its exact URL, bounded by maxBytes. */
  fetchBytes(url: string, maxBytes: number): Promise<Buffer>;
  /**
   * A local, read-only path holding the artifact. The caller verifies its
   * digests before and after use and must call release() when done.
   */
  materialize(ref: ArtifactRef, directory: string): Promise<{ path: string; release(): Promise<void> }>;
}

export interface TransitionVerdict {
  valid: boolean;
  observedContributionHashBlake2b512: string | null;
  observedContributionIndex: number | null;
  /** Stable reason code when not valid. */
  reason?: string;
}

/** Verifies one predecessor -> candidate append. Must never modify its inputs. */
export interface TransitionRunner {
  readonly binarySha256: string | null;
  run(input: {
    predecessorPath: string;
    candidatePath: string;
    predecessorCount: number;
    scratchDirectory: string;
    signal?: AbortSignal;
  }): Promise<TransitionVerdict>;
}
