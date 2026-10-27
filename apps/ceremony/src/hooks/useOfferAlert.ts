"use client";
import { useEffect } from "react";

import { notifyOffer, offerTitle } from "@/lib/offer-alert";
import { playTurnChime } from "@/lib/turn-chime";

/** Flag the start of a turn in the tab title and, if opted in, with a chime and a notification. */
export function useOfferAlert(offered: boolean): void {
  useEffect(() => {
    if (!offered) return;
    const original = document.title;
    document.title = offerTitle(original);
    notifyOffer();
    playTurnChime();
    return () => { document.title = original; };
  }, [offered]);
}
