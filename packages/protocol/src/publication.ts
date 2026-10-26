import { verifyEnvelope } from "./signing.js";
import type { CeremonyManifestV1, JsonValue, PublicKeyRef, SignedEnvelope } from "./types.js";

export const PUBLICATION_ACK_DOMAIN = "MOSS_PHASE2_PUBLICATION_ACK_V1";
export interface PublicationAck {
  type: "moss.phase2.publication-ack.v1";
  ceremonyId: string;
  eventSequence: number;
  eventHash: string;
  bundleSha256: string;
  mirror: { url: string; versionId: string; sha256: string };
  witnessedAt: string;
}
export function verifyPublicationAck(envelope: SignedEnvelope<PublicationAck>, key: PublicKeyRef,
  expected: { ceremonyId: string; eventSequence: number; eventHash: string; bundleSha256?: string }): PublicationAck {
  if (envelope.keyId !== key.keyId) throw new Error("publication acknowledgement signer is not the pinned witness");
  const ack = verifyEnvelope(envelope as unknown as SignedEnvelope<JsonValue>, {
    publicKey: key.publicKeyPem, domain: PUBLICATION_ACK_DOMAIN,
  }) as unknown as PublicationAck;
  if (ack.type !== "moss.phase2.publication-ack.v1" || ack.ceremonyId !== expected.ceremonyId
    || ack.eventSequence !== expected.eventSequence || ack.eventHash !== expected.eventHash
    || !/^[a-f0-9]{64}$/u.test(ack.bundleSha256)
    || (expected.bundleSha256 !== undefined && ack.bundleSha256 !== expected.bundleSha256)
    || ack.mirror?.sha256 !== ack.bundleSha256 || !ack.mirror.versionId || ack.mirror.versionId === "null") {
    throw new Error("publication acknowledgement does not bind the expected head and evidence");
  }
  const url = new URL(ack.mirror.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("witness mirror URL must use HTTPS");
  if (url.searchParams.get("versionId") !== ack.mirror.versionId) throw new Error("witness mirror URL must pin the acknowledged version");
  const date = new Date(ack.witnessedAt);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== ack.witnessedAt || date.valueOf() > Date.now() + 300000) {
    throw new Error("witness timestamp is invalid");
  }
  return ack;
}

export const PRIMARY_PUBLICATION_DOMAIN = "MOSS_PHASE2_PRIMARY_PUBLICATION_V1";
export interface PrimaryPublication {
  type: "moss.phase2.primary-publication.v1";
  ceremonyId: string;
  eventSequence: number;
  eventHash: string;
  bundleSha256: string;
  archive: { url: string; versionId: string; sha256: string };
}
export function verifyPrimaryPublication(envelope: SignedEnvelope<PrimaryPublication>, manifest: CeremonyManifestV1,
  expected: { ceremonyId: string; eventSequence: number; eventHash: string; bundleSha256?: string }): PrimaryPublication {
  if (!manifest.primaryPublication || manifest.publication) throw new Error("primary publication policy not authorized");
  const key = manifest.coordinatorKeys.find(k => k.keyId === envelope.keyId);
  if (!key) throw new Error("primary publication signer is not authorized");
  const record = verifyEnvelope(envelope as unknown as SignedEnvelope<JsonValue>, {
    publicKey: key.publicKeyPem, domain: PRIMARY_PUBLICATION_DOMAIN,
  }) as unknown as PrimaryPublication;
  if (record.type !== "moss.phase2.primary-publication.v1" || record.ceremonyId !== expected.ceremonyId
    || record.eventSequence !== expected.eventSequence || record.eventHash !== expected.eventHash
    || !/^[a-f0-9]{64}$/.test(record.bundleSha256)
    || (expected.bundleSha256 !== undefined && record.bundleSha256 !== expected.bundleSha256)
    || record.archive?.sha256 !== record.bundleSha256 || !record.archive.versionId || record.archive.versionId === "null") throw new Error("primary publication does not bind expected evidence");
  const url = new URL(record.archive.url);
  const path = `/evidence/${expected.ceremonyId}/${expected.eventSequence}/${record.bundleSha256}.json`;
  if (url.origin !== new URL(manifest.primaryPublication.archiveBaseUrl).origin || url.pathname !== path
    || url.username || url.password || url.hash || url.searchParams.get("versionId") !== record.archive.versionId
    || [...url.searchParams.keys()].length !== 1) throw new Error("primary archive URL is not the pinned object version");
  return record;
}
