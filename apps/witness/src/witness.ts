import { createHash, type KeyLike } from "node:crypto";
import {
  assertManifest, assertReceipt, assertIsoDate, assertVerificationReport, canonicalize, canonicalSha256,
  contributionGenesis, evaluateVerifierPolicy, GENESIS_EVENT_HASH, MANIFEST_SIGNATURE_DOMAIN,
  PUBLICATION_ACK_DOMAIN, RECEIPT_SIGNATURE_DOMAIN, TRANSCRIPT_EVENT_SIGNATURE_DOMAIN,
  VERIFICATION_REPORT_SIGNATURE_DOMAIN, signEnvelope, transcriptEventHash, verifyEnvelope,
  verifyPublicationAck, type ArtifactRef, type CeremonyManifestV1, type ContributionReceiptV1,
  type JsonValue, type PublicationAck, type SignedEnvelope, type TranscriptEventV1, type VerificationReportV1,
} from "@moss/phase2-protocol";

export interface MirrorArchive {
  read(key: string): Promise<Buffer | null>;
  /** Conditional, locked, hash-verified write. Existing different bytes MUST fail. */
  put(key: string, bytes: Buffer): Promise<{ versionId: string; sha256: string; url: string }>;
  /** Fetch, hash and retain exact artifact bytes before resolving. */
  mirror(artifact: ArtifactRef): Promise<void>;
}
interface Bundle {
  type: "moss.phase2.publication.v1";
  manifest: SignedEnvelope<CeremonyManifestV1>;
  head: { generation: number; sha256: string; byteLength: number; eventSequence: number; eventHash: string };
  receipt: SignedEnvelope<ContributionReceiptV1> | null;
  event: SignedEnvelope<TranscriptEventV1> | null;
  reports: Array<SignedEnvelope<VerificationReportV1>>;
}

export class PublicationWitness {
  private readonly manifest: CeremonyManifestV1;
  private readonly manifestHash: string;
  constructor(private readonly config: {
    manifest: SignedEnvelope<CeremonyManifestV1>; rootPublicKey: KeyLike;
    privateKey: KeyLike; archive: MirrorArchive; allowRehearsal?: boolean;
    now?: () => Date;
  }) {
    this.manifest = verifyEnvelope(config.manifest as never, { publicKey: config.rootPublicKey, domain: MANIFEST_SIGNATURE_DOMAIN }) as unknown as CeremonyManifestV1;
    assertManifest(this.manifest, { production: true, allowRehearsal: config.allowRehearsal });
    if (!this.manifest.publication) throw new Error("witness policy is missing");
    this.manifestHash = canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", this.manifest as unknown as JsonValue);
  }
  async acknowledge(bytes: Buffer): Promise<SignedEnvelope<PublicationAck>> {
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error("invalid publication length");
    const bundle = JSON.parse(bytes.toString("utf8")) as Bundle;
    if (canonicalize(bundle as unknown as JsonValue) !== bytes.toString("utf8")) throw new Error("publication must be canonical JSON");
    const artifact = this.validate(bundle);
    const head = bundle.head;
    const bundleSha256 = createHash("sha256").update(bytes).digest("hex");
    const prefix = `evidence/witness/${this.manifest.ceremonyId}`;
    const ackKey = `${prefix}/${head.eventSequence}/ack.json`;
    const existing = await this.config.archive.read(ackKey);
    if (existing) return this.existingAck(existing, bundle, bundleSha256);
    if (head.generation > 0) {
      const previousBytes = await this.config.archive.read(`${prefix}/${head.eventSequence - 1}/ack.json`);
      if (!previousBytes) throw new Error("witness refuses an unobserved predecessor");
      const previousAck = JSON.parse(previousBytes.toString("utf8")) as SignedEnvelope<PublicationAck>;
      verifyPublicationAck(previousAck, this.manifest.publication!.witness, {
        ceremonyId: this.manifest.ceremonyId, eventSequence: head.eventSequence - 1,
        eventHash: bundle.event!.payload.previousEventHash,
      });
      const previousBundleBytes = await this.config.archive.read(`${prefix}/${head.eventSequence - 1}/${previousAck.payload.bundleSha256}.json`);
      if (!previousBundleBytes || createHash("sha256").update(previousBundleBytes).digest("hex") !== previousAck.payload.bundleSha256) throw new Error("witness predecessor evidence missing");
      const previous = JSON.parse(previousBundleBytes.toString("utf8")) as Bundle;
      this.validate(previous);
      if (previous.head.generation + 1 !== head.generation || previous.head.sha256 !== bundle.receipt!.payload.predecessor.sha256
        || previous.head.byteLength !== bundle.receipt!.payload.predecessor.byteLength) throw new Error("witness refuses a fork");
    }
    await this.config.archive.mirror(artifact);
    const mirror = await this.config.archive.put(`${prefix}/${head.eventSequence}/${bundleSha256}.json`, bytes);
    if (mirror.sha256 !== bundleSha256) throw new Error("mirrored evidence digest mismatch");
    const payload: PublicationAck = { type: "moss.phase2.publication-ack.v1", ceremonyId: this.manifest.ceremonyId,
      eventSequence: head.eventSequence, eventHash: head.eventHash, bundleSha256, mirror,
      witnessedAt: (this.config.now?.() ?? new Date()).toISOString() };
    const ack = signEnvelope(payload as unknown as JsonValue, { privateKey: this.config.privateKey,
      keyId: this.manifest.publication!.witness.keyId, domain: PUBLICATION_ACK_DOMAIN }) as unknown as SignedEnvelope<PublicationAck>;
    verifyPublicationAck(ack, this.manifest.publication!.witness, payload);
    try { await this.config.archive.put(ackKey, Buffer.from(canonicalize(ack as unknown as JsonValue))); }
    catch (error) {
      const raced = await this.config.archive.read(ackKey);
      if (!raced) throw error;
      return this.existingAck(raced, bundle, bundleSha256);
    }
    return ack;
  }
  private existingAck(bytes: Buffer, bundle: Bundle, bundleSha256: string): SignedEnvelope<PublicationAck> {
    const ack = JSON.parse(bytes.toString("utf8")) as SignedEnvelope<PublicationAck>;
    verifyPublicationAck(ack, this.manifest.publication!.witness, { ceremonyId: this.manifest.ceremonyId,
      eventSequence: bundle.head.eventSequence, eventHash: bundle.head.eventHash, bundleSha256 });
    return ack;
  }
  private validate(bundle: Bundle): ArtifactRef {
    if (bundle.type !== "moss.phase2.publication.v1" || canonicalize(bundle.manifest as unknown as JsonValue) !== canonicalize(this.config.manifest as unknown as JsonValue)) throw new Error("publication manifest is not the pinned epoch");
    if (Object.keys(bundle).sort().join(",") !== ["type", "manifest", "head", "receipt", "event", "reports"].sort().join(",")) throw new Error("unsupported publication fields");
    const h = bundle.head;
    if (!h || Object.keys(h).sort().join(",") !== ["generation", "sha256", "byteLength", "eventSequence", "eventHash"].sort().join(",")) throw new Error("unsupported publication head fields");
    if (!h || !Number.isSafeInteger(h.generation) || h.generation < 0 || h.generation > this.manifest.contributionPolicy.maximumContributions
      || h.eventSequence !== h.generation || !/^[a-f0-9]{64}$/.test(h.eventHash) || !Array.isArray(bundle.reports)) throw new Error("invalid publication head");
    if (h.generation === 0) {
      const genesis = contributionGenesis(this.manifest);
      if (h.sha256 !== genesis.sha256 || h.byteLength !== genesis.byteLength || h.eventHash !== GENESIS_EVENT_HASH || bundle.receipt !== null || bundle.event !== null || bundle.reports.length !== 0) throw new Error("invalid genesis publication");
      return genesis;
    }
    if (!bundle.receipt || !bundle.event) throw new Error("missing acceptance evidence");
    const key = this.manifest.coordinatorKeys[0]!;
    for (const envelope of [bundle.receipt, bundle.event]) if (envelope.keyId !== key.keyId) throw new Error("unauthorized coordinator");
    const receipt = verifyEnvelope(bundle.receipt as never, { publicKey: key.publicKeyPem, domain: RECEIPT_SIGNATURE_DOMAIN }) as unknown as ContributionReceiptV1;
    assertReceipt(receipt);
    assertIsoDate(receipt.acceptedAt, "receipt acceptance time");
    if (receipt.successor.byteLength > this.manifest.contributionPolicy.maxArtifactByteLength) throw new Error("artifact exceeds signed maximum");
    if (this.manifest.contributionPolicy.requirePinnedClientRelease) {
      const hashes = receipt.clientKind === "browser" ? [this.manifest.webRelease.sha256] : receipt.clientKind === "cli" ? this.manifest.cliReleases.map(r => r.sha256) : [];
      if (!receipt.clientReleaseSha256 || !hashes.includes(receipt.clientReleaseSha256)) throw new Error("unapproved client release");
    }
    const event = verifyEnvelope(bundle.event as never, { publicKey: key.publicKeyPem, domain: TRANSCRIPT_EVENT_SIGNATURE_DOMAIN }) as unknown as TranscriptEventV1;
    if (receipt.ceremonyId !== this.manifest.ceremonyId || receipt.relationManifestSha256 !== this.manifestHash
      || receipt.generation !== h.generation || receipt.sequence !== h.eventSequence || receipt.successor.sha256 !== h.sha256
      || receipt.successor.byteLength !== h.byteLength || receipt.transcriptEventHash !== h.eventHash
      || receipt.acceptedAt < this.manifest.schedule.opensAt || receipt.acceptedAt >= this.manifest.schedule.sealsAt
      || event.ceremonyId !== receipt.ceremonyId || event.sequence !== h.eventSequence || event.eventType !== "CONTRIBUTION_ACCEPTED"
      || event.createdAt !== receipt.acceptedAt || transcriptEventHash(event) !== h.eventHash) throw new Error("inconsistent acceptance evidence");
    const ep = event.payload as Record<string, JsonValue>;
    for (const [name, value] of Object.entries({ generation: receipt.generation, predecessorSha256: receipt.predecessor.sha256,
      successorSha256: receipt.successor.sha256, contributionHashBlake2b512: receipt.contributionHashBlake2b512,
      contributionName: receipt.contributionName, clientKind: receipt.clientKind, clientReleaseSha256: receipt.clientReleaseSha256 })) {
      if (ep[name] !== value) throw new Error("event differs from receipt");
    }
    const reports = bundle.reports.map(envelope => {
      const operator = this.manifest.verifierKeys.find(k => k.keyId === envelope.keyId);
      if (!operator) throw new Error("unauthorized verifier");
      const report = verifyEnvelope(envelope as never, { publicKey: operator.publicKeyPem, domain: VERIFICATION_REPORT_SIGNATURE_DOMAIN }) as unknown as VerificationReportV1;
      assertVerificationReport(report, { production: true });
      if (report.operatorKeyId !== operator.keyId || report.verifierImageDigest !== operator.verifierImageDigest
        || report.ceremonyId !== receipt.ceremonyId || report.submissionId !== ep.submissionId || report.predecessorSha256 !== receipt.predecessor.sha256
        || report.candidateSha256 !== h.sha256 || report.genesisSha256 !== contributionGenesis(this.manifest).sha256
        || report.expectedContributionIndex !== h.generation || report.expectedContributionName !== receipt.contributionName
        || report.expectedContributionHashBlake2b512 !== receipt.contributionHashBlake2b512
        || report.passNumber > this.manifest.verifierPolicy.passesPerOperator
        || (report.verificationMethod ?? "snarkjs-zkey-v1") !== (this.manifest.verifierPolicy.verificationMethod ?? "snarkjs-zkey-v1")
        || report.result === "invalid") throw new Error("verifier report does not authorize this acceptance");
      return report;
    });
    if (!evaluateVerifierPolicy(this.manifest.verifierPolicy, reports).satisfied) throw new Error("insufficient verifier evidence");
    return receipt.successor;
  }
}
