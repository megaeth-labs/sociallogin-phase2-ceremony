// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useOfferAlert } from "@/hooks/useOfferAlert";
import { OfferNotifyControl } from "@/app/components/PublicCeremony/OfferNotifyControl";
import { notifyOffer, offerNotificationPermission, requestOfferNotifications } from "./offer-alert";

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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.title = ""; document.body.innerHTML = ""; });

describe("slot offer alerts", () => {
  it("flags the tab title while an offer waits and restores it afterwards", () => {
    document.title = "MOSS ceremony";
    const { rerender, unmount } = renderHook(({ offered }) => useOfferAlert(offered), { initialProps: { offered: false } });
    expect(document.title).toBe("MOSS ceremony");
    rerender({ offered: true });
    expect(document.title).toBe("Your slot is ready · MOSS ceremony");
    rerender({ offered: false });
    expect(document.title).toBe("MOSS ceremony");
    rerender({ offered: true });
    unmount();
    expect(document.title).toBe("MOSS ceremony");
  });

  it("notifies only an opted-in participant whose tab is in the background", () => {
    visibility("hidden");
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
  it("asks for permission only when the participant clicks", async () => {
    const { Fake } = stubNotification("default");
    render(<OfferNotifyControl />);
    expect(Fake.requestPermission).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Notify me when it’s my turn" })); });
    expect(Fake.requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("We’ll notify you");
  });
  it("renders nothing where notifications are blocked or unsupported", () => {
    stubNotification("denied");
    const { container } = render(<OfferNotifyControl />);
    expect(container.innerHTML).toBe("");
  });
});
