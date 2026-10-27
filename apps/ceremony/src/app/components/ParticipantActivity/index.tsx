"use client";
import type { AbandonedAttempt, ParticipantActivity, ReceiptResponse } from "@/lib/api";
import { participantActivityStage } from "@/lib/participant-activity";
import { Button } from "../Button";
import styles from "./style.module.css";

export const CLOSED_ATTEMPT_NOTICE =
  "Your previous attempt was cancelled when the page closed. You can join the queue again.";

export function ParticipantActivityCard({ activity, abandoned = null, closedNotice = false, onViewProgress, onContinue, onReceipt }: {
  activity: ParticipantActivity;
  /** What settling an active slot no tab here is running found; null until checked. */
  abandoned?: AbandonedAttempt | null;
  /** An attempt this browser started was cancelled because its page closed. */
  closedNotice?: boolean;
  onViewProgress: () => void;
  /** Re-enter the contribution flow, which picks up the existing queue ticket. */
  onContinue: () => void;
  onReceipt: (receipt: ReceiptResponse) => void;
}) {
  const stage = participantActivityStage(activity);
  const showClosed = closedNotice && (stage === "empty" || stage === "failed");
  if (stage === "empty" && activity.receipts.length === 0 && !showClosed) return null;
  return <section className={styles.card} aria-label="Your contributions">
    {showClosed && <p role="status">{CLOSED_ATTEMPT_NOTICE}</p>}
    {stage === "pending" && <>
      <h2>Your contribution is being verified.</h2>
      <p>The server is checking your contribution. View its progress below.</p>
      <div className={styles.actions}>
        <Button onClick={onViewProgress}>View contribution progress</Button>
        <a className={styles.link} href="/how-it-works">How it works</a>
      </div>
    </>}
    {stage === "accepted" && <p role="status">Your contribution was accepted. Your signed receipt is ready below.</p>}
    {stage === "unconfirmed" && <p role="status">We haven’t confirmed acceptance. Open your contribution to check again.</p>}
    {stage === "unconfirmed" && <div className={styles.actions}>
      <Button onClick={onViewProgress}>Check contribution status</Button>
      <a className={styles.link} href="/how-it-works">How it works</a>
    </div>}
    {stage === "failed" && !showClosed && <p>Your last attempt ended without acceptance ({activity.state.submission?.state.toLowerCase()}). You can start a new attempt if contributions are open.</p>}
    {stage === "active" && <p role="status">
      {abandoned === "running"
        ? "Your contribution is running in another tab. Keep that tab open until it finishes."
        : abandoned === "unknown"
          ? "Your slot is still held by an earlier attempt, which may be running in another tab or browser. If it isn’t, the slot is released within about 5 minutes and you can join the queue again."
          : "Checking your earlier attempt…"}
    </p>}
    {stage === "queued" && (abandoned === "running"
      ? <p role="status">Your place in the queue is open in another tab. Switch to that tab and keep it open; closing it gives up your place.</p>
      : <>
        <p>You have a place in the queue.</p>
        <Button onClick={onContinue}>Return to the queue</Button>
      </>)}
    {activity.receipts.map((receipt) => <div key={receipt.receiptId} className={styles.receipt}>
      <h3>Contribution #{receipt.contributionIndex}</h3>
      <p>Accepted <time dateTime={new Date(receipt.timestamp).toISOString()}>{new Date(receipt.timestamp).toUTCString()}</time></p>
      <Button variant="secondary" onClick={() => onReceipt(receipt)}>View receipt</Button>
    </div>)}
  </section>;
}
