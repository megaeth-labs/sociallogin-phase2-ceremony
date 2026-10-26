"use client";
import { useEffect, useRef, useState } from "react";
import { settleAbandonedAttempt, type AbandonedAttempt, type ParticipantActivity } from "@/lib/api";

/**
 * Settle the participant's attempt when this tab isn't running it: cancel a
 * slot this browser claimed and then left (its page closed before the cancel
 * got through), and clean up after one that already ended. Re-checked on
 * every activity refresh, since another tab may finish or close meanwhile.
 */
export function useAbandonedAttempt(
  activity: ParticipantActivity | undefined,
  updatedAt: number,
  enabled: boolean,
  onCancelled: () => void,
) {
  const [outcome, setOutcome] = useState<AbandonedAttempt | null>(null);
  const [closedNotice, setClosedNotice] = useState(false);
  const busy = useRef(false);
  const onCancelledRef = useRef(onCancelled);
  onCancelledRef.current = onCancelled;
  useEffect(() => {
    if (!enabled || !activity || busy.current) return;
    busy.current = true;
    settleAbandonedAttempt(activity.state)
      .then((result) => {
        setOutcome(result);
        if (result === "cancelled") {
          setClosedNotice(true);
          onCancelledRef.current();
        }
      })
      .catch(() => setOutcome("unknown"))
      .finally(() => {
        busy.current = false;
      });
  }, [activity, updatedAt, enabled]);
  return { outcome, closedNotice, dismiss: () => setClosedNotice(false) };
}
