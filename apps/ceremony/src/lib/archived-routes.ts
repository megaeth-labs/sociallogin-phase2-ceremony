import { NextResponse } from "next/server";
import { ceremonyArchive } from "./ceremony-archive";

/**
 * The answer of a participant route once the ceremony is archived: 410 Gone,
 * because sign-in tokens, CLI logins and claims only served a live ceremony.
 * Null while the ceremony is live.
 */
export function closedForArchive(): NextResponse | null {
  if (!ceremonyArchive()) return null;
  return NextResponse.json(
    { error: "The ceremony is complete and contributions are closed." },
    { status: 410, headers: { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" } },
  );
}
