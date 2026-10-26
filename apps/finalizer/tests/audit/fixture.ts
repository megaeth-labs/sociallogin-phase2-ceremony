import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHECKPOINT_SIGNATURE_DOMAIN,
  GENESIS_EVENT_HASH,
  MANIFEST_SIGNATURE_DOMAIN,
  OPERATIONAL_UPDATE_DOMAIN,
  PRIMARY_PUBLICATION_DOMAIN,
  RECEIPT_SIGNATURE_DOMAIN,
  TRANSCRIPT_EVENT_SIGNATURE_DOMAIN,
  VERIFICATION_REPORT_SIGNATURE_DOMAIN,
  canonicalSha256,
  canonicalize,
  operationalUpdateHash,
  signEnvelope,
  transcriptEventHash,
  type ArtifactRef,
  type CeremonyManifestV1,
  type ContributionReceiptV1,
  type HeadCheckpointV1,
  type JsonValue,
  type OperationalUpdate,
  type PrimaryPublication,
  type SignedEnvelope,
  type TranscriptEventV1,
  type VerificationReportV1,
} from "@moss/phase2-protocol";
import { inspectBellmanAppend } from "@moss/phase2-zkey-inspect";

import type { AuditOptions } from "../../src/audit/audit.js";
import type { OperationalUpdateHistory } from "../../src/audit/records.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const NATIVE_VERIFIER = join(HERE, "../../../../packages/bellman-verify/target/release/moss-bellman-verify");
const ARCHIVE = "https://archive.example/";
const CEREMONY_ID = "123e4567-e89b-42d3-a456-426614174000";

export interface FixtureHooks {
  /** Replace an artifact's bytes before anything is hashed or signed over it. */
  params?: (generation: number, bytes: Buffer) => Buffer | Promise<Buffer>;
  /** Override the claimed identifier everywhere it is signed. */
  claimedHash?: (generation: number, actual: string) => string;
  receipt?: (generation: number, receipt: ContributionReceiptV1) => void;
  receiptSigner?: (generation: number) => "coordinator" | "rogue";
  event?: (generation: number, event: TranscriptEventV1) => void;
  report?: (generation: number, report: VerificationReportV1) => void;
}

export interface AuditFixture {
  root: string;
  mirror: string;
  chain: string;
  contributions: number;
  manifest: CeremonyManifestV1;
  receipts: SignedEnvelope<ContributionReceiptV1>[];
  /** Mirror-relative paths, for tests that damage the archive afterwards. */
  paths: { bundles: string[]; checkpoints: string[]; artifacts: string[] };
  options(workDir?: string): AuditOptions;
}

let chainCache: Promise<string> | undefined;

/** One synthetic Bellman chain per test file; fixtures copy what they need. */
async function syntheticChain(count: number): Promise<string> {
  chainCache ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "moss-audit-chain-"));
    const result = spawnSync(process.execPath, [join(HERE, "generate-bellman-chain.mjs"), directory, "8"], { stdio: "ignore", timeout: 120_000 });
    if (result.status !== 0) throw new Error("synthetic Bellman chain generation failed");
    return directory;
  })();
  const directory = await chainCache;
  if (count > 8) throw new Error("fixture supports at most 8 contributions");
  return directory;
}

export async function createAuditFixture(options: { contributions?: number; hooks?: FixtureHooks } = {}): Promise<AuditFixture> {
  const contributions = options.contributions ?? 3;
  const hooks = options.hooks ?? {};
  const source = await syntheticChain(contributions);
  const root = await mkdtemp(join(tmpdir(), "moss-audit-fixture-"));
  const mirror = join(root, "mirror");
  const chain = join(root, "chain");
  await mkdir(chain, { recursive: true });

  const rootKey = generateKeyPairSync("ed25519");
  const coordinator = generateKeyPairSync("ed25519");
  const verifier = generateKeyPairSync("ed25519");
  const rogue = generateKeyPairSync("ed25519");
  const pem = (key: KeyObject) => key.export({ type: "spki", format: "pem" }).toString();

  const refs: ArtifactRef[] = [];
  const paths = { bundles: [] as string[], checkpoints: [] as string[], artifacts: [] as string[] };
  for (let generation = 0; generation <= contributions; generation += 1) {
    let bytes: Buffer = await readFile(join(source, `${generation}.params`));
    if (hooks.params && generation > 0) bytes = await hooks.params(generation, Buffer.from(bytes));
    await writeFile(join(chain, `${generation}.params`), bytes);
    const sha256 = sha(bytes);
    const relative = generation === 0
      ? `inputs/sha256/${sha256}/genesis.params`
      : `canonical/${CEREMONY_ID}/sha256/${sha256}.zkey`;
    refs.push({ sha256, byteLength: bytes.byteLength, urls: [`${ARCHIVE}${relative}?versionId=v${generation}`] });
    paths.artifacts.push(relative);
    await put(mirror, relative, bytes);
  }

  const webRelease = { sha256: sha(Buffer.from("web-release")), byteLength: 11, urls: ["https://releases.example/web.json"], sourceCommit: "d".repeat(40) };
  const updatedWebRelease = { sha256: sha(Buffer.from("web-release-2")), byteLength: 13, urls: ["https://releases.example/web-2.json"], sourceCommit: "f".repeat(40) };
  const updatedCliRelease = { sha256: sha(Buffer.from("cli-2")), byteLength: 5, urls: ["https://releases.example/cli-2.js"], sourceCommit: "c".repeat(40) };
  const manifest: CeremonyManifestV1 = {
    schemaVersion: 1,
    purpose: "production",
    operationalPolicy: { minHeartbeatGraceSeconds: 30, maxHeartbeatGraceSeconds: 600, allowWebReleaseUpdates: true, allowCliReleaseUpdates: true },
    primaryPublication: { archiveBaseUrl: ARCHIVE },
    ceremonyId: CEREMONY_ID,
    slug: "moss-google-rs256-zksync-v3",
    relation: {
      profile: "google-rs256-zksync-v3",
      relationId: "google-rs256-zksync-v3-groth16-bn254-2",
      verifierVersion: 4,
      proofSystem: "groth16",
      curve: "bn254",
      sourceRepository: "https://example.test/moss-zk.git",
      sourceCommit: "a".repeat(40),
      sourceClosureSha256: "b".repeat(64),
      circomVersion: "2.2.3",
      snarkjsVersion: "0.7.6",
      r1cs: { sha256: "1".repeat(64), byteLength: 10, urls: ["https://archive.example/circuit.r1cs"] },
      ptau: { sha256: "2".repeat(64), byteLength: 10, urls: ["https://archive.example/pot.ptau"], blake2b512: "3".repeat(128) },
      genesisZkey: { sha256: "4".repeat(64), byteLength: 10, urls: ["https://archive.example/genesis.zkey"] },
      genesisBellman: refs[0]!,
    },
    schedule: { opensAt: "2025-01-01T00:00:00.000Z", sealsAt: "2025-01-02T00:00:00.000Z" },
    beacon: {
      source: "ethereum-block", chainId: 1, blockNumber: 22_000_000, expectedAt: "2025-01-03T00:00:00.000Z",
      derivation: "MOSS_PHASE2_BEACON_V1", numIterationsExp: 10, contributionName: "final",
    },
    coordinatorKeys: [{ keyId: "coordinator-1", algorithm: "Ed25519", publicKeyPem: pem(coordinator.publicKey) }],
    verifierKeys: [{ keyId: "verifier-a", algorithm: "Ed25519", publicKeyPem: pem(verifier.publicKey), verifierImageDigest: `sha256:${"5".repeat(64)}` }],
    verifierPolicy: { verificationMethod: "bellman-transition-v1", operatorKeyIds: ["verifier-a"], requiredOperators: 1, passesPerOperator: 1 },
    contributionPolicy: {
      targetContributions: 100, maximumContributions: 100, maxArtifactByteLength: 1_000_000, requirePinnedClientRelease: true,
      lease: { offerSeconds: 120, absoluteSeconds: 5_400, heartbeatSeconds: 300 }, verifierJobSeconds: 1_800, verifierMaxAttempts: 3,
    },
    webRelease,
    cliReleases: [{ sha256: sha(Buffer.from("cli")), byteLength: 3, urls: ["https://releases.example/cli.js"], sourceCommit: "e".repeat(40) }],
  };
  const manifestEnvelope = signEnvelope(manifest as unknown as JsonValue, { keyId: "root-1", privateKey: rootKey.privateKey, domain: MANIFEST_SIGNATURE_DOMAIN });
  const manifestSha256 = canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest as unknown as JsonValue);

  // One root-signed update: a website release used from generation 2 on, and a
  // CLI release used by generation 3, the one CLI contribution.
  const update = signEnvelope({
    schemaVersion: 1, type: "moss.phase2.operational-update.v1", ceremonyId: CEREMONY_ID, manifestSha256,
    sequence: 1, previousUpdateSha256: null, authorizedAt: "2025-01-01T01:00:00.000Z",
    reason: "Authorize reviewed website and CLI releases.", webRelease: updatedWebRelease, cliRelease: updatedCliRelease,
  } satisfies OperationalUpdate as unknown as JsonValue, { keyId: "root-1", privateKey: rootKey.privateKey, domain: OPERATIONAL_UPDATE_DOMAIN }) as unknown as SignedEnvelope<OperationalUpdate>;
  const updateKey = `evidence/${CEREMONY_ID}/operations/1/${operationalUpdateHash(update)}.json`;
  const updateBytes = Buffer.from(canonicalize(update as unknown as JsonValue));
  await put(mirror, updateKey, updateBytes);
  const operationalUpdates: OperationalUpdateHistory = { updates: [update], archives: [{ key: updateKey, versionId: "u1", sha256: sha(updateBytes) }] };

  const publications: SignedEnvelope<PrimaryPublication>[] = [];
  const receipts: SignedEnvelope<ContributionReceiptV1>[] = [];
  let eventHash = GENESIS_EVENT_HASH;
  const publish = async (generation: number, bundle: JsonValue) => {
    const bytes = Buffer.from(canonicalize(bundle));
    const bundleSha256 = sha(bytes);
    const relative = `evidence/${CEREMONY_ID}/${generation}/${bundleSha256}.json`;
    await put(mirror, relative, bytes);
    const record = signEnvelope({
      type: "moss.phase2.primary-publication.v1", ceremonyId: CEREMONY_ID, eventSequence: generation, eventHash,
      bundleSha256, archive: { url: `${ARCHIVE}${relative}?versionId=b${generation}`, versionId: `b${generation}`, sha256: bundleSha256 },
    } satisfies PrimaryPublication as unknown as JsonValue, { keyId: "coordinator-1", privateKey: coordinator.privateKey, domain: PRIMARY_PUBLICATION_DOMAIN }) as unknown as SignedEnvelope<PrimaryPublication>;
    const checkpointPath = `evidence/${CEREMONY_ID}/${generation}/checkpoint-${bundleSha256}.json`;
    await put(mirror, checkpointPath, Buffer.from(canonicalize(record as unknown as JsonValue)));
    publications.push(record);
    paths.bundles.push(relative);
    paths.checkpoints.push(checkpointPath);
  };

  await publish(0, {
    type: "moss.phase2.publication.v1", manifest: manifestEnvelope as unknown as JsonValue,
    head: { generation: 0, sha256: refs[0]!.sha256, byteLength: refs[0]!.byteLength, eventSequence: 0, eventHash },
    receipt: null, event: null, reports: [],
  });

  for (let generation = 1; generation <= contributions; generation += 1) {
    const appended = await inspectBellmanAppend(join(chain, `${generation - 1}.params`), join(chain, `${generation}.params`), generation - 1)
      .catch(() => ({ contributionHashBlake2b512: "6".repeat(128) }));
    const contributionHash = hooks.claimedHash?.(generation, appended.contributionHashBlake2b512) ?? appended.contributionHashBlake2b512;
    const acceptedAt = new Date(Date.parse("2025-01-01T02:00:00.000Z") + generation * 60_000).toISOString();
    const submissionId = randomUUID();
    const clientKind = generation === 3 ? "cli" : "browser";
    const release = clientKind === "cli" ? updatedCliRelease.sha256 : generation >= 2 ? updatedWebRelease.sha256 : webRelease.sha256;
    const name = `moss-${generation}`;
    const event: TranscriptEventV1 = {
      schemaVersion: 1, ceremonyId: CEREMONY_ID, sequence: generation, previousEventHash: eventHash,
      eventType: "CONTRIBUTION_ACCEPTED",
      payload: {
        submissionId, generation, predecessorSha256: refs[generation - 1]!.sha256, successorSha256: refs[generation]!.sha256,
        contributionHashBlake2b512: contributionHash, contributionName: name, clientKind, clientReleaseSha256: release,
      },
      createdAt: acceptedAt,
    };
    hooks.event?.(generation, event);
    eventHash = transcriptEventHash(event);
    const receipt: ContributionReceiptV1 = {
      schemaVersion: 1, type: "moss.phase2.receipt.v1", ceremonyId: CEREMONY_ID, relationManifestSha256: manifestSha256,
      sequence: generation, generation, predecessor: refs[generation - 1]!, successor: refs[generation]!,
      contributionIndex: generation, contributionName: name, contributionHashBlake2b512: contributionHash,
      participantPseudonym: `participant-${generation % 2}`, clientKind, clientReleaseSha256: release,
      acceptedAt, transcriptEventHash: eventHash,
    };
    hooks.receipt?.(generation, receipt);
    const report: VerificationReportV1 = {
      verificationMethod: "bellman-transition-v1", schemaVersion: 1, type: "moss.phase2.verification-report.v1",
      ceremonyId: CEREMONY_ID, submissionId, jobId: randomUUID(), jobAttempt: 1,
      predecessorSha256: refs[generation - 1]!.sha256, candidateSha256: refs[generation]!.sha256, genesisSha256: refs[0]!.sha256,
      expectedContributionName: name, expectedContributionHashBlake2b512: contributionHash, expectedContributionIndex: generation,
      observedContributionName: null, observedContributionHashBlake2b512: contributionHash, observedContributionIndex: generation,
      operatorKeyId: "verifier-a", verifierImageDigest: `sha256:${"5".repeat(64)}`, snarkjsVersion: "0.7.6", passNumber: 1,
      checks: { objectHash: true, framing: true, exactPrefix: true, exactlyOneContribution: true, contributionMetadata: true,
        contributionHash: true, verifyFromInit: false, bellmanTransition: true },
      result: "valid", startedAt: new Date(Date.parse(acceptedAt) - 30_000).toISOString(),
      completedAt: new Date(Date.parse(acceptedAt) - 10_000).toISOString(),
    };
    hooks.report?.(generation, report);
    const receiptKey = hooks.receiptSigner?.(generation) === "rogue" ? rogue.privateKey : coordinator.privateKey;
    const receiptEnvelope = signEnvelope(receipt as unknown as JsonValue, { keyId: "coordinator-1", privateKey: receiptKey, domain: RECEIPT_SIGNATURE_DOMAIN }) as unknown as SignedEnvelope<ContributionReceiptV1>;
    receipts.push(receiptEnvelope);
    await publish(generation, {
      type: "moss.phase2.publication.v1", manifest: manifestEnvelope as unknown as JsonValue,
      head: { generation, sha256: refs[generation]!.sha256, byteLength: refs[generation]!.byteLength, eventSequence: generation, eventHash },
      receipt: receiptEnvelope as unknown as JsonValue,
      event: signEnvelope(event as unknown as JsonValue, { keyId: "coordinator-1", privateKey: coordinator.privateKey, domain: TRANSCRIPT_EVENT_SIGNATURE_DOMAIN }) as unknown as JsonValue,
      reports: [signEnvelope(report as unknown as JsonValue, { keyId: "verifier-a", privateKey: verifier.privateKey, domain: VERIFICATION_REPORT_SIGNATURE_DOMAIN }) as unknown as JsonValue],
    });
  }

  const head = refs[contributions]!;
  const checkpoint: HeadCheckpointV1 = {
    schemaVersion: 1, type: "moss.phase2.checkpoint.v1", ceremonyId: CEREMONY_ID, state: "SEALED", revision: contributions,
    generation: contributions, headSha256: head.sha256, headByteLength: head.byteLength, eventSequence: contributions, eventHash,
    issuedAt: "2025-01-02T00:05:00.000Z", expiresAt: "2025-01-02T00:10:00.000Z",
  };
  const inputs = join(root, "inputs");
  await mkdir(inputs);
  await writeFile(join(inputs, "manifest.json"), JSON.stringify(manifestEnvelope));
  await writeFile(join(inputs, "checkpoint.json"), JSON.stringify(signEnvelope(checkpoint as unknown as JsonValue,
    { keyId: "coordinator-1", privateKey: coordinator.privateKey, domain: CHECKPOINT_SIGNATURE_DOMAIN })));
  await writeFile(join(inputs, "root.pem"), pem(rootKey.publicKey));
  const rootSpki = sha(rootKey.publicKey.export({ type: "spki", format: "der" }));

  return {
    root, mirror, chain, contributions, manifest, receipts, paths,
    options: (workDir = join(root, "work")) => ({
      manifestEnvelopePath: join(inputs, "manifest.json"),
      rootPublicKeyPath: join(inputs, "root.pem"),
      expectedRootKeyId: "root-1",
      expectedRootKeySpkiSha256: rootSpki,
      sealedCheckpointEnvelopePath: join(inputs, "checkpoint.json"),
      expectedSealedHeadSha256: head.sha256,
      expectedSealedHeadByteLength: head.byteLength,
      publications: structuredClone(publications),
      operationalUpdates: structuredClone(operationalUpdates),
      workDir,
      scope: "full",
    }),
  };
}

async function put(root: string, relative: string, bytes: Buffer): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function sha(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
