// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContributionJourney } from "./index";

afterEach(cleanup);

describe("cancelling a claimed slot", () => {
  it("asks in the page before discarding the attempt", () => {
    const onCancel = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    render(<ContributionJourney stage="computing" onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel attempt" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("group").textContent).toBe(
      "Cancel your contribution? Your slot goes to the next person and this attempt is discarded.Keep contributingCancel contribution",
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep contributing" }));

    fireEvent.click(screen.getByRole("button", { name: "Keep contributing" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel attempt" }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel attempt" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel contribution" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("lets Escape keep the contribution running", () => {
    const onCancel = vi.fn();
    render(<ContributionJourney stage="uploading" onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel attempt" }));
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(screen.queryByRole("group")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("leaves the queue without confirmation", () => {
    for (const stage of ["waiting", "offered"] as const) {
      const onCancel = vi.fn();
      const { unmount } = render(<ContributionJourney stage={stage} onCancel={onCancel} />);
      fireEvent.click(screen.getByRole("button", { name: "Leave queue" }));
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("group")).toBeNull();
      unmount();
    }
  });

  it("can be opened from outside, e.g. by the header logo", () => {
    const onChange = vi.fn();
    render(<ContributionJourney stage="downloading" confirmingCancel onConfirmingCancelChange={onChange} />);
    expect(screen.getByRole("group")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep contributing" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
