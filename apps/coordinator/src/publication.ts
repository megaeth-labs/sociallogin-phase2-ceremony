import { createHash } from "node:crypto";
import { canonicalize, verifyPublicationAck, verifyPrimaryPublication, type CeremonyManifestV1,
  type JsonValue, type PrimaryPublication, type PublicationAck, type SignedEnvelope } from "@moss/phase2-protocol";

export interface PublicationTarget {
  publishBytes(key: string, bytes: Buffer): Promise<{ versionId: string; sha256: string }>;
}
/** An independently operated witness must mirror the evidence before signing. */
export async function publishAndWitness(input: {
  manifest: CeremonyManifestV1;
  bundle: JsonValue;
  eventSequence: number;
  eventHash: string;
  archive: PublicationTarget;
  fetcher?: typeof fetch;
  signPrimary?: (record: PrimaryPublication) => SignedEnvelope<PrimaryPublication>;
}): Promise<{ sha256: string; acknowledgement: SignedEnvelope<PublicationAck> | SignedEnvelope<PrimaryPublication> }> {
  const publication = input.manifest.publication;
  if (!publication && !input.manifest.primaryPublication) throw new Error("signed publication policy is required");
  if (input.manifest.primaryPublication && (publication || !input.signPrimary)) throw new Error("primary publication not authorized");
  const bytes = Buffer.from(canonicalize(input.bundle));
  if (bytes.length > 4 * 1024 * 1024) throw new Error("publication bundle exceeds size limit");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const archived = await input.archive.publishBytes(
    `evidence/${input.manifest.ceremonyId}/${input.eventSequence}/${sha256}.json`, bytes,
  );
  if (archived.sha256 !== sha256 || !archived.versionId || archived.versionId === "null") {
    throw new Error("published evidence does not match the immutable archive pin");
  }
  if (input.manifest.primaryPublication) {
    if (publication || !input.signPrimary) throw new Error("primary publication not authorized");
    const url = new URL(`evidence/${input.manifest.ceremonyId}/${input.eventSequence}/${sha256}.json`, input.manifest.primaryPublication.archiveBaseUrl);
    url.searchParams.set("versionId", archived.versionId);
    const acknowledgement = input.signPrimary({ type: "moss.phase2.primary-publication.v1",
      ceremonyId: input.manifest.ceremonyId, eventSequence: input.eventSequence, eventHash: input.eventHash,
      bundleSha256: sha256, archive: { url: url.toString(), versionId: archived.versionId, sha256 } });
    verifyPrimaryPublication(acknowledgement, input.manifest, { ceremonyId: input.manifest.ceremonyId,
      eventSequence: input.eventSequence, eventHash: input.eventHash, bundleSha256: sha256 });
    // Retain the signed checkpoint itself, not just the bundle it references.
    const checkpoint = Buffer.from(canonicalize(acknowledgement as unknown as JsonValue));
    const checkpointHash = createHash("sha256").update(checkpoint).digest("hex");
    const stored = await input.archive.publishBytes(`evidence/${input.manifest.ceremonyId}/${input.eventSequence}/checkpoint-${sha256}.json`, checkpoint);
    if (stored.sha256 !== checkpointHash || !stored.versionId || stored.versionId === "null") throw new Error("checkpoint archive pin invalid");
    return { sha256, acknowledgement };
  }
  if (!publication) throw new Error("publication policy missing");
  const response = await (input.fetcher ?? fetch)(publication.endpoint, {
    method: "POST", headers: { "content-type": "application/json" }, body: bytes,
    redirect: "error", signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error("independent witness has not acknowledged publication");
  const body = response.body;
  if (!body) throw new Error("empty witness response");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > 65536) throw new Error("witness acknowledgement exceeds size limit");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const acknowledgement = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SignedEnvelope<PublicationAck>;
  verifyPublicationAck(acknowledgement, publication.witness, {
    ceremonyId: input.manifest.ceremonyId, eventSequence: input.eventSequence, eventHash: input.eventHash, bundleSha256: sha256,
  });
  return { sha256, acknowledgement };
}
