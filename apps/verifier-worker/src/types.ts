import type { ArtifactRef, SignedEnvelope, VerificationReportV1 } from "@moss/phase2-protocol";

export interface VerificationArtifact extends ArtifactRef {
  downloadUrl: string;
}

export interface VerificationJobV1 {
  schemaVersion: 1;
  type: "moss.phase2.verification-job.v1";
  jobId: string;
  attempt: number;
  leaseExpiresAt: string;
  ceremonyId: string;
  submissionId: string;
  predecessor: VerificationArtifact;
  candidate: VerificationArtifact;
  genesisSha256: string;
  ptauSha256: string;
  expectedContributionName: string;
  expectedContributionHashBlake2b512: string;
  maxPredecessorContributions: number;
}

export interface LocalVerificationJob {
  job: VerificationJobV1;
  predecessorPath: string;
  candidatePath: string;
  genesisPath: string;
  ptauPath: string;
}

export interface VerificationPassInput {
  predecessorPath: string;
  candidatePath: string;
  genesisPath: string;
  ptauPath: string;
  expectedContributionName: string;
  expectedContributionHashBlake2b512: string;
  maxPredecessorContributions: number;
}

export interface VerificationPassOutput {
  result: "valid" | "invalid";
  prefixValid: boolean;
  verifyFromInit: boolean;
  bellmanTransition?: boolean;
  observedContributionName: string | null;
  observedContributionHashBlake2b512: string | null;
  observedContributionIndex: number | null;
  errorCode?: string;
}

export interface VerificationPassRunner {
  run(
    input: VerificationPassInput,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<VerificationPassOutput>;
}

export interface JobVerificationResult {
  reports: Array<SignedEnvelope<VerificationReportV1>>;
  valid: boolean;
}
