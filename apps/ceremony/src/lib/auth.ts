import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";

import { githubOAuthCredentials } from "./env";

import { deriveParticipant } from "./participant-identity";

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      // Next evaluates route modules while collecting production build data.
      // Keep configuration lookup lazy enough for secretless reproducible
      // builds; NextAuth rejects missing credentials when the route is used.
      ...githubOAuthCredentials(),
      // Ceremony authentication is identity-only. Never request a GitHub write
      // scope merely to publish an optional contribution attestation.
      authorization: { params: { scope: "read:user" } },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, profile, account }) {
      if (profile) {
        const gh = profile as { id?: number; login?: string };
        const providerSubject = account?.providerAccountId ?? String(gh.id ?? "");
        const participant = await deriveParticipant(
          "github",
          providerSubject,
          gh.login ?? profile.name ?? `github-user-${providerSubject}`,
        );
        token.participantId = participant.participantId;
        token.participantName = participant.participantName;
        token.authSubjectHash = participant.authSubjectHash;
      }
      return token;
    },
    session({ session, token }) {
      session.participantId = token.participantId as string;
      session.participantName = token.participantName as string;
      session.authSubjectHash = token.authSubjectHash as string;
      return session;
    },
  },
};
