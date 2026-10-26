// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Readiness } from "./Readiness";
const probe = vi.hoisted(() => vi.fn());
vi.mock("@wonderland/cabure-crypto/browser", () => ({ getBrowserContributionCapabilities: probe }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); probe.mockReset(); });
function device(userAgent: string, platform: string, touch: number) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: touch });
}
it.each([false, true])("blocks mobile setup even in preview=%s and leaves a way back", preview => {
  device("Macintosh Safari", "MacIntel", 5);
  const onReady=vi.fn(),onBack=vi.fn();
  render(<Readiness inputBytes={368440348} onReady={onReady} onBack={onBack} preview={preview} />);
  expect(screen.getByRole("heading", {name:"Use a desktop to contribute"})).toBeTruthy();
  expect(screen.queryByText("Proceed with ceremony anyway")).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:"Back to homepage"}));
  expect(onBack).toHaveBeenCalledOnce();expect(onReady).not.toHaveBeenCalled();expect(probe).not.toHaveBeenCalled();
});
it("preserves the failed storage-check override for touchscreen desktops", async () => {
  device("Windows NT Chrome", "Win32", 10);
  probe.mockResolvedValue({ supported: false, reasons: ["insufficient-opfs-quota"] });
  const onReady=vi.fn();
  render(<Readiness inputBytes={368440348} onReady={onReady} onBack={()=>{}} />);
  fireEvent.click(screen.getByRole("button", {name:"Check browser & storage"}));
  fireEvent.click(await screen.findByLabelText("Proceed with ceremony anyway"));
  fireEvent.click(screen.getByLabelText(/I’m on a desktop/));
  fireEvent.click(screen.getByLabelText(/I understand that my randomness/));
  fireEvent.click(screen.getByRole("button", {name:"Continue to contribution setup"}));
  expect(onReady).toHaveBeenCalledWith(true);
});
