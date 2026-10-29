import { verifiedFinalization, type CeremonyFinalization } from "./finalization";
import { removeBrowserContributionFile } from "@wonderland/cabure-crypto/browser";
import {
  contributionLockName,
  contributionLockState,
  withContributionLockIfFree,
} from "./contribution-lock";
import { uploadBrowserParts, parseMultipartParts, type MultipartPart, type PartGrant } from "./multipart-upload";
import { buildVerificationGuide } from "./verification-guide";
import type {
  CeremonyManifestV1,
  ContributionReceiptV1,
  HeadCheckpointV1,
  SignedEnvelope,
} from "@moss/phase2-protocol";

const CIRCUIT_ID = "social-login";
const CHECKPOINT_DOMAIN = "MOSS_PHASE2_CHECKPOINT_V1";
const RECEIPT_DOMAIN = "MOSS_PHASE2_RECEIPT_V1";
const MANIFEST_HASH_DOMAIN = "MOSS_PHASE2_MANIFEST_PAYLOAD_V1";
const LOCAL_RECEIPTS_KEY = "moss.phase2.receipts.v1";
const LOCAL_JOURNALS_KEY = "moss.phase2.contribution-journals.v1";
const PARTICIPANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface CircuitStatus {
  circuitId: string;
  targetContributions: number;
  totalContributions: number;
  currentParticipant: string | null;
  queueLength: number;
  latestContributionHash: string | null;
  chainHash: string;
  isComplete: boolean;
}

export interface StatusResponse {
  /** Root-signed offline completion record, checked against the sealed checkpoint. */
  finalization?: CeremonyFinalization;
  /** Lifecycle from the verified coordinator checkpoint. */
  ceremonyState?: string;
  isActive: boolean;
  totalContributions: number;
  targetContributions: number;
  endDate: string | null;
  startedAt: number;
  beaconApplied: boolean;
  /** Precommitted Ethereum block from the signed manifest, when that is the beacon source. */
  beaconBlock?: number;
  circuits: CircuitStatus[];
  /**
   * Byte length of the current canonical head, cross-checked against the
   * coordinator's signed checkpoint above. Lets a client size its storage
   * check before queueing rather than after claiming a lease.
   */
  headByteLength: number;
}

export type CircuitPreviewState =
  | "willRun"
  | "alreadyContributed"
  | "targetReached"
  | "fallback";

export interface TierPreview {
  tierId: string;
  items: Array<{ circuitId: string; state: CircuitPreviewState }>;
}

export interface ParticipantEligibilityResponse {
  participantId: string;
  contributedCircuitIds: string[];
  eligibleCircuitIds: string[];
  hasEligibleCircuits: boolean;
  tierPreviews: TierPreview[];
}

export interface CoordinatorOffer {
  leaseId: string;
  expiresAt: string;
  baseGeneration: number;
  expectedContributionName: string;
  predecessor: {
    sha256: string;
    byteLength: number;
    downloadUrl: string;
  };
}

export interface CoordinatorLease extends CoordinatorOffer {
  state: string;
  submissionId?: string;
}

interface QueueView {
  ticketId: string;
  status: string;
  position: number;
  offer: CoordinatorOffer | null;
}

export interface QueuePosition {
  participantId: string;
  circuitId: string;
  position: number;
  estimatedWaitSeconds: number;
  offer: CoordinatorOffer | null;
  /** The offer is a slot this participant already claimed (ticket LEASED). */
  offerClaimed: boolean;
}

export interface ReceiptResponse {
  success: true;
  receiptId: string;
  circuitId: string;
  participantId: string;
  contributionIndex: number;
  contributionHash: string;
  clientContributionHash: string;
  serverContributionHash: string;
  previousContributionHash: string;
  chainHash: string;
  timestamp: number;
  signedReceipt: SignedEnvelope<ContributionReceiptV1>;
}

interface CoordinatorBootstrap {
  activeWebRelease?: CeremonyManifestV1["webRelease"];
  artifactOrigins?: string[];
  heartbeatGraceSeconds?: number;
  coordinatorBaseUrl: string;
  rootPublicKeyPem: string;
  rootSpkiSha256: string;
  manifest: SignedEnvelope<CeremonyManifestV1>;
}

interface ParticipantToken {
  token: string;
  expiresAt: number;
  participantId: string;
  participantName: string;
}

interface UploadGrant {
  uploadId: string;
  objectKey: string;
  expiresAt: string;
  method: "local-proxy" | "s3-multipart";
  uploadUrl?: string;
  headers?: Record<string, string>;
}

interface SubmissionResponse {
  submissionId: string;
  state: string;
  receiptId?: string;
}

interface UploadStateResponse {
  uploadId: string;
  state: string;
  expiresAt: string;
  artifact?: { sha256: string; byteLength: number };
}

export interface ParticipantStateResponse {
  ceremonyId: string;
  participantId: string;
  queue: QueueView | null;
  lease: CoordinatorLease | null;
  submission: SubmissionResponse | null;
}

const ACTIVE_QUEUE_STATES = new Set(["QUEUED", "OFFERED", "LEASED"]);
const TERMINAL_LEASE_STATES = new Set([
  "EXPIRED",
  "REJECTED",
  "STALE",
  "CANCELLED",
]);
const TERMINAL_SUBMISSION_STATES = new Set([
  "REJECTED",
  "STALE",
  "EXPIRED",
  "CANCELLED",
]);

interface BrowserJournalEvidence {
  manifestSha256: string;
  predecessorSha256: string;
  predecessorByteLength: number;
  successorSha256: string;
  successorByteLength: number;
  contributionHashBlake2b512: string;
  contributionName: string;
  baseGeneration: number;
}

interface BrowserContributionJournal {
  outputFileName?: string;
  /** Written by earlier releases; still parsed so their journals load. */
  multipartParts?: MultipartPart[];
  schemaVersion: 1;
  ceremonyId: string;
  participantId: string;
  queueIdempotencyKey?: string;
  queueTicketId?: string;
  leaseId?: string;
  /** The slot this browser itself claimed; polling records other leases too. */
  claimedLeaseId?: string;
  uploadId?: string;
  submissionId?: string;
  receiptId?: string;
  evidence?: BrowserJournalEvidence;
  updatedAt: string;
}

let bootstrapPromise: Promise<CoordinatorBootstrap> | undefined;
// Resolved copies, so a page being closed can still address the coordinator.
let cachedBootstrap: CoordinatorBootstrap | undefined;
let cachedToken: ParticipantToken | undefined;

export async function getVerificationGuide() {
  const bootstrap = await getBootstrap();
  return await buildVerificationGuide({
    manifest: bootstrap.manifest,
    coordinatorBaseUrl: bootstrap.coordinatorBaseUrl,
    sourceCommit: (bootstrap.activeWebRelease ?? bootstrap.manifest.payload.webRelease).sourceCommit,
  });
}

export async function getStatus(signal?: AbortSignal): Promise<StatusResponse> {
  const bootstrap = await getBootstrap(signal);
  const slug = bootstrap.manifest.payload.slug;
  const [status, checkpointEnvelope] = await Promise.all([
    coordinatorFetch<{
      ceremonyId: string;
      state: string;
      generation: number;
      head: { sha256: string; byteLength: number; downloadUrl: string };
      queueDepth: number;
      manifestSha256: string;
    }>(`/v1/ceremonies/${encodeURIComponent(slug)}/status`, { signal }),
    coordinatorFetch<SignedEnvelope<HeadCheckpointV1>>(
      `/v1/ceremonies/${encodeURIComponent(slug)}/checkpoint`,
      { signal },
    ),
  ]);
  const checkpoint = await verifyCoordinatorEnvelope<HeadCheckpointV1>(
    checkpointEnvelope,
    CHECKPOINT_DOMAIN,
    bootstrap.manifest.payload,
  );
  assertCheckpoint(checkpoint);
  if (
    status.manifestSha256 !==
      (await canonicalSha256(
        MANIFEST_HASH_DOMAIN,
        bootstrap.manifest.payload,
      )) ||
    checkpoint.ceremonyId !== bootstrap.manifest.payload.ceremonyId ||
    checkpoint.generation !== status.generation ||
    checkpoint.headSha256 !== status.head.sha256 ||
    checkpoint.headByteLength !== status.head.byteLength
  ) {
    throw new Error("Coordinator status does not match its signed checkpoint.");
  }
  if (Date.parse(checkpoint.expiresAt) <= Date.now()) {
    throw new Error("Coordinator checkpoint is expired.");
  }
  const finalization = await verifiedFinalization(
    bootstrap.manifest, checkpoint,
    await canonicalSha256(MANIFEST_HASH_DOMAIN, bootstrap.manifest.payload),
    (envelope, domain) => verifyCoordinatorEnvelope(envelope, domain, {
      ...bootstrap.manifest.payload,
      coordinatorKeys: [{ keyId: bootstrap.manifest.keyId, algorithm: "Ed25519", publicKeyPem: bootstrap.rootPublicKeyPem }],
    }),
  );
  const target = bootstrap.manifest.payload.contributionPolicy.targetContributions;
  const complete = checkpoint.generation >= target;
  const circuit: CircuitStatus = {
    circuitId: CIRCUIT_ID,
    targetContributions: target,
    totalContributions: checkpoint.generation,
    currentParticipant: null,
    queueLength: status.queueDepth,
    latestContributionHash: checkpoint.headSha256,
    chainHash: checkpoint.eventHash,
    isComplete: complete,
  };
  return {
    finalization,
    ceremonyState: checkpoint.state,
    isActive: checkpoint.state === "OPEN" && !complete,
    totalContributions: checkpoint.generation,
    targetContributions: target,
    endDate: bootstrap.manifest.payload.schedule.sealsAt,
    startedAt: Date.parse(bootstrap.manifest.payload.schedule.opensAt),
    beaconApplied: checkpoint.state === "FINALIZED",
    ...(bootstrap.manifest.payload.beacon.source === "ethereum-block"
      ? { beaconBlock: bootstrap.manifest.payload.beacon.blockNumber } : {}),
    circuits: [circuit],
    headByteLength: checkpoint.headByteLength,
  };
}

export async function getParticipantEligibility(
  signal?: AbortSignal,
): Promise<ParticipantEligibilityResponse> {
  const token = await getParticipantToken(signal);
  await recoverAcceptedReceipt(token, signal, undefined, true);
  const receipts = await readVerifiedLocalReceipts(token);
  const contributed = receipts.length > 0 ? [CIRCUIT_ID] : [];
  const rehearsal = (await getBootstrap(signal)).manifest.payload.purpose === "rehearsal";
  // The signed purpose allows sequential rehearsal attempts. The coordinator
  // remains authoritative for admission, schedule and the total contribution cap.
  return {
    participantId: token.participantId,
    contributedCircuitIds: contributed,
    eligibleCircuitIds: rehearsal || contributed.length === 0 ? [CIRCUIT_ID] : [],
    hasEligibleCircuits: rehearsal || contributed.length === 0,
    tierPreviews: [],
  };
}

export interface ParticipantReceiptsResponse {
  participantId: string;
  receipts: ReceiptResponse[];
}

export async function getMyReceipts(): Promise<ParticipantReceiptsResponse> {
  const token = await getParticipantToken();
  await recoverAcceptedReceipt(token, undefined, undefined, true);
  return {
    participantId: token.participantId,
    receipts: await readVerifiedLocalReceipts(token),
  };
}

export interface ParticipantActivity {
  state: ParticipantStateResponse;
  receipts: ReceiptResponse[];
}

/** Read-only recovery: never claim, resubmit, or regenerate a contribution. */
export async function getParticipantActivity(signal?: AbortSignal, expectedParticipantId?: string): Promise<ParticipantActivity> {
  if (expectedParticipantId && cachedToken?.participantId !== expectedParticipantId) cachedToken = undefined;
  const token = await getParticipantToken(signal);
  if (expectedParticipantId && token.participantId !== expectedParticipantId) {
    throw new Error("Sign-in changed. Refresh the page to view your contributions.");
  }
  const state = await getMyCoordinatorState(signal);
  const receipt = await recoverAcceptedReceipt(token, signal, state, true);
  const receipts = await readVerifiedLocalReceipts(token);
  if (receipt && !receipts.some((item) => item.receiptId === receipt.receiptId)) receipts.push(receipt);
  return { state, receipts };
}

export async function joinQueue(options: {
  tierId?: string;
  circuitIds?: string[];
  signal?: AbortSignal;
}): Promise<{ positions: QueuePosition[] }> {
  if (
    options.circuitIds &&
    (options.circuitIds.length !== 1 || options.circuitIds[0] !== CIRCUIT_ID)
  ) {
    throw new Error("This ceremony has exactly one relation.");
  }
  const bootstrap = await getBootstrap(options.signal);
  const participant = await getParticipantToken(options.signal);
  const recovered = await getMyCoordinatorState(options.signal);
  const repeatRehearsal = bootstrap.manifest.payload.purpose === "rehearsal"
    && recovered.submission?.state === "ACCEPTED";
  if (repeatRehearsal) {
    // Preserve the verified receipt before replacing this attempt's journal.
    const receipt = await recoverAcceptedReceipt(participant, options.signal, recovered, true);
    if (!receipt) throw new Error("Accepted rehearsal contribution has no verified receipt.");
  }
  if (recovered.submission && !repeatRehearsal) {
    if (TERMINAL_SUBMISSION_STATES.has(recovered.submission.state)) {
      resetBrowserJournalAttempt(bootstrap, participant);
    } else {
      const receipt = await recoverAcceptedReceipt(
        participant,
        options.signal,
        recovered,
      );
      if (receipt) {
        throw new Error("This identity already has an accepted contribution.");
      }
      throw new Error(
        `This identity already has submission ${recovered.submission.submissionId} in state ${recovered.submission.state}.`,
      );
    }
  }
  if (
    recovered.queue &&
    ACTIVE_QUEUE_STATES.has(recovered.queue.status)
  ) {
    rememberJournalIdentifiers(bootstrap, participant, {
      queueTicketId: recovered.queue.ticketId,
      ...(recovered.queue.offer
        ? { leaseId: recovered.queue.offer.leaseId }
        : {}),
    });
    return {
      positions: [await mapQueuePosition(recovered.queue, options.signal)],
    };
  }
  if (recovered.lease?.state === "ACTIVE") {
    rememberJournalIdentifiers(bootstrap, participant, {
      leaseId: recovered.lease.leaseId,
    });
    return {
      positions: [
        await mapQueuePosition(
          {
            ticketId: readBrowserJournal(
              bootstrap.manifest.payload.ceremonyId,
              participant.participantId,
            )?.queueTicketId ?? `recovered:${recovered.lease.leaseId}`,
            status: "LEASED",
            position: 1,
            offer: recovered.lease,
          },
          options.signal,
        ),
      ],
    };
  }
  if (!shouldStartFreshBrowserAttempt(recovered, bootstrap.manifest.payload.purpose === "rehearsal")) {
    throw new Error("Coordinator recovery state is not safe to replace with a new queue attempt.");
  }
  // Queue idempotency, lease/upload identifiers, and contribution evidence are
  // scoped to one attempt. Reusing them after a pre-submission lease expiry
  // returns the old terminal ticket and can bind a new computation to old bytes.
  resetBrowserJournalAttempt(bootstrap, participant);
  const journal = ensureBrowserJournal(bootstrap, participant);
  journal.queueIdempotencyKey ??= `browser-queue:${crypto.randomUUID()}`;
  writeBrowserJournal(journal);
  const queue = await coordinatorFetch<QueueView>(
    `/v1/ceremonies/${encodeURIComponent(bootstrap.manifest.payload.slug)}/queue`,
    {
      method: "POST",
      auth: true,
      idempotencyKey: journal.queueIdempotencyKey,
      signal: options.signal,
    },
  );
  rememberJournalIdentifiers(bootstrap, participant, {
    queueTicketId: queue.ticketId,
    ...(queue.offer ? { leaseId: queue.offer.leaseId } : {}),
  });
  return { positions: [await mapQueuePosition(queue, options.signal)] };
}

export function shouldStartFreshBrowserAttempt(
  state: ParticipantStateResponse,
  rehearsal = false,
): boolean {
  if (state.submission) {
    return TERMINAL_SUBMISSION_STATES.has(state.submission.state)
      || (rehearsal && state.submission.state === "ACCEPTED");
  }
  if (state.queue) {
    return !ACTIVE_QUEUE_STATES.has(state.queue.status);
  }
  if (state.lease) {
    return TERMINAL_LEASE_STATES.has(state.lease.state);
  }
  return true;
}

export async function getQueuePosition(options: {
  circuitId: string;
  signal?: AbortSignal;
}): Promise<QueuePosition> {
  if (options.circuitId !== CIRCUIT_ID) throw new Error("Unknown circuit.");
  const bootstrap = await getBootstrap(options.signal);
  const queue = await coordinatorFetch<QueueView>(
    `/v1/ceremonies/${encodeURIComponent(bootstrap.manifest.payload.slug)}/queue/me`,
    { auth: true, signal: options.signal },
  );
  const participant = await getParticipantToken(options.signal);
  rememberJournalIdentifiers(bootstrap, participant, {
    queueTicketId: queue.ticketId,
    ...(queue.offer ? { leaseId: queue.offer.leaseId } : {}),
  });
  return await mapQueuePosition(queue, options.signal);
}

export async function cancelQueue(signal?: AbortSignal): Promise<void> {
  const bootstrap = await getBootstrap(signal);
  await coordinatorFetch<void>(
    `/v1/ceremonies/${encodeURIComponent(bootstrap.manifest.payload.slug)}/queue/me`,
    { method: "DELETE", auth: true, signal },
  );
}

/** The coordinator refuses to withdraw a contribution already submitted for verification. */
function isCancellationRefused(error: unknown): boolean {
  return error instanceof Error && /cancellation unavailable|already submitted/i.test(error.message);
}

/** A cancel that found nothing left to cancel. */
function isNothingToCancel(error: unknown): boolean {
  return error instanceof Error && /queue ticket not found|not in queue/i.test(error.message);
}

/**
 * Leave the queue or give up this participant's slot, then discard the
 * attempt's local files. "submitted" when the coordinator already holds the
 * contribution for verification; nothing local is touched then.
 */
export async function cancelAttempt(signal?: AbortSignal): Promise<"cancelled" | "submitted"> {
  try {
    await cancelQueue(signal);
  } catch (error) {
    if (isCancellationRefused(error)) return "submitted";
    if (!isNothingToCancel(error)) throw error;
  }
  await discardBrowserAttempt(signal);
  return "cancelled";
}

/** The Web Lock the tab running this participant's attempt holds. */
export async function getContributionLockName(signal?: AbortSignal): Promise<string> {
  const [bootstrap, participant] = await Promise.all([
    getBootstrap(signal),
    getParticipantToken(signal),
  ]);
  return contributionLockName(bootstrap.manifest.payload.ceremonyId, participant.participantId);
}

/**
 * The page is closing mid-attempt: give the slot up and drop the saved output.
 * Synchronous so it can run from `pagehide`; the cancel is a keepalive request
 * with the cached token, and nothing here waits on the network. The claim
 * marker stays in the journal so the next visit can say what happened.
 */
export function abandonAttemptOnUnload(): void {
  const bootstrap = cachedBootstrap;
  const participant = cachedToken;
  if (!bootstrap || !participant) return;
  if (participant.expiresAt > Date.now() / 1_000) {
    try {
      void fetch(
        new URL(
          `/v1/ceremonies/${encodeURIComponent(bootstrap.manifest.payload.slug)}/queue/me`,
          bootstrap.coordinatorBaseUrl,
        ),
        {
          method: "DELETE",
          keepalive: true,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          headers: { authorization: `Bearer ${participant.token}` },
        },
      ).catch(() => undefined);
    } catch {
      // Best effort: the coordinator still expires the slot once heartbeats stop.
    }
  }
  const ceremonyId = bootstrap.manifest.payload.ceremonyId;
  let journal: BrowserContributionJournal | null = null;
  try {
    journal = readBrowserJournal(ceremonyId, participant.participantId);
  } catch {
    return;
  }
  if (!journal) return;
  if (journal.outputFileName) {
    void removeBrowserContributionFile(journal.outputFileName).catch(() => undefined);
  }
  try {
    if (journal.claimedLeaseId) {
      writeBrowserJournal({
        schemaVersion: 1,
        ceremonyId,
        participantId: participant.participantId,
        claimedLeaseId: journal.claimedLeaseId,
        updatedAt: new Date().toISOString(),
      });
    } else {
      removeBrowserJournal(ceremonyId, participant.participantId);
    }
  } catch {
    // Storage may be unavailable while the page unloads; the next visit cleans up.
  }
}

/** Remove this participant's saved output and contribution journal entry. */
export async function discardBrowserAttempt(signal?: AbortSignal): Promise<void> {
  const [bootstrap, participant] = await Promise.all([
    getBootstrap(signal),
    getParticipantToken(signal),
  ]);
  await discardLocalAttempt(bootstrap.manifest.payload.ceremonyId, participant.participantId);
}

export type AbandonedAttempt =
  /** Nothing to settle. */
  | "none"
  /** A slot this browser claimed was given up because its page closed. */
  | "cancelled"
  /** Another tab in this browser is running the attempt or holds its queue place. */
  | "running"
  /** A slot is active but this browser cannot tell whether it is running. */
  | "unknown";

/**
 * What to do about the participant's attempt when no tab of this page is
 * running it. Only a slot this browser claimed is ever cancelled, and only
 * while no tab holds the contribution lock: a homepage opened in another tab
 * or browser must never cancel a running contribution.
 */
export function abandonedAttemptPlan(input: {
  state: ParticipantStateResponse;
  claimedLeaseId: string | null;
  lock: "held" | "free" | "unsupported";
}): { cancel: boolean; discard: boolean; outcome: AbandonedAttempt } {
  const { state, claimedLeaseId, lock } = input;
  const none = { cancel: false, discard: false, outcome: "none" as const };
  // Another tab holds the lock from joining the queue until the attempt ends.
  const runningElsewhere = state.lease?.state === "ACTIVE"
    || (!!state.queue && ACTIVE_QUEUE_STATES.has(state.queue.status));
  if (lock === "held") {
    return { ...none, outcome: runningElsewhere ? "running" : "none" };
  }
  // Submitted, being verified or accepted: never cancelled from here.
  if (state.submission && !TERMINAL_SUBMISSION_STATES.has(state.submission.state)) return none;
  if (state.lease?.state === "ACTIVE") {
    return lock === "free" && claimedLeaseId === state.lease.leaseId
      ? { cancel: true, discard: true, outcome: "cancelled" }
      : { ...none, outcome: "unknown" };
  }
  if (state.queue && ACTIVE_QUEUE_STATES.has(state.queue.status)) return none;
  if (!claimedLeaseId) return none;
  // The claimed slot is gone. A submission that later failed has its own message.
  const submitted = state.lease?.leaseId === claimedLeaseId && !!state.lease.submissionId;
  return { cancel: false, discard: true, outcome: submitted ? "none" : "cancelled" };
}

/**
 * Settle an attempt that no tab is running: cancel a slot this browser claimed
 * but abandoned, and remove local files for a slot that is no longer active.
 */
export async function settleAbandonedAttempt(
  state: ParticipantStateResponse,
  signal?: AbortSignal,
): Promise<AbandonedAttempt> {
  const [bootstrap, participant] = await Promise.all([
    getBootstrap(signal),
    getParticipantToken(signal),
  ]);
  if (state.participantId !== participant.participantId) return "none";
  const ceremonyId = bootstrap.manifest.payload.ceremonyId;
  const name = contributionLockName(ceremonyId, participant.participantId);
  let claimedLeaseId: string | null = null;
  try {
    claimedLeaseId = readBrowserJournal(ceremonyId, participant.participantId)?.claimedLeaseId ?? null;
  } catch {
    // An unreadable journal proves nothing about who claimed the slot.
  }
  const lock = await contributionLockState(name);
  const plan = abandonedAttemptPlan({ state, claimedLeaseId, lock });
  if (!plan.cancel && !plan.discard) return plan.outcome;
  // Act under the lock, so a tab starting now cannot be cancelled mid-claim.
  const settled = await withContributionLockIfFree(name, async () => {
    if (plan.cancel) {
      try {
        await cancelQueue(signal);
      } catch (error) {
        if (isCancellationRefused(error)) return "none" as const;
        if (!isNothingToCancel(error)) throw error;
      }
    }
    await discardLocalAttempt(ceremonyId, participant.participantId, { sweep: lock === "free" });
    return plan.outcome;
  });
  return settled ?? (state.lease?.state === "ACTIVE"
    || (!!state.queue && ACTIVE_QUEUE_STATES.has(state.queue.status)) ? "running" : "none");
}

export async function getMyCoordinatorState(
  signal?: AbortSignal,
): Promise<ParticipantStateResponse> {
  const [bootstrap, participant] = await Promise.all([
    getBootstrap(signal),
    getParticipantToken(signal),
  ]);
  const raw = await coordinatorFetch<unknown>(
    `/v1/ceremonies/${encodeURIComponent(bootstrap.manifest.payload.slug)}/me/state`,
    { auth: true, signal },
  );
  const state = parseParticipantState(raw);
  if (
    state.ceremonyId !== bootstrap.manifest.payload.ceremonyId ||
    state.participantId !== participant.participantId
  ) {
    throw new Error("Coordinator participant state has the wrong identity or ceremony.");
  }
  rememberJournalIdentifiers(bootstrap, participant, {
    ...(state.queue ? { queueTicketId: state.queue.ticketId } : {}),
    ...(state.lease ? { leaseId: state.lease.leaseId } : {}),
    ...(state.submission
      ? { submissionId: state.submission.submissionId }
      : {}),
    ...(state.submission?.receiptId
      ? { receiptId: state.submission.receiptId }
      : {}),
  });
  return state;
}

export function parseParticipantState(value: unknown): ParticipantStateResponse {
  const row = strictRecord(value, "participant state");
  const participantId = strictText(
    row.participantId,
    "participant state participant id",
  );
  if (!PARTICIPANT_UUID.test(participantId)) {
    throw new Error("Participant state participant id is invalid.");
  }
  const queue = row.queue === null ? null : parseQueueView(row.queue);
  const lease = row.lease === null ? null : parseCoordinatorLease(row.lease);
  const submission =
    row.submission === null ? null : parseSubmissionResponse(row.submission);
  if (queue?.offer && lease && queue.offer.leaseId !== lease.leaseId) {
    throw new Error("Participant state queue and lease disagree.");
  }
  if (
    lease?.submissionId &&
    submission &&
    lease.submissionId !== submission.submissionId
  ) {
    throw new Error("Participant state lease and submission disagree.");
  }
  return {
    ceremonyId: strictText(row.ceremonyId, "participant state ceremony id"),
    participantId,
    queue,
    lease,
    submission,
  };
}

function parseQueueView(value: unknown): QueueView {
  const row = strictRecord(value, "participant queue");
  const status = strictText(row.status, "participant queue status");
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(status)) {
    throw new Error("Participant queue status is invalid.");
  }
  return {
    ticketId: strictText(row.ticketId, "participant queue ticket id"),
    status,
    position: strictNonnegativeInteger(row.position, "participant queue position"),
    offer: row.offer === null ? null : parseCoordinatorOffer(row.offer),
  };
}

function parseCoordinatorOffer(value: unknown): CoordinatorOffer {
  const row = strictRecord(value, "coordinator offer");
  const predecessor = strictRecord(row.predecessor, "coordinator offer predecessor");
  const sha256 = strictText(predecessor.sha256, "coordinator offer predecessor SHA-256");
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("Coordinator offer predecessor SHA-256 is invalid.");
  }
  const downloadUrl = strictText(
    predecessor.downloadUrl,
    "coordinator offer predecessor URL",
  );
  validateCoordinatorArtifactUrl(downloadUrl);
  return {
    leaseId: strictText(row.leaseId, "coordinator offer lease id"),
    expiresAt: strictIsoDate(row.expiresAt, "coordinator offer expiry"),
    baseGeneration: strictNonnegativeInteger(
      row.baseGeneration,
      "coordinator offer base generation",
    ),
    expectedContributionName: strictText(
      row.expectedContributionName,
      "coordinator offer contribution name",
    ),
    predecessor: {
      sha256,
      byteLength: strictPositiveInteger(
        predecessor.byteLength,
        "coordinator offer predecessor byte length",
      ),
      downloadUrl,
    },
  };
}

function parseCoordinatorLease(value: unknown): CoordinatorLease {
  const row = strictRecord(value, "coordinator lease");
  const offer = parseCoordinatorOffer(row);
  const state = strictText(row.state, "coordinator lease state");
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(state)) {
    throw new Error("Coordinator lease state is invalid.");
  }
  return {
    ...offer,
    state,
    ...(row.submissionId === undefined
      ? {}
      : {
          submissionId: strictText(
            row.submissionId,
            "coordinator lease submission id",
          ),
        }),
  };
}

function parseSubmissionResponse(value: unknown): SubmissionResponse {
  const row = strictRecord(value, "participant submission");
  const state = strictText(row.state, "participant submission state");
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(state)) {
    throw new Error("Participant submission state is invalid.");
  }
  return {
    submissionId: strictText(
      row.submissionId,
      "participant submission id",
    ),
    state,
    ...(row.receiptId === undefined
      ? {}
      : { receiptId: strictText(row.receiptId, "participant receipt id") }),
  };
}

export async function claimOffer(
  offer: CoordinatorOffer,
  signal?: AbortSignal,
): Promise<CoordinatorLease> {
  const [bootstrap, participant] = await Promise.all([
    getBootstrap(signal),
    getParticipantToken(signal),
  ]);
  rememberJournalIdentifiers(bootstrap, participant, {
    leaseId: offer.leaseId,
  });
  let lease: CoordinatorLease;
  try {
    // Parse rather than assert. Every other route to a lease — including the
    // recovery branch below — goes through parseCoordinatorLease, which runs
    // validateCoordinatorArtifactUrl over the download URL and constrains
    // expectedContributionName. A bare cast here left the happy path as the
    // only unvalidated one, so a coordinator could return a name that
    // verifyExactlyOneAppend later rejects and cost the contributor a full
    // contribution and their queue ticket.
    lease = parseCoordinatorLease(
      await coordinatorFetch<unknown>(
        `/v1/offers/${encodeURIComponent(offer.leaseId)}/claim`,
        { method: "POST", auth: true, signal },
      ),
    );
  } catch (claimError) {
    const recovered = await getMyCoordinatorState(signal).catch(() => null);
    const active = recovered && activeLeaseFromState(recovered, offer.leaseId);
    if (!active) throw claimError;
    lease = active;
  }
  await assertLeaseMatchesCheckpoint(lease, signal);
  rememberJournalIdentifiers(bootstrap, participant, {
    leaseId: lease.leaseId,
    claimedLeaseId: lease.leaseId,
  });
  return lease;
}

/** The participant's lease when it is still the given, ACTIVE lease. */
export function activeLeaseFromState(
  state: ParticipantStateResponse,
  leaseId: string,
): CoordinatorLease | null {
  return state.lease?.state === "ACTIVE" && state.lease.leaseId === leaseId
    ? state.lease
    : null;
}

export async function heartbeatLease(
  leaseId: string,
  progress: { phase: string; percent: number; uploadedBytes?: number; totalBytes?: number },
  signal?: AbortSignal,
): Promise<void> {
  await coordinatorFetch<void>(
    `/v1/leases/${encodeURIComponent(leaseId)}/heartbeat`,
    {
      method: "POST",
      auth: true,
      body: JSON.stringify(progress),
      headers: { "content-type": "application/json" },
      signal,
    },
  );
}

/**
 * Send heartbeats comfortably inside the manifest's signed maximum gap. The
 * coordinator treats `heartbeatSeconds` as a liveness deadline, not as the
 * client's desired timer period.
 */
export async function getHeartbeatIntervalMs(
  signal?: AbortSignal,
): Promise<number> {
  const { heartbeatSeconds } = (
    await getBootstrap(signal)
  ).manifest.payload.contributionPolicy.lease;
  return heartbeatClientIntervalMs(heartbeatSeconds);
}

export function heartbeatClientIntervalMs(heartbeatSeconds: number): number {
  if (!Number.isSafeInteger(heartbeatSeconds) || heartbeatSeconds < 1) {
    throw new Error("Signed heartbeat deadline is invalid.");
  }
  return Math.min(5_000, Math.max(1_000, Math.floor((heartbeatSeconds * 1_000) / 3)));
}

export async function uploadZkey(options: {
  leaseId: string;
  payload: Blob;
  expectedSha256: string;
  signal?: AbortSignal;
  onProgress?: (uploaded: number, total: number) => void;
}): Promise<string> {
  const [bootstrap, participant] = await Promise.all([
    getBootstrap(options.signal),
    getParticipantToken(options.signal),
  ]);
  const expectedSha256 = normalizeHex(options.expectedSha256, 64, "zkey SHA-256");
  const grant = await coordinatorFetch<UploadGrant>(
    `/v1/leases/${encodeURIComponent(options.leaseId)}/uploads`,
    { method: "POST", auth: true, signal: options.signal },
  );
  if (grant.method !== "local-proxy" && grant.method !== "s3-multipart") throw new Error("Unsupported upload method.");
  rememberJournalIdentifiers(bootstrap, participant, {
    leaseId: options.leaseId,
    uploadId: grant.uploadId,
  });
  const durable = await coordinatorFetch<UploadStateResponse>(
    `/v1/uploads/${encodeURIComponent(grant.uploadId)}`,
    { auth: true, signal: options.signal },
  );
  assertUploadState(durable, grant.uploadId);
  if (durable.artifact && (
    durable.artifact.sha256 !== expectedSha256 ||
    durable.artifact.byteLength !== options.payload.size
  )) {
    throw new Error("Durable upload state differs from the local zkey.");
  }
  if (durable.state === "COMPLETED") return grant.uploadId;
  if (durable.state !== "INITIATED" && durable.state !== "UPLOADING") throw new Error("Upload is no longer active.");
  let parts: MultipartPart[] | undefined;
  if (grant.method === "s3-multipart") {
    parts = await uploadBrowserParts({ payload: options.payload, expiresAt: grant.expiresAt,
      allowedOrigins: bootstrap.artifactOrigins ?? [], signal: options.signal, onProgress: options.onProgress,
      requestPart: (partNumber) => coordinatorFetch<{ parts: PartGrant[] }>(`/v1/uploads/${encodeURIComponent(grant.uploadId)}/parts`, {
        method: "POST", auth: true, signal: options.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ partNumbers: [partNumber] }),
      }),
    });
  } else if (durable.state === "INITIATED") {
    const uploaded = await coordinatorFetch<{
      uploadId: string;
      state: string;
      byteLength: number;
      sha256: string;
    }>(`/v1/uploads/${encodeURIComponent(grant.uploadId)}/content`, {
      method: "PUT",
      auth: true,
      body: options.payload,
      headers: { "content-type": "application/octet-stream" },
      signal: options.signal,
      timeoutMs: 30 * 60_000,
    });
    if (
      uploaded.byteLength !== options.payload.size ||
      uploaded.sha256 !== expectedSha256
    ) {
      throw new Error("Coordinator upload digest differs from the local zkey.");
    }
  } else if (durable.state !== "UPLOADING") {
    throw new Error(`Candidate upload is in unsupported state ${durable.state}.`);
  }
  const complete = await coordinatorFetch<{
    uploadId: string;
    state: string;
    artifact: { sha256: string; byteLength: number };
  }>(`/v1/uploads/${encodeURIComponent(grant.uploadId)}/complete`, {
    method: "POST",
    auth: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sha256: expectedSha256,
      byteLength: options.payload.size,
      ...(parts ? { parts } : {}),
    }),
    signal: options.signal,
  });
  if (
    complete.artifact.sha256 !== expectedSha256 ||
    complete.artifact.byteLength !== options.payload.size
  ) {
    throw new Error("Completed upload differs from the local zkey.");
  }
  return grant.uploadId;
}

export async function journalContributionEvidence(options: {
  outputFileName?: string;
  lease: CoordinatorLease;
  contributionHash: string;
  expectedZkeySha256: string;
  expectedZkeyByteLength: number;
  signal?: AbortSignal;
}): Promise<void> {
  const [bootstrap, participant] = await Promise.all([
    getBootstrap(options.signal),
    getParticipantToken(options.signal),
  ]);
  const contributionHash = normalizeHex(
    options.contributionHash,
    128,
    "contribution hash",
  );
  const expectedZkeySha256 = normalizeHex(
    options.expectedZkeySha256,
    64,
    "zkey SHA-256",
  );
  if (
    !Number.isSafeInteger(options.expectedZkeyByteLength) ||
    options.expectedZkeyByteLength < 1
  ) {
    throw new Error("zkey byte length is malformed.");
  }
  rememberJournalEvidence(bootstrap, participant, {
    manifestSha256: await canonicalSha256(
      MANIFEST_HASH_DOMAIN,
      bootstrap.manifest.payload,
    ),
    predecessorSha256: options.lease.predecessor.sha256,
    predecessorByteLength: options.lease.predecessor.byteLength,
    successorSha256: expectedZkeySha256,
    successorByteLength: options.expectedZkeyByteLength,
    contributionHashBlake2b512: contributionHash,
    contributionName: options.lease.expectedContributionName,
    baseGeneration: options.lease.baseGeneration,
  });
  if (options.outputFileName) {
    const journal = ensureBrowserJournal(bootstrap, participant);
    journal.outputFileName = options.outputFileName;
    writeBrowserJournal(journal);
  }
}

export async function submitContribution(options: {
  lease: CoordinatorLease;
  uploadId: string;
  contributionHash: string;
  expectedZkeySha256: string;
  expectedZkeyByteLength: number;
  signal?: AbortSignal;
}): Promise<ReceiptResponse> {
  const bootstrap = await getBootstrap(options.signal);
  const participant = await getParticipantToken(options.signal);
  const contributionHash = normalizeHex(
    options.contributionHash,
    128,
    "contribution hash",
  );
  const expectedZkeySha256 = normalizeHex(
    options.expectedZkeySha256,
    64,
    "zkey SHA-256",
  );
  if (
    !Number.isSafeInteger(options.expectedZkeyByteLength) ||
    options.expectedZkeyByteLength < 1
  ) {
    throw new Error("zkey byte length is malformed.");
  }
  rememberJournalEvidence(bootstrap, participant, {
    manifestSha256: await canonicalSha256(
      MANIFEST_HASH_DOMAIN,
      bootstrap.manifest.payload,
    ),
    predecessorSha256: options.lease.predecessor.sha256,
    predecessorByteLength: options.lease.predecessor.byteLength,
    successorSha256: expectedZkeySha256,
    successorByteLength: options.expectedZkeyByteLength,
    contributionHashBlake2b512: contributionHash,
    contributionName: options.lease.expectedContributionName,
    baseGeneration: options.lease.baseGeneration,
  });
  let submitted: SubmissionResponse;
  try {
    submitted = await coordinatorFetch<SubmissionResponse>(
      `/v1/leases/${encodeURIComponent(options.lease.leaseId)}/submit`,
      {
        method: "POST",
        auth: true,
        idempotencyKey: `browser-submit:${options.lease.leaseId}`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uploadId: options.uploadId,
          predecessorSha256: options.lease.predecessor.sha256,
          contributionHashBlake2b512: contributionHash,
          clientKind: "browser",
          // A label, not evidence. A page cannot attest to its own code — a
          // compromised deployment would report this same value — so this simply
          // echoes the manifest. The web release is verified out of band instead,
          // by comparing the served assets against the published release
          // manifest (infra/web-release.mjs --check).
          clientReleaseSha256: (bootstrap.activeWebRelease ?? bootstrap.manifest.payload.webRelease).sha256,
        }),
        signal: options.signal,
      },
    );
  } catch (submitError) {
    const recovered = await coordinatorFetch<CoordinatorLease>(
      `/v1/leases/${encodeURIComponent(options.lease.leaseId)}`,
      { auth: true, signal: options.signal },
    ).catch(() => null);
    if (
      !recovered?.submissionId ||
      !["SUBMITTED", "VERIFYING", "ACCEPTED"].includes(recovered.state) ||
      recovered.leaseId !== options.lease.leaseId ||
      recovered.baseGeneration !== options.lease.baseGeneration ||
      recovered.predecessor.sha256 !== options.lease.predecessor.sha256 ||
      recovered.predecessor.byteLength !== options.lease.predecessor.byteLength ||
      recovered.expectedContributionName !==
        options.lease.expectedContributionName
    ) {
      throw submitError;
    }
    submitted = {
      submissionId: recovered.submissionId,
      state: recovered.state,
    };
  }
  rememberJournalIdentifiers(bootstrap, participant, {
    leaseId: options.lease.leaseId,
    uploadId: options.uploadId,
    submissionId: submitted.submissionId,
  });
  const accepted = await waitForReceipt(submitted, options.signal);
  const envelope = await coordinatorFetch<SignedEnvelope<ContributionReceiptV1>>(
    `/v1/receipts/${encodeURIComponent(accepted.receiptId!)}`,
    { auth: true, signal: options.signal },
  );
  const receipt = await mapAndVerifyReceipt(
    accepted.receiptId!,
    participant,
    envelope,
  );
  if (
    receipt.contributionHash !== expectedZkeySha256 ||
    receipt.serverContributionHash !== contributionHash ||
    receipt.previousContributionHash !== options.lease.predecessor.sha256 ||
    receipt.signedReceipt.payload.predecessor.byteLength !==
      options.lease.predecessor.byteLength ||
    receipt.signedReceipt.payload.successor.byteLength !==
      options.expectedZkeyByteLength ||
    receipt.signedReceipt.payload.generation !==
      options.lease.baseGeneration + 1 ||
    receipt.signedReceipt.payload.contributionName !==
      options.lease.expectedContributionName
  ) {
    throw new Error("Signed receipt does not bind the submitted contribution.");
  }
  rememberReceipt(receipt);
  rememberJournalIdentifiers(bootstrap, participant, {
    receiptId: accepted.receiptId!,
  });
  return receipt;
}

export async function getReceipt(options: {
  receipt: ReceiptResponse;
}): Promise<ReceiptResponse> {
  const participant = await getParticipantToken();
  if (participant.participantId !== options.receipt.participantId) {
    throw new Error("Receipt belongs to a different browser identity.");
  }
  return await mapAndVerifyReceipt(
    options.receipt.receiptId,
    participant,
    options.receipt.signedReceipt,
  );
}

export interface VerifiedPublicReceipt {
  policy: CeremonyManifestV1["verifierPolicy"];
  artifactDownloadUrl?: string;
  envelope: SignedEnvelope<ContributionReceiptV1>;
  receipt: ContributionReceiptV1;
}

/** Verify public signed evidence without requesting a participant token. */
export async function verifyPublicReceipt(
  input: unknown,
  manifest: CeremonyManifestV1,
  /** The manifest's canonical hash, when the caller checks several receipts against it. */
  manifestSha256?: string,
): Promise<VerifiedPublicReceipt> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Expected a signed receipt or a CLI/browser receipt file.");
  }
  const wrapper = input as Record<string, unknown>;
  const candidate = wrapper.receiptEnvelope ?? wrapper.signedReceipt ?? input;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Signed receipt envelope is missing.");
  }
  const envelope = candidate as SignedEnvelope<ContributionReceiptV1>;
  const receipt = await verifyCoordinatorEnvelope(envelope, RECEIPT_DOMAIN, manifest);
  assertReceipt(receipt);
  if (receipt.ceremonyId !== manifest.ceremonyId ||
      receipt.relationManifestSha256 !== (manifestSha256 ?? await canonicalSha256(MANIFEST_HASH_DOMAIN, manifest)) ||
      receipt.generation > manifest.contributionPolicy.maximumContributions) {
    throw new Error("Receipt does not belong to this ceremony manifest.");
  }
  if (receipt.generation === 1 &&
      (receipt.predecessor.sha256 !== (manifest.relation.genesisBellman ?? manifest.relation.genesisZkey).sha256 ||
       receipt.predecessor.byteLength !== (manifest.relation.genesisBellman ?? manifest.relation.genesisZkey).byteLength)) {
    throw new Error("First receipt does not extend the pinned genesis.");
  }
  // Unsigned wrapper fields are never displayed as facts. If present, compare
  // artifact evidence to the authenticated payload instead of ignoring it.
  if (wrapper.signedReceipt) {
    const comparisons = { contributionIndex: receipt.contributionIndex,
      contributionHash: receipt.successor.sha256, previousContributionHash: receipt.predecessor.sha256 };
    for (const [key, expected] of Object.entries(comparisons)) {
      if (key in wrapper && wrapper[key] !== expected) throw new Error("Receipt summary differs from its signed payload.");
    }
  }
  if (wrapper.localEvidence !== undefined) {
    if (!wrapper.localEvidence || typeof wrapper.localEvidence !== "object" || Array.isArray(wrapper.localEvidence)) {
      throw new Error("CLI receipt evidence is malformed.");
    }
    const evidence = wrapper.localEvidence as Record<string, unknown>;
    for (const [key, expected] of Object.entries({
      predecessorSha256: receipt.predecessor.sha256, successorSha256: receipt.successor.sha256,
      contributionHashBlake2b512: receipt.contributionHashBlake2b512, contributionName: receipt.contributionName,
    })) {
      if (evidence[key] !== expected) throw new Error("CLI evidence differs from the signed receipt.");
    }
  }
  return { envelope, receipt, policy: manifest.verifierPolicy };
}

export async function verifyReceiptDocument(text: string): Promise<VerifiedPublicReceipt[]> {
  if (new TextEncoder().encode(text).byteLength > 1_048_576) throw new Error("Receipt files must be at most 1 MB.");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Enter a valid receipt JSON file."); }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.length < 1 || values.length > 100) throw new Error("Provide between 1 and 100 receipts.");
  const bootstrap = await getBootstrap();
  const verified = await Promise.all(values.map((value) => verifyPublicReceipt(value, bootstrap.manifest.payload)));
  const generations = new Set(verified.map(({ receipt }) => receipt.generation));
  if (generations.size !== verified.length) throw new Error("Duplicate contribution receipts.");
  return verified;
}

/** Rows per page of the public contribution history. */
export const HISTORY_PAGE_SIZE = 5;

export interface ContributionHistoryPage {
  /** Accepted contributions in total, from the signed head. */
  total: number;
  /** This page's receipts, newest first. */
  items: VerifiedPublicReceipt[];
}

/**
 * One page of accepted contributions, newest first. Fetches the signed head
 * for the total and then only that page's receipts, so the cost does not grow
 * with the ceremony. Each receipt's signature is checked, the page's receipts
 * must link to each other, and the newest page must end at the signed head.
 * The full chain from genesis is the ceremony audit's job, not every visitor's.
 */
export async function getContributionHistoryPage(page: number, signal?: AbortSignal): Promise<ContributionHistoryPage> {
  if (!Number.isSafeInteger(page) || page < 0) throw new Error("Invalid contribution history page.");
  const { manifest, coordinatorBaseUrl } = await getBootstrap(signal);
  const path = `/v1/ceremonies/${encodeURIComponent(manifest.payload.slug)}`;
  const checkpoint = await verifyCoordinatorEnvelope<HeadCheckpointV1>(
    await coordinatorFetch(`${path}/checkpoint`, { signal }), CHECKPOINT_DOMAIN, manifest.payload,
  );
  assertCheckpoint(checkpoint);
  if (checkpoint.ceremonyId !== manifest.payload.ceremonyId ||
      Date.parse(checkpoint.expiresAt) <= Date.now() ||
      checkpoint.generation > manifest.payload.contributionPolicy.maximumContributions) {
    throw new Error("Contribution history checkpoint is invalid or expired.");
  }
  const total = checkpoint.generation;
  const newest = total - page * HISTORY_PAGE_SIZE;
  if (newest < 1) return { total, items: [] };
  const oldest = Math.max(1, newest - HISTORY_PAGE_SIZE + 1);
  const count = newest - oldest + 1;
  const response = await coordinatorFetch<{ receipts: unknown[] }>(`${path}/contributions?after=${oldest - 1}&limit=${count}`, { signal });
  if (!Array.isArray(response.receipts) || response.receipts.length < count || response.receipts.length > 50) {
    throw new Error("Contribution history is incomplete.");
  }
  const manifestSha256 = await canonicalSha256(MANIFEST_HASH_DOMAIN, manifest.payload);
  const items: VerifiedPublicReceipt[] = [];
  for (const item of response.receipts.slice(0, count)) {
    const verified = await verifyPublicReceipt(item, manifest.payload, manifestSha256);
    const previous = items.at(-1)?.receipt.successor;
    if (verified.receipt.generation !== oldest + items.length ||
        (previous && (verified.receipt.predecessor.sha256 !== previous.sha256 ||
                      verified.receipt.predecessor.byteLength !== previous.byteLength))) {
      throw new Error("Contribution history contains a gap or a broken artifact chain.");
    }
    items.push({ ...verified, artifactDownloadUrl: new URL(`${path}/artifacts/${verified.receipt.successor.sha256}.zkey`, coordinatorBaseUrl).toString() });
  }
  const head = items.at(-1)!.receipt.successor;
  if (newest === total && (head.sha256 !== checkpoint.headSha256 || head.byteLength !== checkpoint.headByteLength)) {
    throw new Error("Contribution history does not reach the signed head.");
  }
  return { total, items: items.reverse() };
}

/** A page of an already verified list, newest first, for fixed records such as the rehearsal snapshot. */
export function historyPageOf(newestFirst: VerifiedPublicReceipt[], page: number): ContributionHistoryPage {
  const start = page * HISTORY_PAGE_SIZE;
  return { total: newestFirst.length, items: newestFirst.slice(start, start + HISTORY_PAGE_SIZE) };
}

async function waitForReceipt(
  initial: SubmissionResponse,
  signal?: AbortSignal,
): Promise<SubmissionResponse> {
  let submission = initial;
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    if (submission.receiptId) return submission;
    if (["REJECTED", "STALE", "EXPIRED", "CANCELLED"].includes(submission.state)) {
      throw new Error(`Contribution verification ended in ${submission.state}.`);
    }
    await abortableDelay(3_000, signal);
    submission = await coordinatorFetch<SubmissionResponse>(
      `/v1/submissions/${encodeURIComponent(submission.submissionId)}`,
      { auth: true, signal },
    );
    const [bootstrap, participant] = await Promise.all([
      getBootstrap(signal),
      getParticipantToken(signal),
    ]);
    rememberJournalIdentifiers(bootstrap, participant, {
      submissionId: submission.submissionId,
      ...(submission.receiptId ? { receiptId: submission.receiptId } : {}),
    });
  }
  throw new Error("Timed out waiting for independent contribution verification.");
}

async function assertLeaseMatchesCheckpoint(
  lease: CoordinatorLease,
  signal?: AbortSignal,
): Promise<void> {
  const bootstrap = await getBootstrap(signal);
  const slug = bootstrap.manifest.payload.slug;
  const envelope = await coordinatorFetch<SignedEnvelope<HeadCheckpointV1>>(
    `/v1/ceremonies/${encodeURIComponent(slug)}/checkpoint`,
    { signal },
  );
  const checkpoint = await verifyCoordinatorEnvelope<HeadCheckpointV1>(
    envelope,
    CHECKPOINT_DOMAIN,
    bootstrap.manifest.payload,
  );
  assertCheckpoint(checkpoint);
  if (
    lease.baseGeneration !== checkpoint.generation ||
    lease.predecessor.sha256 !== checkpoint.headSha256 ||
    lease.predecessor.byteLength !== checkpoint.headByteLength
  ) {
    throw new Error("Offered predecessor is not the signed ceremony head.");
  }
}

/** The coordinator moves a ticket to LEASED when its offer is claimed. */
export function queueOfferClaimed(queue: { status: string; offer: CoordinatorOffer | null }): boolean {
  return queue.offer !== null && queue.status === "LEASED";
}

async function mapQueuePosition(
  queue: QueueView,
  signal?: AbortSignal,
): Promise<QueuePosition> {
  const token = await getParticipantToken(signal);
  return {
    participantId: token.participantId,
    circuitId: CIRCUIT_ID,
    position: queue.offer ? 1 : Math.max(1, queue.position),
    estimatedWaitSeconds: Math.max(0, queue.position - 1) * 90 * 60,
    offer: queue.offer,
    offerClaimed: queueOfferClaimed(queue),
  };
}

async function mapAndVerifyReceipt(
  receiptId: string,
  participant: ParticipantToken,
  envelope: SignedEnvelope<ContributionReceiptV1>,
): Promise<ReceiptResponse> {
  const bootstrap = await getBootstrap();
  const payload = await verifyCoordinatorEnvelope<ContributionReceiptV1>(
    envelope,
    RECEIPT_DOMAIN,
    bootstrap.manifest.payload,
  );
  assertReceipt(payload);
  if (
    payload.ceremonyId !== bootstrap.manifest.payload.ceremonyId ||
    payload.relationManifestSha256 !==
      (await canonicalSha256(
        MANIFEST_HASH_DOMAIN,
        bootstrap.manifest.payload,
      )) ||
    payload.type !== "moss.phase2.receipt.v1" ||
    payload.generation !== payload.contributionIndex ||
    payload.participantPseudonym !== participant.participantName
  ) {
    throw new Error("Signed contribution receipt is malformed.");
  }
  return {
    success: true,
    receiptId,
    circuitId: CIRCUIT_ID,
    participantId: participant.participantId,
    contributionIndex: payload.contributionIndex,
    contributionHash: payload.successor.sha256,
    clientContributionHash: payload.contributionHashBlake2b512,
    serverContributionHash: payload.contributionHashBlake2b512,
    previousContributionHash: payload.predecessor.sha256,
    chainHash: payload.transcriptEventHash,
    timestamp: Date.parse(payload.acceptedAt),
    signedReceipt: envelope,
  };
}

async function verifyCoordinatorEnvelope<T>(
  envelope: SignedEnvelope<T>,
  domain: string,
  manifest: CeremonyManifestV1,
): Promise<T> {
  if (envelope.schemaVersion !== 1 || !/^[A-Za-z0-9_-]{86}$/u.test(envelope.signature)) {
    throw new Error("Coordinator signed envelope is malformed.");
  }
  const key = manifest.coordinatorKeys.find((item) => item.keyId === envelope.keyId);
  if (!key) throw new Error("Coordinator signing key is not in the root manifest.");
  const signature = base64urlBytes(envelope.signature);
  const publicKey = await crypto.subtle.importKey(
    "spki",
    exactArrayBuffer(pemSpkiBytes(key.publicKeyPem)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const payload = new TextEncoder().encode(canonicalize(envelope.payload));
  const domainBytes = new TextEncoder().encode(domain);
  const message = new Uint8Array(domainBytes.byteLength + 1 + payload.byteLength);
  message.set(domainBytes, 0);
  message.set(payload, domainBytes.byteLength + 1);
  if (
    !(await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      exactArrayBuffer(signature),
      exactArrayBuffer(message),
    ))
  ) {
    throw new Error("Coordinator signed envelope has an invalid signature.");
  }
  return envelope.payload;
}

async function coordinatorFetch<T>(
  path: string,
  options: RequestInit & {
    auth?: boolean;
    idempotencyKey?: string;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const bootstrap = await getBootstrap(options.signal ?? undefined);
  const headers = new Headers(options.headers);
  if (options.auth) {
    headers.set(
      "authorization",
      `Bearer ${(await getParticipantToken(options.signal ?? undefined)).token}`,
    );
  }
  if (options.idempotencyKey) {
    headers.set("idempotency-key", options.idempotencyKey);
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Request timed out.", "TimeoutError")),
    options.timeoutMs ?? 30_000,
  );
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(new URL(path, bootstrap.coordinatorBaseUrl), {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      ...options,
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("application/json")
        ? ((await response.json()) as { error?: string })
        : { error: await response.text() };
      throw new Error(body.error || `Coordinator request failed (${response.status}).`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function getBootstrap(signal?: AbortSignal): Promise<CoordinatorBootstrap> {
  bootstrapPromise ??= apiFetch<CoordinatorBootstrap>("/api/ceremony/bootstrap", {
    signal,
  }).then((bootstrap) => {
    cachedBootstrap = bootstrap;
    return bootstrap;
  }).catch((error) => {
    bootstrapPromise = undefined;
    throw error;
  });
  return await bootstrapPromise;
}

async function getParticipantToken(signal?: AbortSignal): Promise<ParticipantToken> {
  if (cachedToken && cachedToken.expiresAt > Date.now() / 1_000 + 120) {
    return cachedToken;
  }
  cachedToken = await apiFetch<ParticipantToken>("/api/ceremony/auth/token", {
    signal,
    cache: "no-store",
  });
  return cachedToken;
}

async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const body = contentType.includes("application/json")
      ? ((await response.json()) as { error?: string })
      : { error: await response.text() };
    throw new Error(body.error || `Request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

async function recoverAcceptedReceipt(
  participant: ParticipantToken,
  signal?: AbortSignal,
  suppliedState?: ParticipantStateResponse,
  allowMissingLocalEvidence = false,
): Promise<ReceiptResponse | null> {
  const state = suppliedState ?? (await getMyCoordinatorState(signal));
  if (
    state.participantId !== participant.participantId ||
    !state.submission?.receiptId
  ) {
    return null;
  }
  const envelope = await coordinatorFetch<SignedEnvelope<ContributionReceiptV1>>(
    `/v1/receipts/${encodeURIComponent(state.submission.receiptId)}`,
    { auth: true, signal },
  );
  const receipt = await mapAndVerifyReceipt(
    state.submission.receiptId,
    participant,
    envelope,
  );
  const bootstrap = await getBootstrap(signal);
  const journal = readBrowserJournal(
    bootstrap.manifest.payload.ceremonyId,
    participant.participantId,
  );
  if (journal?.submissionId && journal.submissionId !== state.submission.submissionId) {
    throw new Error("Coordinator submission differs from the browser recovery journal.");
  }
  if (!journal?.evidence) {
    // Browsing a signed receipt on another device does not prove local authorship.
    // Active contribution recovery still requires exact local evidence below.
    if (allowMissingLocalEvidence) {
      rememberReceipt(receipt);
      return receipt;
    }
    throw new Error(
      "Coordinator reports an accepted receipt, but this browser has no local contribution evidence with which to verify it.",
    );
  }
  const evidence = journal.evidence;
  const payload = receipt.signedReceipt.payload;
  if (
    evidence.manifestSha256 !== payload.relationManifestSha256 ||
    evidence.predecessorSha256 !== payload.predecessor.sha256 ||
    evidence.predecessorByteLength !== payload.predecessor.byteLength ||
    evidence.successorSha256 !== payload.successor.sha256 ||
    evidence.successorByteLength !== payload.successor.byteLength ||
    evidence.contributionHashBlake2b512 !==
      payload.contributionHashBlake2b512 ||
    evidence.contributionName !== payload.contributionName ||
    evidence.baseGeneration + 1 !== payload.generation
  ) {
    throw new Error("Recovered signed receipt differs from the browser contribution journal.");
  }
  rememberReceipt(receipt);
  rememberJournalIdentifiers(bootstrap, participant, {
    submissionId: state.submission.submissionId,
    receiptId: state.submission.receiptId,
  });
  // Accepted while no tab was waiting on it: the verified, stored receipt
  // replaces the saved output, which is otherwise never removed.
  if (journal.outputFileName) await forgetSavedOutput(bootstrap, participant, journal.outputFileName);
  return receipt;
}

function ensureBrowserJournal(
  bootstrap: CoordinatorBootstrap,
  participant: ParticipantToken,
): BrowserContributionJournal {
  const ceremonyId = bootstrap.manifest.payload.ceremonyId;
  return (
    readBrowserJournal(ceremonyId, participant.participantId) ?? {
      schemaVersion: 1,
      ceremonyId,
      participantId: participant.participantId,
      updatedAt: new Date().toISOString(),
    }
  );
}

function rememberJournalIdentifiers(
  bootstrap: CoordinatorBootstrap,
  participant: ParticipantToken,
  patch: Partial<Pick<
    BrowserContributionJournal,
    | "queueTicketId"
    | "leaseId"
    | "claimedLeaseId"
    | "uploadId"
    | "submissionId"
    | "receiptId"
  >>,
): void {
  const journal = ensureBrowserJournal(bootstrap, participant);
  if (
    journal.submissionId &&
    patch.submissionId &&
    journal.submissionId !== patch.submissionId
  ) {
    throw new Error("Coordinator submission differs from the browser recovery journal.");
  }
  if (
    journal.evidence &&
    journal.leaseId &&
    patch.leaseId &&
    journal.leaseId !== patch.leaseId
  ) {
    throw new Error("Coordinator lease differs from the browser recovery journal.");
  }
  Object.assign(journal, patch);
  writeBrowserJournal(journal);
}

function rememberJournalEvidence(
  bootstrap: CoordinatorBootstrap,
  participant: ParticipantToken,
  evidence: BrowserJournalEvidence,
): void {
  assertBrowserJournalEvidence(evidence);
  const journal = ensureBrowserJournal(bootstrap, participant);
  journal.evidence = evidence;
  writeBrowserJournal(journal);
}

function readBrowserJournal(
  ceremonyId: string,
  participantId: string,
): BrowserContributionJournal | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(LOCAL_JOURNALS_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Browser contribution journal is corrupted.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Browser contribution journal is malformed.");
  }
  for (const value of parsed) {
    const journal = parseBrowserJournal(value);
    if (
      journal.ceremonyId === ceremonyId &&
      journal.participantId === participantId
    ) {
      return journal;
    }
  }
  return null;
}

function writeBrowserJournal(journal: BrowserContributionJournal): void {
  if (typeof localStorage === "undefined") {
    throw new Error("Browser persistent storage is unavailable.");
  }
  journal.updatedAt = new Date().toISOString();
  const checked = parseBrowserJournal(journal);
  let existing: BrowserContributionJournal[] = [];
  const raw = localStorage.getItem(LOCAL_JOURNALS_KEY);
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Browser contribution journal is corrupted.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Browser contribution journal is malformed.");
    }
    existing = parsed.map(parseBrowserJournal);
  }
  const filtered = existing.filter(
    (item) =>
      item.ceremonyId !== checked.ceremonyId ||
      item.participantId !== checked.participantId,
  );
  localStorage.setItem(
    LOCAL_JOURNALS_KEY,
    JSON.stringify([...filtered, checked]),
  );
}

function removeBrowserJournal(ceremonyId: string, participantId: string): void {
  if (typeof localStorage === "undefined") return;
  const raw = localStorage.getItem(LOCAL_JOURNALS_KEY);
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  const kept = parsed.filter((value) => {
    const row = value as Partial<BrowserContributionJournal> | null;
    return row?.ceremonyId !== ceremonyId || row?.participantId !== participantId;
  });
  if (kept.length === 0) localStorage.removeItem(LOCAL_JOURNALS_KEY);
  else localStorage.setItem(LOCAL_JOURNALS_KEY, JSON.stringify(kept));
}

const CONTRIBUTION_FILE = /^cabure-phase2-[0-9a-f-]+(\.input)?\.zkey$/;

/**
 * Discard an attempt that will not be submitted: its saved output and its
 * journal entry. `sweep` also removes worker files left by a page that closed
 * mid-download or mid-computation; only pass it when no tab is contributing.
 */
async function discardLocalAttempt(
  ceremonyId: string,
  participantId: string,
  options: { sweep?: boolean } = {},
): Promise<void> {
  let journal: BrowserContributionJournal | null = null;
  try {
    journal = readBrowserJournal(ceremonyId, participantId);
  } catch {
    // Corrupted journals hold nothing worth recovering.
  }
  if (journal?.outputFileName) {
    await removeBrowserContributionFile(journal.outputFileName).catch(() => undefined);
  }
  removeBrowserJournal(ceremonyId, participantId);
  if (options.sweep) await sweepContributionFiles();
}

async function sweepContributionFiles(): Promise<void> {
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") return;
  try {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (CONTRIBUTION_FILE.test(name)) names.push(name);
    }
    for (const name of names) await root.removeEntry(name).catch(() => undefined);
  } catch {
    // Leftover files only cost storage; the browser can still reclaim it.
  }
}

async function forgetSavedOutput(
  bootstrap: CoordinatorBootstrap,
  participant: ParticipantToken,
  outputFileName: string,
): Promise<void> {
  await removeBrowserContributionFile(outputFileName).catch(() => undefined);
  const journal = ensureBrowserJournal(bootstrap, participant);
  delete journal.outputFileName;
  writeBrowserJournal(journal);
}

function resetBrowserJournalAttempt(
  bootstrap: CoordinatorBootstrap,
  participant: ParticipantToken,
): void {
  writeBrowserJournal({
    schemaVersion: 1,
    ceremonyId: bootstrap.manifest.payload.ceremonyId,
    participantId: participant.participantId,
    updatedAt: new Date().toISOString(),
  });
}

function parseBrowserJournal(value: unknown): BrowserContributionJournal {
  const row = strictRecord(value, "browser contribution journal");
  if (row.schemaVersion !== 1) {
    throw new Error("Browser contribution journal schema is invalid.");
  }
  const participantId = strictText(
    row.participantId,
    "browser contribution journal participant id",
  );
  if (!PARTICIPANT_UUID.test(participantId)) {
    throw new Error("Browser contribution journal participant id is invalid.");
  }
  const journal: BrowserContributionJournal = {
    schemaVersion: 1,
    ceremonyId: strictText(row.ceremonyId, "browser contribution journal ceremony id"),
    participantId,
    updatedAt: strictIsoDate(row.updatedAt, "browser contribution journal update time"),
    ...optionalJournalText(row, "queueIdempotencyKey"),
    ...optionalJournalText(row, "queueTicketId"),
    ...optionalJournalText(row, "leaseId"),
    ...optionalJournalText(row, "claimedLeaseId"),
    ...optionalJournalText(row, "uploadId"),
    ...optionalJournalText(row, "submissionId"),
    ...optionalJournalText(row, "receiptId"),
  };
  if (row.outputFileName !== undefined) {
    if (typeof row.outputFileName !== "string" || !/^cabure-phase2-[0-9a-f-]+\.zkey$/.test(row.outputFileName)) throw new Error("Invalid saved contribution filename.");
    journal.outputFileName = row.outputFileName;
  }
  if (row.multipartParts !== undefined) journal.multipartParts = parseMultipartParts(row.multipartParts);
  if (row.evidence !== undefined) {
    const evidence = row.evidence as BrowserJournalEvidence;
    assertBrowserJournalEvidence(evidence);
    journal.evidence = evidence;
  }
  return journal;
}

function optionalJournalText(
  row: Record<string, unknown>,
  key: keyof BrowserContributionJournal,
): Record<string, string> {
  return row[key] === undefined ? {} : { [key]: strictText(row[key], String(key)) };
}

function assertBrowserJournalEvidence(
  evidence: BrowserJournalEvidence,
): void {
  if (
    !/^[a-f0-9]{64}$/u.test(evidence.manifestSha256) ||
    !/^[a-f0-9]{64}$/u.test(evidence.predecessorSha256) ||
    !Number.isSafeInteger(evidence.predecessorByteLength) ||
    evidence.predecessorByteLength < 1 ||
    !/^[a-f0-9]{64}$/u.test(evidence.successorSha256) ||
    !Number.isSafeInteger(evidence.successorByteLength) ||
    evidence.successorByteLength < 1 ||
    !/^[a-f0-9]{128}$/u.test(evidence.contributionHashBlake2b512) ||
    typeof evidence.contributionName !== "string" ||
    evidence.contributionName.length < 1 ||
    evidence.contributionName.length > 64 ||
    !Number.isSafeInteger(evidence.baseGeneration) ||
    evidence.baseGeneration < 0
  ) {
    throw new Error("Browser contribution journal evidence is invalid.");
  }
}

function assertUploadState(
  value: UploadStateResponse,
  expectedUploadId: string,
): void {
  if (
    value.uploadId !== expectedUploadId ||
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.state) ||
    !isCanonicalIsoDate(value.expiresAt) ||
    ((value.state === "UPLOADING" || value.state === "COMPLETED") &&
      (!value.artifact ||
        !/^[a-f0-9]{64}$/u.test(value.artifact.sha256) ||
        !Number.isSafeInteger(value.artifact.byteLength) ||
        value.artifact.byteLength < 1))
  ) {
    throw new Error("Coordinator durable upload state is malformed.");
  }
}

async function readVerifiedLocalReceipts(
  participant: ParticipantToken,
): Promise<ReceiptResponse[]> {
  if (typeof localStorage === "undefined") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(LOCAL_RECEIPTS_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const verified: ReceiptResponse[] = [];
  for (const value of parsed) {
    const receipt = value as ReceiptResponse;
    if (
      receipt?.participantId !== participant.participantId ||
      !receipt.signedReceipt
    ) continue;
    try {
      verified.push(
        await mapAndVerifyReceipt(
          receipt.receiptId,
          participant,
          receipt.signedReceipt,
        ),
      );
    } catch {
      // Ignore corrupted local UI cache entries; the signature is authoritative.
    }
  }
  return verified;
}

function rememberReceipt(receipt: ReceiptResponse): void {
  if (typeof localStorage === "undefined") return;
  try {
    const existing = JSON.parse(
      localStorage.getItem(LOCAL_RECEIPTS_KEY) ?? "[]",
    ) as ReceiptResponse[];
    const filtered = Array.isArray(existing)
      ? existing.filter((item) => item.receiptId !== receipt.receiptId)
      : [];
    localStorage.setItem(
      LOCAL_RECEIPTS_KEY,
      JSON.stringify([...filtered, receipt]),
    );
  } catch {
    // Receipt persistence is a convenience; the returned signed receipt remains valid.
  }
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function strictText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function strictNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return Number(value);
}

function strictPositiveInteger(value: unknown, label: string): number {
  const parsed = strictNonnegativeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} is invalid.`);
  return parsed;
}

function strictIsoDate(value: unknown, label: string): string {
  const text = strictText(value, label);
  if (!isCanonicalIsoDate(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function validateCoordinatorArtifactUrl(value: string): void {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !localHttp)
  ) {
    throw new Error("Coordinator artifact URL is invalid.");
  }
}

function normalizeHex(value: string, length: number, label: string): string {
  const normalized = value.toLowerCase().replace(/^0x/u, "");
  if (normalized.length !== length || !/^[a-f0-9]+$/u.test(normalized)) {
    throw new Error(`${label} is malformed.`);
  }
  return normalized;
}

function assertCheckpoint(value: HeadCheckpointV1): void {
  if (
    value?.schemaVersion !== 1 ||
    value.type !== "moss.phase2.checkpoint.v1" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !Number.isSafeInteger(value.headByteLength) ||
    value.headByteLength <= 0 ||
    !/^[a-f0-9]{64}$/u.test(value.headSha256) ||
    !/^[a-f0-9]{64}$/u.test(value.eventHash) ||
    !isCanonicalIsoDate(value.issuedAt) ||
    !isCanonicalIsoDate(value.expiresAt) ||
    value.issuedAt >= value.expiresAt
  ) {
    throw new Error("Signed ceremony checkpoint is malformed.");
  }
}

function assertReceipt(value: ContributionReceiptV1): void {
  if (
    value?.schemaVersion !== 1 ||
    value.type !== "moss.phase2.receipt.v1" ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
    typeof value.participantPseudonym !== "string" || !value.participantPseudonym.trim() || value.participantPseudonym.length > 128 ||
    typeof value.contributionName !== "string" || !value.contributionName.trim() || value.contributionName.length > 256 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    value.generation !== value.contributionIndex ||
    !/^[a-f0-9]{64}$/u.test(value.relationManifestSha256) ||
    !/^[a-f0-9]{128}$/u.test(value.contributionHashBlake2b512) ||
    !/^[a-f0-9]{64}$/u.test(value.transcriptEventHash) ||
    !isCanonicalIsoDate(value.acceptedAt) ||
    !["browser", "cli", "other"].includes(value.clientKind) ||
    !(value.clientReleaseSha256 === null || /^[a-f0-9]{64}$/u.test(value.clientReleaseSha256))
  ) {
    throw new Error("Signed contribution receipt is malformed.");
  }
  for (const artifact of [value.predecessor, value.successor]) {
    if (
      !/^[a-f0-9]{64}$/u.test(artifact?.sha256) ||
      !Number.isSafeInteger(artifact?.byteLength) ||
      artifact.byteLength <= 0 ||
      !Array.isArray(artifact.urls) ||
      artifact.urls.length === 0
    ) {
      throw new Error("Signed receipt artifact reference is malformed.");
    }
  }
}

function isCanonicalIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function base64urlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url.");
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(`${base64}${padding}`);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const canonical = bytesToBase64url(bytes);
  if (canonical !== value) throw new Error("Noncanonical base64url.");
  return bytes;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function pemSpkiBytes(pem: string): Uint8Array {
  const match = pem.match(
    /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END PUBLIC KEY-----\r?\n?$/u,
  );
  if (!match) throw new Error("Coordinator public key PEM is malformed.");
  return base64Bytes(match[1]!.replace(/\s/gu, ""));
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function canonicalize(value: unknown, stack = new Set<object>()): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Signed payload number is invalid.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") throw new Error("Signed payload is not JSON.");
  if (stack.has(value)) throw new Error("Signed payload contains a cycle.");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalize(item, stack)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], stack)}`)
      .join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

/**
 * The collectible's art seed for a receipt, matching the server's
 * `MOSS_PHASE2_NFT_RECEIPT_V1` hash in lib/nft/server.ts. Display only: the
 * mint voucher always uses the hash of the receipt the server verified.
 */
export async function collectibleReceiptHash(
  envelope: SignedEnvelope<ContributionReceiptV1>,
): Promise<`0x${string}`> {
  return `0x${await canonicalSha256("MOSS_PHASE2_NFT_RECEIPT_V1", envelope.payload)}`;
}

async function canonicalSha256(domain: string, value: unknown): Promise<string> {
  const domainBytes = new TextEncoder().encode(domain);
  const payload = new TextEncoder().encode(canonicalize(value));
  const message = new Uint8Array(domainBytes.byteLength + 1 + payload.byteLength);
  message.set(domainBytes);
  message.set(payload, domainBytes.byteLength + 1);
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(message));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Select only from the authenticated immutable manifest, never a job claim. */
export async function getContributionArtifactFormat(signal?: AbortSignal): Promise<"zkey" | "bellman"> {
  const method = (await getBootstrap(signal)).manifest.payload.verifierPolicy.verificationMethod;
  if (method === "bellman-transition-v1") return "bellman";
  if (method === undefined || method === "snarkjs-zkey-v1") return "zkey";
  throw new Error("Unsupported contribution verification policy.");
}
