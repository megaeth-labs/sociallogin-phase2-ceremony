import { expect, it } from "vitest";
import { isPhoneOrTablet } from "./contribution-device";

it.each([
  ["iPhone", "iPhone", 5, true],
  ["iPad", "iPad", 5, true],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari", "MacIntel", 5, true],
  ["Mozilla/5.0 (Linux; Android 14; Pixel Tablet)", "Linux armv8l", 5, true],
  ["Mozilla/5.0 (Linux; Android 14; Pixel) Mobile", "Linux armv8l", 5, true],
  ["Mozilla/5.0 (Windows NT 10.0) Chrome", "Win32", 10, false],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari", "MacIntel", 0, false],
  ["Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64", 0, false],
])("detects device %s on %s with %i touch points", (userAgent, platform, maxTouchPoints, blocked) => {
  expect(isPhoneOrTablet({ userAgent, platform, maxTouchPoints })).toBe(blocked);
});
it("honors mobile client hints even with a generic user agent", () => {
  expect(isPhoneOrTablet({userAgent: "Chrome", platform: "Linux", maxTouchPoints: 0, userAgentData: { mobile: true }})).toBe(true);
});
