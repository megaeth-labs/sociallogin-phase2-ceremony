import { createPublicKey, KeyObject, sign, verify, type KeyLike } from "node:crypto";

import { canonicalize } from "./jcs.js";
import type { JsonValue, SignedEnvelope } from "./types.js";
import { assertSafeId } from "./validation.js";

function signingBytes(domain: string, payload: JsonValue): Buffer {
  if (domain.length === 0 || domain.includes("\0")) throw new Error("signature domain is invalid");
  return Buffer.concat([Buffer.from(domain, "utf8"), Buffer.from([0]), Buffer.from(canonicalize(payload), "utf8")]);
}

export function signEnvelope<T extends JsonValue>(
  payload: T,
  options: { keyId: string; privateKey: KeyLike; domain: string },
): SignedEnvelope<T> {
  assertSafeId(options.keyId, "keyId");
  if (asymmetricKeyType(options.privateKey) !== "ed25519") throw new Error("envelope signing key must be Ed25519");
  const signature = sign(null, signingBytes(options.domain, payload), options.privateKey).toString("base64url");
  return { schemaVersion: 1, keyId: options.keyId, payload, signature };
}

export function verifyEnvelope<T extends JsonValue>(
  envelope: SignedEnvelope<T>,
  options: { publicKey: KeyLike; domain: string },
): T {
  if (envelope.schemaVersion !== 1) throw new Error("signed envelope schemaVersion is unsupported");
  assertSafeId(envelope.keyId, "keyId");
  if (asymmetricKeyType(options.publicKey) !== "ed25519") throw new Error("envelope verification key must be Ed25519");
  if (!/^[A-Za-z0-9_-]{86}$/u.test(envelope.signature)) throw new Error("signed envelope signature is malformed");
  const decodedSignature = Buffer.from(envelope.signature, "base64url");
  if (decodedSignature.byteLength !== 64 || decodedSignature.toString("base64url") !== envelope.signature) {
    throw new Error("signed envelope signature is not canonical Ed25519 encoding");
  }
  const valid = verify(
    null,
    signingBytes(options.domain, envelope.payload),
    options.publicKey,
    decodedSignature,
  );
  if (!valid) throw new Error("signed envelope signature is invalid");
  return envelope.payload;
}

export const CHECKPOINT_SIGNATURE_DOMAIN = "MOSS_PHASE2_CHECKPOINT_V1";
export const RECEIPT_SIGNATURE_DOMAIN = "MOSS_PHASE2_RECEIPT_V1";
export const VERIFICATION_REPORT_SIGNATURE_DOMAIN = "MOSS_PHASE2_VERIFICATION_REPORT_V1";
export const MANIFEST_SIGNATURE_DOMAIN = "MOSS_PHASE2_MANIFEST_V1";
export const TRANSCRIPT_EVENT_SIGNATURE_DOMAIN = "MOSS_PHASE2_TRANSCRIPT_EVENT_V1";

function asymmetricKeyType(key: KeyLike): string | undefined {
  if (key instanceof KeyObject) return key.asymmetricKeyType;
  return createPublicKey(key).asymmetricKeyType;
}
