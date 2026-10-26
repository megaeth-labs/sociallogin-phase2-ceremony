// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ getStatus }));

import { STATUS_POLL_MS, useCeremonyStatus } from "./useCeremonyStatus";

function Page() {
  useCeremonyStatus();
  return <Nested />;
}
function Nested() {
  useCeremonyStatus({ poll: false });
  return null;
}

describe("ceremony status polling", () => {
  beforeEach(() => { vi.useFakeTimers(); getStatus.mockResolvedValue({ isActive: true }); });
  afterEach(() => vi.useRealTimers());

  it("polls once per interval however many components read it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getStatus).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 3); });
    expect(getStatus).toHaveBeenCalledTimes(4);
  });
});
