import type { KeyLike } from "node:crypto";
import { canonicalSha256 } from "./jcs.js";
import { verifyEnvelope } from "./signing.js";
import { assertFinalizationRecord, FINALIZATION_RECORD_DOMAIN, type FinalizationRecordContext, type FinalizationRecordV1 } from "./finalization-record.js";
import type { CeremonyManifestV1, JsonValue, SignedEnvelope } from "./types.js";

/** Verify the root signature, then bind the record to the manifest and sealed checkpoint. */
export function verifyFinalizationRecord(
  envelope: SignedEnvelope<FinalizationRecordV1>,
  manifest: SignedEnvelope<CeremonyManifestV1>,
  rootPublicKey: KeyLike,
  checkpoint: FinalizationRecordContext["checkpoint"],
): FinalizationRecordV1 {
  if (!envelope || typeof envelope !== "object" ||
      JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(["keyId", "payload", "schemaVersion", "signature"]))
    throw new Error("finalization record: invalid envelope");
  if (envelope.keyId !== manifest.keyId) throw new Error("finalization record: signed by a key other than the manifest root");
  const payload = verifyEnvelope(envelope as unknown as SignedEnvelope<JsonValue>, {
    publicKey: rootPublicKey, domain: FINALIZATION_RECORD_DOMAIN,
  });
  return assertFinalizationRecord(payload, {
    manifest: manifest.payload,
    manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest.payload as unknown as JsonValue),
    checkpoint,
  });
}
