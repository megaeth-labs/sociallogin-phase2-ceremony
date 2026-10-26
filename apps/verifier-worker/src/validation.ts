import {
  assertBlake2b512,
  assertSha256,
  assertUuid,
  assertIsoDate,
  type ArtifactRef,
} from "@moss/phase2-protocol";

import type { VerificationArtifact, VerificationJobV1 } from "./types.js";

export function assertVerificationJob(value: unknown, maxArtifactByteLength: number): asserts value is VerificationJobV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("verification job must be an object");
  const job = value as Partial<VerificationJobV1>;
  if (job.schemaVersion !== 1 || job.type !== "moss.phase2.verification-job.v1") throw new Error("verification job type is unsupported");
  if (typeof job.jobId !== "string") throw new Error("verification job jobId is missing");
  assertUuid(job.jobId, "jobId");
  if (!Number.isSafeInteger(job.attempt) || Number(job.attempt) < 1) {
    throw new Error("verification job attempt is invalid");
  }
  if (typeof job.leaseExpiresAt !== "string") {
    throw new Error("verification job leaseExpiresAt is missing");
  }
  assertIsoDate(job.leaseExpiresAt, "leaseExpiresAt");
  if (typeof job.ceremonyId !== "string") throw new Error("verification job ceremonyId is missing");
  assertUuid(job.ceremonyId, "ceremonyId");
  if (typeof job.submissionId !== "string") throw new Error("verification job submissionId is missing");
  assertUuid(job.submissionId, "submissionId");
  assertVerificationArtifact(job.predecessor, "predecessor", maxArtifactByteLength);
  assertVerificationArtifact(job.candidate, "candidate", maxArtifactByteLength);
  if (typeof job.genesisSha256 !== "string") throw new Error("verification job genesisSha256 is missing");
  assertSha256(job.genesisSha256, "genesisSha256");
  if (typeof job.ptauSha256 !== "string") throw new Error("verification job ptauSha256 is missing");
  assertSha256(job.ptauSha256, "ptauSha256");
  if (typeof job.expectedContributionName !== "string"
    || !/^[\x20-\x7e]{1,64}$/u.test(job.expectedContributionName)) {
    throw new Error("expectedContributionName must be 1-64 printable ASCII bytes");
  }
  if (typeof job.expectedContributionHashBlake2b512 !== "string") {
    throw new Error("expectedContributionHashBlake2b512 is missing");
  }
  assertBlake2b512(job.expectedContributionHashBlake2b512, "expectedContributionHashBlake2b512");
  if (!Number.isSafeInteger(job.maxPredecessorContributions)
    || Number(job.maxPredecessorContributions) < 0
    || Number(job.maxPredecessorContributions) >= 1_000_000) {
    throw new Error("maxPredecessorContributions is invalid");
  }
}

function assertVerificationArtifact(
  value: ArtifactRef | VerificationArtifact | undefined,
  label: string,
  maxArtifactByteLength: number,
): asserts value is VerificationArtifact {
  if (value === undefined || value === null || typeof value !== "object") throw new Error(`${label} artifact is missing`);
  assertSha256(value.sha256, `${label}.sha256`);
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength <= 0 || value.byteLength > maxArtifactByteLength) {
    throw new Error(`${label}.byteLength is invalid`);
  }
  if (!Array.isArray(value.urls) || value.urls.length === 0 || value.urls.some((url) => typeof url !== "string")) {
    throw new Error(`${label}.urls is invalid`);
  }
  const downloadUrl = (value as Partial<VerificationArtifact>).downloadUrl;
  if (typeof downloadUrl !== "string") throw new Error(`${label}.downloadUrl is missing`);
  const parsed = new URL(downloadUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "file:") {
    throw new Error(`${label}.downloadUrl protocol is unsupported`);
  }
}
