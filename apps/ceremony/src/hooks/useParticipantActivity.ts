"use client";
import { useQuery } from "@tanstack/react-query";
import { getParticipantActivity } from "@/lib/api";
import { useParticipant } from "./useParticipant";

export function useParticipantActivity(enabled = true) {
  const { isAuthenticated, participantId } = useParticipant();
  const query = useQuery({
    queryKey: ["participantActivity", participantId],
    queryFn: ({ signal }) => getParticipantActivity(signal, participantId ?? undefined),
    enabled: enabled && isAuthenticated && !!participantId,
    refetchInterval: 5_000,
    retry: false,
  });
  return { ...query, data: isAuthenticated && participantId ? query.data : undefined, isAuthenticated };
}
