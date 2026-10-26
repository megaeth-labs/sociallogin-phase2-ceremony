import type { mega as Wallet } from "@megaeth-labs/wallet-sdk";
let ready: Promise<typeof Wallet> | undefined;
let network: "mainnet" | "testnet" | undefined;

/** Imported only by /collect, only after a deliberate Connect click. */
export async function mossWallet(selectedNetwork: "mainnet" | "testnet") {
  if (network && network !== selectedNetwork)
    throw new Error("Reload this page to switch wallet networks.");
  network = selectedNetwork;
  ready ??= import("@megaeth-labs/wallet-sdk")
    .then(async ({ mega }) => {
      await mega.initialise({
        network: selectedNetwork,
        logging: "error",
        debug: false,
        sponsorMode: "explicit",
        handshakeTimeoutMs: 15_000,
      });
      return mega;
    })
    .catch((error) => {
      ready = undefined;
      network = undefined;
      throw error;
    });
  return ready;
}
