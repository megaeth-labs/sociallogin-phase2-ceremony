import { NextResponse } from "next/server";
import { getParticipant } from "@/lib/participant-auth";
import {
  authorizeBadge,
  BadgeError,
  limitedJson,
  loadBadge,
  receiptId,
} from "@/lib/nft/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};
function failure(error: unknown) {
  return NextResponse.json(
    {
      error:
        error instanceof BadgeError
          ? error.message
          : "Collectible service is unavailable. Your contribution is still accepted.",
    },
    { status: error instanceof BadgeError ? error.status : 503, headers },
  );
}
export async function GET(request: Request) {
  try {
    const participant = await getParticipant();
    if (!participant)
      throw new BadgeError(
        401,
        "Sign in with the GitHub account used for your contribution.",
      );
    const badge = await loadBadge(
      participant,
      receiptId(new URL(request.url).searchParams.get("receiptId")),
    );
    return NextResponse.json(badge?.status ?? { enabled: false }, { headers });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const trustedOrigin = new URL(process.env.NEXTAUTH_URL ?? "").origin;
    if (request.headers.get("origin") !== trustedOrigin)
      throw new BadgeError(403, "Open the claim page on the ceremony website.");
    if (
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      throw new BadgeError(415, "Expected a JSON claim request.");
    const participant = await getParticipant();
    if (!participant)
      throw new BadgeError(
        401,
        "Sign in with the GitHub account used for your contribution.",
      );
    const body = await limitedJson(request, 2048);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => k !== "receiptId" && k !== "recipient")
    )
      throw new BadgeError(400, "Invalid claim request.");
    const input = body as { receiptId?: unknown; recipient?: unknown };
    return NextResponse.json(
      await authorizeBadge(
        participant,
        receiptId(input.receiptId),
        input.recipient,
      ),
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
