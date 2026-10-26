"use client";

import { useEffect, useId, useRef, useState, useCallback } from "react";

import { useCeremonyConfig } from "@/hooks/useCeremonyConfig";
import { useCeremonyStatus } from "@/hooks/useCeremonyStatus";
import { useParticipant } from "@/hooks/useParticipant";
import { useEntropyCollector } from "@/hooks/useEntropyCollector";
import { cn } from "@/utils/cn";
import { EntropyBunny } from "./EntropyBunny";
import styles from "./EntropyScreen.module.css";

export function EntropyScreen({
  onComplete,
  onCancel,
}: {
  onComplete: (entropy: Uint8Array) => void;
  /** Leaves the screen without contributing; collected input is discarded. */
  onCancel?: () => void;
}) {
  const config = useCeremonyConfig();
  const { status } = useCeremonyStatus({ poll: false });
  const { isAuthenticated, participantName } = useParticipant();

  const { copy } = config;
  const shortName = config.branding.shortName;
  const totalContributions = status?.totalContributions;
  const displayName = isAuthenticated ? participantName : undefined;
  const {
    entropyPercent,
    isReady,
    areaRef,
    handlePointerMove,
    recordTap,
    recordKeyPress,
    buildSeed,
  } = useEntropyCollector();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const floorRef = useRef<HTMLDivElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const helperId = useId();
  const progressLabelId = useId();

  // Hand keyboard users straight to the next step once collection completes.
  useEffect(() => {
    if (isReady) continueRef.current?.focus({ preventScroll: true });
  }, [isReady]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = areaRef.current;
      if (!el) return;
      el.setPointerCapture(e.pointerId);
    },
    [areaRef],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isReady) return;

      const el = areaRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      recordTap(e.clientX - rect.left, e.clientY - rect.top);
    },
    [isReady, areaRef, recordTap],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (isReady || e.repeat) return;
      recordKeyPress(e.keyCode);
    },
    [isReady, recordKeyPress],
  );

  const handleSubmit = useCallback(async () => {
    if (!isReady || isSubmitting) return;
    setIsSubmitting(true);
    const seed = await buildSeed();
    onComplete(seed);
  }, [isReady, isSubmitting, buildSeed, onComplete]);

  const barWidth = Math.min(entropyPercent, 100);

  return (
    <div className={styles.container}>
      <div
        ref={areaRef}
        role="application"
        tabIndex={0}
        aria-label={copy.entropy.topBarTitle}
        aria-describedby={helperId}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
        className={styles.interactiveArea}
      />
      <EntropyBunny areaRef={areaRef} floorRef={floorRef} celebrate={isReady} />

      <div className={styles.topBarWrapper}>
        <div className={styles.topBar}>
          <div className={styles.topBarLeft}>
            {onCancel && (
              <>
                <button type="button" className={styles.backButton} onClick={onCancel}>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                    <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Back
                </button>
                <div className={styles.logoDivider} />
              </>
            )}
            <img className={styles.logo} src="/brand/moss.svg" width="83" height="20" alt={shortName} />
            <div className={styles.logoDivider} />
            <span className={styles.topBarTitle}>{copy.entropy.topBarTitle}</span>
          </div>
          <div className={styles.topBarRight}>
            {displayName && (
              <span className={styles.topBarUser}>@{displayName}</span>
            )}

            {totalContributions !== undefined && (
              <>
                {displayName && <div className={styles.divider} />}
                <div className={styles.topBarContributions}>
                  <div className="accentDot" />
                  <span className={styles.topBarContributionsLabel}>
                    {totalContributions.toLocaleString()}{" "}
                    {copy.header.contributionsLabel}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className={styles.bottomPanel}>
        <div ref={floorRef} className={styles.bottomContent}>
          <div className={styles.progressCard}>
            <div className={styles.progressInner}>
              <div className={styles.progressHeader}>
                <span id={progressLabelId} className={styles.progressLabel}>
                  {copy.entropy.strengthLabel}
                </span>
                <span
                  className={cn(
                    styles.progressValue,
                    isReady && styles.progressValueReady,
                  )}
                >
                  {entropyPercent}%
                </span>
              </div>

              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-labelledby={progressLabelId}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(barWidth)}
              >
                <div
                  className={cn(styles.progressFill, isReady && styles.progressFillReady)}
                  style={{ transform: `scaleX(${barWidth / 100})` }}
                />
              </div>

              {!isReady && (
                <p className={styles.progressCue}>{copy.entropy.topBarHint}</p>
              )}
              <p id={helperId} className={styles.progressHelper}>{copy.entropy.helper}</p>
            </div>
          </div>

          <button
            ref={continueRef}
            onClick={handleSubmit}
            disabled={!isReady || isSubmitting}
            className={cn(
              styles.continueButton,
              isReady && !isSubmitting && styles.continueReady,
              (!isReady || isSubmitting) && styles.continueDisabled,
            )}
          >
            {isReady && copy.entropy.readyCta}
            {!isReady && copy.entropy.collectingCta}
          </button>
        </div>
      </div>

      <div className={styles.overlay} role="status">
        {isReady && (
          <div className={styles.overlayContent}>
            <div className={styles.overlayIcon}>
              <svg
                className={styles.overlayIconSvg}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>

            <div className={styles.overlayTitle}>
              {copy.entropy.overlayTitle}
            </div>

            <div className={styles.overlaySubtitle}>
              {copy.entropy.overlaySubtitle}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
