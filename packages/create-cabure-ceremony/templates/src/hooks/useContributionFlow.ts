"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getQueuePosition,
  getZkeyInfo,
  joinQueue,
  submitContribution,
  uploadZkey,
  type ReceiptResponse,
} from "@/lib/api";
import type {
  CircuitRunItem,
  CircuitRunStatus,
  ContribPhase,
} from "@/app/screens/ProgressScreen";
import type { ClientCircuitConfig } from "@/lib/ceremony-config";
import { runContribution } from "@/lib/worker-client";
import { deriveEntropy, sha256 } from "@/utils/entropy";
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
  contributionError: string | null;
  queueError: string | null;
  finalizeReady: boolean;
  receipts: ContributionReceiptWithClient[];
}

export interface JoinOptions {
  tierId?: string;
  circuitIds?: string[];
}

export interface ContributionFlowActions {
  joinAndStart: (options: JoinOptions, circuits: ClientCircuitConfig[]) => Promise<void>;
  retry: () => void;
  cancel: () => void;
  reset: () => void;
}

export function useContributionFlow(options: {
  entropySeed: Uint8Array | null;
  selectedCircuitIds: string[];
  circuits: ClientCircuitConfig[];
  active: boolean;
}): ContributionFlowState & ContributionFlowActions {
  const {
    entropySeed,
    selectedCircuitIds,
    circuits,
    active: flowActive,
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
  const [contributionError, setContributionError] = useState<string | null>(
    null,
  );
  const [receipts, setReceipts] = useState<ContributionReceiptWithClient[]>([]);

  const contributionAbortRef = useRef<AbortController | null>(null);

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
    mutationFn: async (circuitId: string) => {
      const seed = entropySeed!;

      const controller = new AbortController();
      contributionAbortRef.current = controller;

      markCircuitStatus(circuitId, "active");
      setContributionError(null);
      setQueueError(null);
      setContributionPhase("downloading");
      setContributionProgress(0);

      const zkeyInfo = await getZkeyInfo(circuitId, controller.signal);
      const zkeyResponse = await fetch(zkeyInfo.url, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!zkeyResponse.ok) {
        throw new Error("Failed to download zkey.");
      }
      const zkey = new Uint8Array(await zkeyResponse.arrayBuffer());

      if (zkeyInfo.hash) {
        const digest = await sha256(zkey);
        const hex = `0x${Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
        if (hex !== zkeyInfo.hash) {
          throw new Error(
            "Zkey integrity check failed: downloaded file does not match expected hash.",
          );
        }
      }

      setContributionProgress(15);
      setContributionPhase("computing");

      const entropy = await deriveEntropy(seed, circuitId);
      const result = await runContribution({
        prevZkey: zkey,
        entropy,
        name: "contributor",
        onProgress: (percent) => {
          setContributionProgress(15 + percent * 0.7);
        },
        signal: controller.signal,
      });

      // Refresh our queue entry now that the long compute is done, BEFORE the
      // upload and submit. Both prune the queue and reject anyone not at the front,
      // and a compute longer than queueTimeoutSeconds would otherwise have aged our
      // entry out. Bumping joinedAt (see the queue POST) keeps it alive through
      // upload + verify.
      try {
        await joinQueue({ circuitIds: [circuitId], signal: controller.signal });
      } catch (error) {
        // If the user cancelled, re-throw so the mutation exits here. Otherwise the
        // next state update would flash the UI to "uploading" after a cancel. Any
        // other error is best-effort: a later step may be rejected and retried.
        if (controller.signal.aborted) throw error;
      }

      setContributionPhase("uploading");
      setContributionProgress(85);

      if (!participantId) {
        throw new Error("Not signed in: cannot upload contribution.");
      }
      const blobUrl = await uploadZkey({
        circuitId,
        participantId,
        payload: result.zkey,
        signal: controller.signal,
      });

      // The submit POST runs the mandatory server-side verifyChain, seconds on
      // large circuits. Distinct phase so the contributor sees verification, not
      // a frozen "Upload".
      setContributionPhase("verifying");
      setContributionProgress(92);

      const receipt = await submitContribution({
        circuitId,
        contributionHash: result.contributionHash,
        blobUrl,
        signal: controller.signal,
      });
      if (receipt.contributionHash.toLowerCase() !== result.zkeyHash.toLowerCase()) {
        throw new Error(
          "Receipt hash mismatch: the coordinator stored a different zkey than the client uploaded.",
        );
      }

      // Attach the contributor's own h_k for the attestation (client-computed,
      // not the server's serverContributionHash).
      return { ...receipt, clientHk: result.contributionHash };
    },
    onSuccess: (receipt) => {
      const circuitId = receipt.circuitId;

      setReceipts((prev) => [...prev, receipt]);
      setContributionProgress(100);
      markCircuitStatus(circuitId, "done");

      if (currentCircuitIndex < activeCircuitIds.length - 1) {
        setCurrentCircuitIndex((value) => value + 1);
      } else {
        entropySeed?.fill(0);
        setFinalizeReady(true);
      }
    },
    onError: (error) => {
      if (error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : String(error);
      setContributionError(message);
      if (currentCircuitId) {
        markCircuitStatus(currentCircuitId, "error");
      }
    },
  });

  // --- Rejoin mutation ---

  const rejoinMutation = useMutation({
    mutationFn: async () => {
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
    setQueueError(null);
  }, [queueQuery.data, currentCircuitId, updateCircuitRun]);

  // Trigger contribution when at position 1.
  // isPending is intentionally omitted from deps: including it would cause
  // infinite retries on failure (isPending true→false re-fires the effect
  // while position is still 1). On success, currentCircuitId advances.
  useEffect(() => {
    if (
      queueQuery.data?.position === 1 &&
      !contributeMutation.isPending &&
      currentCircuitId &&
      !finalizeReady
    ) {
      contributeMutation.mutate(currentCircuitId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueQuery.data?.position, currentCircuitId, finalizeReady]);

  // Handle "not in queue" errors by rejoining.
  // isPending is intentionally omitted: including it would cause infinite
  // rejoin attempts when the rejoin itself fails with the error still present.
  useEffect(() => {
    const msg = queueQuery.error?.message ?? "";
    if (
      msg.toLowerCase().includes("not in queue") &&
      !finalizeReady &&
      !rejoinMutation.isPending
    ) {
      rejoinMutation.mutate();
    } else if (queueQuery.error && !msg.toLowerCase().includes("not in queue")) {
      setQueueError(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueQuery.error, finalizeReady]);

  // --- Actions (same public API) ---

  const joinAndStart = async (
    joinOptions: JoinOptions,
    allCircuits: ClientCircuitConfig[],
  ) => {
    setCircuitRuns([]);
    setResolvedCircuitIds([]);
    setQueueError(null);
    setCurrentCircuitIndex(0);
    setFinalizeReady(false);
    setContributionPhase("downloading");
    setContributionProgress(0);
    setContributionError(null);
    setReceipts([]);
    contributeMutation.reset();
    queryClient.removeQueries({ queryKey: ["queuePosition"] });
    setFlowRunId((value) => value + 1);

    const result = await joinQueue(joinOptions);

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

  const retry = () => {
    if (currentCircuitId) {
      markCircuitStatus(currentCircuitId, "waiting");
    }
    setContributionError(null);
    setQueueError(null);
    contributeMutation.reset();
    queryClient.resetQueries({
      queryKey: queuePositionQueryKey,
    });
  };

  const cancel = () => {
    entropySeed?.fill(0);
    contributionAbortRef.current?.abort();
    contributeMutation.reset();
    resetState();
  };

  const resetState = () => {
    setCircuitRuns([]);
    setResolvedCircuitIds([]);
    setQueueError(null);
    setCurrentCircuitIndex(0);
    setFlowRunId((value) => value + 1);
    setFinalizeReady(false);
    setContributionPhase("downloading");
    setContributionProgress(0);
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
    contributionError,
    queueError,
    finalizeReady,
    receipts,
    joinAndStart,
    retry,
    cancel,
    reset: resetState,
  };
}
