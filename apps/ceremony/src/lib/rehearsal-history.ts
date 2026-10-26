import type { CeremonyManifestV1, SignedEnvelope } from "@moss/phase2-protocol";
import { historyPageOf, verifyPublicReceipt, type ContributionHistoryPage, type VerifiedPublicReceipt } from "./api";
import { buildVerificationGuide } from "./verification-guide";
import completionRecord from "./rehearsal-finalization.json";
import snapshot from "./rehearsal-history.json";

/**
 * The October 2026 company rehearsal's accepted contributions, captured from
 * its public coordinator after it sealed, so the walkthrough shows real
 * records without a backend. Checked as the live history is: every receipt
 * signature against the rehearsal manifest, an unbroken chain from the pinned
 * genesis, ending at the head its completion record sealed.
 */
export async function getRehearsalHistory(): Promise<VerifiedPublicReceipt[]> {
  const manifest = (snapshot.manifest as unknown as SignedEnvelope<CeremonyManifestV1>).payload;
  const result: VerifiedPublicReceipt[] = [];
  let predecessor: { sha256: string; byteLength: number } = manifest.relation.genesisBellman ?? manifest.relation.genesisZkey;
  for (const item of snapshot.receipts) {
    const verified = await verifyPublicReceipt(item, manifest);
    const { receipt } = verified;
    if (receipt.generation !== result.length + 1 ||
        receipt.predecessor.sha256 !== predecessor.sha256 ||
        receipt.predecessor.byteLength !== predecessor.byteLength) {
      throw new Error("Rehearsal history contains a gap or a broken artifact chain.");
    }
    result.push({ ...verified, artifactDownloadUrl: receipt.successor.urls[0] });
    predecessor = receipt.successor;
  }
  const sealed = completionRecord.payload;
  if (predecessor.sha256 !== sealed.sealedHeadSha256 || predecessor.byteLength !== sealed.sealedHeadByteLength) {
    throw new Error("Rehearsal history does not reach the sealed head.");
  }
  return result.reverse();
}

/** One page of the rehearsal history, shaped like the live coordinator's. */
export async function getRehearsalHistoryPage(page: number): Promise<ContributionHistoryPage> {
  return historyPageOf(await getRehearsalHistory(), page);
}

/** The verify page's materials for the same rehearsal, from its manifest and pinned source commit. */
export async function getRehearsalVerificationGuide() {
  const manifest = snapshot.manifest as unknown as SignedEnvelope<CeremonyManifestV1>;
  return await buildVerificationGuide({
    manifest,
    coordinatorBaseUrl: new URL(snapshot.source).origin,
    sourceCommit: manifest.payload.webRelease.sourceCommit,
  });
}
