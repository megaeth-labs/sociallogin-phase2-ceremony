"use client";

import { useQuery } from "@tanstack/react-query";
import { getStatus } from "@/lib/api";

/** How often an open page refreshes the public ceremony status. */
export const STATUS_POLL_MS = 15_000;

/**
 * The public ceremony status. React Query gives every observer its own polling
 * timer, so only the page's top-level component polls; components rendered
 * inside it pass `poll: false` and read the same cached status.
 */
export function useCeremonyStatus({ poll = true }: { poll?: boolean } = {}) {
  const { data: status, error } = useQuery({
    queryKey: ["ceremonyStatus"],
    queryFn: ({ signal }) => getStatus(signal),
    refetchInterval: poll ? STATUS_POLL_MS : false,
    // A nested reader mounting later must not trigger its own request.
    refetchOnMount: poll,
  });

  return {
    status: status ?? null,
    statusError: error ? error.message : null,
  };
}
