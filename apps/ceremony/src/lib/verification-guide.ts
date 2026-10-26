import type { CeremonyManifestV1, SignedEnvelope } from "@moss/phase2-protocol";
import { buildReceiptVerificationCommand, isLocalCoordinator } from "./cli-instructions";

export interface SigningKey {
  keyId: string;
  publicKeyPem: string;
  /** SHA-256 of the SPKI DER, as `openssl pkey -pubin -outform DER | openssl dgst -sha256` prints it. */
  spkiSha256: string;
}

async function spkiSha256(pem: string): Promise<string> {
  const body = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * What the verify page shows. The manifest stays internal: the page publishes
 * the coordinator signing keys that sign receipts, the ceremony ID receipts
 * carry, and the genesis pin, which are what a receipt and artifact check need.
 */
export async function buildVerificationGuide(input: {
  manifest: SignedEnvelope<CeremonyManifestV1>;
  coordinatorBaseUrl: string;
  sourceCommit: string;
}) {
  const payload = input.manifest.payload;
  const genesis = payload.relation.genesisBellman ?? payload.relation.genesisZkey;
  return {
    local: isLocalCoordinator(input.coordinatorBaseUrl),
    sourceCommit: input.sourceCommit,
    manifest: input.manifest,
    ceremonyId: payload.ceremonyId,
    signingKeys: await Promise.all(payload.coordinatorKeys.map(async (key): Promise<SigningKey> => ({
      keyId: key.keyId,
      publicKeyPem: key.publicKeyPem,
      spkiSha256: await spkiSha256(key.publicKeyPem),
    }))),
    genesis: { sha256: genesis.sha256, byteLength: genesis.byteLength },
    command: buildReceiptVerificationCommand({ ceremonyId: payload.ceremonyId }),
  };
}

export type VerificationGuide = Awaited<ReturnType<typeof buildVerificationGuide>>;
