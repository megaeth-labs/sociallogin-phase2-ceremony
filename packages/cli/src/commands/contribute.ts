import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import {
  assertCompatibleParticipantToken,
  authenticate,
  inspectCompatibleParticipantToken,
  readTokenFile,
} from "../auth.js";
import {
  assertLeaseMatchesCheckpoint,
  loadTrustedCeremonyState,
  loadUpdatedCliReleases,
} from "../ceremony-state.js";
import { CeremonyClient, parseCoordinatorTarget } from "../client.js";
import { computeContribution, type ContributionFormat } from "../contribution.js";
import { checkBellmanAppend, savedCandidate } from "../candidate.js";
import {
  contributionWorkspacePath,
  createContributionWorkspace,
  downloadToFile,
  hashFile,
  persistReceipt,
  removeContributionWorkspace,
  requireAvailableDisk,
  type DownloadResult,
} from "../files.js";
import { LeaseHeartbeat } from "../heartbeat.js";
import { queueInterruptHandler, type InterruptPhase } from "../interrupt.js";
import {
  loadContributionJournal,
  newContributionJournal,
  saveContributionJournal,
  type ContributionJournalV1,
} from "../journal.js";
import { resolveCliReleaseSha256 } from "../release.js";
import { verifyReceipt } from "../trust.js";
import type {
  LeaseResponse,
  OfferResponse,
  ParticipantStateResponse,
  QueueResponse,
  SubmissionResponse,
  TrustedCeremonyState,
  UploadStateResponse,
} from "../types.js";
import { formatBytes, sleep } from "../utils.js";

const QUEUE_POLL_INTERVAL_MS = 3_000;
const SUBMISSION_POLL_INTERVAL_MS = 3_000;
const SUBMISSION_POLL_LIMIT_MS = 6 * 60 * 60_000;
const MINIMUM_WORKSPACE_BYTES = 1_500_000_000n;

export interface ContributeOptions {
  slug?: string;
  manifestRootKey: string;
  authUrl?: string;
  token?: string;
  tokenFile?: string;
  allowDevelopmentManifest?: boolean; allowRehearsal?: boolean;
}

export async function contributeCommand(
  rawUrl: string,
  options: ContributeOptions,
): Promise<void> {
  if (options.token && options.tokenFile) {
    throw new Error("Use only one of --token and --token-file.");
  }
  const target = parseCoordinatorTarget(rawUrl, options.slug);
  if (options.allowDevelopmentManifest && target.production) {
    throw new Error("Development manifests are allowed only on a localhost coordinator URL.");
  }
  console.log(`\nCeremony: ${target.ceremonyUrl}`);
  printSeededHostWarning();

  const publicClient = new CeremonyClient(target);
  const trusted = await loadTrustedCeremonyState(publicClient, options.manifestRootKey, options);
  // The signed policy fixes the artifact format for the whole epoch.
  const format: ContributionFormat =
    trusted.manifest.verifierPolicy.verificationMethod === "bellman-transition-v1" ? "bellman" : "zkey";
  const clientReleaseSha256 = await resolveCliReleaseSha256(trusted.manifest, {
    updatedReleases: () => loadUpdatedCliReleases(publicClient, trusted, options.manifestRootKey, options),
  });

  const participant = await resolveParticipant(
    target.ceremonyUrl,
    target.baseUrl,
    options,
  );
  const client = new CeremonyClient(target, participant.token);
  const remoteState = await retryCoordinatorAction(
    "recover participant state",
    () => client.getMyState(),
  );
  assertParticipantState(remoteState, trusted, participant.participantId);
  const journal =
    (await loadContributionJournal(target.ceremonyUrl, participant.participantId)) ??
    newContributionJournal({
      ceremonyUrl: target.ceremonyUrl,
      ceremonyId: trusted.manifest.ceremonyId,
      participantId: participant.participantId,
    });
  if (shouldResetAttemptJournal(remoteState)) {
    resetJournalAttempt(journal);
  }
  reconcileJournal(journal, remoteState);
  await saveContributionJournal(journal);

  // Ctrl-C while waiting for a turn leaves the queue; once a claim is sent the
  // slot stays reserved so a rerun can resume it.
  let phase: InterruptPhase = "idle";
  const onInterrupt = queueInterruptHandler({
    phase: () => phase,
    leaveQueue: () => client.cancelMyQueue(),
    async forgetQueue() {
      delete journal.queueIdempotencyKey;
      delete journal.queueTicketId;
      delete journal.leaseId;
      await saveContributionJournal(journal);
    },
    log: (message) => console.error(message),
    exit: (code) => process.exit(code),
  });
  const interruptListener = (signal: NodeJS.Signals) => void onInterrupt(signal);
  // The command ends the process when it returns, so the listeners stay.
  process.on("SIGINT", interruptListener);
  process.on("SIGTERM", interruptListener);

  if (
    remoteState.submission &&
    ["REJECTED", "STALE", "EXPIRED", "CANCELLED"].includes(
      remoteState.submission.state,
    )
  ) {
    console.log(
      `Prior submission ${remoteState.submission.submissionId} ended in ${remoteState.submission.state}; starting a new attempt...`,
    );
    resetJournalAttempt(journal);
    await saveContributionJournal(journal);
  } else if (remoteState.submission) {
    phase = "leased";
    await recoverExistingSubmission({
      client,
      trusted,
      journal,
      submission: remoteState.submission,
      participantName: participant.participantName,
    });
    return;
  }

  if (
    remoteState.lease?.state === "ACTIVE" &&
    journal.uploadId &&
    journal.evidence
  ) {
    phase = "leased";
    const resumed = await resumeDurableUploadSubmission({
      client,
      trusted,
      journal,
      lease: remoteState.lease,
      participantName: participant.participantName,
      clientReleaseSha256,
    });
    if (resumed) {
      await recoverExistingSubmission({
        client,
        trusted,
        journal,
        submission: resumed,
        participantName: participant.participantName,
      });
      return;
    }
  }

  if (trusted.status.state !== "OPEN") throw new Error("Ceremony is not open.");
  if (trusted.status.generation >= trusted.manifest.contributionPolicy.maximumContributions) {
    throw new Error("Ceremony has reached its signed maximum contribution count.");
  }

  let lease: LeaseResponse;
  if (remoteState.lease?.state === "ACTIVE") {
    phase = "leased";
    lease = remoteState.lease;
    console.log(`Resuming active lease ${lease.leaseId} from coordinator state...`);
  } else {
    let joined: QueueResponse;
    // A LEASED ticket has already been claimed; never cancel it.
    phase = remoteState.queue?.status === "LEASED" ? "leased" : "waiting";
    if (
      remoteState.queue &&
      ["QUEUED", "OFFERED", "LEASED"].includes(remoteState.queue.status)
    ) {
      joined = remoteState.queue;
      console.log(`Resuming queue ticket ${joined.ticketId}...`);
    } else {
      console.log("Joining queue...");
      journal.queueIdempotencyKey ??= `cli-queue:${randomUUID()}`;
      await saveContributionJournal(journal);
      joined = await retryCoordinatorAction(
        "join queue",
        () => client.joinQueue(journal.queueIdempotencyKey!),
      );
      journal.queueTicketId = joined.ticketId;
      await saveContributionJournal(journal);
    }
    const offer = await waitForOffer(client, joined);
    journal.leaseId = offer.leaseId;
    await saveContributionJournal(journal);
    console.log("  Contribution offer received; claiming lease...");
    phase = "leased";
    lease = await claimLease(client, offer);
    assertClaimMatchesOffer(lease, offer);
  }
  journal.leaseId = lease.leaseId;
  await saveContributionJournal(journal);
  const heartbeat = new LeaseHeartbeat(
    client,
    lease.leaseId,
    Math.min(5_000, Math.max(
      1_000,
      Math.floor(trusted.manifest.contributionPolicy.lease.heartbeatSeconds * 1_000 / 3),
    )),
  );

  let workspace: string | undefined;
  let accepted = false;
  try {
    await heartbeat.start();
    const claimedState = await loadTrustedCeremonyState(publicClient, options.manifestRootKey, options);
    if (claimedState.manifestSha256 !== trusted.manifestSha256) {
      throw new Error("Signed ceremony manifest changed after queueing.");
    }
    assertLeaseMatchesCheckpoint(lease, claimedState);

    let predecessor: DownloadResult;
    let successor: DownloadResult;
    let contributionHashBlake2b512: string;
    const saved = await savedCandidate({
      journal,
      lease,
      manifestSha256: trusted.manifestSha256,
      participantName: participant.participantName,
      format,
    });
    if (saved) {
      ({ predecessor, successor } = saved);
      contributionHashBlake2b512 = saved.contributionHashBlake2b512;
      workspace = saved.workspace;
      console.log("  Reusing the contribution computed before the restart; it will be uploaded without recomputation.");
    } else {
      if (journal.workspaceId) {
        await removeContributionWorkspace(contributionWorkspacePath(journal.workspaceId));
        delete journal.workspaceId;
      }
      workspace = await createContributionWorkspace();
      const requiredBytes = maxBigInt(
        MINIMUM_WORKSPACE_BYTES,
        BigInt(lease.predecessor.byteLength) * 2n + 256n * 1024n * 1024n,
      );
      try {
        await requireAvailableDisk(workspace, requiredBytes);
      } catch (error) {
        await removeContributionWorkspace(workspace);
        workspace = undefined;
        throw error;
      }
      journal.workspaceId = basename(workspace);
      delete journal.evidence;
      await saveContributionJournal(journal);
      const predecessorPath = join(workspace, `predecessor.${extension(format)}`);
      const successorPath = join(workspace, `successor.${extension(format)}`);

      heartbeat.update("DOWNLOADING", { receivedBytes: 0, totalBytes: lease.predecessor.byteLength });
      console.log("  Downloading and hashing the leased predecessor...");
      const predecessorProgress = progressPrinter("download");
      predecessor = await downloadToFile({
        url: lease.predecessor.downloadUrl,
        destination: predecessorPath,
        expectedSha256: lease.predecessor.sha256,
        expectedByteLength: lease.predecessor.byteLength,
        onProgress(received, total) {
          heartbeat.update("DOWNLOADING", { receivedBytes: received, totalBytes: total });
          predecessorProgress(received, total ?? lease.predecessor.byteLength);
        },
      });
      predecessorProgress(predecessor.byteLength, predecessor.byteLength, true);
      console.log(`  Predecessor integrity verified (${formatBytes(predecessor.byteLength)}).`);
      await heartbeat.ensureHealthy();
      assertLeaseTimeRemaining(lease, "compute");

      heartbeat.update("COMPUTING");
      console.log(format === "bellman"
        ? "  Computing the filesystem-backed Bellman contribution..."
        : "  Computing the filesystem-backed Groth16 contribution...");
      contributionHashBlake2b512 = await computeContribution({
        predecessorPath,
        successorPath,
        contributionName: lease.expectedContributionName,
        format,
      });
      if (format === "bellman") {
        await checkBellmanAppend({
          predecessorPath,
          successorPath,
          baseGeneration: lease.baseGeneration,
          contributionHashBlake2b512,
        });
      }
      successor = await hashFile(successorPath);
      if (successor.byteLength > claimedState.manifest.contributionPolicy.maxArtifactByteLength) {
        throw new Error("Successor exceeds the signed maximum artifact byte length.");
      }
      console.log(`  Contribution hash: ${contributionHashBlake2b512}`);
      console.log(`  Successor SHA-256: ${successor.sha256}`);
      journal.evidence = {
        manifestSha256: trusted.manifestSha256,
        predecessorSha256: predecessor.sha256,
        predecessorByteLength: predecessor.byteLength,
        successorSha256: successor.sha256,
        successorByteLength: successor.byteLength,
        contributionHashBlake2b512,
        contributionName: lease.expectedContributionName,
        baseGeneration: lease.baseGeneration,
        participantPseudonym: participant.participantName,
      };
      await saveContributionJournal(journal);
    }
    await heartbeat.ensureHealthy();
    assertLeaseTimeRemaining(lease, "upload");

    // Re-check the signed head immediately before releasing the candidate bytes.
    const preUploadState = await loadTrustedCeremonyState(publicClient, options.manifestRootKey, options);
    if (preUploadState.manifestSha256 !== trusted.manifestSha256) {
      throw new Error("Signed ceremony manifest changed during contribution.");
    }
    assertLeaseMatchesCheckpoint(lease, preUploadState);

    heartbeat.update("UPLOADING", { uploadedBytes: 0, totalBytes: successor.byteLength });
    console.log("  Uploading candidate to coordinator quarantine...");
    const grant = await retryCoordinatorAction(
      "create upload",
      () => client.createUpload(lease.leaseId),
    );
    journal.uploadId = grant.uploadId;
    await saveContributionJournal(journal);
    const uploadProgress = progressPrinter("upload");
    const uploaded = await client.uploadCandidate({
      grant,
      path: successor.path,
      sha256: successor.sha256,
      byteLength: successor.byteLength,
      onProgress(sent, total) {
        heartbeat.update("UPLOADING", { uploadedBytes: sent, totalBytes: total });
        uploadProgress(sent, total);
      },
    });
    uploadProgress(successor.byteLength, successor.byteLength, true);
    await heartbeat.ensureHealthy();
    assertLeaseTimeRemaining(lease, "submission");

    await retryCoordinatorAction(
      "complete upload",
      () => client.completeUpload(grant.uploadId, {
        sha256: successor.sha256,
        byteLength: successor.byteLength,
        ...(uploaded.parts ? { parts: uploaded.parts } : {}),
      }),
    );
    heartbeat.update("SUBMITTING");
    const submissionInput = {
      uploadId: grant.uploadId,
      predecessorSha256: predecessor.sha256,
      contributionHashBlake2b512,
      ...(clientReleaseSha256 ? { clientReleaseSha256 } : {}),
    };
    const submitIdempotencyKey = `cli-submit:${lease.leaseId}`;
    let submitted: SubmissionResponse;
    try {
      submitted = await retryCoordinatorAction(
        "submit candidate",
        () => client.submit(
          lease.leaseId,
          submissionInput,
          submitIdempotencyKey,
        ),
      );
    } catch (submitError) {
      // A response can remain unavailable after the coordinator committed the
      // submission. Recover only from this participant-scoped lease and only
      // when it exposes the durable submission identifier.
      const recovered = await client.getLease(lease.leaseId).catch(() => null);
      if (
        !recovered?.submissionId ||
        !["SUBMITTED", "VERIFYING", "ACCEPTED"].includes(recovered.state) ||
        recovered.leaseId !== lease.leaseId ||
        recovered.baseGeneration !== lease.baseGeneration ||
        recovered.predecessor.sha256 !== lease.predecessor.sha256 ||
        recovered.predecessor.byteLength !== lease.predecessor.byteLength ||
        recovered.expectedContributionName !== lease.expectedContributionName
      ) {
        throw submitError;
      }
      submitted = {
        submissionId: recovered.submissionId,
        state: recovered.state,
      };
    }
    journal.submissionId = submitted.submissionId;
    await saveContributionJournal(journal);
    await heartbeat.stop();

    console.log(`  Candidate submitted (${submitted.submissionId}); awaiting independent verification...`);
    const completed = await waitForReceipt(client, submitted);
    const receiptEnvelope = await retryCoordinatorAction(
      "fetch receipt",
      () => client.getReceipt(completed.receiptId),
    );
    const receipt = verifyReceipt(
      receiptEnvelope,
      trusted.manifest,
      {
        manifestSha256: trusted.manifestSha256,
        predecessorSha256: predecessor.sha256,
        predecessorByteLength: predecessor.byteLength,
        successorSha256: successor.sha256,
        successorByteLength: successor.byteLength,
        contributionHashBlake2b512,
        contributionName: lease.expectedContributionName,
        baseGeneration: lease.baseGeneration,
      },
    );
    if (receipt.participantPseudonym !== participant.participantName) {
      throw new Error("Signed receipt participant does not match the authenticated CLI identity.");
    }
    const receiptPath = await persistReceipt(trusted.manifest.ceremonyId, receipt.sequence, {
      receiptEnvelope,
      localEvidence: {
        predecessorSha256: predecessor.sha256,
        successorSha256: successor.sha256,
        contributionHashBlake2b512,
        contributionName: lease.expectedContributionName,
        submissionId: submitted.submissionId,
      },
    });
    await removeContributionWorkspace(workspace);
    workspace = undefined;
    accepted = true;
    phase = "idle";
    journal.receiptId = completed.receiptId;
    delete journal.workspaceId;
    await saveContributionJournal(journal);

    console.log(`\nContribution #${receipt.contributionIndex} accepted.`);
    console.log(`Signed receipt saved to ${receiptPath}`);
    console.log(`Successor: ${receipt.successor.sha256}\n`);
  } finally {
    await heartbeat.stop().catch(() => undefined);
    if (!accepted && workspace) {
      console.error(`  Contribution workspace retained for recovery: ${workspace}`);
    }
  }
}

async function resolveParticipant(
  ceremonyUrl: string,
  coordinatorBaseUrl: string,
  options: ContributeOptions,
): Promise<{
  token: string;
  participantId: string;
  participantName: string;
}> {
  if (options.tokenFile) {
    const token = await readTokenFile(options.tokenFile);
    return { token, ...inspectCompatibleParticipantToken(token) };
  }
  if (options.token) {
    assertCompatibleParticipantToken(options.token);
    return {
      token: options.token,
      ...inspectCompatibleParticipantToken(options.token),
    };
  }
  console.log("Authenticating with the device flow...");
  const auth = await authenticate({
    authUrl: options.authUrl ?? coordinatorBaseUrl,
    ceremonyUrl,
  });
  return {
    token: auth.token,
    participantId: auth.participantId,
    participantName: auth.participantName,
  };
}

async function waitForOffer(client: CeremonyClient, initial: QueueResponse): Promise<OfferResponse> {
  let queue = initial;
  for (;;) {
    if ((queue.status === "OFFERED" || queue.status === "LEASED") && queue.offer) {
      return queue.offer;
    }
    if (queue.status !== "QUEUED") {
      throw new Error(`Queue ticket entered terminal or unsupported state ${queue.status}.`);
    }
    process.stdout.write(`\r  Queue position: ${queue.position}  `);
    await sleep(QUEUE_POLL_INTERVAL_MS);
    queue = await retryCoordinatorAction("poll queue", () => client.getMyQueue());
  }
}

async function claimLease(client: CeremonyClient, offer: OfferResponse): Promise<LeaseResponse> {
  try {
    return await client.claimOffer(offer.leaseId);
  } catch (claimError) {
    // A claim response can be lost after the coordinator commits it. Recover only
    // if an authenticated lease lookup proves this exact lease is already active.
    const lease = await client.getLease(offer.leaseId).catch(() => null);
    if (lease?.state === "ACTIVE") return lease;
    throw claimError;
  }
}

function assertClaimMatchesOffer(lease: LeaseResponse, offer: OfferResponse): void {
  if (
    lease.leaseId !== offer.leaseId ||
    lease.baseGeneration !== offer.baseGeneration ||
    lease.expectedContributionName !== offer.expectedContributionName ||
    lease.predecessor.sha256 !== offer.predecessor.sha256 ||
    lease.predecessor.byteLength !== offer.predecessor.byteLength
  ) {
    throw new Error("Claimed lease differs from the contribution offer.");
  }
}

async function waitForReceipt(
  client: CeremonyClient,
  initial: SubmissionResponse,
): Promise<SubmissionResponse & { receiptId: string }> {
  const deadline = Date.now() + SUBMISSION_POLL_LIMIT_MS;
  let submission = initial;
  for (;;) {
    if (submission.receiptId) return submission as SubmissionResponse & { receiptId: string };
    if (["REJECTED", "STALE", "CANCELLED"].includes(submission.state)) {
      throw new Error(`Candidate verification ended in state ${submission.state}.`);
    }
    if (!["SUBMITTED", "VERIFYING", "ACCEPTED"].includes(submission.state)) {
      throw new Error(`Candidate entered unsupported submission state ${submission.state}.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out awaiting verification. Submission ${submission.submissionId} can be polled later.`,
      );
    }
    await sleep(SUBMISSION_POLL_INTERVAL_MS);
    const next = await retryCoordinatorAction(
      "poll submission",
      () => client.getSubmission(submission.submissionId),
    );
    if (next.submissionId !== initial.submissionId) {
      throw new Error("Coordinator returned a different submission while polling.");
    }
    submission = next;
  }
}

async function recoverExistingSubmission(input: {
  client: CeremonyClient;
  trusted: TrustedCeremonyState;
  journal: ContributionJournalV1;
  submission: SubmissionResponse;
  participantName: string;
}): Promise<void> {
  const { client, trusted, journal, participantName } = input;
  if (!journal.evidence) {
    throw new Error(
      `Coordinator reports submission ${input.submission.submissionId}, but this client has no local evidence journal with which to verify its receipt.`,
    );
  }
  if (
    journal.submissionId &&
    journal.submissionId !== input.submission.submissionId
  ) {
    throw new Error("Coordinator submission differs from the durable client journal.");
  }
  journal.submissionId = input.submission.submissionId;
  await saveContributionJournal(journal);

  console.log(
    `Recovering submission ${input.submission.submissionId} from coordinator state...`,
  );
  const completed = await waitForReceipt(client, input.submission);
  const envelope = await retryCoordinatorAction(
    "fetch recovered receipt",
    () => client.getReceipt(completed.receiptId),
  );
  const evidence = journal.evidence;
  if (evidence.manifestSha256 !== trusted.manifestSha256) {
    throw new Error("Recovery journal references a different signed ceremony manifest.");
  }
  const receipt = verifyReceipt(envelope, trusted.manifest, {
    manifestSha256: evidence.manifestSha256,
    predecessorSha256: evidence.predecessorSha256,
    predecessorByteLength: evidence.predecessorByteLength,
    successorSha256: evidence.successorSha256,
    successorByteLength: evidence.successorByteLength,
    contributionHashBlake2b512: evidence.contributionHashBlake2b512,
    contributionName: evidence.contributionName,
    baseGeneration: evidence.baseGeneration,
  });
  if (
    receipt.participantPseudonym !== participantName ||
    evidence.participantPseudonym !== participantName
  ) {
    throw new Error("Recovered receipt participant does not match the authenticated CLI identity.");
  }
  const receiptPath = await persistReceipt(
    trusted.manifest.ceremonyId,
    receipt.sequence,
    {
      receiptEnvelope: envelope,
      localEvidence: {
        predecessorSha256: evidence.predecessorSha256,
        successorSha256: evidence.successorSha256,
        contributionHashBlake2b512: evidence.contributionHashBlake2b512,
        contributionName: evidence.contributionName,
        submissionId: completed.submissionId,
        recoveredAfterRestart: true,
      },
    },
  );
  journal.receiptId = completed.receiptId;
  if (journal.workspaceId) {
    await removeContributionWorkspace(contributionWorkspacePath(journal.workspaceId));
    delete journal.workspaceId;
  }
  await saveContributionJournal(journal);
  console.log(`\nContribution #${receipt.contributionIndex} accepted.`);
  console.log(`Recovered signed receipt saved to ${receiptPath}\n`);
}

async function resumeDurableUploadSubmission(input: {
  client: CeremonyClient;
  trusted: TrustedCeremonyState;
  journal: ContributionJournalV1;
  lease: LeaseResponse;
  participantName: string;
  clientReleaseSha256?: string;
}): Promise<SubmissionResponse | null> {
  const {
    client,
    trusted,
    journal,
    lease,
    participantName,
    clientReleaseSha256,
  } = input;
  const evidence = journal.evidence!;
  if (
    evidence.manifestSha256 !== trusted.manifestSha256 ||
    evidence.predecessorSha256 !== lease.predecessor.sha256 ||
    evidence.predecessorByteLength !== lease.predecessor.byteLength ||
    evidence.contributionName !== lease.expectedContributionName ||
    evidence.baseGeneration !== lease.baseGeneration ||
    evidence.participantPseudonym !== participantName
  ) {
    throw new Error("Completed-upload recovery evidence does not match the active lease.");
  }
  assertLeaseMatchesCheckpoint(lease, trusted);
  assertLeaseTimeRemaining(lease, "completed-upload recovery");
  const upload = await retryCoordinatorAction(
    "recover durable upload",
    () => client.getUpload(journal.uploadId!),
  );
  if (upload.uploadId !== journal.uploadId) {
    throw new Error("Coordinator returned a different durable upload during recovery.");
  }
  if (upload.expiresAt !== lease.expiresAt || Date.parse(upload.expiresAt) <= Date.now()) {
    throw new Error("Durable upload expiry does not match the active lease.");
  }
  const recoveryAction = durableUploadRecoveryAction(upload, evidence);
  if (recoveryAction === null) return null;
  if (recoveryAction === "complete") {
    console.log(`Finalizing durable upload ${journal.uploadId} without recomputation...`);
    await retryCoordinatorAction(
      "complete recovered upload",
      () => client.completeUpload(journal.uploadId!, {
        sha256: evidence.successorSha256,
        byteLength: evidence.successorByteLength,
      }),
    );
  }
  console.log(`Resuming durable upload ${journal.uploadId}; submitting without recomputation...`);
  let submission: SubmissionResponse;
  try {
    submission = await retryCoordinatorAction(
      "submit recovered upload",
      () => client.submit(
        lease.leaseId,
        {
          uploadId: journal.uploadId!,
          predecessorSha256: evidence.predecessorSha256,
          contributionHashBlake2b512: evidence.contributionHashBlake2b512,
          ...(clientReleaseSha256 ? { clientReleaseSha256 } : {}),
        },
        `cli-submit:${lease.leaseId}`,
      ),
    );
  } catch (submitError) {
    const recovered = await client.getLease(lease.leaseId).catch(() => null);
    if (
      !recovered?.submissionId ||
      !["SUBMITTED", "VERIFYING", "ACCEPTED"].includes(recovered.state) ||
      recovered.leaseId !== lease.leaseId ||
      recovered.baseGeneration !== lease.baseGeneration ||
      recovered.predecessor.sha256 !== lease.predecessor.sha256 ||
      recovered.predecessor.byteLength !== lease.predecessor.byteLength ||
      recovered.expectedContributionName !== lease.expectedContributionName
    ) {
      throw submitError;
    }
    submission = {
      submissionId: recovered.submissionId,
      state: recovered.state,
    };
  }
  journal.submissionId = submission.submissionId;
  await saveContributionJournal(journal);
  return submission;
}

export function durableUploadRecoveryAction(
  upload: UploadStateResponse,
  evidence: NonNullable<ContributionJournalV1["evidence"]>,
): "complete" | "submit" | null {
  if (upload.state === "INITIATED") return null;
  if (upload.state !== "UPLOADING" && upload.state !== "COMPLETED") {
    throw new Error(`Durable upload is in unsupported state ${upload.state}.`);
  }
  if (
    !upload.artifact ||
    upload.artifact.sha256 !== evidence.successorSha256 ||
    upload.artifact.byteLength !== evidence.successorByteLength
  ) {
    throw new Error("Durable upload differs from the local recovery evidence.");
  }
  return upload.state === "UPLOADING" ? "complete" : "submit";
}

export function shouldResetAttemptJournal(
  state: ParticipantStateResponse,
): boolean {
  if (state.submission) return false;
  if (
    state.lease &&
    ["EXPIRED", "REJECTED", "STALE", "CANCELLED"].includes(
      state.lease.state,
    )
  ) {
    return true;
  }
  if (
    state.queue &&
    ["QUEUED", "OFFERED", "LEASED"].includes(state.queue.status)
  ) {
    return false;
  }
  if (state.lease?.state === "ACTIVE") return false;
  if (state.lease) {
    throw new Error(
      `Coordinator returned lease state ${state.lease.state} without its submission.`,
    );
  }
  return true;
}

function assertParticipantState(
  state: ParticipantStateResponse,
  trusted: TrustedCeremonyState,
  participantId: string,
): void {
  if (state.ceremonyId !== trusted.manifest.ceremonyId) {
    throw new Error("Participant recovery state belongs to a different ceremony.");
  }
  if (state.participantId !== participantId) {
    throw new Error("Participant recovery state belongs to a different identity.");
  }
}

function reconcileJournal(
  journal: ContributionJournalV1,
  state: ParticipantStateResponse,
): void {
  if (
    journal.ceremonyId !== state.ceremonyId ||
    journal.participantId !== state.participantId
  ) {
    throw new Error("Durable contribution journal belongs to different coordinator state.");
  }
  if (
    journal.submissionId &&
    state.submission &&
    journal.submissionId !== state.submission.submissionId
  ) {
    throw new Error("Coordinator submission differs from the durable client journal.");
  }
  if (
    journal.evidence &&
    journal.leaseId &&
    state.lease &&
    journal.leaseId !== state.lease.leaseId
  ) {
    throw new Error("Coordinator lease differs from the durable client journal.");
  }
  if (state.queue) journal.queueTicketId = state.queue.ticketId;
  if (state.lease) journal.leaseId = state.lease.leaseId;
  if (state.submission) journal.submissionId = state.submission.submissionId;
  if (state.submission?.receiptId) journal.receiptId = state.submission.receiptId;
}

function resetJournalAttempt(journal: ContributionJournalV1): void {
  delete journal.workspaceId;
  delete journal.queueIdempotencyKey;
  delete journal.queueTicketId;
  delete journal.leaseId;
  delete journal.uploadId;
  delete journal.submissionId;
  delete journal.receiptId;
  delete journal.evidence;
}

function extension(format: ContributionFormat): "params" | "zkey" {
  return format === "bellman" ? "params" : "zkey";
}

function assertLeaseTimeRemaining(lease: LeaseResponse, nextStage: string): void {
  if (Date.parse(lease.expiresAt) <= Date.now()) {
    throw new Error(`Lease expired before ${nextStage}; candidate will not be submitted.`);
  }
}

function progressPrinter(label: string): (done: number, total: number, final?: boolean) => void {
  let lastPrintedAt = 0;
  return (done, total, final = false) => {
    const now = Date.now();
    if (!final && now - lastPrintedAt < 1_000) return;
    lastPrintedAt = now;
    const percent = total > 0 ? Math.min(100, done / total * 100).toFixed(1) : "?";
    process.stdout.write(`\r  ${label}: ${formatBytes(done)} / ${formatBytes(total)} (${percent}%)  `);
    if (final) process.stdout.write("\n");
  };
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

async function retryCoordinatorAction<T>(
  label: string,
  action: () => Promise<T>,
  maximumAttempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt === maximumAttempts || !isRetryableCoordinatorError(error)) throw error;
      await sleep(attempt * 1_000);
    }
  }
  throw new Error(`${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function isRetryableCoordinatorError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = /Coordinator request failed \((\d{3})/u.exec(error.message)?.[1];
  if (status) {
    const code = Number(status);
    return code === 408 || code === 425 || code === 429 || code >= 500;
  }
  return error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError;
}

/**
 * A contribution's secrecy rests entirely on this host's CSPRNG. A machine
 * restored from a snapshot, cloned from an image, or provisioned from a golden
 * template can reproduce another contributor's entropy pool, and the resulting
 * contribution verifies structurally while adding nothing. Nothing downstream
 * can detect that from the contribution alone, so warn before any secret is
 * generated.
 */
function printSeededHostWarning(): void {
  console.log(
    [
      "",
      "  Run this on a freshly seeded host.",
      "",
      "  Do not contribute from a VM restored from a snapshot, cloned from an",
      "  image, or provisioned from a golden template. Such a host can reproduce",
      "  another contributor's random state, producing a contribution that",
      "  verifies but adds no entropy to the ceremony.",
      "",
      "  Destroy this machine's working directory and its secret material once",
      "  your receipt is saved.",
      "",
    ].join("\n"),
  );
}
