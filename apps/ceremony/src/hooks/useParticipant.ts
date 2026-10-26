"use client";

import { useSession, signIn } from "next-auth/react";
import { signInCallbackUrl } from "@/lib/continue-after-sign-in";

export type AuthMethod = "github";

export function useParticipant() {
  const { data: session, status } = useSession();

  const participantId = session?.participantId ?? null;
  const participantName = session?.participantName ?? "";
  const isAuthenticated = status === "authenticated";

  const authenticate = (_method: AuthMethod) => {
    // Come back ready to continue at the browser check (see LandingScreen).
    void signIn("github", { callbackUrl: signInCallbackUrl(window.location.href) });
  };

  return {
    participantId,
    participantName,
    isAuthenticated,
    authenticate,
  };
}
