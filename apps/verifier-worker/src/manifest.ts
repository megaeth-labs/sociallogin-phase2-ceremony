import { createPublicKey, type KeyLike } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  MANIFEST_SIGNATURE_DOMAIN,
  assertManifest,
  verifyEnvelope,
  type CeremonyManifestV1,
  type JsonValue,
  type SignedEnvelope,
} from "@moss/phase2-protocol";

export async function loadVerifiedManifest(options: {
  envelopePath: string;
  rootPublicKeyPath: string;
  production: boolean;
  allowRehearsal?: boolean;
}): Promise<{ envelope: SignedEnvelope<CeremonyManifestV1>; manifest: CeremonyManifestV1 }> {
  const [envelopeText, rootPublicKey] = await Promise.all([
    readFile(options.envelopePath, "utf8"),
    readFile(options.rootPublicKeyPath, "utf8"),
  ]);
  const envelope = JSON.parse(envelopeText) as SignedEnvelope<JsonValue>;
  const manifest = verifyEnvelope(envelope, {
    publicKey: rootPublicKey,
    domain: MANIFEST_SIGNATURE_DOMAIN,
  }) as unknown as CeremonyManifestV1;
  assertManifest(manifest, { production: options.production, allowRehearsal: options.allowRehearsal });
  return { envelope: envelope as unknown as SignedEnvelope<CeremonyManifestV1>, manifest };
}

export function assertOperatorKey(
  manifest: CeremonyManifestV1,
  operatorKeyId: string,
  privateKey: KeyLike,
  verifierImageDigest?: string,
): void {
  if (!manifest.verifierPolicy.operatorKeyIds.includes(operatorKeyId)) {
    throw new Error("operator key is not authorized by the manifest verifier policy");
  }
  const key = manifest.verifierKeys.find((candidate) => candidate.keyId === operatorKeyId);
  if (!key) throw new Error("operator public key is missing from the manifest");
  if (verifierImageDigest !== undefined && key.verifierImageDigest !== verifierImageDigest) {
    throw new Error("verifier image digest does not match the signed manifest");
  }
  const expected = createPublicKey(key.publicKeyPem).export({ type: "spki", format: "der" });
  const actual = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (!Buffer.from(expected).equals(Buffer.from(actual))) throw new Error("operator private key does not match the manifest");
}
