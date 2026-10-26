"use client";
import { useEffect } from "react";

import { notifyOffer, offerTitle } from "@/lib/offer-alert";

/** Flag a waiting slot offer in the tab title and, if opted in, a notification. */
export function useOfferAlert(offered: boolean): void {
  useEffect(() => {
    if (!offered) return;
    const original = document.title;
    document.title = offerTitle(original);
    notifyOffer();
    return () => { document.title = original; };
  }, [offered]);
}
