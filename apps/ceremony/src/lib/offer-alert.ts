/** Shown in the tab while a slot offer is being started. */
export function offerTitle(original: string): string {
  return `Your turn has started · ${original}`;
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

// Set by this page load's opt-in click, so a permission granted on an earlier
// visit never alerts on its own: the same rule as the chime.
let optedIn = false;

/** Call from the opt-in click. */
export function optInToTurnAlerts(): void {
  optedIn = true;
}

/** Test seam: forget the opt-in. */
export function resetTurnAlertOptInForTests(): void {
  optedIn = false;
}

/** Notify only when the participant opted in on this page and is not already looking at the tab. */
export function notifyOffer(): boolean {
  if (!optedIn) return false;
  if (offerNotificationPermission() !== "granted") return false;
  if (typeof document !== "undefined" && document.visibilityState === "visible") return false;
  new Notification("Your contribution has started", {
    body: "Keep the ceremony tab open and your computer awake until it finishes.",
    tag: "moss-slot-offer",
  });
  return true;
}
