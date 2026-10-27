"use client";
import { useState } from "react";

import { Button } from "@/app/components/Button";
import {
  offerNotificationPermission,
  optInToTurnAlerts,
  requestOfferNotifications,
} from "@/lib/offer-alert";
import { enableTurnChime, turnChimeEnabled } from "@/lib/turn-chime";

/**
 * Opt-in only: the click turns on the chime and, where the browser has not
 * been asked yet, requests notification permission. Neither happens on its own.
 */
export function OfferNotifyControl() {
  const [enabled, setEnabled] = useState(() => turnChimeEnabled());
  const [notifying, setNotifying] = useState(() => offerNotificationPermission() === "granted");
  if (enabled) {
    return (
      <p role="status">
        {notifying
          ? "We’ll play a sound and show a notification when your contribution starts."
          : "We’ll play a sound when your contribution starts."}
      </p>
    );
  }
  return (
    <Button
      variant="secondary"
      size="small"
      onClick={() => {
        optInToTurnAlerts();
        setEnabled(enableTurnChime());
        if (offerNotificationPermission() === "default") {
          void requestOfferNotifications()
            .then((permission) => setNotifying(permission === "granted"), () => undefined);
        }
      }}
    >
      Alert me when my turn starts
    </Button>
  );
}
