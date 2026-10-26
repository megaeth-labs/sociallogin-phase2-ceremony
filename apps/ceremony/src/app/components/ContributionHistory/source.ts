"use client";

import { createContext, useContext } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getContributionHistoryPage, type ContributionHistoryPage } from "@/lib/api";
import { STATUS_POLL_MS } from "@/hooks/useCeremonyStatus";

type LoadHistoryPage = (page: number, signal?: AbortSignal) => Promise<ContributionHistoryPage>;

/**
 * Where accepted contributions come from: the live coordinator by default, or
 * a fixed record such as the walkthrough's rehearsal snapshot.
 */
export const HistorySource = createContext<LoadHistoryPage>(getContributionHistoryPage);

/**
 * One page of the history, newest first. Page 0 is shared by the history card,
 * the lobby's chain and How it works, so they make one request between them.
 */
export function useContributionHistory(page = 0) {
  const load = useContext(HistorySource);
  const live = load === getContributionHistoryPage;
  return useQuery({
    queryKey: live ? ["contributionHistory", page] : ["contributionHistory", "fixed", page],
    queryFn: ({ signal }) => load(page, signal),
    refetchInterval: live ? STATUS_POLL_MS : false,
    staleTime: live ? 0 : Infinity,
    // Keep the current rows on screen while the next page loads.
    placeholderData: keepPreviousData,
  });
}
