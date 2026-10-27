"use client";
import { useState } from "react";

import { Button } from "@/app/components/Button";
import {
  offerNotificationPermission,
  requestOfferNotifications,
} from "@/lib/offer-alert";
import { enableTurnChime, turnChimeEnabled } from "@/lib/turn-chime";

/**
 * Opt-in only: the click turns on the chime and, where the browser has not
 * been asked yet, requests notification permission. Neither happens on its own.
 */
export function OfferNotifyControl() {
  const [enabled, setEnabled] = useState(() => turnChimeEnabled());
  if (enabled) {
    return <p role="status">We’ll play a sound when your contribution starts, even if this tab is in the background.</p>;
  }
  return (
    <Button
      variant="secondary"
      size="small"
      onClick={() => {
        setEnabled(enableTurnChime());
        if (offerNotificationPermission() === "default") void requestOfferNotifications().catch(() => undefined);
      }}
    >
      Play a sound when my turn starts
    </Button>
  );
}
