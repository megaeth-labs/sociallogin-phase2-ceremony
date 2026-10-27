// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTurnChimeForTests } from "./turn-chime";

import { useOfferAlert } from "@/hooks/useOfferAlert";
import { OfferNotifyControl } from "@/app/components/PublicCeremony/OfferNotifyControl";
import { notifyOffer, offerNotificationPermission, optInToTurnAlerts, requestOfferNotifications, resetTurnAlertOptInForTests } from "./offer-alert";

function stubNotification(permission: NotificationPermission) {
  const created: unknown[][] = [];
  const Fake = vi.fn(function (this: unknown, ...args: unknown[]) { created.push(args); }) as unknown as typeof Notification;
  Object.assign(Fake, { permission, requestPermission: vi.fn(async () => "granted" as const) });
  vi.stubGlobal("Notification", Fake);
  return { Fake, created };
}

function visibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
}

afterEach(() => { resetTurnAlertOptInForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.title = ""; document.body.innerHTML = ""; });

describe("slot offer alerts", () => {
  it("flags the tab title while an offer waits and restores it afterwards", () => {
    document.title = "MOSS ceremony";
    const { rerender, unmount } = renderHook(({ offered }) => useOfferAlert(offered), { initialProps: { offered: false } });
    expect(document.title).toBe("MOSS ceremony");
    rerender({ offered: true });
    expect(document.title).toBe("Your turn has started · MOSS ceremony");
    rerender({ offered: false });
    expect(document.title).toBe("MOSS ceremony");
    rerender({ offered: true });
    unmount();
    expect(document.title).toBe("MOSS ceremony");
  });

  it("never notifies without this page's opt-in click, even with permission from an earlier visit", () => {
    visibility("hidden");
    const stub = stubNotification("granted");
    expect(notifyOffer()).toBe(false);
    expect(stub.created).toHaveLength(0);
  });

  it("notifies only an opted-in participant whose tab is in the background", () => {
    visibility("hidden");
    optInToTurnAlerts();
    let stub = stubNotification("default");
    expect(notifyOffer()).toBe(false);
    stub = stubNotification("granted");
    expect(notifyOffer()).toBe(true);
    expect(stub.created).toHaveLength(1);
    visibility("visible");
    expect(notifyOffer()).toBe(false);
    expect(stub.created).toHaveLength(1);
  });

  it("never prompts on its own and reports unsupported browsers", async () => {
    const { Fake } = stubNotification("default");
    renderHook(() => useOfferAlert(true));
    expect(Fake.requestPermission).not.toHaveBeenCalled();
    expect(await requestOfferNotifications()).toBe("granted");
    vi.stubGlobal("Notification", undefined);
    expect(offerNotificationPermission()).toBe("unsupported");
    expect(notifyOffer()).toBe(false);
  });
});

describe("OfferNotifyControl", () => {
  class FakeAudioContext {
    resume = vi.fn(async () => undefined);
  }
  afterEach(() => resetTurnChimeForTests());

  it("turns on the chime and asks for notifications only when the participant clicks", async () => {
    const { Fake } = stubNotification("default");
    vi.stubGlobal("AudioContext", FakeAudioContext);
    render(<OfferNotifyControl />);
    expect(Fake.requestPermission).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Alert me when my turn starts" })); });
    expect(Fake.requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent)
      .toBe("We’ll play a sound and show a notification when your contribution starts.");
  });
  it("still offers the chime where notifications are blocked", async () => {
    const { Fake } = stubNotification("denied");
    vi.stubGlobal("AudioContext", FakeAudioContext);
    render(<OfferNotifyControl />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Alert me when my turn starts" })); });
    expect(Fake.requestPermission).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("We’ll play a sound when your contribution starts.");
  });
});
