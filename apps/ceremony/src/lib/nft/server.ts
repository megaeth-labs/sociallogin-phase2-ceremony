import { createPublicKey } from "node:crypto";
import {
  assertReceipt,
  canonicalSha256,
  RECEIPT_SIGNATURE_DOMAIN,
  verifyEnvelope,
  type ContributionReceiptV1,
  type SignedEnvelope,
  type JsonValue,
} from "@moss/phase2-protocol";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  toBytes,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { megaeth, megaethTestnet } from "viem/chains";
import {
  loadCoordinatorBootstrap,
  type CoordinatorBootstrap,
} from "../coordinator-bootstrap";
import {
  signParticipantToken,
  type Participant,
} from "../participant-identity";
import { readServerMaterial } from "../server-material";
import {
  badgeAbi,
  claimDomain,
  claimTypes,
  type BadgeStatus,
  type ClaimVoucher,
} from "./contract";

export class BadgeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function badgeConfig() {
  if (process.env.NFT_CLAIMS_ENABLED !== "true") return null;
  const network = process.env.NFT_NETWORK ?? "testnet";
  if (network !== "testnet" && network !== "mainnet")
    throw new Error("Invalid NFT network configuration.");
  const address = process.env.NFT_CONTRACT_ADDRESS;
  if (!address || !isAddress(address) || address.toLowerCase() === zeroAddress)
    throw new Error("NFT contract is not configured.");
  const rpc = new URL(process.env.NFT_RPC_URL ?? "");
  if (rpc.protocol !== "https:" || rpc.username || rpc.password)
    throw new Error("NFT RPC must use HTTPS.");
  const chain = network === "mainnet" ? megaeth : megaethTestnet;
  return {
    network: network as "testnet" | "mainnet",
    chain,
    address: getAddress(address),
    rpc: rpc.toString(),
  };
}

/** Bound both browser requests and coordinator responses before parsing JSON. */
export async function limitedJson(
  message: Request | Response,
  limit: number,
): Promise<unknown> {
  if (!message.body) throw new BadgeError(400, "Missing request body.");
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BadgeError(413, "Request is too large.");
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new BadgeError(400, "Invalid JSON.");
    }
  } finally {
    reader.releaseLock();
  }
}
export function receiptId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new BadgeError(400, "Choose a valid contribution receipt.");
  }
  return value;
}
export function verifyBadgeReceipt(
  envelope: SignedEnvelope<ContributionReceiptV1>,
  bootstrap: CoordinatorBootstrap,
) {
  const manifest = bootstrap.manifest.payload;
  const key = manifest.coordinatorKeys.find(
    (key) => key.keyId === envelope.keyId,
  );
  if (!key) throw new BadgeError(403, "Receipt signer is not authorized.");
  const receipt = verifyEnvelope(envelope as never, {
    publicKey: createPublicKey(key.publicKeyPem),
    domain: RECEIPT_SIGNATURE_DOMAIN,
  }) as unknown as ContributionReceiptV1;
  assertReceipt(receipt);
  if (
    receipt.ceremonyId !== manifest.ceremonyId ||
    receipt.relationManifestSha256 !==
      canonicalSha256(
        "MOSS_PHASE2_MANIFEST_PAYLOAD_V1",
        manifest as unknown as JsonValue,
      )
  ) {
    throw new BadgeError(403, "Receipt belongs to another ceremony.");
  }
  return {
    receipt,
    hash: `0x${canonicalSha256("MOSS_PHASE2_NFT_RECEIPT_V1", receipt as unknown as JsonValue)}` as Hex,
  };
}

/** Ownership comes from the participant-scoped coordinator endpoint, never a submitted receipt. */
export async function loadBadge(participant: Participant, id: string) {
  const config = badgeConfig();
  if (!config) return null;
  const bootstrap = await loadCoordinatorBootstrap();
  const { token } = await signParticipantToken(participant, "browser");
  const response = await fetch(
    new URL(
      `/v1/receipts/${encodeURIComponent(receiptId(id))}`,
      bootstrap.coordinatorBaseUrl,
    ),
    {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new BadgeError(
      response.status === 404 ? 404 : 503,
      response.status === 404
        ? "No accepted contribution found for this signed-in account."
        : "Receipt verification is temporarily unavailable.",
    );
  const envelope = (await limitedJson(
    response,
    65_536,
  )) as SignedEnvelope<ContributionReceiptV1>;
  const { receipt, hash } = verifyBadgeReceipt(envelope, bootstrap);
  const client = createPublicClient({
    chain: config.chain,
    transport: http(config.rpc, { timeout: 15_000, retryCount: 1 }),
  });
  const read = <T>(
    functionName: "ceremonyId" | "claimSigner" | "transferable" | "paused",
  ) =>
    client.readContract({
      address: config.address,
      abi: badgeAbi,
      functionName,
    }) as Promise<T>;
  const [chainId, ceremonyId, signer, transferable, paused, claimant] =
    await Promise.all([
      client.getChainId(),
      read<Hex>("ceremonyId"),
      read<Hex>("claimSigner"),
      read<boolean>("transferable"),
      read<boolean>("paused"),
      client.readContract({
        address: config.address,
        abi: badgeAbi,
        functionName: "claimedBy",
        args: [hash],
      }),
    ]);
  if (
    chainId !== config.chain.id ||
    ceremonyId !== keccak256(toBytes(bootstrap.manifest.payload.ceremonyId))
  )
    throw new Error("Badge contract chain or ceremony mismatch.");
  const claimedBy = claimant === zeroAddress ? null : getAddress(claimant);
  const owner = claimedBy
    ? await client.readContract({
        address: config.address,
        abi: badgeAbi,
        functionName: "ownerOf",
        args: [BigInt(hash)],
      })
    : null;
  const status: BadgeStatus = {
    enabled: true,
    network: config.network,
    chainId,
    contractAddress: config.address,
    receiptHash: hash,
    tokenId: BigInt(hash).toString(),
    contributionIndex: receipt.contributionIndex,
    transferable,
    claimedBy,
    owner,
    explorerBaseUrl: config.chain.blockExplorers.default.url,
  };
  return { status, signer, paused };
}

export async function authorizeBadge(
  participant: Participant,
  id: string,
  recipient: unknown,
) {
  if (
    typeof recipient !== "string" ||
    !isAddress(recipient) ||
    recipient.toLowerCase() === zeroAddress
  )
    throw new BadgeError(400, "Connect a valid wallet first.");
  const badge = await loadBadge(participant, id);
  if (!badge) throw new BadgeError(503, "Collectible minting is not open yet.");
  if (badge.status.claimedBy)
    throw new BadgeError(
      409,
      "This contribution already has a collectible. Refresh its status.",
    );
  if (badge.paused)
    throw new BadgeError(503, "Collectible minting is temporarily paused.");
  // Dedicated secp256k1 issuer key; never reuse manifest/coordinator/participant signing keys.
  const raw = (
    await readServerMaterial("NFT_CLAIM_SIGNER_PRIVATE_KEY", true)
  ).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw))
    throw new Error("Invalid NFT claim signer configuration.");
  const account = privateKeyToAccount(raw as Hex);
  if (account.address.toLowerCase() !== badge.signer.toLowerCase())
    throw new Error("NFT claim signer does not match contract.");
  const message = {
    recipient: getAddress(recipient),
    receiptHash: badge.status.receiptHash,
    contributionIndex: BigInt(badge.status.contributionIndex),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  };
  const signature = await account.signTypedData({
    domain: claimDomain(badge.status.chainId, badge.status.contractAddress),
    types: claimTypes,
    primaryType: "Claim",
    message,
  });
  const voucher: ClaimVoucher = {
    ...message,
    contributionIndex: message.contributionIndex.toString(),
    deadline: message.deadline.toString(),
    signature,
  };
  return { status: badge.status, voucher };
}
