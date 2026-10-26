import type { CeremonyManifestV1, HeadCheckpointV1, SignedEnvelope } from "@moss/phase2-protocol";
import { assertFinalizationRecord, FINALIZATION_RECORD_DOMAIN, type FinalizationRecordV1 } from "@moss/phase2-protocol/finalization-record";
import record from "@/lib/rehearsal-finalization.json";
// The production completion record. `null` until the ceremony is finalized;
// it ships in a root-authorized web release (RUNBOOK §9).
import productionRecord from "@/lib/ceremony-finalization.json";

export const FINALIZATION_DOMAIN = "MOSS_PHASE2_REHEARSAL_FINALIZATION_V1";
export type RehearsalFinalization = typeof record.payload;
export type FinalArtifact = RehearsalFinalization["artifacts"]["finalZkey"];
export type ProductionFinalization = FinalizationRecordV1;
export type CeremonyFinalization = RehearsalFinalization | ProductionFinalization;
export const PRODUCTION_FINALIZATION_DOMAIN = FINALIZATION_RECORD_DOMAIN;
/** Where the site serves the signed production record for independent download. */
export const PRODUCTION_FINALIZATION_DOWNLOAD = "/finalization.signed.json";

export function isRehearsalFinalization(result: CeremonyFinalization): result is RehearsalFinalization {
  return result.type === "moss.phase2.rehearsal-finalization.v1";
}

/** The terminal beacon as the page names it. */
export function finalBeacon(result: CeremonyFinalization): { label: string; unit: string; value: number } {
  const beacon = result.beacon;
  return "round" in beacon
    ? { label: "drand beacon", unit: "Round", value: beacon.round }
    : { label: "Ethereum beacon", unit: "Block", value: beacon.blockNumber };
}

/** The root-signed production record, bound to the live sealed checkpoint. */
export async function verifiedProductionFinalization(
  manifest: SignedEnvelope<CeremonyManifestV1>,
  checkpoint: HeadCheckpointV1,
  manifestSha256: string,
  verify: (envelope: SignedEnvelope<ProductionFinalization>) => Promise<unknown>,
  envelope = productionRecord as unknown as SignedEnvelope<ProductionFinalization> | null,
): Promise<ProductionFinalization | undefined> {
  if (!envelope || manifest.payload.ceremonyId !== envelope.payload?.ceremonyId) return undefined;
  if (manifest.payload.purpose === "rehearsal" || envelope.keyId !== manifest.keyId)
    throw Error("Finalization record is not authorized for this ceremony.");
  const result = await verify(envelope);
  try {
    return assertFinalizationRecord(result, { manifest: manifest.payload, manifestSha256, checkpoint });
  } catch {
    throw Error("Finalization record does not match the sealed ceremony.");
  }
}

/** Each record kind is accepted only for its own kind of manifest. */
export async function verifiedFinalization(
  manifest: SignedEnvelope<CeremonyManifestV1>,
  checkpoint: HeadCheckpointV1,
  manifestSha256: string,
  verify: (envelope: SignedEnvelope<unknown>, domain: string) => Promise<unknown>,
): Promise<CeremonyFinalization | undefined> {
  return manifest.payload.purpose === "rehearsal"
    ? verifiedRehearsalFinalization(manifest, checkpoint, manifestSha256,
        async (envelope) => (await verify(envelope, FINALIZATION_DOMAIN)) as RehearsalFinalization)
    : verifiedProductionFinalization(manifest, checkpoint, manifestSha256, (envelope) => verify(envelope, PRODUCTION_FINALIZATION_DOMAIN));
}

/** Operator attestation for this completed rehearsal, not a replacement checkpoint. */
export async function verifiedRehearsalFinalization(
  manifest: SignedEnvelope<CeremonyManifestV1>,
  checkpoint: HeadCheckpointV1,
  manifestSha256: string,
  verify: (envelope: SignedEnvelope<RehearsalFinalization>) => Promise<RehearsalFinalization>,
  envelope: SignedEnvelope<RehearsalFinalization> = record as SignedEnvelope<RehearsalFinalization>,
): Promise<RehearsalFinalization | undefined> {
  if (manifest.payload.ceremonyId !== envelope.payload.ceremonyId) return undefined;
  if (manifest.payload.purpose !== "rehearsal" || envelope.keyId !== manifest.keyId)
    throw Error("Finalization record is not authorized for this rehearsal.");
  const result = await verify(envelope);
  const beacon = manifest.payload.beacon;
  if (result.schemaVersion !== 1 || result.type !== "moss.phase2.rehearsal-finalization.v1" ||
      result.manifestSha256 !== manifestSha256 || checkpoint.ceremonyId !== result.ceremonyId ||
      !["SEALED", "FINALIZED"].includes(checkpoint.state) ||
      result.sealedHeadSha256 !== checkpoint.headSha256 || result.sealedHeadByteLength !== checkpoint.headByteLength ||
      result.sealedEventHash !== checkpoint.eventHash || result.sealedEventSequence !== checkpoint.eventSequence ||
      result.ordinaryContributions !== checkpoint.generation || result.ordinaryContributions < 1 ||
      result.beaconContributions !== 1 || beacon.source !== "ethereum-block" ||
      result.beacon.blockNumber !== beacon.blockNumber || result.beacon.numIterationsExp !== beacon.numIterationsExp ||
      !/^[a-f0-9]{64}$/.test(result.beacon.blockHash) || result.publicInputs !== 20 ||
      !Number.isFinite(Date.parse(result.completedAt)) || Date.parse(result.completedAt) < Date.parse(manifest.payload.schedule.sealsAt))
    throw Error("Finalization record does not match the sealed ceremony.");
  for (const artifact of Object.values(result.artifacts)) {
    const url = new URL(artifact.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength <= 0 ||
        !artifact.versionId || url.searchParams.get("versionId") !== artifact.versionId ||
        !url.pathname.includes(`/sha256/${artifact.sha256}/`))
      throw Error("Finalization download is not immutable and hash-pinned.");
  }
  return result;
}
