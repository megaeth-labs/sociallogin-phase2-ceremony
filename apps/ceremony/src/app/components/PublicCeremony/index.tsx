"use client";
import { FinalizedCeremony } from "@/app/components/FinalizedCeremony";
import { finalBeacon, isRehearsalFinalization } from "@/lib/finalization";
import { DOWNLOAD_SLOT_RELEASED, UPLOAD_SLOT_RELEASED, UPLOAD_TOO_SLOW, type WorkerProgress } from "@/lib/contribution-progress";

import { useEffect, useId, useRef, useState } from "react";
import type { StatusResponse } from "@/lib/api";
import {
  ceremonyStage,
  claimAvailable,
  phasePercent,
} from "@/lib/public-ceremony";
import { formatDeadline, friendlyRemaining } from "@/lib/countdown";
import { Button } from "@/app/components/Button";
import styles from "./style.module.css";
import lobby from "./lobby.module.css";
import journey from "./journey.module.css";
import { JourneyWindow } from "./JourneyWindow";
import { OfferNotifyControl } from "./OfferNotifyControl";
import { LobbyTraits } from "./LobbyTraits";
import { AmbientVideo } from "@/app/components/AmbientVideo";
import { SiteFooter } from "@/app/components/SiteFooter";


/**
 * The lobby's primary call to action: a frost pill with a mint light running
 * around its edge, so it reads as the one live control in the hero.
 */
export function ContributeButton(props: React.ComponentProps<typeof Button>) {
  return (
    <span className={lobby.ctaRing} data-disabled={props.disabled || undefined}>
      <Button variant="accent" {...props} />
    </span>
  );
}

/** Finalized pages: the one action, which scrolls to the artifacts below. */
export function DownloadFinalButton() {
  return (
    <ContributeButton
      onClick={() => {
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        document.getElementById("final-artifacts")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      }}
    >
      Download the final artifacts
    </ContributeButton>
  );
}

export function useClock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function PublicLobby({
  status,
  participation,
  history,
  details,
  onVerify,
  preview = false,
  collectiblesEnabled = false,
  rehearsalRecord,
  hideHeroLink = false,
}: {
  status: StatusResponse | null;
  participation: React.ReactNode;
  history?: React.ReactNode;
  /** Secondary disclosures, rendered after the evidence call to action. */
  details?: React.ReactNode;
  onVerify: () => void;
  preview?: boolean;
  /** Whether the server has collectible claims switched on. */
  collectiblesEnabled?: boolean;
  /** Overrides whether the record gets the dress-rehearsal labels; defaults to its type. */
  rehearsalRecord?: boolean;
  /** A signed-in contributor who is done sees only their receipt in the hero. */
  hideHeroLink?: boolean;
}) {
  const now = useClock();
  const stage = ceremonyStage(status, now ?? status?.startedAt ?? 0);
  const closed = stage === "sealed" || stage === "finalized";
  const accepted = status?.totalContributions ?? null;
  const rehearsalLabels = status?.finalization ? rehearsalRecord ?? isRehearsalFinalization(status.finalization) : false;
  const beacon = status?.finalization ? finalBeacon(status.finalization) : null;
  return (
    <div className={lobby.lobby}>
      <section className={lobby.hero} aria-labelledby="lobby-title">
        <AmbientVideo className={lobby.heroBg} src="/brand/hero-bg" poster="/brand/hero-bg-poster.webp" />
        <div className={lobby.heroInner}>
          <div className={lobby.heroCopy}>
            <h1 id="lobby-title" className={stage === "sealed" && !status?.finalization ? `${lobby.heroTitle} ${lobby.heroTitleLong}` : lobby.heroTitle}>
              {status?.finalization && rehearsalLabels ? (
                <>
                  <span>Rehearsal</span>
                  <span>complete</span>
                </>
              ) : stage === "sealed" ? (
                <>
                  <span>Contributions</span>
                  <span>closed</span>
                </>
              ) : stage === "finalized" || status?.finalization ? (
                <>
                  <span>Ceremony</span>
                  <span>complete</span>
                </>
              ) : (
                <>
                  <span>Help secure</span>
                  <span>social login</span>
                </>
              )}
            </h1>
            <p className={lobby.heroLede}>
              {status?.finalization
                ? "Thank you to everyone who contributed. You can download the final keys and verification records below."
                : stage === "finalized"
                ? "Thank you to everyone who contributed. The final keys are published, and anyone can verify them independently."
                : closed
                ? "Thank you to everyone who took part. The final keys will be published once the public beacon is applied and verified."
                : <>Contribute randomness from your desktop browser to help create the keys for MOSS’s ZK-powered social login experience. Takes <span className={lobby.nowrap}>5–10 minutes</span> once your turn begins.</>}
            </p>
            <div className={lobby.heroCta}>
              {participation}
              {!closed && !hideHeroLink && (
                <a className={lobby.heroLink} href="/how-it-works">
                  How it works
                </a>
              )}
            </div>
          </div>
          <div className={lobby.heroRabbit}>
            <AmbientVideo
              alpha
              src="/brand/rabbit-browsing"
              poster="/brand/rabbit-browsing-poster.webp"
              width={1000}
              height={838}
            />
            <span className={lobby.scan} aria-hidden="true">
              <span className={`${lobby.scanTrack} ${lobby.scanBand}`} />
            </span>
            <span className={lobby.scanBeam} aria-hidden="true">
              <span className={`${lobby.scanTrack} ${lobby.scanLine}`}>
                <span className={lobby.scanDot} />
              </span>
            </span>
          </div>
          {status?.finalization ? (
            // A finished ceremony shows its outcome instead of live counters.
            <dl className={lobby.heroStats}>
              <div>
                <dt>Contributions</dt>
                <dd>
                  {status.finalization.ordinaryContributions.toLocaleString()}
                  <small> + 1 beacon</small>
                </dd>
              </div>
              <div>
                <dt>{beacon!.label}</dt>
                <dd>
                  <small>{beacon!.unit} </small>
                  {beacon!.value.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>Final key SHA-256</dt>
                <dd className={lobby.heroHash} title={status.finalization.artifacts.finalZkey.sha256}>
                  {status.finalization.artifacts.finalZkey.sha256.slice(0, 8)}…{status.finalization.artifacts.finalZkey.sha256.slice(-6)}
                </dd>
              </div>
            </dl>
          ) : (
          <dl className={lobby.heroStats}>
            <div>
              <dt>Accepted contributions</dt>
              <dd>
                {accepted === null ? "—" : accepted.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>{closed ? "Ethereum beacon" : "In the queue"}</dt>
              <dd>
                {closed ? (status?.beaconBlock ? <><small>Block </small>{status.beaconBlock.toLocaleString()}</> : "Pending") : status
                  ? status.circuits
                      .reduce((sum, circuit) => sum + circuit.queueLength, 0)
                      .toLocaleString()
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>{closed ? "Contribution window" : "Time left"}</dt>
              <dd>
                {closed
                  ? "Closed"
                  : status?.endDate && now !== null
                    ? friendlyRemaining(status.endDate, now)
                    : "Awaiting schedule"}
              </dd>
            </div>
          </dl>
          )}
        </div>
      </section>
      <div className={lobby.container}>
        {status?.finalization && <FinalizedCeremony result={status.finalization} rehearsal={rehearsalLabels} />}
        <LobbyTraits open={stage === "open"} closed={closed} finalized={stage === "finalized"} collectiblesEnabled={collectiblesEnabled} bandOnly={stage === "finalized"} />
        {history && <div id="history" className={lobby.history}>{history}</div>}
        <section id="verify" className={lobby.evidence} aria-labelledby="evidence-title">
          <div>
            <h2 id="evidence-title">Check a contribution yourself</h2>
            <p>Download a receipt and the files needed for a local check.</p>
          </div>
          <Button variant="secondary" onClick={onVerify}>
            Verify contributions locally
          </Button>
        </section>
        {details && <div className={lobby.details}>{details}</div>}
      </div>
      <SiteFooter home onVerify={onVerify} finalized={!!status?.finalization} />
    </div>
  );
}

export type JourneyStage =
  | "joining"
  | "waiting"
  | "offered"
  | "downloading"
  | "computing"
  | "uploading"
  | "verifying"
  | "accepted"
  | "missed"
  | "error";
const content: Record<JourneyStage, [string, string]> = {
  joining: [
    "Joining the queue.",
    "Checking your browser and requesting a place. No slot has been reserved yet.",
  ],
  waiting: [
    "You’re in the queue.",
    "Only one contribution can run at a time. When your turn comes, your contribution starts automatically, so keep this tab open and your computer awake. There is no reliable waiting-time estimate yet.",
  ],
  missed: [
    "You missed your turn.",
    "Your turn came while this page couldn’t start it, for example because the computer was asleep or offline, so it passed to the next person. Rejoin to take a new place at the end of the queue.",
  ],
  offered: [
    "Your turn is ready.",
    "Starting your contribution. If it doesn’t start on its own, claim the slot before the offer expires.",
  ],
  downloading: [
    "Downloading the contribution file",
    "",
  ],
  computing: [
    "Computing your contribution",
    "Your device is computing the contribution locally. Keep this tab in the foreground and your computer awake until the upload finishes.",
  ],
  uploading: [
    "Sending your contribution.",
    "Uploading the resulting artifact. Your private randomness is not part of the upload.",
  ],
  verifying: [
    "Your contribution is being checked.",
    "The server is checking your contribution against the previous one. This can take several minutes.",
  ],
  accepted: [
    "Your contribution was accepted",
    "Your signed acceptance receipt is ready. Keep it so you can check your contribution independently.",
  ],
  error: [
    "Your contribution needs attention.",
    "This attempt has not been confirmed as accepted. Check the message below before trying again.",
  ],
};
export const CLOSE_CANCELS_NOTICE =
  "Keep this tab open. Closing or reloading it cancels your contribution and gives your slot to the next person.";

export function ContributionJourney({
  stage,
  position,
  offerExpiresAt,
  leaseExpiresAt,
  progress = 0,
  progressDetail,
  error,
  onClaim,
  onCancel,
  onRetry,
  onRejoin,
  onReceipt,
  busy = false,
  preview = false,
  submitted = false,
  confirmingCancel,
  onConfirmingCancelChange,
}: {
  stage: JourneyStage;
  position?: number;
  offerExpiresAt?: string | null;
  leaseExpiresAt?: string | null;
  progress?: number;
  progressDetail?: WorkerProgress | null;
  error?: string | null;
  onClaim?: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
  /** After a missed turn: take a new place at the end of the queue. */
  onRejoin?: () => void;
  onReceipt?: () => void;
  busy?: boolean;
  preview?: boolean;
  /** The failed attempt was already handed over for verification. */
  submitted?: boolean;
  /** Controls the cancel confirmation from outside, e.g. for the header logo. */
  confirmingCancel?: boolean;
  onConfirmingCancelChange?: (open: boolean) => void;
}) {
  const now = useClock();
  const [ownConfirming, setOwnConfirming] = useState(false);
  const confirming = confirmingCancel ?? ownConfirming;
  const setConfirming = onConfirmingCancelChange ?? setOwnConfirming;
  const canClaim = now !== null && claimAvailable(offerExpiresAt ?? null, now);
  const steps = ["Download", "Contribute", "Upload", "Verification"];
  const computeStages: JourneyStage[] = [
    "downloading",
    "computing",
    "uploading",
    "verifying",
  ];
  const index = stage === "accepted" ? 4 : computeStages.indexOf(stage);
  const slotExpired = stage === "error"
    && (/lease is unavailable or expired/i.test(error ?? "")
      || error === DOWNLOAD_SLOT_RELEASED || error === UPLOAD_SLOT_RELEASED || error === UPLOAD_TOO_SLOW);
  const detail = progressDetail?.phase === stage ? progressDetail : null;
  const label = detail?.label ?? steps[index];
  const percent = detail
    ? detail.percent
    : index >= 0 && index < 4
      ? phasePercent(
          stage as "downloading" | "computing" | "uploading" | "verifying",
          progress,
        )
      : null;
  const expiredOffer = stage === "offered" && now !== null && !canClaim;
  // A claimed slot before hand-over: cancelling it discards real work.
  const slotClaimed = index >= 0 && index < 3;
  const askToCancel = confirming && slotClaimed;
  useEffect(() => {
    if (!slotClaimed && confirming) setConfirming(false);
  }, [slotClaimed, confirming, setConfirming]);
  // Keeping the contribution returns focus to the button that asked.
  const actionsRef = useRef<HTMLDivElement>(null);
  const kept = useRef(false);
  useEffect(() => {
    if (askToCancel || !kept.current) return;
    kept.current = false;
    actionsRef.current?.querySelector<HTMLButtonElement>("[data-cancel-attempt]")?.focus();
  }, [askToCancel]);
  return (
    <section className={journey.journey} aria-label="Contribution progress">
      <JourneyWindow
        footer={index >= 0 && (
          <ol className={journey.rail}>
            {steps.map((label, i) => (
              <li
                key={label}
                data-current={i === index}
                data-done={i < index}
                aria-current={i === index ? "step" : undefined}
              >
                <span className={journey.node} aria-hidden="true" />
                <span className={journey.railNumber}>{i < index ? "✓ " : `${i + 1}. `}</span>
                <span>{label}</span>
              </li>
            ))}
          </ol>
        )}
      >
        <div className={journey.heading} aria-live="polite" aria-atomic="true">
          <div key={expiredOffer ? "expired" : stage} className={journey.enter}>
            {stage === "accepted" ? (
              // The check rides at the end of the headline's last line.
              <h1 className={journey.title}>
                {content[stage][0]}
                <svg className={`${journey.done} ${journey.titleCheck}`} viewBox="0 0 48 48" aria-hidden="true">
                  <circle cx="24" cy="24" r="22" />
                  <path d="M14 24.5l6.5 6.5L34 17.5" />
                </svg>
              </h1>
            ) : (
              <h1 className={journey.title}>{expiredOffer ? "Your slot expired" : content[stage][0]}</h1>
            )}
            {(expiredOffer || content[stage][1]) && (
              <p className={journey.lede}>
                {expiredOffer
                  ? "The offer timed out before it was claimed."
                  : content[stage][1]}
              </p>
            )}
            {stage !== "accepted" && stage !== "error" && stage !== "missed" && stage !== "uploading" && stage !== "verifying" && !expiredOffer && (
              <p className={journey.timeNote}>
                Allow about 5–10 minutes once your turn starts, plus queue time.
                Slower devices or connections may take longer.
              </p>
            )}
          </div>
        </div>
      </JourneyWindow>
      {(stage === "waiting" || stage === "offered") && (
        <div className={journey.tray}>
          <div key={expiredOffer ? "expired" : stage} className={`${journey.plate} ${journey.status} ${journey.enter}`}>
            {stage === "waiting" ? (
              <>
                <p className={journey.statusLabel}>Queue position</p>
                <div className={journey.big} data-pending={!(position && position > 0)}>
                  {position && position > 0
                    ? `#${position}`
                    : "Checking your place…"}
                </div>
                {position === 1 && (
                  <p>Your slot will be offered as soon as the current contributor is finished.</p>
                )}
                <p>
                  Your contribution starts automatically when your turn comes.
                </p>
                {!preview && <OfferNotifyControl />}
              </>
            ) : (
              <>
                <p className={journey.statusLabel}>
                  {now === null
                    ? "Checking offer deadline…"
                    : canClaim
                      ? "Claim your slot within"
                      : "This offer has expired"}
                </p>
                {!expiredOffer && (
                  <div className={journey.offerRow}>
                    <div className={journey.big} role="timer" data-pending={!(now !== null && offerExpiresAt)}>
                      {now !== null && offerExpiresAt
                        ? friendlyRemaining(offerExpiresAt, now)
                        : "Checking deadline…"}
                    </div>
                    <ContributeButton
                      onClick={onClaim}
                      disabled={!canClaim || busy}
                    >
                      {busy ? "Claiming slot…" : "Claim my slot"}
                    </ContributeButton>
                  </div>
                )}
                {now !== null && !canClaim && (
                  <p>The slot has passed to the next person.</p>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {index >= 0 && index < 4 && (
        <div className={journey.tray}>
          <div className={`${journey.plate} ${journey.status}`} aria-live="polite">
            <div key={stage} className={journey.enter}>
              <div className={journey.progressRow}>
                <p>
                  {label}
                  {percent !== null ? ` · ${percent}%` : " · in progress"}
                </p>
              </div>
              <progress
                className={journey.visuallyHidden}
                aria-label={label}
                max={100}
                {...(percent !== null ? { value: percent } : {})}
              />
              <span className={journey.meter} aria-hidden="true" data-indeterminate={percent === null}>
                <span style={percent !== null ? { transform: `scaleX(${percent / 100})` } : undefined} />
              </span>
              {stage === "computing" && percent === null && (
                <p>
                  The computation does not report a percentage. Keep this tab open;
                  the next step will appear when it finishes.
                </p>
              )}
              {stage === "verifying" && (
                <p>
                  If accepted, you’ll receive a signed receipt. Save it and check
                  the final ceremony record later to confirm your contribution
                  was included.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
      {stage === "accepted" && (
        <div className={journey.tray}>
          <div className={`${journey.plate} ${journey.status} ${journey.acceptedRow} ${journey.enter}`}>
            <ContributeButton onClick={onReceipt}>
              View your receipt
            </ContributeButton>
          </div>
        </div>
      )}
      {slotClaimed && (
        <p className={journey.notice}>
          <strong>{CLOSE_CANCELS_NOTICE}</strong>{" "}
          Keep it in the foreground and your computer awake through the upload.
          Switching tabs or minimizing the browser may pause activity and cause
          your slot to expire before the deadline.
          {leaseExpiresAt && (
            <>
              {" "}Slot deadline:{" "}
              <time dateTime={leaseExpiresAt}>{formatDeadline(leaseExpiresAt)}</time>.
            </>
          )}
        </p>
      )}
      {error && (
        <div className={`${journey.error} ${journey.enter}`} role="alert">
          {slotExpired
            ? "Your contribution slot is no longer active. This can happen if the browser pauses in the background, your computer sleeps, your connection drops, or the slot deadline passes. Return to the ceremony to check your contribution status. If this attempt was not accepted or submitted for verification, join the queue again for a new slot. Keep the contribution tab in the foreground until the upload finishes."
            : error}
        </div>
      )}
      {askToCancel ? (
        <CancelConfirmation
          onConfirm={() => {
            setConfirming(false);
            onCancel?.();
          }}
          onKeep={() => {
            kept.current = true;
            setConfirming(false);
          }}
        />
      ) : (
        <div ref={actionsRef} className={journey.actions}>
          {stage === "missed" && (
            <Button onClick={onRejoin} disabled={busy}>
              Rejoin the queue
            </Button>
          )}
          {stage === "error" && !slotExpired && (
            <Button onClick={onRetry}>
              {submitted ? "Check contribution status" : "Try again"}
            </Button>
          )}
          {stage !== "accepted" && stage !== "verifying" && !(stage === "error" && submitted) && (
            <Button
              variant="secondary"
              size="small"
              onClick={slotClaimed ? () => setConfirming(true) : onCancel}
              disabled={stage === "joining" && busy}
              data-cancel-attempt
            >
              {slotExpired || stage === "missed"
                ? "Back to homepage"
                : stage === "waiting" || stage === "offered"
                ? "Leave queue"
                : "Cancel attempt"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** In-page confirmation before a claimed slot is given up. */
function CancelConfirmation({ onConfirm, onKeep }: { onConfirm: () => void; onKeep: () => void }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  // Focus the safe choice, so a stray Enter keeps the contribution running.
  useEffect(() => ref.current?.querySelector("button")?.focus(), []);
  return (
    <div
      ref={ref}
      className={`${journey.confirm} ${journey.enter}`}
      role="group"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === "Escape") onKeep();
      }}
    >
      <p id={titleId}>
        <strong>Cancel your contribution?</strong> Your slot goes to the next
        person and this attempt is discarded.
      </p>
      <div className={journey.actions}>
        <Button onClick={onKeep}>Keep contributing</Button>
        <Button variant="secondary" size="small" onClick={onConfirm}>
          Cancel contribution
        </Button>
      </div>
    </div>
  );
}
