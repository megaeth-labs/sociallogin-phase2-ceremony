import type {
  CeremonyManifestV1,
  ContributionReceiptV1,
  HeadCheckpointV1,
  SignedEnvelope,
} from "@moss/phase2-protocol";
import archive from "../../public/ceremony-archive.json";

/** Where the site serves the archive, for the browser and for anyone checking it. */
export const CEREMONY_ARCHIVE_PATH = "/ceremony-archive.json";

/**
 * A sealed ceremony's public records, captured from its coordinator before the
 * coordinator was retired (infra/capture-ceremony-archive.mjs). Every record
 * in it is signed, and every signature is checked before anything is shown.
 */
export interface CeremonyArchive {
  schemaVersion: 1;
  type: "moss.phase2.ceremony-archive.v1";
  slug: string;
  ceremonyId: string;
  capturedAt: string;
  /** The retired coordinator, for the record only. Nothing requests it. */
  coordinator: string;
  /** The root-signed operational updates, latest version, in the archive bucket. */
  operationalUpdatesUrl: string;
  manifest: SignedEnvelope<CeremonyManifestV1>;
  checkpoint: SignedEnvelope<HeadCheckpointV1>;
  receipts: SignedEnvelope<ContributionReceiptV1>[];
}

/**
 * The archive of the ceremony this deployment serves, or null while that
 * ceremony still has a live coordinator. Server-only: the browser fetches the
 * receipts from CEREMONY_ARCHIVE_PATH when it needs them.
 */
export function ceremonyArchive(
  slug = process.env.CEREMONY_SLUG?.trim(),
  value: unknown = archive,
): CeremonyArchive | null {
  const candidate = value as Partial<CeremonyArchive> | null;
  if (!slug || candidate?.type !== "moss.phase2.ceremony-archive.v1" || candidate.slug !== slug) return null;
  if (candidate.schemaVersion !== 1 || !candidate.manifest || !candidate.checkpoint ||
      !Array.isArray(candidate.receipts) || typeof candidate.operationalUpdatesUrl !== "string" ||
      candidate.manifest.payload?.slug !== slug || candidate.manifest.payload.ceremonyId !== candidate.ceremonyId) {
    throw new Error("The ceremony archive is malformed.");
  }
  const url = new URL(candidate.operationalUpdatesUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("The ceremony archive's update list URL is not a plain HTTPS URL.");
  }
  return candidate as CeremonyArchive;
}
