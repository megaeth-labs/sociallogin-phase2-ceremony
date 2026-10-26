"use client";
import { useEffect, useRef, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import type { Address, Hex } from "viem";
import { BadgeArt, BadgeTraits } from "../components/ContributionCollectible";
import styles from "../components/ContributionCollectible/style.module.css";
import { AmbientVideo } from "../components/AmbientVideo";
import { ContributeButton } from "../components/PublicCeremony";
import {
  badgeAbi,
  type BadgeResponse,
  type BadgeStatus,
  type ClaimVoucher,
} from "@/lib/nft/contract";
import { mossWallet } from "@/lib/nft/wallet";

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error ?? "Couldn’t load your collectible. Try again.");
  return body as T;
}
/** Full address for assistive tech and copying; a short form on screen. */
function WalletAddress({ value, prefix }: { value: string; prefix?: string }) {
  return (
    <span className={styles.address} title={value}>
      {prefix}
      <span aria-hidden="true">{value.slice(0, 6)}…{value.slice(-4)}</span>
      <span className={styles.visuallyHidden}>{value}</span>
    </span>
  );
}

export function CollectPage({ receiptId, preview }: { receiptId: string | null; preview?: "wallet" | "mint" | "collected" }) {
  const exampleWallet: Address = "0x0000000000000000000000000000000000000001";
  const exampleBadge: BadgeStatus = {
    enabled: true, network: "mainnet", chainId: 4326,
    contractAddress: "0x0000000000000000000000000000000000000000",
    // Example only: keccak256("moss-preview-receipt"), so the artwork has traits to draw.
    receiptHash: "0x0a943199316c5f1cdf0cb200285e3518ce9a4d3e67986d10bdb0c2624720b5fd", tokenId: "128", contributionIndex: 128,
    transferable: false, claimedBy: preview === "collected" ? exampleWallet : null,
    owner: preview === "collected" ? exampleWallet : null, explorerBaseUrl: "https://mega.etherscan.io",
  };
  const session = useSession();
  const [badge, setBadge] = useState<BadgeResponse | null>(preview ? exampleBadge : null);
  const [wallet, setWallet] = useState<Address | null>(preview && preview !== "wallet" ? exampleWallet : null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [transaction, setTransaction] = useState<Hex | null>(null);
  const lock = useRef(false);
  const authenticated = !!preview || session.status === "authenticated";
  const active = authenticated && badge?.enabled ? badge : null;
  async function refresh(signal?: AbortSignal) {
    if (preview) return exampleBadge;
    const data = await responseJson<BadgeResponse>(
      await fetch(
        `/api/ceremony/nft?receiptId=${encodeURIComponent(receiptId ?? "")}`,
        { cache: "no-store", signal },
      ),
    );
    setBadge(data);
    return data;
  }
  useEffect(() => {
    if (preview) return;
    setBadge(null);
    setError("");
    setConsent(false);
    setTransaction(null);
    if (!authenticated || !receiptId) return;
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
    // Account changes discard eligibility; the server always checks the current session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, session.data?.participantId, receiptId, preview]);
  async function run(action: () => Promise<void>) {
    if (preview) {
      setMessage("Preview only. No wallet is connected and no transaction is submitted.");
      return;
    }
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setMessage("");
      setError(
        e instanceof Error
          ? e.message
          : "Something went wrong. Your contribution is still accepted.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function connect() {
    if (!active) return;
    setMessage("Opening MOSS Wallet…");
    const sdk = await mossWallet(active.network);
    sdk.events.onStatusChange((status) => {
      setWallet(
        status.status === "connected" && status.network === active.network
          ? (status.address ?? null)
          : null,
      );
      setConsent(false);
    });
    const result = await sdk.connect();
    if (result.status === "connected" && result.address) {
      if (result.network !== active.network)
        throw new Error(
          `Switch MOSS Wallet to ${active.network} and reconnect.`,
        );
      setWallet(result.address);
    }
    setMessage(
      result.status === "cancelled"
        ? "Connection cancelled. You can try again whenever you’re ready."
        : "",
    );
  }
  async function mint() {
    if (!active || !wallet || !consent) return;
    const sdk = await mossWallet(active.network);
    const connected = await sdk.status();
    if (
      connected.status !== "connected" ||
      connected.network !== active.network ||
      connected.address?.toLowerCase() !== wallet.toLowerCase()
    ) {
      setWallet(null);
      setConsent(false);
      throw new Error("Your wallet changed. Reconnect before minting.");
    }
    setMessage("Checking your contribution…");
    const { status, voucher } = await responseJson<{
      status: BadgeStatus;
      voucher: ClaimVoucher;
    }>(
      await fetch("/api/ceremony/nft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receiptId, recipient: wallet }),
      }),
    );
    if (
      status.contractAddress !== active.contractAddress ||
      status.chainId !== active.chainId ||
      voucher.recipient.toLowerCase() !== wallet.toLowerCase() ||
      voucher.receiptHash !== active.receiptHash
    )
      throw new Error(
        "Claim configuration changed. Refresh before continuing.",
      );
    setMessage("Approve your collectible in MOSS Wallet…");
    const result = await sdk.callContract({
      address: status.contractAddress,
      abi: badgeAbi,
      functionName: "claim",
      args: [
        voucher.recipient,
        voucher.receiptHash,
        BigInt(voucher.contributionIndex),
        BigInt(voucher.deadline),
        voucher.signature,
      ],
      value: BigInt(0),
      silent: false,
      sponsor: false,
    });
    if (result.status === "cancelled") {
      setMessage("Mint cancelled. Your collectible is still available.");
      return;
    }
    if (result.status !== "approved")
      throw new Error(
        "The wallet could not complete the mint. Check its status before retrying.",
      );
    // Approval alone is not success. Confirm contract state via the server RPC.
    const tx = result.receipt?.transactionHash ?? result.receipt?.hash;
    if (tx && /^0x[0-9a-fA-F]{64}$/.test(tx)) setTransaction(tx);
    setMessage("Checking onchain confirmation…");
    const updated = await refresh();
    setMessage(
      updated.enabled && updated.claimedBy
        ? ""
        : "Confirmation is pending. Check status before trying another mint.",
    );
  }
  // Which branch is showing, so a change of state can cross-fade in.
  const view = !receiptId
    ? "none"
    : !preview && session.status === "loading"
      ? "session"
      : !authenticated
        ? "signin"
        : badge && !badge.enabled
          ? "closed"
          : !active
            ? "checking"
            : active.claimedBy
              ? "collected"
              : wallet
                ? transaction ? "awaiting" : "connected"
                : "connect";
  return (
    <main className={styles.page}>
      <section className={styles.window} aria-labelledby="collect-title">
        <AmbientVideo className={styles.windowBg} src="/brand/hero-bg" poster="/brand/hero-bg-poster.webp" />
        <div className={styles.windowInner}>
          <a className={styles.back} href={preview ? "/review" : "/"}>← Back to {preview ? "review" : "homepage"}</a>
          <div className={styles.collectGrid}>
            <div className={styles.collectCopy}>
              <p className={styles.eyebrow}>MOSS / Contribution collectible</p>
              <h1 id="collect-title">Your contribution collectible</h1>
              <p className={styles.lede}>
                Mint a collectible to mark your contribution to the MOSS social login
                ceremony. Your bunny is generated onchain from a hash of your
                contribution receipt, so no two are alike.
              </p>
              <div className={styles.tray}>
                <section
                  className={styles.claim}
                  aria-label="Claim your contribution collectible"
                >
                  <div key={view} className={styles.swap}>
            {!receiptId ? (
              <p>
                Choose an accepted contribution from your receipt history to
                collect its badge.
              </p>
            ) : !preview && session.status === "loading" ? (
              <p role="status">Checking your sign-in…</p>
            ) : !authenticated ? (
              <>
                <p>Sign in with the GitHub account you used to contribute.</p>
                <ContributeButton
                  onClick={() =>
                    void signIn("github", {
                      callbackUrl: `/collect?receiptId=${encodeURIComponent(receiptId)}`,
                    })
                  }
                >
                  Sign in with GitHub
                </ContributeButton>
              </>
            ) : badge && !badge.enabled ? (
              <>
                <h2>Your contribution was accepted</h2>
                <p>
                  Collectible minting isn’t open yet. You can come back from
                  your receipt history when it is.
                </p>
              </>
            ) : !active ? (
              <p role="status">
                {error
                  ? "Collectible status could not be loaded."
                  : "Checking your accepted contribution…"}
              </p>
            ) : active.claimedBy ? (
              <>
                <p className={styles.mintedLine} role="status">
                  Your contribution #{active.contributionIndex} has been minted
                  on MegaETH {active.network}.
                </p>
                <p className={styles.ownerRow}><WalletAddress prefix="Owner: " value={active.owner ?? ""} /></p>
                <div className={styles.actions}>
                  <a
                    className={styles.secondary}
                    href={preview ? undefined : `${active.explorerBaseUrl}/token/${active.contractAddress}?a=${active.tokenId}`}
                    aria-disabled={!!preview}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View collectible ↗
                  </a>
                  <button
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const sdk = await mossWallet(active.network);
                        await sdk.collectible({
                          address: active.contractAddress,
                          tokenId: active.tokenId,
                        });
                      })
                    }
                  >
                    Open in MOSS Wallet
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Collectible for contribution #{active.contributionIndex}</h2>
                <p>
                  On MegaETH {active.network}.{" "}
                  {active.transferable
                    ? "A transferable collectible."
                    : "This collectible cannot be transferred to another wallet."}
                </p>
                {wallet ? (
                  <div className={styles.wallet}>
                    <span className={styles.walletDot} aria-hidden="true" />
                    <div className={styles.walletIdentity}>
                      <span className={styles.walletLabel}>Connected wallet</span>
                      <WalletAddress value={wallet} />
                    </div>
                    <button
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const sdk = await mossWallet(active.network);
                          await sdk.disconnect();
                          setWallet(null);
                          setConsent(false);
                        })
                      }
                    >
                      Disconnect
                    </button>
                  </div>
                ) : (
                  <ContributeButton
                    disabled={busy}
                    onClick={() => void run(connect)}
                  >
                    Connect MOSS Wallet
                  </ContributeButton>
                )}
                {wallet && (
                  <>
                    <label className={styles.consent}>
                      <input
                        type="checkbox"
                        checked={consent}
                        disabled={busy}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      <span>
                        I understand this publicly links my wallet to this
                        contribution.
                      </span>
                    </label>
                    <ContributeButton
                      disabled={busy || !consent || !!transaction}
                      onClick={() => void run(mint)}
                    >
                      {busy
                        ? "Working…"
                        : transaction
                          ? "Awaiting confirmation"
                          : "Mint my collectible"}
                    </ContributeButton>
                  </>
                )}
              </>
            )}
                  </div>
            {message && <p key={message} role="status" className={styles.status}>{message}</p>}
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            {authenticated &&
              receiptId &&
              (error || transaction || message.includes("pending")) && (
                <button
                  className={styles.secondary}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const updated = await refresh();
                      if (updated.enabled && updated.claimedBy) setMessage("");
                      else
                        setMessage(
                          "No confirmed mint yet. Check your wallet before retrying.",
                        );
                    })
                  }
                >
                  Check collectible status
                </button>
              )}
            {transaction && active && (
              <p className={styles.txLink}>
                <a
                  href={`${active.explorerBaseUrl}/tx/${transaction}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View transaction ↗
                </a>
              </p>
            )}
                </section>
              </div>
            </div>
            <div className={styles.collectArt}>
              <div className={styles.card} data-minted={!!active?.claimedBy}>
                <BadgeArt index={active?.contributionIndex} receiptHash={active?.receiptHash} />
              </div>
              {active?.receiptHash && <BadgeTraits receiptHash={active.receiptHash} />}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
