"use client";

import { useEffect, useState } from "react";

import { collectibleReceiptHash, type ReceiptResponse } from "@/lib/api";
import { useCeremonyConfig } from "@/hooks/useCeremonyConfig";
import { cn } from "@/utils/cn";
import { Button } from "@/app/components/Button";
import { JourneyWindow } from "@/app/components/PublicCeremony/JourneyWindow";
import journey from "@/app/components/PublicCeremony/journey.module.css";
import { useReceiptActions } from "@/hooks/useReceiptActions";
import { ContributionCollectible } from "@/app/components/ContributionCollectible";
import styles from "./CompleteScreen.module.css";

/**
 * The page shown once a contribution is accepted: one headline in the
 * journey window, then the receipts, the optional collectible and the local
 * generation note. Details reveal shortly after the headline.
 */
export function CompleteScreen({
  receipts,
  onRestart,
  onVerify,
  recovered = false,
  preview = false,
  collectiblesEnabled = false,
}: {
  receipts: ReceiptResponse[];
  /** Offer the optional bunny; off when the ceremony ships without it. */
  collectiblesEnabled?: boolean;
  recovered?: boolean;
  /** Review walkthrough: the collectible link stays inside the walkthrough. */
  preview?: boolean;
  onRestart: () => void;
  onVerify: () => void;
}) {
  const config = useCeremonyConfig();
  const { copy } = config;
  const ceremonyName = config.name;
  const {
    receiptPayload,
    latestReceipt,
    handleCopyItem,
    handleDownload,
    handleShare,
  } = useReceiptActions({
    receipts,
    ceremonyName,
    receiptFilename: copy.complete.receiptFilename,
    shareTemplate: copy.complete.shareTemplate,
  });
  const [bunnyHash, setBunnyHash] = useState<string | null>(null);
  const signedReceipt = latestReceipt?.signedReceipt;
  useEffect(() => {
    setBunnyHash(null);
    if (!signedReceipt) return;
    let live = true;
    collectibleReceiptHash(signedReceipt)
      .then((hash) => { if (live) setBunnyHash(hash); })
      .catch(() => {});
    return () => { live = false; };
  }, [signedReceipt]);

  const [showDetails, setShowDetails] = useState(false);
  const [checkmarkVisible, setCheckmarkVisible] = useState(false);

  useEffect(() => {
    const checkTimer = setTimeout(() => setCheckmarkVisible(true), 400);
    const detailsTimer = setTimeout(() => setShowDetails(true), 3000);
    return () => {
      clearTimeout(checkTimer);
      clearTimeout(detailsTimer);
    };
  }, []);

  return (
    <div className={journey.journey}>
      <JourneyWindow>
        <div className={journey.heading}>
          <div className={journey.enter}>
            <h1 id="complete-title" className={journey.title}>
              {copy.complete.title}
              {/* The check rides inline after the headline's last word. */}
              <svg
                className={cn(journey.done, journey.titleCheck, styles.check, checkmarkVisible ? styles.checkVisible : styles.checkHidden)}
                viewBox="0 0 56 56"
                aria-hidden="true"
              >
                <circle cx="28" cy="28" r="26" />
                <path d="M17 29l7.5 7.5L40 21" />
              </svg>
            </h1>
            <p className={journey.lede}>{copy.complete.subtitle}</p>
          </div>
        </div>
      </JourneyWindow>

      <div className={styles.detailsArea}>
      {/* The receipt reveals after the headline; until then, say it's coming
          rather than leave an empty page. */}
      <p role="status" className={cn(styles.loading, showDetails && styles.loadingDone)} aria-hidden={showDetails}>
        {copy.complete.loadingReceipt}
      </p>
      <div className={cn(styles.details, showDetails ? styles.detailsVisible : styles.detailsHidden)}>
        <section className={journey.tray} aria-labelledby="receipts-title">
          <div className={cn(journey.plate, styles.receipts)}>
            <h2 id="receipts-title">{copy.complete.contributionsTitle}</h2>

            {receipts.length === 0 && (
              <p>{copy.complete.emptyContributions}</p>
            )}

            {receipts.length > 0 && (
              <ul className={styles.ledger}>
                {receipts.map((receipt) => (
                  <li key={`${receipt.circuitId}-${receipt.contributionIndex}`}>
                    <span className={styles.index}>#{receipt.contributionIndex.toLocaleString()} <span className={styles.name}>{receipt.signedReceipt.payload.participantPseudonym}</span></span>
                    <time className={styles.accepted} dateTime={new Date(receipt.timestamp).toISOString()}>
                      Accepted {formatAccepted(receipt.timestamp)}
                    </time>
                    <code className={styles.hash} title={`SHA-256 of your contribution: ${receipt.contributionHash}`}>
                      {receipt.contributionHash.slice(0, 10)}…
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopyItem(receipt.contributionHash)}
                      title={copy.complete.copyItemCta}
                      aria-label={copy.complete.copyItemCta}
                      className={styles.copyButton}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                        <rect x="9" y="9" width="10" height="10" rx="2" />
                        <rect x="5" y="5" width="10" height="10" rx="2" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className={journey.actions}>
              <Button variant="accent" onClick={handleShare} disabled={!latestReceipt}>
                {copy.complete.shareCta}
              </Button>
              <Button variant="secondary" onClick={handleDownload} disabled={!receiptPayload}>
                {copy.complete.downloadCta}
              </Button>
              <Button variant="secondary" onClick={onVerify}>
                {copy.complete.verifyCta}
              </Button>
            </div>
          </div>
        </section>

        {collectiblesEnabled && latestReceipt && (
          <ContributionCollectible
            preview={preview}
            receiptId={latestReceipt.receiptId}
            index={latestReceipt.contributionIndex}
            receiptHash={bunnyHash ?? undefined}
          />
        )}

        <div className={journey.actions}>
          <Button variant="secondary" onClick={onRestart}>
            {copy.complete.restartCta}
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
}

/** Acceptance time in UTC, the ceremony's reference clock. */
function formatAccepted(timestamp: number): string {
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
  }) + " UTC";
}
