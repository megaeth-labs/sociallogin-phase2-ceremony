/** Shown in the tab while a slot offer is waiting to be claimed. */
export function offerTitle(original: string): string {
  return `Your slot is ready · ${original}`;
}

export type OfferNotificationPermission = NotificationPermission | "unsupported";

export function offerNotificationPermission(): OfferNotificationPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Ask only from a user gesture; browsers ignore or penalize unprompted asks. */
export async function requestOfferNotifications(): Promise<OfferNotificationPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  return await Notification.requestPermission();
}

/** Notify only when the participant opted in and is not already looking at the tab. */
export function notifyOffer(): boolean {
  if (offerNotificationPermission() !== "granted") return false;
  if (typeof document !== "undefined" && document.visibilityState === "visible") return false;
  new Notification("Your contribution slot is ready", {
    body: "Return to the ceremony tab and claim it before the offer expires.",
    tag: "moss-slot-offer",
  });
  return true;
}
