import { timingSafeEqual } from "node:crypto";

import { contributionHashBlake2b512 } from "./hash.js";
import { inspectBn254Groth16Zkey, type ContributionRecord } from "./parser.js";
import { sourceFrom, type ByteSource } from "./source.js";

export interface AppendExpectation {
  expectedContributionName: string;
  expectedContributionHashBlake2b512?: string;
  maxPredecessorContributions: number;
  kind?: "ordinary" | "beacon";
  expectedBeaconHash?: Uint8Array;
  expectedBeaconIterationsExp?: number;
}

export interface AppendInspectionResult {
  predecessorCount: number;
  candidateCount: number;
  contributionIndex: number;
  contributionName: string | null;
  contributionHashBlake2b512: string;
  contributionType: 0 | 1;
  csHash: string;
}

export class AppendExpectationMismatchError extends Error {
  constructor(
    message: string,
    readonly inspection: AppendInspectionResult,
  ) {
    super(message);
    this.name = "AppendExpectationMismatchError";
  }
}

export async function verifyExactlyOneAppend(
  predecessorInput: ByteSource | Uint8Array | string,
  candidateInput: ByteSource | Uint8Array | string,
  expectation: AppendExpectation,
  hashContribution: (record: ContributionRecord) => Promise<string> = contributionHashBlake2b512,
): Promise<AppendInspectionResult> {
  if (!/^[\x20-\x7e]{1,64}$/u.test(expectation.expectedContributionName)) {
    throw new Error("expected contribution name must be 1-64 printable ASCII bytes");
  }
  const predecessorHandle = await sourceFrom(predecessorInput);
  const candidateHandle = await sourceFrom(candidateInput);
  try {
    const predecessor = await inspectBn254Groth16Zkey(predecessorHandle.source, {
      maxContributions: expectation.maxPredecessorContributions,
    });
    const candidate = await inspectBn254Groth16Zkey(candidateHandle.source, {
      maxContributions: predecessor.contributions.length + 1,
    });
    if (!equal(predecessor.csHash, candidate.csHash)) throw new Error("candidate circuit hash differs from predecessor");
    if (candidate.nVars !== predecessor.nVars || candidate.nPublic !== predecessor.nPublic || candidate.domainSize !== predecessor.domainSize) {
      throw new Error("candidate circuit dimensions differ from predecessor");
    }
    if (candidate.contributions.length !== predecessor.contributions.length + 1) {
      throw new Error("candidate must contain exactly one new contribution");
    }
    for (let index = 0; index < predecessor.contributions.length; index += 1) {
      if (!equal(predecessor.contributions[index].raw, candidate.contributions[index].raw)) {
        throw new Error(`candidate contribution prefix differs at index ${index}`);
      }
    }
    const last = candidate.contributions.at(-1)!;
    const hash = await hashContribution(last);
    if (!/^[a-f0-9]{128}$/u.test(hash)) throw new Error("contribution hasher returned a malformed digest");
    const inspection: AppendInspectionResult = {
      predecessorCount: predecessor.contributions.length,
      candidateCount: candidate.contributions.length,
      contributionIndex: candidate.contributions.length,
      contributionName: last.name ?? null,
      contributionHashBlake2b512: hash,
      contributionType: last.type,
      csHash: Buffer.from(candidate.csHash).toString("hex"),
    };
    // Hygiene check, not a soundness control. g1s and g1sx come from the
    // contributor's own proof-of-knowledge randomness and secret multiplier and
    // never from the predecessor, so a host whose CSPRNG state was duplicated —
    // a VM restored from a snapshot, a container with a stuck entropy source —
    // emits points identical to the contributor it was cloned from, regardless
    // of position in the chain. That contribution passes verifyFromInit and
    // every framing check while adding no entropy.
    //
    // It catches accidental duplication under a stock client only. g1s is a
    // nonce, so a deliberate attacker reusing delta simply draws a fresh one;
    // snarkjs has a code path that does exactly that. Phase 2 needs one honest
    // contributor, so a malicious degenerate contribution is not a threat and
    // this is not trying to be that defence. Parse-time canonicalisation of
    // field limbs keeps the byte comparison meaningful.
    //
    // Comparing only the new record against the prefix gives set-wide
    // uniqueness: the prefix is proven byte-identical to the predecessor above,
    // which passed this same check, down to a genesis holding no contributions.
    // Honest collision is ~2^-127.
    for (let index = 0; index < candidate.contributions.length - 1; index += 1) {
      const earlier = candidate.contributions[index];
      const field = equal(earlier.pointBytes.g1s, last.pointBytes.g1s)
        ? "g1s"
        : equal(earlier.pointBytes.g1sx, last.pointBytes.g1sx)
          ? "g1sx"
          : null;
      if (field) {
        throw new AppendExpectationMismatchError(
          `new contribution reuses the ${field} point of contribution ${index + 1}; the contributing host's randomness is not unique`,
          inspection,
        );
      }
    }
    if (last.name !== expectation.expectedContributionName) {
      throw new AppendExpectationMismatchError("new contribution name does not match the lease", inspection);
    }
    const kind = expectation.kind ?? "ordinary";
    if (kind === "ordinary") {
      if (last.type !== 0 || last.beaconHash !== undefined || last.numIterationsExp !== undefined) {
        throw new AppendExpectationMismatchError("new contribution is not an ordinary contribution", inspection);
      }
    } else {
      if (last.type !== 1 || expectation.expectedBeaconHash === undefined || expectation.expectedBeaconIterationsExp === undefined) {
        throw new AppendExpectationMismatchError("beacon append expectation is incomplete or candidate is not a beacon", inspection);
      }
      if (!equal(last.beaconHash!, expectation.expectedBeaconHash)
        || last.numIterationsExp !== expectation.expectedBeaconIterationsExp) {
        throw new AppendExpectationMismatchError("beacon parameters do not match the precommitted beacon", inspection);
      }
    }
    if (expectation.expectedContributionHashBlake2b512 !== undefined
      && hash !== expectation.expectedContributionHashBlake2b512) {
      throw new AppendExpectationMismatchError("new contribution hash does not match the submission", inspection);
    }
    return inspection;
  } finally {
    if (predecessorHandle.owned) await predecessorHandle.source.close?.();
    if (candidateHandle.owned) await candidateHandle.source.close?.();
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
