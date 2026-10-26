import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalSha256,
  signEnvelope,
  type CeremonyManifestV1,
  type ContributionReceiptV1,
  type JsonValue,
} from "@moss/phase2-protocol";
import { keccak256, recoverTypedDataAddress, toBytes, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { megaethTestnet } from "viem/chains";
import { claimDomain, claimTypes } from "./contract";
import {
  authorizeBadge,
  badgeConfig,
  limitedJson,
  loadBadge,
  verifyBadgeReceipt,
} from "./server";
import {
  loadCoordinatorBootstrap,
  type CoordinatorBootstrap,
} from "../coordinator-bootstrap";
import { signParticipantToken } from "../participant-identity";
import { readServerMaterial } from "../server-material";

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), readContract: vi.fn() }));
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => rpc,
}));
vi.mock("../coordinator-bootstrap", () => ({
  loadCoordinatorBootstrap: vi.fn(),
}));
vi.mock("../participant-identity", () => ({ signParticipantToken: vi.fn() }));
vi.mock("../server-material", () => ({ readServerMaterial: vi.fn() }));
const keys = generateKeyPairSync("ed25519");
const mintKey = generatePrivateKey();
const issuer = privateKeyToAccount(mintKey);
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const contract = "0x1111111111111111111111111111111111111111";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const participant = {
  participantId: id,
  participantName: "Alice",
  authSubjectHash: "test-subject",
};
const artifact = (digit: string) => ({
  sha256: digit.repeat(64),
  byteLength: 100,
  urls: ["https://example.test/artifact"],
});
const manifest = {
  ceremonyId: id,
  coordinatorKeys: [
    {
      keyId: "coordinator",
      publicKeyPem: keys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
  ],
} as CeremonyManifestV1;
const payload: ContributionReceiptV1 = {
  schemaVersion: 1,
  type: "moss.phase2.receipt.v1",
  ceremonyId: id,
  relationManifestSha256: canonicalSha256(
    "MOSS_PHASE2_MANIFEST_PAYLOAD_V1",
    manifest as unknown as JsonValue,
  ),
  sequence: 1,
  generation: 1,
  contributionIndex: 1,
  predecessor: artifact("1"),
  successor: artifact("2"),
  contributionName: "contribution",
  contributionHashBlake2b512: "3".repeat(128),
  participantPseudonym: "Alice",
  clientKind: "browser",
  clientReleaseSha256: "4".repeat(64),
  acceptedAt: "2026-09-29T12:00:00.000Z",
  transcriptEventHash: "5".repeat(64),
};
const signed = (receipt = payload) =>
  signEnvelope(receipt as unknown as JsonValue, {
    keyId: "coordinator",
    privateKey: keys.privateKey,
    domain: "MOSS_PHASE2_RECEIPT_V1",
  });
const bootstrap = {
  coordinatorBaseUrl: "https://coordinator.example",
  manifest: { payload: manifest },
} as CoordinatorBootstrap;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NFT_CLAIMS_ENABLED", "true");
  vi.stubEnv("NFT_NETWORK", "testnet");
  vi.stubEnv("NFT_CONTRACT_ADDRESS", contract);
  vi.stubEnv("NFT_RPC_URL", "https://rpc.example");
  vi.mocked(loadCoordinatorBootstrap).mockResolvedValue(bootstrap);
  vi.mocked(signParticipantToken).mockResolvedValue({
    token: "scoped-test-token",
    expiresAt: 100,
  });
  vi.mocked(readServerMaterial).mockResolvedValue(mintKey);
  rpc.getChainId.mockResolvedValue(megaethTestnet.id);
  rpc.readContract.mockImplementation(
    async ({ functionName }) =>
      ({
        ceremonyId: keccak256(toBytes(id)),
        claimSigner: issuer.address,
        transferable: false,
        paused: false,
        claimedBy: zeroAddress,
        ownerOf: recipient,
      })[functionName as string],
  );
  request = vi.fn(async () => Response.json(signed()));
  vi.stubGlobal("fetch", request);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("receipt-gated collectible authorization", () => {
  it("uses the signed-in participant's scoped receipt and a distinct mint key", async () => {
    const result = await authorizeBadge(participant, id, recipient);
    expect(signParticipantToken).toHaveBeenCalledWith(participant, "browser");
    expect(request).toHaveBeenCalledWith(
      new URL(`https://coordinator.example/v1/receipts/${id}`),
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer scoped-test-token",
        }),
      }),
    );
    expect(readServerMaterial).toHaveBeenCalledWith(
      "NFT_CLAIM_SIGNER_PRIVATE_KEY",
      true,
    );
    expect(result.status).toMatchObject({
      contributionIndex: 1,
      network: "testnet",
      claimedBy: null,
    });
    const voucher = result.voucher;
    expect(
      await recoverTypedDataAddress({
        domain: claimDomain(megaethTestnet.id, contract),
        types: claimTypes,
        primaryType: "Claim",
        message: {
          ...voucher,
          contributionIndex: BigInt(voucher.contributionIndex),
          deadline: BigInt(voucher.deadline),
        },
        signature: voucher.signature,
      }),
    ).toBe(issuer.address);
    expect(
      Number(voucher.deadline) - Math.floor(Date.now() / 1000),
    ).toBeLessThanOrEqual(600);
  });
  it("does not issue claims for someone else's receipt or a pending contribution", async () => {
    request.mockResolvedValue(
      Response.json({ error: "not found" }, { status: 404 }),
    );
    await expect(
      authorizeBadge(participant, id, recipient),
    ).rejects.toMatchObject({ status: 404 });
    expect(readServerMaterial).not.toHaveBeenCalled();
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
  it("rejects tampered, foreign-ceremony and foreign-manifest receipts", async () => {
    for (const envelope of [
      { ...signed(), payload: { ...payload, contributionIndex: 99 } },
      signed({
        ...payload,
        ceremonyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
      signed({ ...payload, relationManifestSha256: "f".repeat(64) }),
      { ...signed(), keyId: "unknown" },
    ]) {
      request.mockResolvedValue(Response.json(envelope));
      await expect(
        authorizeBadge(participant, id, recipient),
      ).rejects.toThrow();
    }
    expect(readServerMaterial).not.toHaveBeenCalled();
  });
  it("blocks repeat claims but still returns the current owner", async () => {
    rpc.readContract.mockImplementation(
      async ({ functionName }) =>
        ({
          ceremonyId: keccak256(toBytes(id)),
          claimSigner: issuer.address,
          transferable: true,
          paused: false,
          claimedBy: recipient,
          ownerOf: recipient,
        })[functionName as string],
    );
    expect((await loadBadge(participant, id))?.status.owner).toBe(recipient);
    await expect(
      authorizeBadge(participant, id, recipient),
    ).rejects.toMatchObject({ status: 409 });
    expect(readServerMaterial).not.toHaveBeenCalled();
  });
  it.each(["chain", "ceremony", "signer", "paused"])(
    "fails closed on %s mismatch",
    async (kind) => {
      if (kind === "chain") rpc.getChainId.mockResolvedValue(1);
      const previous = rpc.readContract.getMockImplementation()!;
      rpc.readContract.mockImplementation(async (args) => {
        if (kind === "ceremony" && args.functionName === "ceremonyId")
          return `0x${"f".repeat(64)}`;
        if (kind === "signer" && args.functionName === "claimSigner")
          return recipient;
        if (kind === "paused" && args.functionName === "paused") return true;
        return previous(args);
      });
      await expect(
        authorizeBadge(participant, id, recipient),
      ).rejects.toThrow();
    },
  );
  it("is disabled by default without loading keys, SDK, coordinator or RPC", async () => {
    vi.stubEnv("NFT_CLAIMS_ENABLED", undefined);
    expect(await loadBadge(participant, id)).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(readServerMaterial).not.toHaveBeenCalled();
  });
  it("rejects invalid recipients and configuration", async () => {
    await expect(
      authorizeBadge(participant, id, zeroAddress),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      authorizeBadge(participant, id, "not-address"),
    ).rejects.toMatchObject({ status: 400 });
    vi.stubEnv("NFT_NETWORK", "invalid");
    expect(badgeConfig).toThrow();
    vi.stubEnv("NFT_NETWORK", "testnet");
    vi.stubEnv("NFT_RPC_URL", "http://rpc.example");
    expect(badgeConfig).toThrow();
  });
  it("limits streamed request size and rejects malformed JSON", async () => {
    await expect(
      limitedJson(new Response("x".repeat(2049)), 2048),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      limitedJson(new Response("bad json"), 2048),
    ).rejects.toMatchObject({ status: 400 });
  });
});
