import { getServerSession } from "next-auth";

import { authOptions } from "./auth";
import type { Participant } from "./participant-identity";

/** Resolve the authenticated browser participant from its signed session. */
export async function getParticipant(): Promise<Participant | null> {
  const session = await getServerSession(authOptions);
  if (!session?.participantId || !session.authSubjectHash) return null;
  return {
    participantId: session.participantId,
    participantName: session.participantName ?? "",
    authSubjectHash: session.authSubjectHash,
  };
}
