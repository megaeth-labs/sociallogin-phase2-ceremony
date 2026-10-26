import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    participantId: string;
    participantName: string;
    authSubjectHash: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    participantId?: string;
    participantName?: string;
    authSubjectHash?: string;
  }
}
