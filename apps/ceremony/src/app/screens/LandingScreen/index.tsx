"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useCeremonyStatus } from "@/hooks/useCeremonyStatus";
import { useParticipant } from "@/hooks/useParticipant";
import { useParticipantEligibility } from "@/hooks/useParticipantEligibility";
import { ContributionHistory } from "@/app/components/ContributionHistory";
import { ContributeButton, DownloadFinalButton, PublicLobby, useClock } from "@/app/components/PublicCeremony";
import { Button } from "@/app/components/Button";
import { ceremonyStage } from "@/lib/public-ceremony";
import { getMyReceipts } from "@/lib/api";
import { continueAfterSignIn, hasContinueMarker, withoutContinueMarker } from "@/lib/continue-after-sign-in";
import styles from "@/app/components/PublicCeremony/style.module.css";

export function LandingScreen({
  onAuth,
  onBegin,
  onVerify,
  activity,
  hasPendingContribution = false,
  activityStatus = "ready",
  collectiblesEnabled = false,
}: {
  onAuth: (method: "github") => void;
  onBegin: () => void;
  onVerify: () => void;
  activity?: ReactNode;
  hasPendingContribution?: boolean;
  /** Whether the participant's existing attempts have loaded yet. */
  activityStatus?: "loading" | "ready" | "error";
  collectiblesEnabled?: boolean;
}) {
  const { status, statusError } = useCeremonyStatus({ poll: false });
  const { isAuthenticated, participantName } = useParticipant();
  const { eligibility, eligibilityLoading, eligibilityError } =
    useParticipantEligibility();
  const now = useClock();
  const stage = ceremonyStage(status, now ?? status?.startedAt ?? 0);
  const browserEnabled =
    process.env.NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED === "true";
  // Back from GitHub sign-in: a first-time contributor goes straight on to
  // the browser check. Everyone else stays here; the marker is cleared once
  // the decision is made so a reload doesn't repeat it.
  useEffect(() => {
    if (!hasContinueMarker(window.location.href)) return;
    const next = continueAfterSignIn({
      isAuthenticated,
      canContribute: stage === "open" && browserEnabled && !statusError,
      eligibility,
      eligibilityLoading,
      eligibilityError: !!eligibilityError,
      activity: activityStatus,
      hasPendingContribution,
    });
    if (next === "wait") return;
    window.history.replaceState(window.history.state, "", withoutContinueMarker(window.location.href));
    if (next === "begin") onBegin();
  }, [isAuthenticated, stage, browserEnabled, statusError, eligibility, eligibilityLoading, eligibilityError, activityStatus, hasPendingContribution, onBegin]);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  async function downloadReceipts() {
    setReceiptBusy(true);
    setReceiptError(null);
    try {
      const data = await getMyReceipts();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data.receipts, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "moss-ceremony-receipts.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setReceiptError("Could not download your receipts. Please try again.");
    } finally {
      setReceiptBusy(false);
    }
  }
  // A signed-in participant with nothing left to contribute sees only their
  // receipt card, which already links to each receipt.
  const contributed = !!activity && isAuthenticated && !hasPendingContribution && !eligibilityLoading &&
    !eligibilityError && !!eligibility && !eligibility.hasEligibleCircuits;
  const participation = (
    <>
      {activity}
      {stage === "finalized" ? (
        status?.finalization ? <DownloadFinalButton /> : <Button onClick={onVerify}>Open verification guide</Button>
      ) : stage === "sealed" ? null : stage === "capacity" ? (
        <>
          <h2>The current cap is reached.</h2>
          <p>
            No new slots are available under the signed policy. Finalization
            still follows the published schedule.
          </p>
        </>
      ) : stage !== "open" ? (
        <>
          <h2>
            {stage === "scheduled"
              ? "We’re getting ready to open."
              : "Participation is unavailable."}
          </h2>
          <p>
            {stage === "scheduled"
              ? "The opening time has not arrived. Check the ceremony schedule before returning to contribute."
              : "Wait for a fresh ceremony status before joining. No slot will be claimed from this view."}
          </p>
        </>
      ) : !browserEnabled ? (
        <>
          <h2>Browser participation opens soon.</h2>
          <p>
            The public browser flow is being prepared. Contributions are not
            enabled in this web release.
          </p>
          {process.env.NODE_ENV === "development" && (
            <a className={styles.link} href="/preview">
              Explore the public ceremony preview →
            </a>
          )}
        </>
      ) : !isAuthenticated ? (
        <>
          <p data-emphasis>Sign in to get started.</p>
          <ContributeButton
            onClick={() => onAuth("github")}
            disabled={!!statusError}
          >
            Contribute now
          </ContributeButton>
        </>
      ) : contributed || hasPendingContribution ? null : (
        <>
          <h2>Welcome{participantName ? `, ${participantName}` : " back"}.</h2>
          {/* Eligible and ready: the welcome and the button say enough. */}
          {!(eligibility?.hasEligibleCircuits && !hasPendingContribution && !eligibilityLoading && !eligibilityError) && (
            <p>
              {eligibilityLoading
                ? "Checking your participation…"
                : eligibilityError
                  ? "We couldn’t confirm your eligibility. Please wait for the next status update."
                  : "You’ve successfully contributed. Thank you!"}
            </p>
          )}
          {eligibility?.hasEligibleCircuits && !hasPendingContribution &&
            eligibility.contributedCircuitIds.length > 0 && (
              <p role="note">You’ve already contributed. You can contribute again to test the flow during this rehearsal only. Each attempt joins the queue separately.</p>
            )}
          {eligibility?.hasEligibleCircuits && !hasPendingContribution && (
            <ContributeButton
              disabled={
                eligibilityLoading || !!eligibilityError || !!statusError
              }
              onClick={onBegin}
            >
              Contribute now
            </ContributeButton>
          )}
          {eligibilityError && (
            <p role="alert">Eligibility check unavailable.</p>
          )}
        </>
      )}
      {isAuthenticated && !contributed &&
        (eligibility?.contributedCircuitIds.length ?? 0) > 0 && (
          <Button
            variant="secondary"
            onClick={() => void downloadReceipts()}
            disabled={receiptBusy}
          >
            {receiptBusy ? "Downloading…" : "Download my receipts"}
          </Button>
        )}
      {receiptError && <p role="alert">{receiptError}</p>}
    </>
  );
  return (
    <PublicLobby
      collectiblesEnabled={collectiblesEnabled}
      status={status}
      participation={participation}
      hideHeroLink={contributed || hasPendingContribution}
      history={<ContributionHistory />}
      onVerify={onVerify}
      details={process.env.NODE_ENV === "development" ? (
        <p className={styles.note}>
          <a className={styles.link} href="/preview">
            Preview all public ceremony screens
          </a>{" "}
          · simulated data, no real participation.
        </p>
      ) : undefined}
    />
  );
}
