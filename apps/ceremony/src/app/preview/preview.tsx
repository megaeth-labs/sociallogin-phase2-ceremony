"use client";
import { ContributionHistory } from "../components/ContributionHistory";
import { HistorySource } from "../components/ContributionHistory/source";
import { getRehearsalHistoryPage, getRehearsalVerificationGuide } from "@/lib/rehearsal-history";
import { CollectibleGallery } from "./Gallery";
import { EntropyScreen } from "../screens/EntropyScreen";
import { VerifyScreen } from "../screens/VerifyScreen";
import { VerificationGuideSource } from "../screens/VerifyScreen/source";
import { CompleteScreen } from "../screens/CompleteScreen";
import { CollectPage } from "../collect/view";
import { AccountMenu } from "@/app/components/AccountMenu";
import { ParticipantActivityCard } from "@/app/components/ParticipantActivity";
// Stand-in data for the finalized walkthrough screen, in the production record's shape.
import { SAMPLE_PRODUCTION_FINALIZATION as completionRecord } from "./sample-finalization";
import { useEffect, useState } from "react";
import {
  PublicLobby,
  ContributeButton,
  DownloadFinalButton,
  ContributionJourney,
  type JourneyStage,
} from "@/app/components/PublicCeremony";
import { Readiness } from "@/app/components/PublicCeremony/Readiness";
import { JourneyWindow } from "@/app/components/PublicCeremony/JourneyWindow";
import journey from "@/app/components/PublicCeremony/journey.module.css";
import { Button } from "@/app/components/Button";
import type { ParticipantActivity, ReceiptResponse, StatusResponse } from "@/lib/api";
import styles from "@/app/components/PublicCeremony/style.module.css";
import pageStyles from "../page.module.css";
import reviewStyles from "./review.module.css";
import headerStyles from "@/app/components/Header/Header.module.css";

const PREVIEW_ARTIFACT_BYTES = 368440348;

/**
 * Example only: an unsigned stand-in shaped like a coordinator receipt, so the
 * live completion screen can be reviewed. Its hashes are keccak256 values of
 * made-up seeds, not records from any ceremony.
 */
const EXAMPLE_HASH = "0a943199316c5f1cdf0cb200285e3518ce9a4d3e67986d10bdb0c2624720b5fd";
const EXAMPLE_RECEIPT = {
  success: true,
  receiptId: "example-receipt",
  circuitId: "social-login",
  participantId: "example-participant",
  contributionIndex: 128,
  contributionHash: EXAMPLE_HASH,
  clientContributionHash: EXAMPLE_HASH,
  serverContributionHash: EXAMPLE_HASH,
  previousContributionHash: "0".repeat(64),
  chainHash: EXAMPLE_HASH,
  timestamp: Date.parse("2026-10-02T11:23:19Z"),
  signedReceipt: {
    keyId: "example-only",
    signature: "example-only",
    payload: { example: true, contributionIndex: 128, participantPseudonym: "octocat", successor: { sha256: EXAMPLE_HASH } },
  },
} as unknown as ReceiptResponse;

/** Example signed-in contributor, as the homepage shows them after acceptance. */
const EXAMPLE_NAME = "moss-contributor";
const EXAMPLE_ACTIVITY = {
  state: { submission: { state: "ACCEPTED", receiptId: EXAMPLE_RECEIPT.receiptId }, lease: null, queue: null },
  receipts: [EXAMPLE_RECEIPT],
} as unknown as ParticipantActivity;

type Screen =
  | "lobby"
  | "signedIn"
  | "readiness"
  | "entropy"
  | "verify"
  | "complete"
  | "contributed"
  | "wallet"
  | "mint"
  | "collected"
  | "gallery"
  | JourneyStage
  | "expired"
  | "sealed"
  | "finalized";
const screens: [Screen, string][] = [
  ["lobby", "Lobby"],
  ["signedIn", "Signed in, ready"],
  ["readiness", "Readiness"],
  ["entropy", "Randomness"],
  ["waiting", "Queue"],
  ["offered", "Slot offer"],
  ["downloading", "Download"],
  ["computing", "Compute"],
  ["uploading", "Upload"],
  ["verifying", "Verification"],
  ["accepted", "Accepted"],
  ["complete", "Contribution complete"],
  ["contributed", "Signed in, contributed"],
  ["wallet", "Connect wallet"],
  ["mint", "Mint collectible"],
  ["collected", "Collected"],
  ["gallery", "Collectible gallery"],
  ["verify", "Verify locally"],
  ["sealed", "Sealed"],
  ["finalized", "Finalized"],
  ["expired", "Expired slot"],
  ["error", "Error"],
];

export function PublicCeremonyPreview({ hostedReview = false }: { hostedReview?: boolean; backendReady?: boolean } = {}) {
  const [controlsHidden, setControlsHidden] = useState(false);
  const [screen, setScreen] = useState<Screen>("lobby");
  const [epoch, setEpoch] = useState<number | null>(null);
  const [offerDeadline, setOfferDeadline] = useState<string | null>(null);
  useEffect(() => {
    setEpoch(Date.now());
    const restore = () => {
      const next = new URLSearchParams(window.location.search).get("screen");
      if (screens.some(([key]) => key === next)) setScreen(next as Screen);
      else setScreen("lobby");
      setOfferDeadline(new Date(Date.now() + 120_000).toISOString());
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [screen]);
  function go(next: Screen) {
    setScreen(next);
    const url = new URL(window.location.href);
    url.searchParams.set("screen", next);
    window.history.pushState(null, "", url);
    if (next === "offered")
      setOfferDeadline(new Date(Date.now() + 120_000).toISOString());
  }
  const status: StatusResponse | null =
    epoch === null
      ? null
      : {
          ceremonyState:
            screen === "sealed"
              ? "SEALED"
              : screen === "finalized"
                ? "FINALIZED"
                : "OPEN",
          ...(screen === "finalized" ? { finalization: completionRecord } : {}),
          isActive: screen !== "sealed" && screen !== "finalized",
          beaconApplied: screen === "finalized",
          beaconBlock: completionRecord.beacon.source === "ethereum-block" ? completionRecord.beacon.blockNumber : undefined,
          totalContributions: 128,
          targetContributions: 5000,
          headByteLength: PREVIEW_ARTIFACT_BYTES,
          startedAt: epoch - 86400000,
          endDate: new Date(epoch + 13 * 86400000).toISOString(),
          circuits: [
            {
              circuitId: "example",
              totalContributions: 128,
              targetContributions: 5000,
              queueLength: screen === "lobby" ? 24 : 0,
              currentParticipant: null,
              latestContributionHash: null,
              chainHash: "",
              isComplete: false,
            },
          ],
        };
  const history = <ContributionHistory />;
  const lobby =
    screen === "lobby" || screen === "signedIn" || screen === "sealed" || screen === "finalized" || screen === "contributed";
  const content = lobby ? (
          <PublicLobby
            preview
            collectiblesEnabled
            rehearsalRecord={false}
            hideHeroLink={screen === "contributed"}
            status={status}
            onVerify={() => go("verify")}
            history={history}
            participation={
              screen === "sealed" ? null : screen === "finalized" ? (
                <DownloadFinalButton />
              ) : screen === "signedIn" ? (
                // Back from GitHub sign-in, before the browser check.
                <>
                  <h2>Welcome, {EXAMPLE_NAME}.</h2>
                  <ContributeButton onClick={() => go("readiness")}>
                    Contribute now
                  </ContributeButton>
                </>
              ) : screen === "contributed" ? (
                // Same structure as the live signed-in homepage after acceptance.
                <>
                  <ParticipantActivityCard activity={EXAMPLE_ACTIVITY} onViewProgress={() => go("complete")} onContinue={() => go("complete")} onReceipt={() => go("complete")} />
                </>
              ) : (
                <>
                  <p data-emphasis>Sign in to get started.</p>
                  <ContributeButton onClick={() => go("readiness")}>
                    Contribute now
                  </ContributeButton>
                </>
              )
            }
          />
        ) : screen === "readiness" ? (
          <Readiness
            preview
            inputBytes={PREVIEW_ARTIFACT_BYTES}
            onBack={() => go("lobby")}
            onReady={() => go("entropy")}
          />
        ) : screen === "entropy" ? (
          <EntropyScreen onComplete={() => go("waiting")} onCancel={() => go("readiness")} />
        ) : screen === "verify" ? (
          // Verification materials come from the same rehearsal record.
          <VerificationGuideSource.Provider value={getRehearsalVerificationGuide}>
            <VerifyScreen onBack={() => go("lobby")} />
          </VerificationGuideSource.Provider>
        ) : screen === "complete" ? (
          <CompleteScreen preview collectiblesEnabled receipts={[EXAMPLE_RECEIPT]} onRestart={() => go("lobby")} onVerify={() => go("verify")} />
        ) : screen === "gallery" ? (
          <CollectibleGallery />
        ) : screen === "wallet" || screen === "mint" || screen === "collected" ? (
          <CollectPage key={screen} receiptId="preview" preview={screen} />
        ) : (
          <>
            <ContributionJourney
              preview
              stage={screen === "expired" ? "offered" : screen}
              position={8}
              offerExpiresAt={
                screen === "expired"
                  ? "2020-01-01T00:00:00.000Z"
                  : offerDeadline
              }
              leaseExpiresAt={
                epoch ? new Date(epoch + 90 * 60000).toISOString() : null
              }
              progress={screen === "downloading" ? 12 : 52}
              error={
                screen === "error"
                  ? "Upload interrupted."
                  : null
              }
              onClaim={() => go("downloading")}
              onCancel={() => go("lobby")}
              onRetry={() => go("uploading")}
              onReceipt={() => go("complete")}
            />

          </>
        );
  const standalone = screen === "entropy" || screen === "wallet" || screen === "mint" || screen === "collected";
  const current = screens.findIndex(([key]) => key === screen);
  return (
    // History and the lobby's chain show the rehearsal's real accepted contributions.
    <HistorySource.Provider value={getRehearsalHistoryPage}>
      <div className={`${pageStyles.page} ${reviewStyles.walkthrough}`}>
        {standalone ? content : <>
          <header className={headerStyles.header}>
            <button onClick={() => go("lobby")} className={headerStyles.logoButton} aria-label="MOSS ceremony home">
              <img src="/brand/moss.svg" width="108" height="26" alt="MOSS" />
              <span className={headerStyles.logoDivider} aria-hidden="true" />
              <span className={headerStyles.title}>Social login ceremony <span>PHASE 02</span></span>
            </button>
            {screen === "contributed" || screen === "signedIn" ? <AccountMenu previewName={EXAMPLE_NAME} />
              : hostedReview ? <AccountMenu />
              : lobby && <AccountMenu onPreviewSignIn={() => go("signedIn")} />}
          </header>
          <main className={`${pageStyles.main} ${lobby || screen === "verify" || screen === "gallery" ? pageStyles.landing : styles.shell}`}>
            {content}
          </main>
        </>}
        <nav className={`${reviewStyles.controls} ${controlsHidden ? reviewStyles.collapsed : ""}`} aria-label="Review walkthrough">
          {controlsHidden ? (
            <button onClick={() => setControlsHidden(false)}>Show walkthrough controls</button>
          ) : <>
            <div className={reviewStyles.context}>
              <strong>Walkthrough</strong>
              <span>Simulated · {current + 1} / {screens.length}</span>
            </div>
            <button aria-label="Previous screen" disabled={current === 0} onClick={() => go(screens[current - 1][0])}>←</button>
            <label className={reviewStyles.selector}>
              <span className={reviewStyles.visuallyHidden}>Review screen</span>
              <select value={screen} onChange={event => go(event.target.value as Screen)}>
                {screens.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <button aria-label="Next screen" disabled={current === screens.length - 1} onClick={() => go(screens[current + 1][0])}>→</button>
            <button className={reviewStyles.hide} onClick={() => setControlsHidden(true)}>Hide controls</button>
          </>}
        </nav>
      </div>
    </HistorySource.Provider>
  );
}
