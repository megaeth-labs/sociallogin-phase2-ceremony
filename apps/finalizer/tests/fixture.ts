import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHECKPOINT_SIGNATURE_DOMAIN,
  MANIFEST_SIGNATURE_DOMAIN,
  signEnvelope,
  type CeremonyManifestV1,
  type CeremonyState,
  type HeadCheckpointV1,
  type JsonValue,
  type PublicKeyRef,
  type VerifierKeyRef,
} from "@moss/phase2-protocol";

import type {
  BeaconResolver,
  FinalizeOptions,
  Phase2Backend,
  VerifiedBeaconV1,
} from "../src/types.js";
import {
  computeDrandChainInfoHash,
  deriveMossPhase2BeaconV1,
  serializeDrandEvidence,
} from "../src/beacon.js";
import { sha256Bytes } from "../src/hashing.js";

const TEST_DRAND_CHAIN_INFO = {
  publicKey: "12".repeat(48),
  periodSeconds: 30,
  genesisTime: 1_732_158_750,
  groupHash: "34".repeat(32),
  schemeId: "pedersen-bls-chained" as const,
  beaconId: "default",
  roundTime: "2025-01-03T00:00:00.000Z",
};
const TEST_DRAND_CHAIN_HASH = computeDrandChainInfoHash(TEST_DRAND_CHAIN_INFO);

export interface TestFixture {
  root: string;
  options: FinalizeOptions;
  manifest: CeremonyManifestV1;
  headBytes: Buffer;
}

export async function createTestFixture(
  options: {
    bellman?: boolean;
    checkpointState?: CeremonyState;
    rehearsal?: boolean;
    ethereum?: boolean;
    checkpointGeneration?: number;
    sourceCommitLength?: 40 | 64;
    beaconNumIterationsExp?: number;
  } = {},
): Promise<TestFixture> {
  const root = await mkdtemp(join(tmpdir(), "moss-finalizer-test-"));
  const inputs = join(root, "inputs");
  await mkdir(inputs);
  const rootKey = generateKeyPairSync("ed25519");
  const coordinatorKey = generateKeyPairSync("ed25519");
  const verifierKeyA = generateKeyPairSync("ed25519");
  const verifierKeyB = generateKeyPairSync("ed25519");

  const r1csBytes = Buffer.from("test-r1cs-bytes-v1");
  const ptauBytes = Buffer.from("test-ptau-bytes-v1");
  const headBytes = options.bellman ? bellmanFixture(2) : Buffer.from("test-sealed-head-v1");
  const r1csPath = join(inputs, "circuit.bin");
  const ptauPath = join(inputs, "ptau.bin");
  const sealedHeadPath = join(inputs, "sealed-head.bin");
  await Promise.all([
    writeFile(r1csPath, r1csBytes),
    writeFile(ptauPath, ptauBytes),
    writeFile(sealedHeadPath, headBytes),
  ]);

  const manifest: CeremonyManifestV1 = {
    schemaVersion: 1,
    ceremonyId: "123e4567-e89b-42d3-a456-426614174000",
    slug: "moss-google-rs256-zksync-v3",
    relation: {
      profile: "google-rs256-zksync-v3",
      relationId: "google-rs256-zksync-v3-groth16-bn254-2",
      verifierVersion: 4,
      proofSystem: "groth16",
      curve: "bn254",
      sourceRepository: "https://example.test/moss-zk.git",
      sourceCommit: "a".repeat(options.sourceCommitLength ?? 40),
      sourceClosureSha256: "b".repeat(64),
      circomVersion: "2.2.3",
      snarkjsVersion: "0.7.6",
      r1cs: artifact(r1csBytes, "r1cs"),
      ptau: {
        ...artifact(ptauBytes, "ptau"),
        blake2b512: digest("blake2b512", ptauBytes),
      },
      genesisZkey: {
        sha256: "c".repeat(64),
        byteLength: 123,
        urls: ["https://example.test/genesis.zkey"],
      },
    },
    schedule: {
      opensAt: "2025-01-01T00:00:00.000Z",
      sealsAt: "2025-01-02T00:00:00.000Z",
    },
    beacon: {
      source: "drand",
      chainHash: TEST_DRAND_CHAIN_HASH,
      round: 123456,
      expectedAt: "2025-01-03T00:00:00.000Z",
      derivation: "MOSS_PHASE2_BEACON_V1",
      numIterationsExp: options.beaconNumIterationsExp ?? 10,
      contributionName: "moss-final-beacon",
    },
    coordinatorKeys: [publicKeyRef("coordinator-1", coordinatorKey.publicKey)],
    verifierKeys: [
      verifierKeyRef("verifier-1", verifierKeyA.publicKey, "4"),
      verifierKeyRef("verifier-2", verifierKeyB.publicKey, "5"),
    ],
    verifierPolicy: {
      operatorKeyIds: ["verifier-1", "verifier-2"],
      requiredOperators: 2,
      passesPerOperator: 1,
    },
    contributionPolicy: {
      targetContributions: 2,
      maximumContributions: 2,
      maxArtifactByteLength: 1_000_000_000,
      requirePinnedClientRelease: true,
      lease: {
        offerSeconds: 120,
        absoluteSeconds: 5_400,
        heartbeatSeconds: 15,
      },
      verifierJobSeconds: 3_600,
      verifierMaxAttempts: 3,
    },
    webRelease: {
      ...artifact(Buffer.from("web-release"), "web"),
      sourceCommit: "d".repeat(options.sourceCommitLength ?? 40),
    },
    cliReleases: [
      {
        ...artifact(Buffer.from("cli-release"), "cli"),
        sourceCommit: "e".repeat(options.sourceCommitLength ?? 40),
      },
    ],
  };

  if (options.rehearsal) {
    manifest.purpose = "rehearsal";
    manifest.verifierKeys = manifest.verifierKeys.slice(0, 1);
    manifest.verifierPolicy.operatorKeyIds = manifest.verifierPolicy.operatorKeyIds.slice(0, 1);
    manifest.verifierPolicy.requiredOperators = 1;
  }
  if (options.ethereum) manifest.beacon = {
    source: "ethereum-block", chainId: 1, blockNumber: 22000000,
    expectedAt: manifest.beacon.expectedAt, derivation: "MOSS_PHASE2_BEACON_V1",
    numIterationsExp: manifest.beacon.numIterationsExp, contributionName: manifest.beacon.contributionName,
  };
  if (options.bellman) {
    const original = Buffer.from("original-genesis-zkey");
    const genesis = bellmanFixture(0);
    manifest.verifierPolicy.verificationMethod = "bellman-transition-v1";
    manifest.relation.genesisZkey = { sha256: digest("sha256", original), byteLength: original.length, urls: ["https://artifacts.example/genesis.zkey"] };
    manifest.relation.genesisBellman = { sha256: digest("sha256", genesis), byteLength: genesis.length, urls: ["https://artifacts.example/genesis.params"] };
    await writeFile(join(inputs, "genesis.zkey"), original);
  }
  const manifestEnvelope = signEnvelope(
    manifest as unknown as JsonValue,
    {
      keyId: "root-1",
      privateKey: rootKey.privateKey,
      domain: MANIFEST_SIGNATURE_DOMAIN,
    },
  );
  const manifestEnvelopePath = join(inputs, "manifest.json");
  await writeFile(manifestEnvelopePath, JSON.stringify(manifestEnvelope));

  const checkpoint: HeadCheckpointV1 = {
    schemaVersion: 1,
    type: "moss.phase2.checkpoint.v1",
    ceremonyId: manifest.ceremonyId,
    state: options.checkpointState ?? "SEALED",
    revision: 9,
    generation: options.checkpointGeneration ?? 2,
    headSha256: digest("sha256", headBytes),
    headByteLength: headBytes.byteLength,
    eventSequence: 15,
    eventHash: "9".repeat(64),
    issuedAt: "2025-01-02T00:00:00.000Z",
    expiresAt: "2035-01-02T00:00:00.000Z",
  };
  const checkpointEnvelope = signEnvelope(
    checkpoint as unknown as JsonValue,
    {
      keyId: "coordinator-1",
      privateKey: coordinatorKey.privateKey,
      domain: CHECKPOINT_SIGNATURE_DOMAIN,
    },
  );
  const sealedCheckpointEnvelopePath = join(inputs, "checkpoint.json");
  await writeFile(
    sealedCheckpointEnvelopePath,
    JSON.stringify(checkpointEnvelope),
  );

  const rootPublicKeyPath = join(inputs, "root-public.pem");
  await writeFile(
    rootPublicKeyPath,
    rootKey.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
  );

  return {
    root,
    manifest,
    headBytes,
    options: {
      genesisZkeyPath: options.bellman ? join(inputs, "genesis.zkey") : undefined,
      manifestEnvelopePath,
      rootPublicKeyPath,
      expectedRootKeyId: "root-1",
      expectedRootKeySpkiSha256: digest(
        "sha256",
        rootKey.publicKey.export({ type: "spki", format: "der" }),
      ),
      sealedCheckpointEnvelopePath,
      sealedHeadPath,
      expectedSealedHeadSha256: checkpoint.headSha256,
      expectedSealedHeadByteLength: checkpoint.headByteLength,
      r1csPath,
      ptauPath,
      outputDir: join(root, "final"),
    },
  };
}

export class TestBeaconResolver implements BeaconResolver {
  constructor(
    private readonly override: Partial<VerifiedBeaconV1> = {},
  ) {}

  async resolve(
    spec: CeremonyManifestV1["beacon"],
  ): Promise<VerifiedBeaconV1> {
    const signature = "56".repeat(96);
    const randomness = sha256Bytes(Buffer.from(signature, "hex"));
    const beaconHashHex = deriveMossPhase2BeaconV1({
      chainHash: spec.chainHash,
      round: spec.round,
      randomness,
    });
    const evidence = {
      schemaVersion: 1 as const,
      type: "moss.phase2.drand-evidence.v1" as const,
      chainHash: spec.chainHash,
      round: spec.round,
      chainInfo: TEST_DRAND_CHAIN_INFO,
      beacon: {
        round: spec.round,
        randomness,
        signature,
        previousSignature: "78".repeat(96),
      },
      sources: [
        {
          endpoint: "https://a.example.test",
          infoUrl: `https://a.example.test/${spec.chainHash}/info`,
          beaconUrl: `https://a.example.test/${spec.chainHash}/public/${spec.round}`,
        },
        {
          endpoint: "https://b.example.test",
          infoUrl: `https://b.example.test/${spec.chainHash}/info`,
          beaconUrl: `https://b.example.test/${spec.chainHash}/public/${spec.round}`,
        },
      ],
      verification: {
        implementation: "drand-client" as const,
        implementationVersion: "1.4.2" as const,
        chainInfoHashAlgorithm: "drand-chain-info-v1" as const,
        beaconVerification: "bls-signature-and-sha256-randomness" as const,
        sourceAgreement: "all-configured-distinct-origins" as const,
      },
      derivation: {
        name: "MOSS_PHASE2_BEACON_V1" as const,
        encoding:
          "sha256(utf8(domain)||00||chainHash32||uint64be(round)||randomness32)" as const,
        beaconHashHex,
      },
    };
    const base: VerifiedBeaconV1 = {
      schemaVersion: 1,
      source: "drand",
      chainHash: spec.chainHash,
      round: spec.round,
      derivation: spec.derivation,
      beaconHashHex,
      evidenceSha256: sha256Bytes(serializeDrandEvidence(evidence)),
      evidence,
      verifier: {
        id: "moss-finalizer/drand-client",
        version: "1.4.2",
        method: "drand-bls-signature-and-chain-hash",
      },
    };
    return { ...base, ...this.override };
  }
}

export class TestBackend implements Phase2Backend {
  readonly verifyResults: boolean[] = [true, true];
  applyCalls = 0;
  inspectBeaconCount = 0;
  appendFails = false;
  verificationKeyPublicInputs = 20;

  async metadata() {
    return {
      snarkjsVersion: "0.7.6" as const,
      solidityTemplateSha256: "1".repeat(64),
    };
  }

  async inspectSealedHead() {
    return {
      contributionCount: 2,
      beaconContributionCount: this.inspectBeaconCount,
      nPublic: 20,
    };
  }

  async verifyFromR1cs() {
    return this.verifyResults.shift() ?? true;
  }

  async applyBeacon(input: { finalZkeyPath: string }) {
    this.applyCalls += 1;
    await writeFile(input.finalZkeyPath, "deterministic-final-zkey");
    return { contributionHashBlake2b512: "2".repeat(128) };
  }

  async verifyBeaconAppend() {
    if (this.appendFails) throw new Error("test append rejected");
    return {
      predecessorCount: 2,
      candidateCount: 3,
      contributionIndex: 3,
      contributionHashBlake2b512: "2".repeat(128),
      csHash: "3".repeat(128),
    };
  }

  async exportVerificationKey() {
    return {
      protocol: "groth16",
      curve: "bn128",
      nPublic: this.verificationKeyPublicInputs,
      IC: Array.from(
        { length: this.verificationKeyPublicInputs + 1 },
        (_, index) => [String(index), "0", "1"],
      ),
      vk_alpha_1: ["1", "2", "1"],
    };
  }

  async exportSolidityVerifier() {
    return "// deterministic test verifier\ncontract Verifier {}\n";
  }
}

function publicKeyRef(keyId: string, key: KeyObject): PublicKeyRef {
  return {
    keyId,
    algorithm: "Ed25519",
    publicKeyPem: key.export({ type: "spki", format: "pem" }).toString(),
  };
}

function verifierKeyRef(
  keyId: string,
  key: KeyObject,
  digestNibble: string,
): VerifierKeyRef {
  return {
    ...publicKeyRef(keyId, key),
    verifierImageDigest: `sha256:${digestNibble.repeat(64)}`,
  };
}

function artifact(bytes: Uint8Array, name: string) {
  return {
    sha256: digest("sha256", bytes),
    byteLength: bytes.byteLength,
    urls: [`https://example.test/${name}.bin`],
  };
}

function digest(
  algorithm: "sha256" | "blake2b512",
  bytes: Uint8Array,
): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

export function bellmanFixture(count: number): Buffer {
  const bytes = Buffer.alloc(668 + count * 384);
  bytes.writeUInt32BE(count, 664);
  return bytes;
}
