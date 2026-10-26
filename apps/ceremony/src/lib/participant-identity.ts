import {
  createHmac,
  createPrivateKey,
  sign,
  type KeyObject,
} from "node:crypto";
import { readServerMaterial } from "./server-material";

import { requiredServerEnv } from "./server-env";

export interface Participant {
  participantId: string;
  participantName: string;
  authSubjectHash: string;
}

const CLI_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
const BROWSER_TOKEN_EXPIRY_SECONDS = 60 * 60;
let signingKeyPromise: Promise<KeyObject> | undefined;
let derivationKeyPromise: Promise<Buffer> | undefined;

/**
 * Derive a stable, non-enumerable coordinator identity from the OAuth
 * provider's immutable subject. The raw GitHub id never leaves this issuer.
 */
export async function deriveParticipant(
  provider: string,
  providerSubject: string,
  participantName: string,
): Promise<Participant> {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(provider)) {
    throw new Error("Unsupported identity provider.");
  }
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(providerSubject)) {
    throw new Error("Identity provider subject is invalid.");
  }
  const pseudonym = participantName.trim();
  if (
    !pseudonym ||
    pseudonym.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(pseudonym)
  ) {
    throw new Error("Participant pseudonym is invalid.");
  }

  const key = await loadDerivationKey();
  const subject = `${provider}:${providerSubject}`;
  const idBytes = createHmac("sha256", key)
    .update("MOSS_PHASE2_PARTICIPANT_ID_V1\0", "utf8")
    .update(subject, "utf8")
    .digest()
    .subarray(0, 16);
  idBytes[6] = (idBytes[6]! & 0x0f) | 0x80;
  idBytes[8] = (idBytes[8]! & 0x3f) | 0x80;
  const hex = idBytes.toString("hex");
  const participantId =
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
  const authSubjectHash = createHmac("sha256", key)
    .update("MOSS_PHASE2_AUTH_SUBJECT_V1\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");

  return {
    participantId,
    participantName: pseudonym,
    authSubjectHash,
  };
}

/** Issue the coordinator's strict EdDSA JWT for a browser or CLI client. */
export async function signParticipantToken(
  participant: Participant,
  kind: "browser" | "cli",
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp =
    now +
    (kind === "cli" ? CLI_TOKEN_EXPIRY_SECONDS : BROWSER_TOKEN_EXPIRY_SECONDS);
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: requiredServerEnv("PARTICIPANT_JWT_ISSUER"),
      aud: requiredServerEnv("PARTICIPANT_JWT_AUDIENCE"),
      sub: participant.participantId,
      name: participant.participantName,
      ash: participant.authSubjectHash,
      iat: now,
      nbf: now - 5,
      exp,
    }),
  ).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(`${header}.${payload}`, "ascii"),
    await loadSigningKey(),
  ).toString("base64url");
  return { token: `${header}.${payload}.${signature}`, expiresAt: exp };
}

async function loadSigningKey(): Promise<KeyObject> {
  signingKeyPromise ??= readServerMaterial("PARTICIPANT_JWT_PRIVATE_KEY", true).then((pem) => createPrivateKey(pem));
  return await signingKeyPromise;
}

async function loadDerivationKey(): Promise<Buffer> {
  derivationKeyPromise ??= readServerMaterial("PARTICIPANT_ID_DERIVATION_KEY", true).then((encoded) => {
    const trimmed = encoded.trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(trimmed)) {
      throw new Error(
        "Participant derivation key must be 32-byte canonical base64url.",
      );
    }
    const bytes = Buffer.from(trimmed, "base64url");
    if (bytes.byteLength !== 32 || bytes.toString("base64url") !== trimmed) {
      throw new Error("Participant derivation key encoding is invalid.");
    }
    return bytes;
  });
  return await derivationKeyPromise;
}
