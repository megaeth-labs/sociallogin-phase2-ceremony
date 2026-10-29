"use client";
import { requireDesktopContribution } from "@/lib/contribution-device";

import { getContributionArtifactFormat } from "@/lib/api";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getBrowserContributionCapabilities,
  removeBrowserContributionFile,
  requestPersistentBrowserStorage,
} from "@wonderland/cabure-crypto/browser";

import {
  abandonAttemptOnUnload,
  cancelAttempt,
  claimOffer,
  getContributionLockName,
  getQueuePosition,
  getStatus,
  getHeartbeatIntervalMs,
  heartbeatLease,
  journalContributionEvidence,
  joinQueue,
  submitContribution,
  uploadZkey,
  type CoordinatorLease,
  type CoordinatorOffer,
  type ReceiptResponse,
} from "@/lib/api";
import type {
  CircuitRunItem,
  CircuitRunStatus,
  ContribPhase,
} from "@/app/screens/ProgressScreen";
import { describeBrowserCapabilityFailure } from "@/lib/capability-messages";
import type { ClientCircuitConfig } from "@/lib/ceremony-config";
import { runContribution } from "@/lib/worker-client";
import {
  DOWNLOAD_SLOT_RELEASED,
  UPLOAD_SLOT_RELEASED,
  UPLOAD_TOO_SLOW,
  projectedUploadMisses,
  workerProgress,
  type WorkerProgress,
} from "@/lib/contribution-progress";
import { claimAvailable } from "@/lib/public-ceremony";
import { acquireContributionLock, type ContributionLock } from "@/lib/contribution-lock";
import { deriveEntropy } from "@/utils/entropy";
import { useParticipant } from "@/hooks/useParticipant";

// Server receipt plus the contributor's OWN h_k, computed client-side
// (`result.contributionHash` from contribute(), not the server's
// `serverContributionHash`). The attestation publishes this so it is the
// contributor's own statement and can surface an operator that recorded a
// different hash. See CompleteScreen.
export interface ContributionReceiptWithClient extends ReceiptResponse {
  clientHk: string;
}

export interface ContributionFlowState {
  circuitRuns: CircuitRunItem[];
  currentCircuitIndex: number;
  currentCircuitId: string | null;
  currentCircuit: ClientCircuitConfig | undefined;
  contributionPhase: ContribPhase;
  contributionProgress: number;
  workerProgressDetail: WorkerProgress | null;
  contributionError: string | null;
  queueError: string | null;
  finalizeReady: boolean;
  receipts: ContributionReceiptWithClient[];
  offer: CoordinatorOffer | null;
  leaseExpiresAt: string | null;
  claiming: boolean;
  /** The queue's offer is a slot this participant already claimed. */
  offerClaimed: boolean;
  /** The contribution was handed to the server for verification; it can no longer be cancelled. */
  submitted: boolean;
  /** The queue place ended, usually an offer that lapsed unclaimed; rejoining takes a click. */
  turnMissed: boolean;
}

/** The attempt in flight: its claimed slot, and whether it was handed over. */
interface AttemptState {
  lease: CoordinatorLease;
  submitted: boolean;
}

export const ALREADY_OPEN_ELSEWHERE =
  "Your contribution is already open in another tab. Continue there, or close that tab and try again.";
const SLOT_IN_USE_ELSEWHERE =
  "Your slot is in use in another tab or browser. Continue there, or return to the homepage.";

export interface JoinOptions {
  tierId?: string;
  circuitIds?: string[];
}

export interface ContributionFlowActions {
  joinAndStart: (options: JoinOptions, circuits: ClientCircuitConfig[]) => Promise<void>;
  claim: () => void;
  retry: () => void;
  /** Take a new place at the end of the queue after a missed turn. */
  rejoin: () => void;
  cancel: () => Promise<CancelOutcome>;
  detach: () => void;
  reset: () => void;
}

/** "submitted" when the coordinator already holds the contribution for verification. */
export type CancelOutcome = "cancelled" | "submitted";

export function useContributionFlow(options: {
  overrideFailedCheck?: boolean;
  entropySeed: Uint8Array | null;
  selectedCircuitIds: string[];
  circuits: ClientCircuitConfig[];
  active: boolean;
  /** Start as soon as a slot is offered, without waiting for a click. Defaults to true. */
  autoClaim?: boolean;
}): ContributionFlowState & ContributionFlowActions {
  const {
    entropySeed,
    selectedCircuitIds,
    circuits,
    active: flowActive,
    autoClaim = true,
  } = options;

  const queryClient = useQueryClient();
  const { participantId } = useParticipant();

  const [circuitRuns, setCircuitRuns] = useState<CircuitRunItem[]>([]);
  const [resolvedCircuitIds, setResolvedCircuitIds] = useState<string[]>([]);
  const [currentCircuitIndex, setCurrentCircuitIndex] = useState(0);
  const [flowRunId, setFlowRunId] = useState(0);
  const [finalizeReady, setFinalizeReady] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [contributionPhase, setContributionPhase] =
    useState<ContribPhase>("downloading");
  const [contributionProgress, setContributionProgress] = useState(0);
  const [workerProgressDetail, setWorkerProgressDetail] =
    useState<WorkerProgress | null>(null);
  const [contributionError, setContributionError] = useState<string | null>(
    null,
  );
  const [receipts, setReceipts] = useState<ContributionReceiptWithClient[]>([]);

  const contributionAbortRef = useRef<AbortController | null>(null);
  const claimInFlight = useRef(false);
  const [leaseExpiresAt, setLeaseExpiresAt] = useState<string | null>(null);
  const attemptRef = useRef<AttemptState | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // Held from joining until the attempt ends, so other tabs can tell this
  // attempt is running and never cancel it.
  const lockRef = useRef<ContributionLock | null>(null);
  // While set, closing or reloading the page gives up the queue place or slot.
  // Cleared once the contribution is handed over for verification.
  const cancelOnClose = useRef(false);
  // The slot release after a failed attempt, which a retry waits for.
  const releaseRef = useRef<Promise<unknown> | null>(null);
  // An ended queue place waits for a click to rejoin, so an unattended tab
  // drops out after one missed offer instead of cycling through the queue.
  const [turnMissed, setTurnMissed] = useState(false);
  // Set by "Try again", the one case where an ended place rejoins by itself.
  const rejoinWhenTicketEnds = useRef(false);

  const activeCircuitIds =
    resolvedCircuitIds.length > 0 ? resolvedCircuitIds : selectedCircuitIds;
  const currentCircuitId = activeCircuitIds[currentCircuitIndex] ?? null;
  const currentCircuit = circuits.find(
    (circuit) => circuit.id === currentCircuitId,
  );

  const updateCircuitRun = useCallback(
    (circuitId: string, patch: Partial<CircuitRunItem>) => {
      setCircuitRuns((prev) =>
        prev.map((circuit) =>
          circuit.id === circuitId ? { ...circuit, ...patch } : circuit,
        ),
      );
    },
    [],
  );

  const markCircuitStatus = useCallback(
    (circuitId: string, status: CircuitRunStatus) => {
      updateCircuitRun(circuitId, { status });
    },
    [updateCircuitRun],
  );

  // --- Contribution mutation (download → compute → upload) ---

  const contributeMutation = useMutation({
    mutationFn: async ({
      circuitId,
      offer,
    }: {
      circuitId: string;
      offer: CoordinatorOffer;
    }) => {
      requireDesktopContribution();
      const seed = entropySeed!;

      const controller = new AbortController();
      contributionAbortRef.current = controller;

      markCircuitStatus(circuitId, "active");
      setContributionError(null);
      setQueueError(null);
      setContributionPhase("downloading");
      setContributionProgress(0);
      setWorkerProgressDetail(null);
      setSubmitted(false);

      attemptRef.current = null;
      const lease = await claimOffer(offer, controller.signal);
      const attempt: AttemptState = { lease, submitted: false };
      attemptRef.current = attempt;
      setLeaseExpiresAt(lease.expiresAt);
      let heartbeatFailures = 0;
      let heartbeatError: Error | null = null;
      let heartbeatInFlight = false;
      let heartbeatStopped = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let heartbeatPhase: ContribPhase = "downloading";
      let heartbeatPercent = 0;
      // Byte counts while uploading, so the coordinator can tell a slow upload.
      let uploadBytes: { uploadedBytes: number; totalBytes: number } | null = null;
      const stopHeartbeat = () => {
        heartbeatStopped = true;
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      };
      const sendHeartbeat = async () => {
        if (heartbeatStopped || heartbeatInFlight || controller.signal.aborted) return;
        heartbeatInFlight = true;
        try {
          await heartbeatLease(
            lease.leaseId,
            { phase: heartbeatPhase, percent: heartbeatPercent,
              ...(heartbeatPhase === "uploading" && uploadBytes ? uploadBytes : {}) },
            controller.signal,
          );
          heartbeatFailures = 0;
        } catch (error) {
          if (heartbeatStopped || controller.signal.aborted) return;
          heartbeatFailures += 1;
          if (heartbeatFailures >= 3) {
            heartbeatError =
              error instanceof Error
                ? error
                : new Error("Ceremony lease heartbeat failed.");
            controller.abort(heartbeatError);
          }
        } finally {
          heartbeatInFlight = false;
        }
      };
      await heartbeatLease(
        lease.leaseId,
        { phase: "downloading", percent: 0 },
        controller.signal,
      );

      const heartbeatIntervalMs = await getHeartbeatIntervalMs(
        controller.signal,
      );
      heartbeatTimer = setInterval(
        () => void sendHeartbeat(),
        heartbeatIntervalMs,
      );

      const entropy = await deriveEntropy(seed, circuitId);
      let computed = false;
      let result: Awaited<ReturnType<typeof runContribution>>;
      try {
        result = await runContribution({
          artifactFormat: await getContributionArtifactFormat(controller.signal),
          overrideFailedCheck: options.overrideFailedCheck === true,
          predecessorUrl: lease.predecessor.downloadUrl,
          predecessorSize: lease.predecessor.byteLength,
          predecessorSha256: `0x${lease.predecessor.sha256}`,
          entropy,
          name: lease.expectedContributionName,
          onProgress: (stage, percent) => {
            if (stage === "compute") computed = true;
            const detail = workerProgress(stage, percent, computed);
            if (detail) {
              heartbeatPhase = detail.phase;
              heartbeatPercent = detail.heartbeatPercent;
              setContributionPhase(detail.phase);
              setContributionProgress(heartbeatPercent);
              setWorkerProgressDetail(detail);
            }
          },
          signal: controller.signal,
        });
      } catch (error) {
        stopHeartbeat();
        // Assigned by the heartbeat callback, which control-flow narrowing cannot see.
        const lost = heartbeatError as Error | null;
        if (lost && heartbeatPhase === "downloading"
          && /lease is unavailable or expired/i.test(lost.message)) {
          throw new Error(DOWNLOAD_SLOT_RELEASED);
        }
        throw lost ?? error;
      }

      try {
        heartbeatPhase = "uploading";
        heartbeatPercent = 85;
        setContributionPhase("uploading");
        setContributionProgress(85);

        if (!participantId) {
          throw new Error("Not signed in: cannot upload contribution.");
        }
        const output = await result.outputFile.getFile();
        if (output.size !== result.outputSize) {
          throw new Error("Local contribution output changed before upload.");
        }
        await journalContributionEvidence({
          outputFileName: result.outputFileName,
          lease,
          contributionHash: result.contributionHash,
          expectedZkeySha256: result.zkeyHash,
          expectedZkeyByteLength: result.outputSize,
          signal: controller.signal,
        });
        // Stop an upload that cannot finish before the slot's deadline: its
        // submission would be refused anyway, and the next person can start.
        const uploadStartedAt = Date.now();
        const deadline = Date.parse(lease.expiresAt);
        const uploadId = await uploadZkey({
          leaseId: lease.leaseId,
          payload: output,
          expectedSha256: result.zkeyHash,
          signal: controller.signal,
          onProgress: (uploaded, total) => {
            uploadBytes = { uploadedBytes: uploaded, totalBytes: total };
            heartbeatPercent = 85 + (7 * uploaded) / total;
            setContributionProgress(heartbeatPercent);
            const now = Date.now();
            if (projectedUploadMisses({ startedAt: uploadStartedAt, now, uploaded, total, deadline })) {
              controller.abort(new Error(UPLOAD_TOO_SLOW));
            }
          },
        });

        stopHeartbeat();
        // Handed over: from here a closed page must not cancel, and the
        // coordinator would refuse to anyway.
        attempt.submitted = true;
        cancelOnClose.current = false;
        setSubmitted(true);
        heartbeatPhase = "verifying";
        heartbeatPercent = 92;
        setContributionPhase("verifying");
        setContributionProgress(92);
        const receipt = await submitContribution({
          lease,
          uploadId,
          contributionHash: result.contributionHash,
          expectedZkeySha256: result.zkeyHash,
          expectedZkeyByteLength: result.outputSize,
          signal: controller.signal,
        });

        return { ...receipt, clientHk: result.contributionHash };
      } catch (error) {
        const reason = controller.signal.reason;
        if (reason instanceof Error && reason.message === UPLOAD_TOO_SLOW) throw reason;
        // Assigned by the heartbeat callback, which control-flow narrowing cannot see.
        const lost = heartbeatError as Error | null;
        if (lost && heartbeatPhase === "uploading"
          && /lease is unavailable or expired/i.test(lost.message)) {
          throw new Error(UPLOAD_SLOT_RELEASED);
        }
        throw lost ?? error;
      } finally {
        stopHeartbeat();
        // Nothing reuses the output once it is uploaded, or once the attempt
        // fails: a failed slot is released rather than resumed.
        await removeBrowserContributionFile(result.outputFileName).catch(
          () => undefined,
        );
      }
    },
    onSettled: () => { claimInFlight.current = false; },
    onSuccess: (receipt) => {
      const circuitId = receipt.circuitId;
      attemptRef.current = null;

      setReceipts((prev) => [...prev, receipt]);
      setContributionProgress(100);
      markCircuitStatus(circuitId, "done");

      if (currentCircuitIndex < activeCircuitIds.length - 1) {
        setCurrentCircuitIndex((value) => value + 1);
      } else {
        entropySeed?.fill(0);
        setFinalizeReady(true);
        cancelOnClose.current = false;
        lockRef.current?.release();
        lockRef.current = null;
      }
    },
    onError: (error) => {
      if (error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : String(error);
      const attempt = attemptRef.current;
      if (attempt && !attempt.submitted) {
        // A claimed slot cannot be resumed: give it to the next person now
        // rather than holding the queue until the heartbeat lapses.
        cancelOnClose.current = false;
        releaseRef.current = cancelAttempt().catch(() => undefined);
      }
      setContributionError(message);
      if (currentCircuitId) {
        markCircuitStatus(currentCircuitId, "error");
      }
    },
  });

  // --- Rejoin mutation ---

  const rejoinMutation = useMutation({
    mutationFn: async () => {
      requireDesktopContribution();
      const remaining = activeCircuitIds.slice(currentCircuitIndex);
      return await joinQueue({
        circuitIds: remaining,
      });
    },
    onSuccess: (result) => {
      const remaining = activeCircuitIds.slice(currentCircuitIndex);
      setCircuitRuns((prev) =>
        prev.map((circuit) => {
          if (!remaining.includes(circuit.id) || circuit.status === "done") {
            return circuit;
          }
          const position = result.positions.find(
            (item) => item.circuitId === circuit.id,
          );
          return {
            ...circuit,
            status: "waiting" as const,
            position: position?.position,
            etaSeconds: position?.estimatedWaitSeconds,
          };
        }),
      );
      setQueueError(null);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setQueueError(message);
    },
  });

  // --- Queue position query (auto-polling) ---

  const queueEnabled =
    flowActive &&
    circuitRuns.length > 0 &&
    !contributionError &&
    !turnMissed &&
    !!currentCircuitId &&
    !contributeMutation.isPending &&
    !finalizeReady;
  const queuePositionQueryKey = [
    "queuePosition",
    flowRunId,
    currentCircuitId,
  ] as const;

  const queueQuery = useQuery({
    queryKey: queuePositionQueryKey,
    queryFn: ({ signal }) =>
      getQueuePosition({
        circuitId: currentCircuitId!,
        signal,
      }),
    refetchInterval: 3_000,
    // The slot-ready alert only fires while the tab is hidden, so the queue
    // position must keep updating there too.
    refetchIntervalInBackground: true,
    enabled: queueEnabled,
    retry: false,
  });

  // Update circuit run with latest queue position
  useEffect(() => {
    if (!queueQuery.data || !currentCircuitId) return;
    updateCircuitRun(currentCircuitId, {
      position: queueQuery.data.position,
      etaSeconds: queueQuery.data.estimatedWaitSeconds,
    });
    // This tab never claimed it, so another tab or browser is using the slot.
    setQueueError(queueQuery.data.offerClaimed ? SLOT_IN_USE_ELSEWHERE : null);
  }, [queueQuery.data, currentCircuitId, updateCircuitRun]);

  // Claims the offered slot. Joining already required the participant's
  // randomness and consent, so an offer is claimed automatically; this action
  // stays as the fallback button if that automatic claim did not go through.
  const claim = () => {
    const offer = queueQuery.data?.offer;
    if (!offer || !currentCircuitId || !entropySeed || finalizeReady ||
        claimInFlight.current || contributeMutation.isPending ||
        !claimAvailable(offer.expiresAt, Date.now())) return;
    if (queueQuery.data?.offerClaimed) return;
    claimInFlight.current = true;
    contributeMutation.mutate({ circuitId: currentCircuitId, offer });
  };

  // Each offer is claimed automatically once, so a tab left in the background
  // contributes when its turn comes instead of letting the offer lapse.
  const autoClaimedLeaseId = useRef<string | null>(null);
  useEffect(() => {
    const offer = queueQuery.data?.offer;
    if (!autoClaim || !offer || queueQuery.data?.offerClaimed || contributionError) return;
    if (autoClaimedLeaseId.current === offer.leaseId) return;
    autoClaimedLeaseId.current = offer.leaseId;
    claim();
    // claim reads the latest state itself; this runs once per new offer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoClaim, queueQuery.data, contributionError]);

  useEffect(() => {
    if (!contributeMutation.isPending || contributionPhase === "verifying") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [contributeMutation.isPending, contributionPhase]);

  // Closing or reloading the page cancels the attempt: the queue place or
  // claimed slot goes to the next person at once, instead of after the
  // server's heartbeat expiry, which stays as the backstop.
  useEffect(() => {
    let abandoned = false;
    const abandon = () => {
      if (!cancelOnClose.current) return;
      cancelOnClose.current = false;
      abandoned = true;
      abandonAttemptOnUnload();
    };
    // Restored from the back/forward cache after giving the slot up.
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted && abandoned) window.location.reload();
    };
    window.addEventListener("pagehide", abandon);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pagehide", abandon);
      window.removeEventListener("pageshow", restore);
      // Leaving the page without unloading it abandons the attempt too.
      abandon();
      contributionAbortRef.current?.abort();
      lockRef.current?.release();
      lockRef.current = null;
    };
  }, []);

  // A "not in queue" answer means the place ended, usually an offer that lapsed
  // unclaimed. Rejoin only after "Try again"; otherwise wait for a click.
  // isPending is intentionally omitted: including it would cause infinite
  // rejoin attempts when the rejoin itself fails with the error still present.
  useEffect(() => {
    const msg = queueQuery.error?.message ?? "";
    if (
      (msg.toLowerCase().includes("not in queue") ||
        msg.toLowerCase().includes("queue ticket not found")) &&
      !finalizeReady &&
      !rejoinMutation.isPending
    ) {
      if (rejoinWhenTicketEnds.current) {
        rejoinWhenTicketEnds.current = false;
        rejoinMutation.mutate();
      } else {
        setTurnMissed(true);
      }
    } else if (
      queueQuery.error &&
      !msg.toLowerCase().includes("not in queue") &&
      !msg.toLowerCase().includes("queue ticket not found")
    ) {
      setQueueError(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueQuery.error, finalizeReady]);

  // --- Actions (same public API) ---

  const joinAndStart = async (
    joinOptions: JoinOptions,
    allCircuits: ClientCircuitConfig[],
  ) => {
    if (process.env.NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED !== "true") {
      throw new Error(
        "Browser contributions are not enabled for this release. Use the signed CLI.",
      );
    }
    requireDesktopContribution();
    if (!lockRef.current) {
      const lock = await acquireContributionLock(await getContributionLockName());
      if (!lock) throw new Error(ALREADY_OPEN_ELSEWHERE);
      lockRef.current = lock;
    }
    await requestPersistentBrowserStorage().catch(() => false);
    // Readiness estimates are advisory when the participant explicitly opts out.
    // Artifact pins, entropy generation and actual I/O still enforce their rules.
    if (!options.overrideFailedCheck) {
      const status = await getStatus();
      const capabilities = await getBrowserContributionCapabilities({
        inputSizeBytes: status.headByteLength,
      });
      if (!capabilities.supported) {
        throw new Error(describeBrowserCapabilityFailure(capabilities));
      }
    }

    attemptRef.current = null;
    setSubmitted(false);
    setLeaseExpiresAt(null);
    setTurnMissed(false);
    rejoinWhenTicketEnds.current = false;
    setCircuitRuns([]);
    setResolvedCircuitIds([]);
    setQueueError(null);
    setCurrentCircuitIndex(0);
    setFinalizeReady(false);
    setContributionPhase("downloading");
    setContributionProgress(0);
    setWorkerProgressDetail(null);
    setContributionError(null);
    setReceipts([]);
    contributeMutation.reset();
    queryClient.removeQueries({ queryKey: ["queuePosition"] });
    setFlowRunId((value) => value + 1);

    let result: Awaited<ReturnType<typeof joinQueue>>;
    cancelOnClose.current = true;
    try {
      result = await joinQueue(joinOptions);
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : String(error));
      throw error;
    }

    const ids = result.positions.map((p) => p.circuitId);
    setResolvedCircuitIds(ids);

    const runs: CircuitRunItem[] = ids.map((circuitId) => {
      const circuit = allCircuits.find((item) => item.id === circuitId);
      const position = result.positions.find(
        (item) => item.circuitId === circuitId,
      );
      return {
        id: circuitId,
        label: circuit?.label ?? circuitId,
        status: "waiting",
        position: position?.position,
        etaSeconds: position?.estimatedWaitSeconds,
      };
    });

    setCircuitRuns(runs);
  };

  /** Back into the queue: a failed attempt's slot was already released. */
  const retry = () => {
    if (attemptRef.current?.submitted) return;
    attemptRef.current = null;
    setSubmitted(false);
    setLeaseExpiresAt(null);
    if (currentCircuitId) {
      markCircuitStatus(currentCircuitId, "waiting");
    }
    setContributionError(null);
    setQueueError(null);
    contributeMutation.reset();
    cancelOnClose.current = true;
    // The released place no longer exists; this explicit retry rejoins it.
    rejoinWhenTicketEnds.current = true;
    setTurnMissed(false);
    // Poll only once the release has landed, so the old slot is not seen again.
    void Promise.resolve(releaseRef.current).then(() => {
      releaseRef.current = null;
      void queryClient.resetQueries({
        queryKey: queuePositionQueryKey,
      });
    });
  };

  /** After a missed turn: take a new place at the end of the queue. */
  const rejoin = () => {
    if (!turnMissed || rejoinMutation.isPending) return;
    setQueueError(null);
    queryClient.removeQueries({ queryKey: queuePositionQueryKey });
    // Polling resumes only once the new place exists.
    rejoinMutation.mutate(undefined, { onSuccess: () => setTurnMissed(false) });
  };

  /** Stop locally without touching the coordinator. */
  const detach = () => {
    entropySeed?.fill(0);
    contributionAbortRef.current?.abort();
    contributeMutation.reset();
    resetState();
  };

  /** Stop locally, then ask the coordinator to release the slot for the next person. */
  const cancel = async (): Promise<CancelOutcome> => {
    // Keep the lock until the release lands, so a homepage check in the
    // meantime does not mistake this for a page that closed.
    const lock = lockRef.current;
    lockRef.current = null;
    detach();
    try {
      // On failure the journal is kept, so the next visit can still cancel.
      return await cancelAttempt().catch(() => "cancelled" as const);
    } finally {
      lock?.release();
    }
  };

  const resetState = () => {
    attemptRef.current = null;
    cancelOnClose.current = false;
    rejoinWhenTicketEnds.current = false;
    setTurnMissed(false);
    lockRef.current?.release();
    lockRef.current = null;
    setSubmitted(false);
    setLeaseExpiresAt(null);
    setCircuitRuns([]);
    setResolvedCircuitIds([]);
    setQueueError(null);
    setCurrentCircuitIndex(0);
    setFlowRunId((value) => value + 1);
    setFinalizeReady(false);
    setContributionPhase("downloading");
    setContributionProgress(0);
    setWorkerProgressDetail(null);
    setContributionError(null);
    setReceipts([]);
    contributeMutation.reset();
    queryClient.removeQueries({ queryKey: ["queuePosition"] });
  };

  return {
    circuitRuns,
    currentCircuitIndex,
    currentCircuitId,
    currentCircuit,
    contributionPhase,
    contributionProgress,
    workerProgressDetail,
    contributionError,
    queueError,
    finalizeReady,
    receipts,
    offer: queueQuery.data?.offer ?? null,
    leaseExpiresAt,
    claiming: contributeMutation.isPending,
    offerClaimed: queueQuery.data?.offerClaimed === true,
    submitted,
    turnMissed,
    joinAndStart,
    claim,
    retry,
    rejoin,
    cancel,
    detach,
    reset: resetState,
  };
}
