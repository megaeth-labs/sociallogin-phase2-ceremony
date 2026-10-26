import { NextResponse } from "next/server";

import { loadCoordinatorBootstrap } from "@/lib/coordinator-bootstrap";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await loadCoordinatorBootstrap(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Ceremony bootstrap validation failed.",
      },
      { status: 503 },
    );
  }
}
