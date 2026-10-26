// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const query = vi.hoisted(() => ({ useQuery: vi.fn(), keepPreviousData: vi.fn() }));
vi.mock("@tanstack/react-query", () => query);
vi.mock("@/lib/api", () => ({ getContributionHistoryPage: vi.fn(), HISTORY_PAGE_SIZE: 5, collectibleReceiptHash: vi.fn(async () => `0x${"c".repeat(64)}`) }));
import { ContributionHistory } from "./index";

function history(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    receipt: {
      generation: count - i, contributionIndex: count - i,
      participantPseudonym: `participant-${count - i}`, acceptedAt: "2026-10-02T12:00:00Z",
      predecessor: { sha256: "a".repeat(64) }, successor: { sha256: "b".repeat(64), byteLength: 100 },
    },
    envelope: { keyId: "test" },
    policy: { verificationMethod: "bellman-transition-v1", requiredOperators: 1, passesPerOperator: 1, operatorKeyIds: ["test"] },
  }));
}
/** Serves the requested page of a newest-first history, as the hook would. */
function serve(count: number, extra: Record<string, unknown> = {}) {
  const all = history(count);
  query.useQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
    const page = Number(queryKey.at(-1));
    return { data: { total: count, items: all.slice(page * 5, page * 5 + 5) }, isPending: false, ...extra };
  });
}
afterEach(cleanup);
/** Contributor names shown in the collapsed rows. */
const rowNames = (root: ParentNode) => [...root.querySelectorAll("summary [class*=name]")].map((el) => el.textContent);

describe("homepage contribution history", () => {
  it("shows the newest five and requests the older entries as their own page", () => {
    serve(6);
    const { container } = render(<ContributionHistory />);
    expect(container.querySelectorAll("details")).toHaveLength(5);
    expect(container.querySelector("p[class*=total]")?.textContent).toBe("6accepted contributions in total");
    expect(rowNames(container)).toContain("participant-6");
    expect(rowNames(container)).not.toContain("participant-1");
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(rowNames(container)).toContain("participant-1");
    expect(screen.getByRole("status").textContent).toContain("Page 2 of 2");
    expect(query.useQuery.mock.calls.at(-1)?.[0].queryKey).toEqual(["contributionHistory", 1]);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(rowNames(container)).toContain("participant-6");
  });
  it("clamps the current page when history changes and hides unverified history on error", () => {
    serve(6);
    const { rerender, container } = render(<ContributionHistory />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    serve(1);
    rerender(<ContributionHistory />);
    expect(screen.getByRole("status").textContent).toContain("Page 1 of 1");
    serve(1, { error: new Error("Invalid signature") });
    rerender(<ContributionHistory />);
    expect(container.querySelectorAll("details")).toHaveLength(0);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Invalid signature");
  });
  it("shows an empty total without pagination", () => {
    serve(0);
    render(<ContributionHistory />);
    expect(document.querySelector("p[class*=total]")?.textContent).toBe("0accepted contributions in total");
    expect(screen.queryByRole("navigation")).toBeNull();
  });
  it("keeps the current rows while the next page loads", () => {
    serve(12, { isPlaceholderData: true });
    const { container } = render(<ContributionHistory />);
    expect(screen.getByRole("status").textContent).toBe("Loading page…");
    expect(container.querySelector("[aria-busy=true]")).not.toBeNull();
  });
});
