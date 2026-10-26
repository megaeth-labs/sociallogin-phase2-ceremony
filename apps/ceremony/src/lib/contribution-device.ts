export const DESKTOP_REQUIRED =
  "Please open this page on a desktop or laptop to contribute. Phone and tablet contributions are not supported. You can still view ceremony status and contribution history here.";

type DeviceNavigator = Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> & {
  userAgentData?: { mobile?: boolean };
};

/** Best-effort device detection, not a security boundary. Do not use viewport
 * width or touch alone: small windows and touchscreen laptops are supported. */
export function isPhoneOrTablet(device: DeviceNavigator): boolean {
  return device.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk\/|Kindle|PlayBook/i.test(device.userAgent) ||
    (/Mac/i.test(device.platform) && device.maxTouchPoints > 1);
}

export function requireDesktopContribution(): void {
  if (typeof navigator !== "undefined" && isPhoneOrTablet(navigator)) {
    throw new Error(DESKTOP_REQUIRED);
  }
}
