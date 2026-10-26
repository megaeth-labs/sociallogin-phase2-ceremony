import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_SIGNATURE_DOMAIN,
  assertCeremonyTransition,
  assertVerificationReport,
  assertVerifierPolicy,
  canonicalize,
  evaluateVerifierPolicy,
  signEnvelope,
  verifyEnvelope,
  type HeadCheckpointV1,
  type VerificationReportV1,
} from "../src/index.js";

describe("canonical JSON and signatures", () => {
  it("canonicalizes object keys and round-trips an Ed25519 envelope", () => {
    expect(canonicalize({ z: 1, a: [true, "x"] })).toBe('{"a":[true,"x"],"z":1}');
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload: HeadCheckpointV1 = {
      schemaVersion: 1,
      type: "moss.phase2.checkpoint.v1",
      ceremonyId: "123e4567-e89b-42d3-a456-426614174000",
      state: "OPEN",
      revision: 3,
      generation: 2,
      headSha256: "1".repeat(64),
      headByteLength: 460_000_000,
      eventSequence: 3,
      eventHash: "2".repeat(64),
      issuedAt: "2026-07-30T00:00:00.000Z",
      expiresAt: "2026-07-30T00:01:00.000Z",
    };
    const envelope = signEnvelope(payload as unknown as import("../src/types.js").JsonValue, {
      keyId: "coordinator-1",
      privateKey,
      domain: CHECKPOINT_SIGNATURE_DOMAIN,
    });
    expect(verifyEnvelope(envelope, { publicKey, domain: CHECKPOINT_SIGNATURE_DOMAIN })).toEqual(payload);
    const changedFirstCharacter = envelope.signature[0] === "A" ? "B" : "A";
    expect(() => verifyEnvelope({
      ...envelope,
      signature: `${changedFirstCharacter}${envelope.signature.slice(1)}`,
    }, {
      publicKey,
      domain: CHECKPOINT_SIGNATURE_DOMAIN,
    })).toThrow(/invalid/u);

    const noncanonicalLastCharacter: Record<string, string> = {
      A: "B",
      Q: "R",
      g: "h",
      w: "x",
    };
    const last = envelope.signature.at(-1)!;
    expect(() => verifyEnvelope({
      ...envelope,
      signature: `${envelope.signature.slice(0, -1)}${noncanonicalLastCharacter[last]}`,
    }, {
      publicKey,
      domain: CHECKPOINT_SIGNATURE_DOMAIN,
    })).toThrow(/canonical/u);
  });

  it("rejects non-JSON and cyclic values", () => {
    expect(() => canonicalize({ n: Number.NaN } as never)).toThrow(/finite/u);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalize(cycle as never)).toThrow(/cycle/u);
  });
});

describe("fail-closed verifier policy", () => {
  const checks = {
    objectHash: true,
    framing: true,
    exactPrefix: true,
    exactlyOneContribution: true,
    contributionMetadata: true,
    contributionHash: true,
    verifyFromInit: true,
  };
  const report = (operatorKeyId: string, passNumber: number): VerificationReportV1 => ({
    schemaVersion: 1,
    type: "moss.phase2.verification-report.v1",
    ceremonyId: "123e4567-e89b-42d3-a456-426614174000",
    submissionId: "223e4567-e89b-42d3-a456-426614174000",
    jobId: "323e4567-e89b-42d3-a456-426614174000",
    jobAttempt: 1,
    predecessorSha256: "1".repeat(64),
    candidateSha256: "2".repeat(64),
    genesisSha256: "3".repeat(64),
    expectedContributionName: "moss-participant",
    expectedContributionHashBlake2b512: "5".repeat(128),
    expectedContributionIndex: 1,
    observedContributionName: "moss-participant",
    observedContributionHashBlake2b512: "5".repeat(128),
    observedContributionIndex: 1,
    operatorKeyId,
    verifierImageDigest: "sha256:" + "4".repeat(64),
    snarkjsVersion: "0.7.6",
    passNumber,
    checks,
    result: "valid",
    startedAt: "2026-07-30T00:00:00.000Z",
    completedAt: "2026-07-30T00:01:00.000Z",
  });

  it("binds Bellman reports to their own policy without claiming zkey verification or embedded names", () => {
    const policy = { verificationMethod: "bellman-transition-v1" as const, operatorKeyIds: ["a"], requiredOperators: 1, passesPerOperator: 1 };
    const bellman: VerificationReportV1 = { ...report("a", 1), verificationMethod: "bellman-transition-v1", observedContributionName: null,
      checks: { ...checks, verifyFromInit: false, bellmanTransition: true } };
    expect(() => assertVerificationReport(bellman, { production: true })).not.toThrow();
    expect(evaluateVerifierPolicy(policy, [bellman]).satisfied).toBe(true);
    expect(evaluateVerifierPolicy(policy, [report("a", 1)]).satisfied).toBe(false);
    expect(evaluateVerifierPolicy({ ...policy, verificationMethod: undefined }, [bellman]).satisfied).toBe(false);
    for (const changed of [
      { ...bellman, observedContributionName: "invented" },
      { ...bellman, checks: { ...bellman.checks, verifyFromInit: true } },
      { ...bellman, checks: { ...bellman.checks, bellmanTransition: false } },
      { ...bellman, observedContributionIndex: 2 },
    ]) expect(() => assertVerificationReport(changed, { production: true })).toThrow();
  });

  it("accepts one full pass from each operator and refuses duplicate or failed approvals", () => {
    const policy = { operatorKeyIds: ["operator-a", "operator-b"], requiredOperators: 2, passesPerOperator: 1 };
    expect(() => assertVerifierPolicy(policy, { production: true })).not.toThrow();
    const a = report("operator-a", 1);
    const b = report("operator-b", 1);
    expect(evaluateVerifierPolicy(policy, [a]).satisfied).toBe(false);
    expect(evaluateVerifierPolicy(policy, [a, a]).satisfied).toBe(false);
    expect(evaluateVerifierPolicy(policy, [a, { ...a, jobAttempt: 2 }]).satisfied).toBe(false);
    expect(evaluateVerifierPolicy(policy, [a, report("unauthorized", 1)]).satisfied).toBe(false);
    for (const result of ["invalid", "error"] as const) {
      expect(evaluateVerifierPolicy(policy, [a, { ...b, result }]).satisfied).toBe(false);
    }
    expect(evaluateVerifierPolicy(policy, [a, { ...b, checks: { ...checks, verifyFromInit: false } }]).satisfied).toBe(false);
    expect(evaluateVerifierPolicy(policy, [a, b]).satisfied).toBe(true);
  });

  it.each([0, -1, 0.5, Number.NaN])("rejects an invalid pass count (%s)", (passesPerOperator) => {
    expect(() => assertVerifierPolicy({ operatorKeyIds: ["a", "b"], requiredOperators: 2, passesPerOperator }, { production: true }))
      .toThrow(/passesPerOperator/u);
  });

  it("still enforces two distinct passes when explicitly required by a manifest", () => {
    const policy = { operatorKeyIds: ["operator-a", "operator-b"], requiredOperators: 2, passesPerOperator: 2 };
    assertVerifierPolicy(policy, { production: true });
    expect(evaluateVerifierPolicy(policy, [report("operator-a", 1), report("operator-a", 2)]).satisfied).toBe(false);
    expect(evaluateVerifierPolicy(policy, [
      report("operator-a", 1), report("operator-a", 2), report("operator-b", 1), report("operator-b", 2),
    ]).satisfied).toBe(true);
  });

  it("rejects a production policy that lets a listed operator be skipped", () => {
    expect(() => assertVerifierPolicy({
      operatorKeyIds: ["one", "two", "three"],
      requiredOperators: 2,
      passesPerOperator: 1,
    }, { production: true })).toThrow(/unanimity/u);
  });

  it("rejects a valid report whose observed append differs from its expectation", () => {
    const mismatched = report("operator-a", 1);
    mismatched.observedContributionIndex = 2;
    expect(() => assertVerificationReport(mismatched, { production: true })).toThrow(/metadata/u);
    expect(evaluateVerifierPolicy({
      operatorKeyIds: ["operator-a"],
      requiredOperators: 1,
      passesPerOperator: 1,
    }, [mismatched]).satisfied).toBe(false);
  });
});

describe("state transitions", () => {
  it("makes sealing irreversible", () => {
    expect(() => assertCeremonyTransition("OPEN", "SEALED")).not.toThrow();
    expect(() => assertCeremonyTransition("SEALED", "OPEN")).toThrow(/invalid/u);
  });
});

it("permits a single production verifier but still requires unanimity", () => {
  const policy = { operatorKeyIds: ["one"], requiredOperators: 1, passesPerOperator: 1 };
  expect(() => assertVerifierPolicy(policy, { production: true })).not.toThrow();
  expect(() => assertVerifierPolicy({ ...policy, operatorKeyIds: ["one", "two"] }, { production: true })).toThrow(/unanimity/);
});

it("allows a primary archive in production but never alongside a witness or over plain HTTP", async () => {
  const { assertManifest } = await import("../src/index.js");
  const partial = { ceremonyId: "fixture", slug: "fixture", relation: null, schedule: null, beacon: null, coordinatorKeys: [], verifierKeys: [], verifierPolicy: null, contributionPolicy: null, webRelease: null, cliReleases: [], schemaVersion: 1, purpose: "production", primaryPublication: { archiveBaseUrl: "https://archive.example/" } };
  // Validation passes the publication checks and stops at the next missing field.
  expect(() => assertManifest(partial as never, { production: true })).not.toThrow(/primary/);
  expect(() => assertManifest({ ...partial, publication: {} } as never, { production: true })).toThrow(/excludes witness/);
  expect(() => assertManifest({ ...partial, purpose: "rehearsal", publication: {} } as never, { production: true, allowRehearsal: true })).toThrow(/excludes witness/);
  expect(() => assertManifest({ ...partial, purpose: "rehearsal", primaryPublication: { archiveBaseUrl: "http://archive.example/" } } as never, { production: true, allowRehearsal: true })).toThrow(/HTTPS/);
});
