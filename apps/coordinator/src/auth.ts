import { createPublicKey, KeyObject, timingSafeEqual, verify, type KeyLike } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ParticipantPrincipal {
  participantId: string;
  pseudonym: string;
  authSubjectHash: string;
}

export interface InternalVerifierPrincipal {
  operatorKeyId: string;
}

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}

export interface Authenticator {
  authenticate(request: RequestLike): Promise<ParticipantPrincipal>;
}

export class EdDsaJwtAuthenticator implements Authenticator {
  constructor(private readonly config: {
    publicKey: KeyLike;
    issuer: string;
    audience: string;
    clockToleranceSeconds?: number;
  }) {
    const key = config.publicKey instanceof KeyObject ? config.publicKey : createPublicKey(config.publicKey);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("participant JWT key must be Ed25519");
    if (!config.issuer || !config.audience) throw new Error("participant JWT issuer and audience must be nonempty");
  }

  async authenticate(request: RequestLike): Promise<ParticipantPrincipal> {
    const authorization = singleHeader(request.headers.authorization);
    if (!authorization?.startsWith("Bearer ")) throw new Error("participant bearer token is required");
    return verifyParticipantToken(authorization.slice(7), this.config);
  }
}

export function verifyParticipantToken(token: string, config: {
  publicKey: KeyLike; issuer: string; audience: string; clockToleranceSeconds?: number;
}): ParticipantPrincipal {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) throw new Error("participant token is malformed");
  const header = decodeCanonicalJson(parts[0]) as { alg?: unknown; typ?: unknown };
  if (header.alg !== "EdDSA" || header.typ !== "JWT") throw new Error("participant token algorithm or type is unsupported");
  const signature = Buffer.from(parts[2], "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== parts[2]) throw new Error("participant token signature is noncanonical");
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), config.publicKey, signature)) {
    throw new Error("participant token signature is invalid");
  }
  const claims = decodeCanonicalJson(parts[1]) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1_000);
  const tolerance = config.clockToleranceSeconds ?? 5;
  if (claims.iss !== config.issuer || !audienceIncludes(claims.aud, config.audience)) throw new Error("participant token issuer or audience is invalid");
  if (!Number.isSafeInteger(claims.exp) || Number(claims.exp) < now - tolerance) throw new Error("participant token is expired");
  if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || Number(claims.nbf) > now + tolerance)) throw new Error("participant token is not active");
  if (typeof claims.sub !== "string" || !UUID.test(claims.sub)) throw new Error("participant token subject is invalid");
  if (typeof claims.name !== "string" || claims.name.length < 1 || claims.name.length > 128 || /[\u0000-\u001f\u007f]/u.test(claims.name)) {
    throw new Error("participant token pseudonym is invalid");
  }
  if (typeof claims.ash !== "string" || !SHA256.test(claims.ash)) throw new Error("participant token auth-subject hash is invalid");
  return { participantId: claims.sub, pseudonym: claims.name, authSubjectHash: claims.ash };
}

export function fixedBearerAuthenticator(expectedToken: string): (request: RequestLike) => void {
  if (expectedToken.length < 32) throw new Error("internal verifier bearer token is too short");
  return (request) => {
    const actual = singleHeader(request.headers.authorization);
    const expected = `Bearer ${expectedToken}`;
    if (actual === undefined || Buffer.byteLength(actual) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
      throw new Error("internal verifier authentication failed");
    }
  };
}

export function verifierBearerAuthenticator(
  tokens: ReadonlyMap<string, string>,
): (request: RequestLike) => InternalVerifierPrincipal {
  if (tokens.size === 0) throw new Error("internal verifier token map is empty");
  const expected = [...tokens].map(([operatorKeyId, token]) => {
    if (token.length < 32) {
      throw new Error(`internal verifier bearer token for ${operatorKeyId} is too short`);
    }
    return {
      operatorKeyId,
      authorization: Buffer.from(`Bearer ${token}`),
    };
  });
  if (new Set(expected.map(({ authorization }) => authorization.toString("base64"))).size !== expected.length) {
    throw new Error("internal verifier bearer tokens must be unique per operator");
  }
  return (request) => {
    const actualValue = singleHeader(request.headers.authorization);
    if (actualValue !== undefined) {
      const actual = Buffer.from(actualValue);
      for (const candidate of expected) {
        if (actual.byteLength === candidate.authorization.byteLength
          && timingSafeEqual(actual, candidate.authorization)) {
          return { operatorKeyId: candidate.operatorKeyId };
        }
      }
    }
    throw new Error("internal verifier authentication failed");
  };
}

function decodeCanonicalJson(value: string): unknown {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("participant token uses noncanonical base64url");
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("participant token JSON is invalid"); }
}

function audienceIncludes(value: unknown, expected: string): boolean {
  return value === expected || Array.isArray(value) && value.includes(expected);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.length === 1 ? value[0] : undefined : value;
}
