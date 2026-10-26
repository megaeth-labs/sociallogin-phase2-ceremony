import type { ProductionFinalization } from "@/lib/finalization";
import rehearsal from "@/lib/rehearsal-finalization.json";

// Stand-in for the finalized walkthrough screen: the production record's shape
// filled with the completed rehearsal's real, downloadable outputs. The
// rehearsal published the beacon evidence, sealed import, finalizer summary and
// audit inside its artifact index, so those entries point at the index. Never
// verified or shown outside /preview.
const record = rehearsal.payload;
const { artifactIndex } = record.artifacts;

export const SAMPLE_PRODUCTION_FINALIZATION: ProductionFinalization = {
  schemaVersion: 1,
  type: "moss.phase2.finalization.v1",
  ceremonyId: record.ceremonyId,
  manifestSha256: record.manifestSha256,
  sealedCheckpoint: {
    generation: record.ordinaryContributions,
    headSha256: record.sealedHeadSha256,
    headByteLength: record.sealedHeadByteLength,
    eventHash: record.sealedEventHash,
    eventSequence: record.sealedEventSequence,
  },
  ordinaryContributions: record.ordinaryContributions,
  beaconContributions: 1,
  beacon: {
    source: "ethereum-block",
    chainId: 1,
    blockNumber: record.beacon.blockNumber,
    blockHash: record.beacon.blockHash,
    derivation: "MOSS_PHASE2_BEACON_V1",
    numIterationsExp: record.beacon.numIterationsExp,
    beaconHash: "0".repeat(64),
    contributionHashBlake2b512: "0".repeat(128),
  },
  completedAt: record.completedAt,
  publicInputs: 20,
  proofTests: record.proofTests,
  audit: { transitionsReplayed: record.ordinaryContributions, receiptsChecked: record.ordinaryContributions },
  artifacts: {
    ...record.artifacts,
    sealedImport: artifactIndex,
    beaconEvidence: artifactIndex,
    finalizerSummary: artifactIndex,
    auditReport: artifactIndex,
  },
};
