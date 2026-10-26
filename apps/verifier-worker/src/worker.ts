import type { KeyLike } from "node:crypto";

import {
  VERIFICATION_REPORT_SIGNATURE_DOMAIN,
  verificationChecksSatisfied,
  type VerificationMethod,
  assertVerificationReport,
  signEnvelope,
  type JsonValue,
  type SignedEnvelope,
  type VerificationChecks,
  type VerificationReportV1,
} from "@moss/phase2-protocol";

import { hashFile } from "./hashing.js";
import type {
  JobVerificationResult,
  LocalVerificationJob,
  VerificationPassOutput,
  VerificationPassRunner,
} from "./types.js";

export interface WorkerConfiguration {
  verificationMethod?: VerificationMethod;
  operatorKeyId: string;
  privateKey: KeyLike;
  verifierImageDigest: string;
  passesPerOperator: number;
  passTimeoutMs: number;
  production: boolean;
  trustedArtifactValidation?: {
    genesisSha256: string;
    ptauSha256: string;
  };
  signal?: AbortSignal;
}

export async function verifyLocalJob(
  local: LocalVerificationJob,
  runner: VerificationPassRunner,
  configuration: WorkerConfiguration,
): Promise<JobVerificationResult> {
  assertConfiguration(configuration);
  const [predecessor, candidate] = await Promise.all([
    hashFile(local.predecessorPath),
    hashFile(local.candidatePath),
  ]);
  const trusted = configuration.trustedArtifactValidation ?? {
    genesisSha256: (await hashFile(local.genesisPath)).sha256,
    ptauSha256: (await hashFile(local.ptauPath)).sha256,
  };
  const objectHash = predecessor.sha256 === local.job.predecessor.sha256
    && predecessor.byteLength === local.job.predecessor.byteLength
    && candidate.sha256 === local.job.candidate.sha256
    && candidate.byteLength === local.job.candidate.byteLength
    && trusted.genesisSha256 === local.job.genesisSha256
    && trusted.ptauSha256 === local.job.ptauSha256;

  if (!objectHash) {
    return {
      valid: false,
      reports: [signReport(buildReport(local, configuration, 1, {
        result: "invalid",
        checks: emptyChecks(),
        errorCode: "ARTIFACT_HASH_MISMATCH",
      }), configuration)],
    };
  }

  const reports: Array<SignedEnvelope<VerificationReportV1>> = [];
  for (let passNumber = 1; passNumber <= configuration.passesPerOperator; passNumber += 1) {
    configuration.signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    try {
      const output = await runner.run({
        predecessorPath: local.predecessorPath,
        candidatePath: local.candidatePath,
        genesisPath: local.genesisPath,
        ptauPath: local.ptauPath,
        expectedContributionName: local.job.expectedContributionName,
        expectedContributionHashBlake2b512: local.job.expectedContributionHashBlake2b512,
        maxPredecessorContributions: local.job.maxPredecessorContributions,
      }, configuration.passTimeoutMs, configuration.signal);
      const checks = checksFrom(output, local, configuration.verificationMethod);
      const valid = output.result === "valid" && verificationChecksSatisfied({ verificationMethod: configuration.verificationMethod, checks });
      reports.push(signReport(buildReport(local, configuration, passNumber, {
        startedAt,
        result: valid ? "valid" : "invalid",
        checks,
        observedContributionName: output.observedContributionName,
        observedContributionHashBlake2b512: output.observedContributionHashBlake2b512,
        observedContributionIndex: output.observedContributionIndex,
        ...(!valid ? { errorCode: output.errorCode ?? "CONTRIBUTION_METADATA_MISMATCH" } : {}),
      }), configuration));
    } catch {
      reports.push(signReport(buildReport(local, configuration, passNumber, {
        startedAt,
        result: "error",
        checks: emptyChecks({ objectHash: true }),
        errorCode: "VERIFIER_PROCESS_ERROR",
      }), configuration));
    }
  }
  return {
    reports,
    valid: reports.length === configuration.passesPerOperator
      && reports.every((envelope) => envelope.payload.result === "valid"
        && verificationChecksSatisfied(envelope.payload)),
  };
}

function buildReport(
  local: LocalVerificationJob,
  configuration: WorkerConfiguration,
  passNumber: number,
  outcome: {
    result: VerificationReportV1["result"];
    checks: VerificationChecks;
    startedAt?: string;
    errorCode?: string;
    observedContributionName?: string | null;
    observedContributionHashBlake2b512?: string | null;
    observedContributionIndex?: number | null;
  },
): VerificationReportV1 {
  const startedAt = outcome.startedAt ?? new Date().toISOString();
  return {
    ...(configuration.verificationMethod === undefined ? {} : { verificationMethod: configuration.verificationMethod }),
    schemaVersion: 1,
    type: "moss.phase2.verification-report.v1",
    ceremonyId: local.job.ceremonyId,
    submissionId: local.job.submissionId,
    jobId: local.job.jobId,
    jobAttempt: local.job.attempt,
    predecessorSha256: local.job.predecessor.sha256,
    candidateSha256: local.job.candidate.sha256,
    genesisSha256: local.job.genesisSha256,
    expectedContributionName: local.job.expectedContributionName,
    expectedContributionHashBlake2b512: local.job.expectedContributionHashBlake2b512,
    expectedContributionIndex: local.job.maxPredecessorContributions + 1,
    observedContributionName: outcome.observedContributionName ?? null,
    observedContributionHashBlake2b512: outcome.observedContributionHashBlake2b512 ?? null,
    observedContributionIndex: outcome.observedContributionIndex ?? null,
    operatorKeyId: configuration.operatorKeyId,
    verifierImageDigest: configuration.verifierImageDigest,
    snarkjsVersion: "0.7.6",
    passNumber,
    checks: configuration.verificationMethod === "bellman-transition-v1" ? { ...outcome.checks, bellmanTransition: outcome.checks.bellmanTransition ?? false } : outcome.checks,
    result: outcome.result,
    startedAt,
    completedAt: new Date().toISOString(),
    ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
  };
}

function signReport(
  report: VerificationReportV1,
  configuration: WorkerConfiguration,
): SignedEnvelope<VerificationReportV1> {
  assertVerificationReport(report, { production: configuration.production });
  return signEnvelope(report as unknown as JsonValue, {
    keyId: configuration.operatorKeyId,
    privateKey: configuration.privateKey,
    domain: VERIFICATION_REPORT_SIGNATURE_DOMAIN,
  }) as unknown as SignedEnvelope<VerificationReportV1>;
}

function checksFrom(output: VerificationPassOutput, local: LocalVerificationJob, method?: VerificationMethod): VerificationChecks {
  const expectedIndex = local.job.maxPredecessorContributions + 1;
  return {
    objectHash: true,
    framing: output.prefixValid,
    exactPrefix: output.prefixValid,
    exactlyOneContribution: output.prefixValid,
    contributionMetadata: output.prefixValid
      && output.observedContributionName === (method === "bellman-transition-v1" ? null : local.job.expectedContributionName)
      && output.observedContributionIndex === expectedIndex,
    contributionHash: output.prefixValid
      && output.observedContributionHashBlake2b512 === local.job.expectedContributionHashBlake2b512,
    verifyFromInit: output.verifyFromInit,
    ...(method === "bellman-transition-v1" ? { bellmanTransition: output.bellmanTransition === true } : {}),
  };
}

function emptyChecks(overrides: Partial<VerificationChecks> = {}): VerificationChecks {
  return {
    objectHash: false,
    framing: false,
    exactPrefix: false,
    exactlyOneContribution: false,
    contributionMetadata: false,
    contributionHash: false,
    verifyFromInit: false,
    ...overrides,
  };
}

function assertConfiguration(configuration: WorkerConfiguration): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(configuration.operatorKeyId)) throw new Error("operator key id is invalid");
  if (configuration.production && !/^sha256:[a-f0-9]{64}$/u.test(configuration.verifierImageDigest)) {
    throw new Error("production verifier image digest must be sha256-pinned");
  }
  if (!configuration.production && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(configuration.verifierImageDigest)) {
    throw new Error("verifier image identifier is invalid");
  }
  if (!Number.isSafeInteger(configuration.passesPerOperator) || configuration.passesPerOperator < 1) {
    throw new Error("passesPerOperator is invalid");
  }
  if (configuration.production && configuration.trustedArtifactValidation === undefined) {
    throw new Error("production verifier workers require startup validation of trusted artifacts");
  }
}
