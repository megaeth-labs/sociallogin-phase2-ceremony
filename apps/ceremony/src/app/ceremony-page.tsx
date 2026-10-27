"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Header } from "./components/Header";
import { LandingScreen } from "./screens/LandingScreen";
import { EntropyScreen } from "./screens/EntropyScreen";
import { TierScreen } from "./screens/TierScreen";
import { ContributionJourney } from "./components/PublicCeremony";
import { Readiness } from "./components/PublicCeremony/Readiness";
import { CompleteScreen } from "./screens/CompleteScreen";
import { VerifyScreen } from "./screens/VerifyScreen";

import { type CeremonyStep, type TierId } from "@/lib/ceremony-config";
import { useCeremonyConfig } from "@/hooks/useCeremonyConfig";
import { useCeremonyStatus } from "@/hooks/useCeremonyStatus";
import { useParticipant } from "@/hooks/useParticipant";
import { useContributionFlow } from "@/hooks/useContributionFlow";
import { useOfferAlert } from "@/hooks/useOfferAlert";
import { useParticipantActivity } from "@/hooks/useParticipantActivity";
import { useAbandonedAttempt } from "@/hooks/useAbandonedAttempt";
import { participantActivityStage } from "@/lib/participant-activity";
import type { ReceiptResponse } from "@/lib/api";
import { ParticipantActivityCard } from "./components/ParticipantActivity";
import { Button } from "./components/Button";
import styles from "./page.module.css";

export default function CeremonyPage({ collectiblesEnabled = false }: { collectiblesEnabled?: boolean } = {}) {
  const config = useCeremonyConfig();
  const [step, setStep] = useState<CeremonyStep>("landing");
  const [entropySeed, setEntropySeed] = useState<Uint8Array | null>(null);
  const tiers = config.tiers ?? [];
  const tiersEnabled = config.tiersEnabled ?? false;
  const [selectedTier, setSelectedTier] = useState<TierId>(
    tiers[0]?.id ?? "core",
  );
  const [isJoining, setIsJoining] = useState(false);
  const joiningRef = useRef(false);
  const [overrideFailedCheck, setOverrideFailedCheck] = useState(false);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const { status, statusError } = useCeremonyStatus();
  const { authenticate, participantId } = useParticipant();
  const activity = useParticipantActivity(step === "landing" || step === "activity");
  const activityStage = activity.data ? participantActivityStage(activity.data) : "empty";
  // Not while this tab runs the flow or is cancelling it: its own attempt is
  // never abandoned.
  const [cancelling, setCancelling] = useState(false);
  const abandoned = useAbandonedAttempt(
    activity.data,
    activity.dataUpdatedAt,
    (step === "landing" || step === "activity") && !cancelling,
    () => void activity.refetch(),
  );
  const [pastReceipt, setPastReceipt] = useState<ReceiptResponse | null>(null);
  const viewReceipt = (receipt: ReceiptResponse) => {
    setPastReceipt(receipt);
    setStep("activity");
  };

  const selectedCircuitIds = useMemo(() => {
    if (!tiersEnabled) {
      return config.circuits.map((circuit) => circuit.id);
    }
    const tier = tiers.find((item) => item.id === selectedTier);
    return tier
      ? tier.circuitIds
      : config.circuits.map((circuit) => circuit.id);
  }, [selectedTier, tiersEnabled, tiers]);

  const contribution = useContributionFlow({
    entropySeed,
    overrideFailedCheck,
    selectedCircuitIds,
    circuits: config.circuits,
    active: step === "progress",
  });
  // The verify guide sends people back to the contribution history table,
  // which only exists once the homepage has rendered with live status.
  const [historyPending, setHistoryPending] = useState(false);
  const showHistory = () => {
    setStep("landing");
    setHistoryPending(true);
  };
  useEffect(() => {
    if (!historyPending || step !== "landing") return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const table = document.getElementById("history");
      if (table || Date.now() - started > 5000) {
        window.clearInterval(timer);
        table?.scrollIntoView({ block: "start" });
        setHistoryPending(false);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [historyPending, step]);

  // Once the receipt is in, go straight to the accepted page, and refresh the
  // public status and history so the new contribution shows without waiting
  // for the next poll.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (step !== "progress" || !contribution.finalizeReady) return;
    setStep("complete");
    void queryClient.invalidateQueries({ queryKey: ["ceremonyStatus"] });
    void queryClient.invalidateQueries({ queryKey: ["contributionHistory"] });
  }, [step, contribution.finalizeReady, queryClient]);

  useOfferAlert(
    step === "progress" &&
      contribution.offer !== null &&
      !contribution.offerClaimed &&
      !contribution.claiming &&
      !contribution.contributionError,
  );

  const handleAuth = (method: "github") => {
    if (status && !status.isActive) return;
    authenticate(method);
  };

  const handleBeginContribution = () => {
    abandoned.dismiss();
    setOverrideFailedCheck(false);
    setReadinessOpen(true);
  };

  const handleEntropyComplete = (seed: Uint8Array) => {
    setEntropySeed(seed);
    if (tiersEnabled) {
      setStep("tier");
    } else {
      setStep("progress");
      void handleJoinQueue();
    }
  };

  const handleJoinQueue = async () => {
    if (joiningRef.current) return;
    joiningRef.current = true;
    setIsJoining(true);
    setJoinError(null);
    try {
      const joinOptions = tiersEnabled
        ? { tierId: selectedTier }
        : { circuitIds: selectedCircuitIds };
      await contribution.joinAndStart(joinOptions, config.circuits);
      setStep("progress");
    } catch (error) {
      setJoinError(
        error instanceof Error
          ? error.message
          : "Could not join the queue. Please try again.",
      );
    } finally {
      joiningRef.current = false;
      setIsJoining(false);
    }
  };

  const resetFlow = () => {
    entropySeed?.fill(0);
    setEntropySeed(null);
    contribution.reset();
    setJoinError(null);
    setReadinessOpen(false);
    setStep("landing");
  };

  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const handleCancelContribution = () => {
    if (joiningRef.current) return;
    setConfirmingCancel(false);
    if (contribution.contributionPhase === "verifying" || contribution.submitted) contribution.detach();
    // Refresh afterwards so the homepage shows the released slot. If the
    // server already had the contribution, show its verification instead.
    else {
      setCancelling(true);
      void contribution.cancel().then((outcome) => {
        if (outcome === "submitted") {
          setPastReceipt(null);
          setStep("activity");
        }
      }).finally(async () => {
        await activity.refetch();
        setCancelling(false);
      });
    }
    entropySeed?.fill(0);
    setEntropySeed(null);
    setJoinError(null);
    setReadinessOpen(false);
    setStep("landing");
  };

  // A receipt the activity view shows as the accepted page, which has its own way home.
  const acceptedReceipt = pastReceipt?.participantId === participantId ? pastReceipt
    : activityStage === "accepted" ? activity.data?.receipts.find((item) => item.receiptId === activity.data?.state.submission?.receiptId) : undefined;

  const isFullScreen = step === "entropy";
  const runningStage = contribution.circuitRuns.find(
    (c) => c.id === contribution.currentCircuitId,
  )?.status === "active" ? contribution.contributionPhase : null;
  // A claimed slot asks before it is given up, from the logo as from the button.
  const slotClaimed = !joinError && !contribution.contributionError && !contribution.queueError &&
    !contribution.finalizeReady && runningStage !== null && runningStage !== "verifying";

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        {!isFullScreen && (
          <Header
            step={step}
            onLogoClick={
              step === "progress"
                ? slotClaimed ? () => setConfirmingCancel(true) : handleCancelContribution
                : () => {
                    setReadinessOpen(false);
                    setStep("landing");
                  }
            }
          />
        )}

        {isFullScreen && <EntropyScreen onComplete={handleEntropyComplete} onCancel={resetFlow} />}

        {!isFullScreen && (
          <main
            className={`${styles.main} ${(step === "landing" && !readinessOpen && status) || step === "verify" ? styles.landing : ""}`}
          >
            {step === "landing" && !status && !statusError && (
              <div className={styles.loader}>
                <div className={styles.spinner} />
                <p className={styles.loaderText}>Loading ceremony...</p>
              </div>
            )}

            {step === "landing" && readinessOpen && status && (
              <Readiness
                inputBytes={status.headByteLength}
                onBack={() => setReadinessOpen(false)}
                onReady={(override) => {
                  setOverrideFailedCheck(override);
                  setReadinessOpen(false);
                  setStep("entropy");
                }}
              />
            )}

            {step === "landing" && status && !readinessOpen && (
              <LandingScreen
                collectiblesEnabled={collectiblesEnabled}
                onAuth={handleAuth}
                onBegin={handleBeginContribution}
                onVerify={() => setStep("verify")}
                hasPendingContribution={["pending", "active", "unconfirmed"].includes(activityStage)}
                hasQueuePlace={activityStage === "queued"}
                activityStatus={activity.data ? "ready" : activity.error ? "error" : "loading"}
                activity={activity.isAuthenticated && <>
                  {activity.data && <ParticipantActivityCard activity={activity.data}
                    abandoned={abandoned.outcome} closedNotice={abandoned.closedNotice}
                    onViewProgress={() => { setPastReceipt(null); setStep("activity"); }} onContinue={handleBeginContribution} onReceipt={viewReceipt} />}
                  {activity.error && <p role="alert">Couldn’t refresh your contributions. <button onClick={() => void activity.refetch()}>Retry status check</button></p>}
                </>}
              />
            )}

            {step === "activity" && (
              !activity.isAuthenticated ? <div className={styles.prompt}>
                <h2>Sign in to view your contributions.</h2>
                <Button onClick={() => authenticate("github")}>Continue with GitHub</Button>
              </div> : <>
                {activity.error && <p className={styles.inlineAlert} role="alert">Couldn’t refresh contribution status. No new attempt has been started. <button onClick={() => void activity.refetch()}>Retry status check</button></p>}
                {(() => {
                  if (acceptedReceipt) return <CompleteScreen recovered collectiblesEnabled={collectiblesEnabled} receipts={[acceptedReceipt]} onRestart={() => { setPastReceipt(null); setStep("landing"); }} onVerify={() => setStep("verify")} />;
                  if (!activity.data) return <p role="status">Loading your contribution…</p>;
                  if (activityStage === "pending") return <ContributionJourney stage="verifying" onCancel={() => setStep("landing")} />;
                  return <>
                    <ParticipantActivityCard activity={activity.data} abandoned={abandoned.outcome} closedNotice={abandoned.closedNotice}
                      onViewProgress={() => void activity.refetch()} onContinue={handleBeginContribution} onReceipt={viewReceipt} />
                    {activityStage === "empty" && <p>No submitted contributions yet.</p>}
                  </>;
                })()}
                {!acceptedReceipt && <Button variant="secondary" onClick={() => setStep("landing")}>Back to homepage</Button>}
              </>
            )}

            {step === "tier" && tiersEnabled && (
              <TierScreen
                selectedTier={selectedTier}
                onSelectTier={setSelectedTier}
                onNext={handleJoinQueue}
                isJoining={isJoining}
              />
            )}

            {step === "progress" && (
              <ContributionJourney
                stage={
                  joinError ||
                  contribution.contributionError ||
                  contribution.queueError
                    ? "error"
                    : contribution.turnMissed
                      ? "missed"
                    : isJoining || contribution.circuitRuns.length === 0
                      ? "joining"
                      : contribution.finalizeReady
                        ? "accepted"
                        : runningStage
                          ? runningStage
                          : contribution.offer
                            ? "offered"
                            : "waiting"
                }
                position={
                  contribution.circuitRuns.find(
                    (c) => c.id === contribution.currentCircuitId,
                  )?.position
                }
                offerExpiresAt={contribution.offer?.expiresAt}
                leaseExpiresAt={contribution.leaseExpiresAt}
                submitted={!joinError && contribution.submitted}
                confirmingCancel={confirmingCancel}
                onConfirmingCancelChange={setConfirmingCancel}
                progress={contribution.contributionProgress}
                progressDetail={contribution.workerProgressDetail}
                error={
                  joinError ??
                  contribution.contributionError ??
                  contribution.queueError
                }
                busy={isJoining || contribution.claiming}
                onClaim={contribution.claim}
                onRejoin={contribution.rejoin}
                onReceipt={() => setStep("complete")}
                onRetry={() => {
                  if (joinError) void handleJoinQueue();
                  // Handed over already: its outcome is the server's to report.
                  else if (contribution.submitted) {
                    contribution.detach();
                    setPastReceipt(null);
                    setStep("activity");
                  } else contribution.retry();
                }}
                onCancel={handleCancelContribution}
              />
            )}

            {step === "complete" && (
              <CompleteScreen
                collectiblesEnabled={collectiblesEnabled}
                receipts={contribution.receipts}
                onRestart={resetFlow}
                onVerify={() => setStep("verify")}
              />
            )}

            {step === "verify" && (
              <VerifyScreen onBack={showHistory} />
            )}

            {statusError && (
              <div className={styles.statusError} role="alert">
                <h2>Ceremony status unavailable</h2>
                <p>{statusError}</p>
                <p>
                  The page will retry automatically. Participation requires a
                  fresh, verified status.
                </p>
                {process.env.NODE_ENV === "development" && (
                  <a href="/preview">Open the isolated UI preview</a>
                )}
              </div>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
