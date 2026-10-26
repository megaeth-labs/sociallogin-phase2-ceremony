import { readFile } from "node:fs/promises";

import {
  MANIFEST_SIGNATURE_DOMAIN,
  assertManifest,
  verifyEnvelope,
  type CeremonyManifestV1,
  type SignedEnvelope,
} from "@moss/phase2-protocol";

export async function loadSignedManifest(input: {
  envelopePath: string;
  rootPublicKeyPath: string;
  production: boolean;
  allowRehearsal?: boolean;
}): Promise<SignedEnvelope<CeremonyManifestV1>> {
  const [rawEnvelope, publicKey] = await Promise.all([
    readFile(input.envelopePath, "utf8"),
    readFile(input.rootPublicKeyPath, "utf8"),
  ]);
  let envelope: SignedEnvelope<CeremonyManifestV1>;
  try { envelope = JSON.parse(rawEnvelope) as SignedEnvelope<CeremonyManifestV1>; }
  catch { throw new Error("ceremony manifest envelope is not valid JSON"); }
  const payload = verifyEnvelope(envelope as never, {
    publicKey,
    domain: MANIFEST_SIGNATURE_DOMAIN,
  }) as unknown as CeremonyManifestV1;
  assertManifest(payload, { production: input.production, allowRehearsal: input.allowRehearsal });
  return envelope;
}
