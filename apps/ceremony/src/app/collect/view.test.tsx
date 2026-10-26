// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectPage } from "./view";
import { ContributionCollectible } from "../components/ContributionCollectible";
import { mossWallet } from "@/lib/nft/wallet";

const sdk = vi.hoisted(() => ({
  connect: vi.fn(),
  status: vi.fn(),
  callContract: vi.fn(),
  disconnect: vi.fn(),
  collectible: vi.fn(),
  events: { onStatusChange: vi.fn() },
}));
const auth = vi.hoisted(() => ({
  value: { status: "authenticated", data: { participantId: "alice" } },
}));
vi.mock("next-auth/react", () => ({
  useSession: () => auth.value,
  signIn: vi.fn(),
}));
vi.mock("@/lib/nft/wallet", () => ({ mossWallet: vi.fn(async () => sdk) }));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const address = `0x${"1".repeat(40)}`;
const receiptHash = `0x${"2".repeat(64)}`;
const badge = {
  enabled: true,
  network: "testnet",
  chainId: 6343,
  contractAddress: `0x${"3".repeat(40)}`,
  receiptHash,
  tokenId: "123",
  contributionIndex: 2,
  transferable: false,
  claimedBy: null,
  owner: null,
  explorerBaseUrl: "https://explorer.example",
};
let confirmed = false;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  confirmed = false;
  auth.value = { status: "authenticated", data: { participantId: "alice" } };
  sdk.connect.mockResolvedValue({
    status: "connected",
    address,
    network: "testnet",
  });
  sdk.status.mockResolvedValue({
    status: "connected",
    address,
    network: "testnet",
  });
  sdk.callContract.mockResolvedValue({ status: "cancelled" });
  request = vi.fn(async (_url, options) =>
    options?.method === "POST"
      ? Response.json({
          status: badge,
          voucher: {
            recipient: address,
            receiptHash,
            contributionIndex: "2",
            deadline: "2000000000",
            signature: "0x1234",
          },
        })
      : Response.json(
          confirmed ? { ...badge, claimedBy: address, owner: address } : badge,
        ),
  );
  vi.stubGlobal("fetch", request);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function connect() {
  render(<CollectPage receiptId={id} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Connect MOSS Wallet" }),
  );
  await screen.findByRole("button", { name: "Disconnect" });
}
it("uses a full document link after acceptance, without loading a wallet", () => {
  render(<ContributionCollectible receiptId={id} index={2} />);
  expect(
    screen
      .getByRole("link", { name: /Collect with MOSS Wallet/ })
      .getAttribute("href"),
  ).toBe(`/collect?receiptId=${id}`);
  expect(mossWallet).not.toHaveBeenCalled();
});
it("requires explicit public-link consent and handles wallet cancellation", async () => {
  await connect();
  const mint = screen.getByRole("button", { name: "Mint my collectible" });
  expect(mint.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(mint);
  await screen.findByText(/Mint cancelled/);
  expect(sdk.callContract).toHaveBeenCalledWith(
    expect.objectContaining({
      functionName: "claim",
      value: BigInt(0),
      silent: false,
      sponsor: false,
    }),
  );
  expect(screen.queryByText(/has been minted on MegaETH/)).toBeNull();
  expect(mint.hasAttribute("disabled")).toBe(false);
});
it("never treats wallet approval as confirmed minting", async () => {
  sdk.callContract.mockResolvedValue({
    status: "approved",
    receipt: { transactionHash: `0x${"a".repeat(64)}` },
  });
  await connect();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Mint my collectible" }));
  await screen.findByText(/Confirmation is pending/);
  expect(screen.queryByText(/has been minted on MegaETH/)).toBeNull();
  confirmed = true;
  fireEvent.click(
    screen.getByRole("button", { name: "Check collectible status" }),
  );
  await screen.findByText(/has been minted on MegaETH/);
  expect(sdk.callContract).toHaveBeenCalledTimes(1);
});
it("recovers an already minted collectible after reloading", async () => {
  confirmed = true;
  render(<CollectPage receiptId={id} />);
  await screen.findByText(/has been minted on MegaETH/);
  expect(mossWallet).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Mint my collectible" }),
  ).toBeNull();
});
it("rejects a wallet switch before issuing a voucher", async () => {
  await connect();
  sdk.status.mockResolvedValue({
    status: "connected",
    address,
    network: "mainnet",
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Mint my collectible" }));
  await screen.findByRole("alert");
  expect(
    request.mock.calls.some(([, options]) => options?.method === "POST"),
  ).toBe(false);
  expect(sdk.callContract).not.toHaveBeenCalled();
});
it("shows disabled minting honestly and leaves the wallet unloaded", async () => {
  request.mockResolvedValue(Response.json({ enabled: false }));
  render(<CollectPage receiptId={id} />);
  await screen.findByText(/Collectible minting isn’t open yet/);
  expect(mossWallet).not.toHaveBeenCalled();
});
it("does not request eligibility while signed out", async () => {
  auth.value.status = "unauthenticated";
  render(<CollectPage receiptId={id} />);
  await screen.findByRole("button", { name: "Sign in with GitHub" });
  await waitFor(() => expect(request).not.toHaveBeenCalled());
});

it.each(["wallet", "mint", "collected"] as const)("keeps %s review completely separate from live minting", async (preview) => {
  auth.value.status = "unauthenticated";
  render(<CollectPage receiptId="preview" preview={preview} />);
  if (preview === "wallet") fireEvent.click(screen.getByRole("button", { name: "Connect MOSS Wallet" }));
  if (preview === "mint") {
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Mint my collectible" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  }
  if (preview === "collected") fireEvent.click(screen.getByRole("button", { name: "Open in MOSS Wallet" }));
  await screen.findByText(/Preview only/);
  expect(request).not.toHaveBeenCalled();
  expect(mossWallet).not.toHaveBeenCalled();
  expect(sdk.callContract).not.toHaveBeenCalled();
});
it("keeps the preview collect link inside the walkthrough", () => {
  render(<ContributionCollectible receiptId="preview" index={128} preview />);
  expect(screen.getByRole("link", { name: /Collect with MOSS Wallet/ }).getAttribute("href")).toBe("/review?screen=wallet");
});
