import type {
  BeaconSpec,
  CeremonyManifestV1,
  HeadCheckpointV1,
} from "@moss/phase2-protocol";

interface VerifiedBeaconBase {
  schemaVersion: 1;
  derivation: "MOSS_PHASE2_BEACON_V1";
  /** Exact lowercase, unprefixed bytes supplied to snarkjs zkey beacon. */
  beaconHashHex: string;
  /** SHA-256 of the immutable evidence bytes verified by the resolver. */
  evidenceSha256: string;
}

export interface VerifiedDrandBeaconV1 extends VerifiedBeaconBase {
  source: "drand";
  chainHash: string;
  round: number;
  /** Canonical evidence written verbatim by the finalizer. */
  evidence: DrandBeaconEvidenceV1;
  verifier: {
    id: string;
    version: string;
    method: "drand-bls-signature-and-chain-hash";
  };
}

export interface VerifiedEthereumBlockBeaconV1 extends VerifiedBeaconBase {
  source: "ethereum-block";
  chainId: number;
  blockNumber: number;
  /** Lowercase, unprefixed 32-byte block hash. */
  blockHash: string;
  evidence: EthereumBlockBeaconEvidenceV1;
  verifier: {
    id: string;
    version: string;
    method: "ethereum-finalized-block-hash";
  };
}

export type VerifiedBeaconV1 =
  | VerifiedDrandBeaconV1
  | VerifiedEthereumBlockBeaconV1;

/**
 * What every configured endpoint agreed on for the precommitted block. The
 * block must be finalized rather than merely deep, so there is no reorg
 * ambiguity to reason about: post-Merge finality is a consensus guarantee, not
 * a probability.
 */
export interface EthereumBlockBeaconEvidenceV1 {
  type: "moss.phase2.ethereum-block-evidence.v1";
  chainId: number;
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  stateRoot: string;
  timestamp: number;
  /** Finalized head height observed, which must be at or above blockNumber. */
  finalizedBlockNumber: number;
  endpointCount: number;
  observedAt: string;
}

export interface DrandChainInfoEvidenceV1 {
  publicKey: string;
  periodSeconds: number;
  genesisTime: number;
  groupHash: string;
  schemeId:
    | "pedersen-bls-chained"
    | "pedersen-bls-unchained"
    | "bls-unchained-on-g1"
    | "bls-unchained-g1-rfc9380"
    | "bls-bn254-unchained-on-g1";
  beaconId: string;
  roundTime: string;
}

export interface DrandBeaconRecordEvidenceV1 {
  round: number;
  randomness: string;
  signature: string;
  previousSignature?: string;
}

export interface DrandEvidenceSourceV1 {
  endpoint: string;
  infoUrl: string;
  beaconUrl: string;
}

/**
 * Normalized cryptographic evidence. Its canonical JSON plus one LF is hashed
 * by `evidenceSha256` and emitted as `drand-evidence.json`.
 */
export interface DrandBeaconEvidenceV1 {
  schemaVersion: 1;
  type: "moss.phase2.drand-evidence.v1";
  chainHash: string;
  round: number;
  chainInfo: DrandChainInfoEvidenceV1;
  beacon: DrandBeaconRecordEvidenceV1;
  sources: DrandEvidenceSourceV1[];
  verification: {
    implementation: "drand-client";
    implementationVersion: "1.4.2";
    chainInfoHashAlgorithm: "drand-chain-info-v1";
    beaconVerification: "bls-signature-and-sha256-randomness";
    sourceAgreement: "all-configured-distinct-origins";
  };
  derivation: {
    name: "MOSS_PHASE2_BEACON_V1";
    encoding:
      "sha256(utf8(domain)||00||chainHash32||uint64be(round)||randomness32)";
    beaconHashHex: string;
  };
}

/**
 * Security boundary for future-beacon acquisition.
 *
 * An implementation must authenticate the configured drand chain, verify the
 * selected round's BLS signature, enforce finality/availability, and implement
 * the named derivation before returning. The finalizer validates that the
 * returned metadata matches the signed manifest, but cannot manufacture those
 * missing cryptographic checks itself.
 */
export interface BeaconResolver {
  resolve(spec: Readonly<BeaconSpec>): Promise<VerifiedBeaconV1>;
}

export interface SealedHeadInspection {
  contributionCount: number;
  beaconContributionCount: number;
  nPublic: number;
}

export interface BeaconAppendInspection {
  predecessorCount: number;
  candidateCount: number;
  contributionIndex: number;
  contributionHashBlake2b512: string;
  csHash: string;
}

export interface BackendMetadata {
  snarkjsVersion: "0.7.6";
  solidityTemplateSha256: string;
}

export interface Phase2Backend {
  importBellman?(genesisPath: string, bellmanPath: string, outputPath: string): Promise<void>;
  exportBellman?(zkeyPath: string, outputPath: string): Promise<void>;
  metadata(): Promise<BackendMetadata>;
  inspectSealedHead(
    sealedHeadPath: string,
    maxContributions: number,
  ): Promise<SealedHeadInspection>;
  verifyFromR1cs(
    r1csPath: string,
    ptauPath: string,
    zkeyPath: string,
  ): Promise<boolean>;
  applyBeacon(input: {
    sealedHeadPath: string;
    finalZkeyPath: string;
    contributionName: string;
    beaconHashHex: string;
    numIterationsExp: number;
  }): Promise<{ contributionHashBlake2b512: string }>;
  verifyBeaconAppend(input: {
    sealedHeadPath: string;
    finalZkeyPath: string;
    expectedContributionName: string;
    expectedContributionHashBlake2b512: string;
    expectedBeaconHash: Uint8Array;
    expectedBeaconIterationsExp: number;
    maxPredecessorContributions: number;
  }): Promise<BeaconAppendInspection>;
  exportVerificationKey(finalZkeyPath: string): Promise<unknown>;
  exportSolidityVerifier(finalZkeyPath: string): Promise<string>;
}

export interface FinalizeOptions {
  genesisZkeyPath?: string;
  allowRehearsal?: boolean;
  manifestEnvelopePath: string;
  rootPublicKeyPath: string;
  expectedRootKeyId: string;
  expectedRootKeySpkiSha256: string;
  sealedCheckpointEnvelopePath: string;
  sealedHeadPath: string;
  expectedSealedHeadSha256: string;
  expectedSealedHeadByteLength: number;
  r1csPath: string;
  ptauPath: string;
  outputDir: string;
}

export interface FinalizerDependencies {
  beaconResolver: BeaconResolver;
  backend?: Phase2Backend;
  now?: () => Date;
}

export interface LoadedFinalizationAuthority {
  manifest: CeremonyManifestV1;
  manifestEnvelopeSha256: string;
  manifestCanonicalPayloadSha256: string;
  manifestRootKeyId: string;
  manifestRootKeySpkiSha256: string;
  checkpoint: HeadCheckpointV1;
  checkpointEnvelopeSha256: string;
  checkpointSignerKeyId: string;
}

export interface FinalArtifactSummaryV1 {
  schemaVersion: 1;
  type: "moss.phase2.final-artifacts.v1";
  ceremonyId: string;
  relationId: string;
  authority: {
    manifestEnvelopeSha256: string;
    manifestCanonicalPayloadSha256: string;
    manifestRootKeyId: string;
    manifestRootKeySpkiSha256: string;
    sealedCheckpointEnvelopeSha256: string;
    sealedCheckpointSignerKeyId: string;
    sealedEventHash: string;
    sealedEventSequence: number;
    sealedGeneration: number;
  };
  inputs: {
    r1cs: { sha256: string; byteLength: number };
    ptau: { sha256: string; blake2b512: string; byteLength: number };
    sealedHead: {
      sha256: string;
      byteLength: number;
      ordinaryContributionCount: number;
    };
  };
  beacon: {
    derivation: "MOSS_PHASE2_BEACON_V1";
    beaconHashHex: string;
    evidenceSha256: string;
    resolverId: string;
    resolverVersion: string;
    numIterationsExp: number;
    contributionName: string;
    contributionHashBlake2b512: string;
  } & (
    | {
        source: "drand";
        chainHash: string;
        round: number;
        verificationMethod: "drand-bls-signature-and-chain-hash";
      }
    | {
        source: "ethereum-block";
        chainId: number;
        blockNumber: number;
        blockHash: string;
        verificationMethod: "ethereum-finalized-block-hash";
      }
  );
  toolchain: {
    snarkjsVersion: "0.7.6";
    solidityTemplateSha256: string;
  };
  outputs: {
    importedSealedZkey?: { fileName: "sealed-import.zkey"; sha256: string; byteLength: number };
    finalZkey: { fileName: "final.zkey"; sha256: string; byteLength: number };
    verificationKey: {
      fileName: "verification_key.json";
      sha256: string;
      byteLength: number;
      publicInputCount: 20;
    };
    solidityVerifier: {
      fileName: "Verifier.sol";
      sha256: string;
      byteLength: number;
    };
    beaconEvidence: {
      fileName: "drand-evidence.json" | "ethereum-block-evidence.json";
      sha256: string;
      byteLength: number;
    };
  };
}
