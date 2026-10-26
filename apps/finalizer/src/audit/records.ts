import { createHash, type KeyObject } from "node:crypto";

import {
  GENESIS_EVENT_HASH,
  RECEIPT_SIGNATURE_DOMAIN,
  TRANSCRIPT_EVENT_SIGNATURE_DOMAIN,
  VERIFICATION_REPORT_SIGNATURE_DOMAIN,
  assertReceipt,
  assertVerificationReport,
  authorizedCliReleases,
  canonicalize,
  contributionGenesis,
  evaluateVerifierPolicy,
  operationalUpdateHash,
  transcriptEventHash,
  verifyEnvelope,
  verifyOperationalUpdates,
  verifyPrimaryPublication,
  verifyRehearsalWebRelease,
  type ArtifactRef,
  type CeremonyManifestV1,
  type ContributionReceiptV1,
  type HeadCheckpointV1,
  type JsonValue,
  type OperationalUpdate,
  type PrimaryPublication,
  type PublicKeyRef,
  type RehearsalWebReleaseAuthorization,
  type SignedEnvelope,
  type TranscriptEventV1,
  type VerificationReportV1,
} from "@moss/phase2-protocol";

import type { AuditCheckName, AuditFailure, AuditFetcher } from "./types.js";

/** The coordinator caps evidence bundles at 4 MiB before publishing them. */
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_SMALL_RECORD_BYTES = 64 * 1024;
const BELLMAN_RECORD_BYTES = 384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface OperationalUpdateHistory {
  updates: SignedEnvelope<OperationalUpdate>[];
  /** Archive pins as returned by the coordinator; required whenever updates exist. */
  archives?: Array<{ key: string; versionId: string; sha256: string } | null>;
}

export interface RecordsInput {
  manifestEnvelope: SignedEnvelope<CeremonyManifestV1>;
  manifest: CeremonyManifestV1;
  manifestSha256: string;
  rootPublicKey: KeyObject;
  checkpoint: HeadCheckpointV1;
  publications: SignedEnvelope<PrimaryPublication>[];
  operationalUpdates: OperationalUpdateHistory | null;
  /** Optional independent copy of the coordinator's receipt list to cross-check. */
  receipts?: SignedEnvelope<ContributionReceiptV1>[];
  webReleaseAuthorizations?: SignedEnvelope<RehearsalWebReleaseAuthorization>[];
  allowRehearsal: boolean;
  fetcher: AuditFetcher;
}

export interface ChainLink {
  generation: number;
  predecessor: ArtifactRef;
  successor: ArtifactRef;
  contributionHashBlake2b512: string;
  /** Only links whose receipt signature verified are replayed. */
  authenticated: boolean;
}

export interface RecordsResult {
  links: ChainLink[];
  counts: {
    contributions: number;
    distinctParticipants: number;
    publicationBundles: number;
    verifierReports: number;
    operationalUpdates: number;
    browserContributions: number;
    cliContributions: number;
    otherContributions: number;
  };
}

/** Collects every failure instead of stopping at the first. */
export class Findings {
  readonly failures: AuditFailure[] = [];
  readonly items = new Map<AuditCheckName, number>();
  readonly ran = new Set<AuditCheckName>();

  item(check: AuditCheckName, count = 1): void {
    this.ran.add(check);
    this.items.set(check, (this.items.get(check) ?? 0) + count);
  }

  fail(check: AuditCheckName, generation: number | null, message: string): void {
    this.ran.add(check);
    this.failures.push({ check, generation, message });
  }

  /** Runs fn; a thrown error becomes a failure and the result is undefined. */
  async attempt<T>(check: AuditCheckName, generation: number | null, fn: () => T | Promise<T>): Promise<T | undefined> {
    this.ran.add(check);
    try {
      return await fn();
    } catch (error) {
      this.fail(check, generation, error instanceof Error ? error.message : "unknown error");
      return undefined;
    }
  }
}

interface PublicationBundle {
  type: "moss.phase2.publication.v1";
  manifest: SignedEnvelope<CeremonyManifestV1>;
  head: { generation: number; sha256: string; byteLength: number; eventSequence: number; eventHash: string };
  receipt: SignedEnvelope<ContributionReceiptV1> | null;
  event: SignedEnvelope<TranscriptEventV1> | null;
  reports: SignedEnvelope<VerificationReportV1>[];
}

/** A client build and when it was authorized; null when the manifest itself pins it. */
interface ReleaseAuthorization { sha256: string; authorizedAt: string | null }

/**
 * Re-derives the accepted chain from the archived, signed evidence: every
 * publication record and its bundle, receipt, transcript event and verifier
 * report, from the pinned genesis to the sealed checkpoint. Nothing here
 * trusts the coordinator beyond its signatures.
 */
export async function auditRecords(input: RecordsInput, findings: Findings): Promise<RecordsResult> {
  const { manifest, checkpoint } = input;
  const ceremonyId = manifest.ceremonyId;
  const sealed = checkpoint.generation;
  const genesis = contributionGenesis(manifest);
  const releases = await auditReleaseAuthorizations(input, findings);
  const receiptList = input.receipts ? indexReceipts(input.receipts, findings) : undefined;

  const bySequence = new Map<number, SignedEnvelope<PrimaryPublication>>();
  for (const publication of input.publications) {
    const sequence = publication?.payload?.eventSequence;
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      findings.fail("publications", null, "publication record has an invalid event sequence");
    } else if (bySequence.has(sequence)) {
      findings.fail("publications", sequence, "publication record is duplicated");
    } else if (sequence > sealed) {
      findings.fail("publications", sequence, "publication record is later than the sealed checkpoint");
    } else {
      bySequence.set(sequence, publication);
    }
  }

  const links: ChainLink[] = [];
  const participants = new Set<string>();
  const counts = { browser: 0, cli: 0, other: 0, reports: 0, bundles: 0 };
  // null means an earlier failure left the value unknown; later items are
  // still checked on their own terms rather than cascading the same failure.
  let head: { sha256: string; byteLength: number } | null = { sha256: genesis.sha256, byteLength: genesis.byteLength };
  let eventHash: string | null = GENESIS_EVENT_HASH;
  let previousAcceptedAt = manifest.schedule.opensAt;

  for (let generation = 0; generation <= sealed; generation += 1) {
    findings.item("publications");
    const publication = bySequence.get(generation);
    if (!publication) {
      findings.fail("publications", generation, "publication record is missing");
      head = null; eventHash = null;
      continue;
    }
    const record = await findings.attempt("publications", generation, () =>
      verifyPrimaryPublication(publication, manifest, {
        ceremonyId, eventSequence: generation, eventHash: publication.payload.eventHash,
      }));
    if (!record) { head = null; eventHash = null; continue; }

    findings.item("archivedCheckpoints");
    await findings.attempt("archivedCheckpoints", generation, async () => {
      const url = new URL(`evidence/${ceremonyId}/${generation}/checkpoint-${record.bundleSha256}.json`,
        manifest.primaryPublication!.archiveBaseUrl);
      const bytes = await input.fetcher.fetchBytes(url.toString(), MAX_SMALL_RECORD_BYTES);
      if (!bytes.equals(Buffer.from(canonicalize(publication as unknown as JsonValue)))) {
        throw new Error("archived checkpoint differs from the signed publication record");
      }
    });

    const bundle = await findings.attempt("publications", generation, async () => {
      const bytes = await input.fetcher.fetchBytes(record.archive.url, MAX_BUNDLE_BYTES);
      if (createHash("sha256").update(bytes).digest("hex") !== record.bundleSha256) {
        throw new Error("archived evidence bundle does not match its signed hash");
      }
      const value = JSON.parse(bytes.toString("utf8")) as PublicationBundle;
      if (value?.type !== "moss.phase2.publication.v1") throw new Error("evidence bundle type is unsupported");
      if (canonicalize(value.manifest as unknown as JsonValue) !== canonicalize(input.manifestEnvelope as unknown as JsonValue)) {
        throw new Error("evidence bundle carries a different manifest");
      }
      if (value.head?.generation !== generation || value.head.eventSequence !== generation
        || value.head.eventHash !== record.eventHash) {
        throw new Error("evidence bundle head does not match its publication record");
      }
      if (!Array.isArray(value.reports)) throw new Error("evidence bundle reports are malformed");
      return value;
    });
    if (!bundle) { head = null; eventHash = null; continue; }
    counts.bundles += 1;

    if (generation === 0) {
      findings.item("artifactLinkage");
      await findings.attempt("artifactLinkage", 0, () => {
        if (bundle.receipt !== null || bundle.event !== null || bundle.reports.length !== 0) {
          throw new Error("genesis evidence bundle must not contain a contribution");
        }
        if (bundle.head.sha256 !== genesis.sha256 || bundle.head.byteLength !== genesis.byteLength) {
          throw new Error("genesis evidence bundle does not name the pinned genesis");
        }
        if (record.eventHash !== GENESIS_EVENT_HASH) throw new Error("genesis publication must use the genesis event hash");
      });
      continue;
    }

    // Receipt: who the coordinator says contributed, and which bytes.
    findings.item("receipts");
    const receipt = await findings.attempt("receipts", generation, () => {
      if (!bundle.receipt) throw new Error("evidence bundle has no receipt");
      const payload = verifySigned(bundle.receipt, manifest.coordinatorKeys, RECEIPT_SIGNATURE_DOMAIN, "receipt", "coordinator");
      assertReceipt(payload);
      if (payload.ceremonyId !== ceremonyId) throw new Error("receipt belongs to a different ceremony");
      if (payload.generation !== generation || payload.contributionIndex !== generation || payload.sequence !== generation) {
        throw new Error("receipt generation, index and sequence do not match its position");
      }
      if (payload.relationManifestSha256 !== input.manifestSha256) throw new Error("receipt is bound to a different manifest");
      if (payload.transcriptEventHash !== record.eventHash) throw new Error("receipt event hash differs from its publication record");
      if (payload.acceptedAt < manifest.schedule.opensAt || payload.acceptedAt >= manifest.schedule.sealsAt) {
        throw new Error("receipt was accepted outside the signed schedule");
      }
      if (payload.acceptedAt < previousAcceptedAt) throw new Error("receipt acceptance time moved backwards");
      if (receiptList) {
        const listed = receiptList.get(generation);
        if (!listed || canonicalize(listed as unknown as JsonValue) !== canonicalize(bundle.receipt as unknown as JsonValue)) {
          throw new Error("archived receipt differs from the coordinator's receipt list");
        }
      }
      return payload;
    });

    findings.item("artifactLinkage");
    if (receipt) {
      await findings.attempt("artifactLinkage", generation, () => {
        if (head && (receipt.predecessor.sha256 !== head.sha256 || receipt.predecessor.byteLength !== head.byteLength)) {
          throw new Error("receipt predecessor is not the previous accepted head");
        }
        if (receipt.successor.byteLength !== receipt.predecessor.byteLength + BELLMAN_RECORD_BYTES
          && manifest.verifierPolicy.verificationMethod === "bellman-transition-v1") {
          throw new Error("receipt successor is not exactly one Bellman record longer");
        }
        if (receipt.successor.byteLength > manifest.contributionPolicy.maxArtifactByteLength) {
          throw new Error("receipt successor exceeds the signed artifact size limit");
        }
        if (bundle.head.sha256 !== receipt.successor.sha256 || bundle.head.byteLength !== receipt.successor.byteLength) {
          throw new Error("evidence bundle head is not the receipt successor");
        }
      });
      participants.add(receipt.participantPseudonym);
      previousAcceptedAt = receipt.acceptedAt;
      links.push({ generation, predecessor: receipt.predecessor, successor: receipt.successor,
        contributionHashBlake2b512: receipt.contributionHashBlake2b512, authenticated: true });
    }

    // Transcript: the hash chain that orders every acceptance.
    findings.item("transcript");
    const event = await findings.attempt("transcript", generation, () => {
      if (!bundle.event) throw new Error("evidence bundle has no transcript event");
      const payload = verifySigned(bundle.event, manifest.coordinatorKeys, TRANSCRIPT_EVENT_SIGNATURE_DOMAIN, "transcript event", "coordinator");
      const computed = transcriptEventHash(payload);
      if (computed !== record.eventHash || computed !== bundle.head.eventHash) throw new Error("transcript event hash differs from its publication record");
      if (eventHash !== null && payload.previousEventHash !== eventHash) throw new Error("transcript event does not link to the previous event");
      if (payload.sequence !== generation || payload.ceremonyId !== ceremonyId) throw new Error("transcript event sequence or ceremony is wrong");
      if (payload.eventType !== "CONTRIBUTION_ACCEPTED") throw new Error("transcript event type is unsupported");
      const body = payload.payload as Record<string, unknown>;
      if (typeof body?.submissionId !== "string" || !UUID.test(body.submissionId)) throw new Error("transcript event submission ID is invalid");
      if (receipt && (payload.createdAt !== receipt.acceptedAt || body.generation !== generation
        || body.predecessorSha256 !== receipt.predecessor.sha256 || body.successorSha256 !== receipt.successor.sha256
        || body.contributionHashBlake2b512 !== receipt.contributionHashBlake2b512
        || body.contributionName !== receipt.contributionName || body.clientKind !== receipt.clientKind
        || (body.clientReleaseSha256 ?? null) !== receipt.clientReleaseSha256)) {
        throw new Error("transcript event does not match its receipt");
      }
      return { payload, hash: computed, submissionId: body.submissionId };
    });
    eventHash = event ? event.hash : null;

    // Verifier reports: the signed policy decides how many must agree.
    findings.item("verifierReports", bundle.reports.length);
    counts.reports += bundle.reports.length;
    await findings.attempt("verifierReports", generation, () => {
      if (!receipt || !event) throw new Error("verifier reports cannot be bound without an authenticated receipt and event");
      const reports = bundle.reports.map((envelope) => {
        const key = uniqueKey(manifest.verifierKeys, envelope.keyId, "verifier");
        const payload = verifyEnvelope(envelope as unknown as SignedEnvelope<JsonValue>, {
          publicKey: key.publicKeyPem, domain: VERIFICATION_REPORT_SIGNATURE_DOMAIN,
        }) as unknown as VerificationReportV1;
        assertVerificationReport(payload, { production: true });
        if ((payload.verificationMethod ?? "snarkjs-zkey-v1") !== (manifest.verifierPolicy.verificationMethod ?? "snarkjs-zkey-v1")) {
          throw new Error("verifier report method differs from the signed policy");
        }
        if (payload.operatorKeyId !== envelope.keyId || !manifest.verifierPolicy.operatorKeyIds.includes(payload.operatorKeyId)
          || payload.passNumber > manifest.verifierPolicy.passesPerOperator) {
          throw new Error("verifier report operator or pass is not authorized");
        }
        if (payload.verifierImageDigest !== (key as { verifierImageDigest?: string }).verifierImageDigest) {
          throw new Error("verifier report image differs from the signed verifier key");
        }
        if (payload.ceremonyId !== ceremonyId || payload.submissionId !== event.submissionId
          || payload.genesisSha256 !== genesis.sha256
          || payload.predecessorSha256 !== receipt.predecessor.sha256 || payload.candidateSha256 !== receipt.successor.sha256
          || payload.expectedContributionName !== receipt.contributionName
          || payload.expectedContributionHashBlake2b512 !== receipt.contributionHashBlake2b512
          || payload.expectedContributionIndex !== generation) {
          throw new Error("verifier report is not bound to the accepted contribution");
        }
        if (payload.completedAt > receipt.acceptedAt) throw new Error("verifier report completed after acceptance");
        return payload;
      });
      if (!evaluateVerifierPolicy(manifest.verifierPolicy, reports).satisfied) {
        throw new Error("verifier reports do not satisfy the signed verifier policy");
      }
    });

    // Client release: which signed release the contributor reported using.
    findings.item("clientReleases");
    if (receipt) {
      if (receipt.clientKind === "browser") counts.browser += 1;
      else if (receipt.clientKind === "cli") counts.cli += 1;
      else counts.other += 1;
      await findings.attempt("clientReleases", generation, () => {
        if (!manifest.contributionPolicy.requirePinnedClientRelease) return;
        const release = receipt.clientReleaseSha256;
        const candidates = receipt.clientKind === "browser" ? releases.browser : receipt.clientKind === "cli" ? releases.cli : [];
        const allowed = candidates.some((entry) => entry.sha256 === release && (entry.authorizedAt === null || entry.authorizedAt <= receipt.acceptedAt));
        if (!allowed) throw new Error("receipt client release was not authorized when the contribution was accepted");
      });
    }

    if (!receipt) head = null;
    else head = { sha256: receipt.successor.sha256, byteLength: receipt.successor.byteLength };
  }

  findings.item("artifactLinkage");
  await findings.attempt("artifactLinkage", sealed, () => {
    if (checkpoint.eventSequence !== sealed) throw new Error("sealed checkpoint event sequence differs from its generation");
    if (!head || head.sha256 !== checkpoint.headSha256 || head.byteLength !== checkpoint.headByteLength) {
      throw new Error("accepted chain does not end at the sealed checkpoint head");
    }
    if (eventHash !== checkpoint.eventHash) throw new Error("transcript does not end at the sealed checkpoint event");
  });
  if (receiptList) {
    for (const generation of receiptList.keys()) {
      if (generation < 1 || generation > sealed) findings.fail("receipts", generation, "receipt list has an entry outside the sealed chain");
    }
  }

  return {
    links,
    counts: {
      contributions: links.length,
      distinctParticipants: participants.size,
      publicationBundles: counts.bundles,
      verifierReports: counts.reports,
      operationalUpdates: input.operationalUpdates?.updates.length ?? 0,
      browserContributions: counts.browser,
      cliContributions: counts.cli,
      otherContributions: counts.other,
    },
  };
}

/** Operational updates and, for rehearsals, separate web-release authorizations. */
async function auditReleaseAuthorizations(input: RecordsInput, findings: Findings): Promise<{ browser: ReleaseAuthorization[]; cli: ReleaseAuthorization[] }> {
  const { manifest, manifestEnvelope, rootPublicKey } = input;
  const releases: ReleaseAuthorization[] = [{ sha256: manifest.webRelease.sha256, authorizedAt: null }];
  let cli: ReleaseAuthorization[] = authorizedCliReleases(manifest, []);
  const history = input.operationalUpdates;
  findings.item("operationalUpdates", 0);
  if (!history) {
    findings.fail("operationalUpdates", null, "operational update history was not supplied");
  } else {
    findings.item("operationalUpdates", history.updates.length);
    const verified = await findings.attempt("operationalUpdates", null, () => {
      verifyOperationalUpdates(history.updates, manifestEnvelope, rootPublicKey, input.allowRehearsal);
      return true;
    });
    if (verified) {
      cli = authorizedCliReleases(manifest, history.updates);
      for (const [index, update] of history.updates.entries()) {
        if (update.payload.webRelease) releases.push({ sha256: update.payload.webRelease.sha256, authorizedAt: update.payload.authorizedAt });
        await findings.attempt("operationalUpdates", null, async () => {
          const pin = history.archives?.[index];
          if (!pin) throw new Error(`operational update ${update.payload.sequence} has no archive pin`);
          const expectedKey = `evidence/${manifest.ceremonyId}/operations/${update.payload.sequence}/${operationalUpdateHash(update)}.json`;
          if (pin.key !== expectedKey || !pin.versionId || pin.versionId === "null") throw new Error(`operational update ${update.payload.sequence} archive pin is malformed`);
          const url = new URL(pin.key, archiveBase(manifest));
          url.searchParams.set("versionId", pin.versionId);
          const bytes = await input.fetcher.fetchBytes(url.toString(), MAX_SMALL_RECORD_BYTES);
          if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256
            || !bytes.equals(Buffer.from(canonicalize(update as unknown as JsonValue)))) {
            throw new Error(`archived operational update ${update.payload.sequence} differs from the signed update`);
          }
        });
      }
    }
  }
  for (const authorization of input.webReleaseAuthorizations ?? []) {
    findings.item("clientReleases");
    const value = await findings.attempt("clientReleases", null, () => {
      if (!input.allowRehearsal) throw new Error("separate web release authorizations are rehearsal-only");
      return verifyRehearsalWebRelease(authorization, manifestEnvelope, rootPublicKey);
    });
    if (value) releases.push({ sha256: value.release.sha256, authorizedAt: value.authorizedAt });
  }
  return { browser: releases, cli };
}

function indexReceipts(receipts: SignedEnvelope<ContributionReceiptV1>[], findings: Findings): Map<number, SignedEnvelope<ContributionReceiptV1>> {
  const map = new Map<number, SignedEnvelope<ContributionReceiptV1>>();
  for (const receipt of receipts) {
    const generation = receipt?.payload?.generation;
    if (!Number.isSafeInteger(generation)) findings.fail("receipts", null, "receipt list entry has no generation");
    else if (map.has(generation)) findings.fail("receipts", generation, "receipt list entry is duplicated");
    else map.set(generation, receipt);
  }
  return map;
}

function verifySigned<T>(envelope: SignedEnvelope<T>, keys: readonly PublicKeyRef[], domain: string, label: string, role: string): T {
  if (!envelope || typeof envelope !== "object") throw new Error(`${label} envelope is malformed`);
  const key = uniqueKey(keys, envelope.keyId, role);
  try {
    return verifyEnvelope(envelope as unknown as SignedEnvelope<JsonValue>, { publicKey: key.publicKeyPem, domain }) as unknown as T;
  } catch {
    throw new Error(`${label} signature is invalid`);
  }
}

function uniqueKey<K extends PublicKeyRef>(keys: readonly K[], keyId: string, role: string): K {
  const matches = keys.filter((key) => key.keyId === keyId);
  if (matches.length !== 1) throw new Error(`signer is not an authorized ${role} key`);
  return matches[0]!;
}

function archiveBase(manifest: CeremonyManifestV1): string {
  if (!manifest.primaryPublication) throw new Error("manifest has no primary publication archive");
  return manifest.primaryPublication.archiveBaseUrl;
}
