"use client";
import { useEffect, useState } from "react";

import { Button } from "@/app/components/Button";
import {
  offerNotificationPermission,
  requestOfferNotifications,
  type OfferNotificationPermission,
} from "@/lib/offer-alert";

/** Opt-in only: the permission prompt opens from this button, never on its own. */
export function OfferNotifyControl() {
  const [permission, setPermission] = useState<OfferNotificationPermission | null>(null);
  useEffect(() => setPermission(offerNotificationPermission()), []);
  if (permission === "default") {
    return (
      <Button
        variant="secondary"
        size="small"
        onClick={() => void requestOfferNotifications().then(setPermission, () => undefined)}
      >
        Notify me when it’s my turn
      </Button>
    );
  }
  if (permission === "granted") {
    return <p role="status">We’ll notify you when it’s your turn, even if this tab is in the background.</p>;
  }
  return null;
}
