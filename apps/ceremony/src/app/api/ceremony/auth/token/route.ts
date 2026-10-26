import { rehearsalReviewEnabled } from "@/lib/rehearsal-review";
import { NextResponse } from "next/server";

import { getParticipant } from "@/lib/participant-auth";
import { signParticipantToken } from "@/lib/participant-identity";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

/** Exchange a signed browser session for a short-lived coordinator token. */
export async function GET(): Promise<NextResponse> {
  if (rehearsalReviewEnabled()) {
    return NextResponse.json({ error: "Contributions are closed during rehearsal review." }, { status: 423, headers: NO_STORE_HEADERS });
  }
  const participant = await getParticipant();
  if (!participant) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }
  const token = await signParticipantToken(participant, "browser");
  return NextResponse.json({
    ...token,
    participantId: participant.participantId,
    participantName: participant.participantName,
  }, { headers: NO_STORE_HEADERS });
}
