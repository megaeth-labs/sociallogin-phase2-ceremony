import { parseAbi, type Address, type Hex } from "viem";

export const badgeAbi = parseAbi([
  "function claim(address recipient, bytes32 receiptHash, uint256 contributionIndex, uint256 deadline, bytes signature)",
  "function claimedBy(bytes32) view returns (address)",
  "function ownerOf(uint256) view returns (address)",
  "function ceremonyId() view returns (bytes32)",
  "function claimSigner() view returns (address)",
  "function transferable() view returns (bool)",
  "function paused() view returns (bool)",
]);
export const claimTypes = {
  Claim: [
    { name: "recipient", type: "address" },
    { name: "receiptHash", type: "bytes32" },
    { name: "contributionIndex", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
export const claimDomain = (chainId: number, verifyingContract: Address) => ({
  name: "MOSS Ceremony Contribution",
  version: "1",
  chainId,
  verifyingContract,
});
export interface BadgeStatus {
  enabled: true;
  network: "testnet" | "mainnet";
  chainId: number;
  contractAddress: Address;
  receiptHash: Hex;
  tokenId: string;
  contributionIndex: number;
  transferable: boolean;
  claimedBy: Address | null;
  owner: Address | null;
  explorerBaseUrl: string;
}
export interface ClaimVoucher {
  recipient: Address;
  receiptHash: Hex;
  contributionIndex: string;
  deadline: string;
  signature: Hex;
}
export type BadgeResponse = { enabled: false } | BadgeStatus;
