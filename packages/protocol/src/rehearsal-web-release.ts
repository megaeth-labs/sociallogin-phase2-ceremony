import type { KeyLike } from "node:crypto";
import { canonicalSha256 } from "./jcs.js";
import { verifyEnvelope } from "./signing.js";
import { assertIsoDate, assertRelease } from "./validation.js";
import type { CeremonyManifestV1, JsonValue, ReleaseRef, SignedEnvelope } from "./types.js";

export const REHEARSAL_WEB_RELEASE_DOMAIN = "MOSS_PHASE2_REHEARSAL_WEB_RELEASE_V1";
export interface RehearsalWebReleaseAuthorization {
  schemaVersion: 1;
  type: "moss.phase2.rehearsal-web-release.v1";
  ceremonyId: string;
  manifestSha256: string;
  originalWebReleaseSha256: string;
  authorizedAt: string;
  release: ReleaseRef;
}

/** Add one reviewed browser release without changing the original ceremony hash.
 * This deliberately does not introduce a production manifest amendment policy.
 * The original browser release remains authorized for in-flight participants.
 */
export function verifyRehearsalWebRelease(
  envelope: SignedEnvelope<RehearsalWebReleaseAuthorization>,
  manifestEnvelope: SignedEnvelope<CeremonyManifestV1>,
  rootPublicKey: KeyLike,
): RehearsalWebReleaseAuthorization {
  const manifest = manifestEnvelope.payload;
  if (manifest.purpose !== "rehearsal") throw new Error("web release authorization is rehearsal-only");
  if (envelope.keyId !== manifestEnvelope.keyId) throw new Error("web release root key id differs from manifest");
  const value = verifyEnvelope(envelope as unknown as SignedEnvelope<JsonValue>, {
    publicKey: rootPublicKey, domain: REHEARSAL_WEB_RELEASE_DOMAIN,
  }) as unknown as RehearsalWebReleaseAuthorization;
  const expected = ["schemaVersion", "type", "ceremonyId", "manifestSha256", "originalWebReleaseSha256", "authorizedAt", "release"].sort();
  if (!value || typeof value !== "object" || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)
    || value.schemaVersion !== 1 || value.type !== "moss.phase2.rehearsal-web-release.v1") {
    throw new Error("invalid web release authorization");
  }
  if (value.ceremonyId !== manifest.ceremonyId
    || value.manifestSha256 !== canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest as unknown as JsonValue)
    || value.originalWebReleaseSha256 !== manifest.webRelease.sha256) {
    throw new Error("web release authorization is bound to a different ceremony manifest");
  }
  assertIsoDate(value.authorizedAt, "authorizedAt");
  assertRelease(value.release, "authorized web release", { production: true });
  if (value.release.sha256 === manifest.webRelease.sha256) throw new Error("additional web release must differ from original");
  return value;
}
