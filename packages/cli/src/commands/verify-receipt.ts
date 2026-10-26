import { readFile, stat } from "node:fs/promises";
import { createPublicKey, type KeyObject } from "node:crypto";
import { contributionGenesis, assertReceipt, RECEIPT_SIGNATURE_DOMAIN, verifyEnvelope, type CeremonyManifestV1, type ContributionReceiptV1, type JsonValue, type SignedEnvelope } from "@moss/phase2-protocol";
import { readManifestRootPublicKey, verifyManifest } from "../trust.js";
import type { ManifestEnvelope } from "../types.js";

export async function readReceiptJson(path: string): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 1_048_576) throw new Error("JSON input must be a regular file of at most 1 MB.");
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > 1_048_576) throw new Error("JSON input exceeds 1 MB.");
  try { return JSON.parse(text); } catch { throw new Error("Input is not valid JSON."); }
}

/**
 * What a receipt is checked against. With the manifest, everything it pins;
 * with only the ceremony signing key, the signature, ceremony ID and the
 * receipt's own consistency.
 */
interface ReceiptTrust {
  publicKeyFor(keyId: string): KeyObject;
  ceremonyId: string;
  manifestSha256?: string;
  maximumContributions?: number;
  genesis?: { sha256: string; byteLength: number };
}

export function verifyReceiptFileContents(input: unknown, manifest: CeremonyManifestV1, manifestSha256: string): ContributionReceiptV1[] {
  return checkReceipts(input, {
    publicKeyFor(keyId) {
      const keys = manifest.coordinatorKeys.filter((key) => key.keyId === keyId);
      if (keys.length !== 1) throw new Error("Receipt signing key is not authorized by the manifest.");
      return createPublicKey(keys[0].publicKeyPem);
    },
    ceremonyId: manifest.ceremonyId,
    manifestSha256,
    maximumContributions: manifest.contributionPolicy.maximumContributions,
    genesis: contributionGenesis(manifest),
  });
}

/** Checks receipts against the ceremony signing key published on the ceremony site, without the manifest. */
export function verifyReceiptFileContentsWithKey(input: unknown, signingKey: KeyObject, ceremonyId: string): ContributionReceiptV1[] {
  return checkReceipts(input, { publicKeyFor: () => signingKey, ceremonyId });
}

function checkReceipts(input: unknown, trust: ReceiptTrust): ContributionReceiptV1[] {
  const values = Array.isArray(input) ? input : [input];
  if (!values.length || values.length > 100) throw new Error("Provide between 1 and 100 receipts.");
  const seen = new Set<number>();
  return values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid receipt file.");
    const wrapper = value as Record<string, unknown>;
    const envelope = (wrapper.receiptEnvelope ?? wrapper.signedReceipt ?? value) as SignedEnvelope<JsonValue>;
    if (!envelope || typeof envelope !== "object") throw new Error("Missing signed receipt envelope.");
    const receipt = verifyEnvelope(envelope, { publicKey: trust.publicKeyFor(envelope.keyId), domain: RECEIPT_SIGNATURE_DOMAIN }) as unknown as ContributionReceiptV1;
    assertReceipt(receipt);
    if (receipt.ceremonyId !== trust.ceremonyId) throw new Error("Receipt belongs to a different ceremony.");
    if (trust.manifestSha256 !== undefined && receipt.relationManifestSha256 !== trust.manifestSha256) throw new Error("Receipt belongs to a different ceremony or manifest.");
    if (receipt.generation !== receipt.contributionIndex || (trust.maximumContributions !== undefined && receipt.generation > trust.maximumContributions) || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) throw new Error("Receipt contribution index is invalid.");
    if (Date.parse(receipt.acceptedAt) > Date.now() + 300_000) throw new Error("Receipt acceptance time is in the future.");
    if (trust.genesis && receipt.generation === 1 && (receipt.predecessor.sha256 !== trust.genesis.sha256 || receipt.predecessor.byteLength !== trust.genesis.byteLength)) throw new Error("Receipt does not extend the pinned genesis.");
    if (seen.has(receipt.generation)) throw new Error("Duplicate receipt generation.");
    seen.add(receipt.generation);
    if (wrapper.localEvidence !== undefined) {
      const evidence = wrapper.localEvidence as Record<string, unknown>;
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("Malformed local evidence.");
      for (const [key, expected] of Object.entries({ predecessorSha256: receipt.predecessor.sha256, successorSha256: receipt.successor.sha256, contributionHashBlake2b512: receipt.contributionHashBlake2b512, contributionName: receipt.contributionName })) {
        if (evidence[key] !== expected) throw new Error("Local evidence differs from the signed receipt.");
      }
    }
    if (wrapper.signedReceipt) {
      for (const [key, expected] of Object.entries({ contributionIndex: receipt.contributionIndex, contributionHash: receipt.successor.sha256, previousContributionHash: receipt.predecessor.sha256 })) {
        if (key in wrapper && wrapper[key] !== expected) throw new Error("Browser receipt summary differs from its signature.");
      }
    }
    return receipt;
  });
}

export interface VerifyReceiptOptions {
  manifest?: string;
  manifestRootKey?: string;
  slug?: string;
  signingKey?: string;
  ceremonyId?: string;
  allowDevelopmentManifest?: boolean;
  allowRehearsal?: boolean;
}

/** Entirely offline: no coordinator, OAuth or artifact downloads. */
export async function verifyReceiptCommand(path: string, options: VerifyReceiptOptions): Promise<void> {
  const receipts = await verifyReceiptsFromOptions(path, options);
  for (const receipt of receipts) {
    console.log(`Contribution #${receipt.contributionIndex}: receipt signature and ceremony binding verified.`);
    console.log(`Accepted at: ${receipt.acceptedAt}`);
    console.log(`Input SHA-256: ${receipt.predecessor.sha256}`);
    console.log(`Input bytes: ${receipt.predecessor.byteLength}`);
    console.log(`Output SHA-256: ${receipt.successor.sha256}`);
    console.log(`Output bytes: ${receipt.successor.byteLength}`);
  }
  console.log("No cryptographic artifact verification or final-chain inclusion check was performed.");
}

async function verifyReceiptsFromOptions(path: string, options: VerifyReceiptOptions): Promise<ContributionReceiptV1[]> {
  const byKey = options.signingKey !== undefined || options.ceremonyId !== undefined;
  const byManifest = options.manifest !== undefined || options.manifestRootKey !== undefined || options.slug !== undefined;
  if (byKey === byManifest) throw new Error("Use either --signing-key with --ceremony-id, or --manifest with --manifest-root-key and --slug.");
  if (byKey) {
    if (options.signingKey === undefined || options.ceremonyId === undefined) throw new Error("--signing-key and --ceremony-id are both required.");
    const [input, key] = await Promise.all([readReceiptJson(path), readSigningPublicKey(options.signingKey)]);
    return verifyReceiptFileContentsWithKey(input, key, options.ceremonyId);
  }
  if (options.manifest === undefined || options.manifestRootKey === undefined || options.slug === undefined) {
    throw new Error("--manifest, --manifest-root-key and --slug are all required.");
  }
  const [input, manifestInput, root] = await Promise.all([readReceiptJson(path), readReceiptJson(options.manifest), readManifestRootPublicKey(options.manifestRootKey)]);
  const { manifest, manifestSha256 } = verifyManifest(manifestInput as ManifestEnvelope, root, { production: !options.allowDevelopmentManifest, expectedSlug: options.slug, allowRehearsal: options.allowRehearsal });
  return verifyReceiptFileContents(input, manifest, manifestSha256);
}

async function readSigningPublicKey(path: string): Promise<KeyObject> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 16_384) throw new Error("Signing key must be a regular PEM file.");
  const key = createPublicKey(await readFile(path, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be an Ed25519 public key.");
  return key;
}
