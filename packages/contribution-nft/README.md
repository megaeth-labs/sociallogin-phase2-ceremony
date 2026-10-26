# MOSS contribution collectible

An optional ERC-721 commemorating an accepted ceremony contribution. The completion
screen links to `/collect?receiptId=...`; contributors connect MOSS Wallet and
approve `claim`. The npm dependency is **@megaeth-labs/wallet-sdk 1.0.7**, pinned
in the workspace lockfile. No local SDK linking is used.

Initial configuration is **MegaETH testnet**, with a **non-transferable** badge.
The constructor supports a transferable deployment if that policy is preferred.
Artwork and JSON metadata are stored entirely onchain as data URIs. This is a
MOSS collectible, not an official POAP or Ethereum KZG credential.

## Artwork

Each badge is a bunny whose traits are read from the receipt hash: byte 0
picks the background, then glass, ears, outfit, marking, eyes, headwear,
neckwear, eye colour and signal (bytes 0 to 9), each from a 256-weight rarity
table. The bunny is a frosted-glass sculpture, after MOSS's glass rabbit: tinted
glass lit from above, edges brightened by a rim gradient, specular streaks,
translucent ears that let the background through, glass-bead eyes and a small
carved smile. It sits in a cyberpunk night: rain-lit skylines with neon, circuit
plates, frosted glass stars on dyed paper, HUD corner brackets and scanlines,
LED implants and harnesses, a cyber eye implant and a scanning drone. A rare
glitched signal (20 in 256) swaps the smile for a wide toothy grin and redraws
the bunny with offset colour channels and sliced bands. Markings are mirrored so
both halves of the face always match. Obsidian glass gets a pale haze over its
background so a dark bunny never sits on a dark sky. The full hash is drawn as a 2x128
strip in the footer next to the contributor number and shortened receipt, so
the art can be checked against the receipt.

`src/BadgeArt.sol` is generated from `apps/ceremony/src/lib/nft/badge-svg.ts`,
which also draws the web preview. After changing the art run
`pnpm --filter @moss/phase2-ceremony-web generate:badge-art`; the web and forge
suites pin the same SVG keccak and fail if the two drift. Shared template
fragments (night skies, glass gradients, star fields, hoodies, irises) are emitted once as
private functions, so colour variants cost only their parameters. The art is
split across `BadgeRenderer` (background, glass, ears, body, outfit) and
`BadgeFaceRenderer` (markings, eyes, mouth, accessories, trait metadata). The
renderer is deployed first and passed to the badge's constructor, and it deploys
the face renderer itself, so every contract stays under the EIP-170 runtime
limit and no creation code carries more art than the EIP-3860 initcode limit
allows. The renderer is immutable and pure; marketplaces still read everything
from the badge's `tokenURI`, which returns self-contained base64 JSON with the
SVG inline.

## Flow and trust

1. The contributor opens a verified acceptance receipt and chooses **Collect with
   MOSS Wallet**. Receipt history can reopen the claim later, including on another
   computer after GitHub sign-in.
2. A full document navigation isolates `/collect` from contribution workers.
   The SDK loads only after a Connect click. Only `/collect` allows the pinned
   `https://account.megaeth.com` iframe origin. Other pages keep `frame-src 'none'`.
   Use full document navigation back to the ceremony as well; do not replace these
   anchors with client-side routing that could retain a wallet frame.
   `/collect` uses `Referrer-Policy: strict-origin`: the wallet derives its Penpal
   peer from `document.referrer`. Suppressing it causes a handshake timeout.
   Only the website origin is sent, never the receipt ID or query string; other
   ceremony pages retain `no-referrer`.
3. The server uses the signed-in participant's scoped coordinator JWT to fetch
   their accepted receipt. It verifies the coordinator signature, schema, ceremony
   ID and original manifest hash. A browser-supplied receipt, display name, pending
   submission, or knowledge of someone else's receipt ID never grants eligibility.
4. The server checks RPC chain ID and contract ceremony ID, reads mint state and
   issues a ten-minute EIP-712 authorization using a **separate secp256k1 issuer
   key**. The contract domain binds the authorization to chain ID and contract;
   its fields bind recipient, receipt hash, contribution index and deadline.
5. The wallet explicitly approves the zero-value contract call. No session key,
   spending allowance or silent transaction permission is requested. The UI asks
   for consent to publicly link the wallet to the contribution. Gas sponsorship is
   not configured; the wallet displays any network fees.
6. The contract requires the recipient to be the caller, verifies the issuer's
   signature, and mints once per canonical receipt hash. State is set before the
   receiver callback. Replays, changed recipients and cross-chain/contract use
   fail. Multiple vouchers for the same receipt cannot mint multiple NFTs.
7. The UI checks contract state through the server before reporting collection.
   Wallet approval is not confirmation. If confirmation is pending, use **Check
   collectible status**. If a transaction fails, reload to recheck eligibility and
   retry. A reload also recovers an already minted NFT without resubmitting.

One NFT is allowed **per accepted contribution**, not per person or wallet. A
contributor can receive multiple NFTs if ceremony policy allows multiple accepted
contributions. For transferable deployments, `claimedBy` retains the original
recipient and `ownerOf` reports the current holder.

The NFT is an issuer-attested souvenir, not a proof of circuit correctness, final
inclusion, unique humanity, or secret erasure. The claim issuer is trusted to issue
vouchers only for accepted receipts. Compromising this separate key could create
false badges but cannot accept a contribution or change the ceremony chain. The
contract owner can pause new mints and rotate that key; production uses a
separately managed owner EOA, kept offline. Key rotation invalidates outstanding old vouchers.

## Build and test

Install Foundry (tested with **v1.5.1**) and the workspace's Node/pnpm versions:

```sh
pnpm install --frozen-lockfile
pnpm --filter @moss/contribution-nft build:contracts
pnpm test:contracts
pnpm --filter @moss/phase2-ceremony-web test
```

Solidity **0.8.30**, OpenZeppelin **5.6.1**, optimizer 200 runs, Cancun EVM target.
Foundry compilation requires its pinned compiler download on the first run. CI has
a dedicated contract test job. Standard repository build/test commands retain
their existing behavior and do not require Foundry outside this job.

## Local browser review

After `pnpm build`, start the production web build in one terminal:

```sh
pnpm --filter @moss/phase2-ceremony-web exec next start -p 3108
```

With desktop Google Chrome installed, run in another terminal:

```sh
pnpm --filter @moss/phase2-ceremony-web test:wallet-ui
```

This uses the actual published npm SDK with a synthetic Penpal wallet iframe,
GitHub session and claim API. It checks connection, consent, approved mint flow,
onchain-confirmed display, reload recovery, desktop/mobile overflow and effective
CSP headers. It blocks external requests, creates no wallet and sends no real
transaction. Screenshots are saved to the OS temporary directory. It does not
replace a real MOSS Wallet + deployed testnet contract acceptance test.

## Provision and enable

Nothing in this branch deploys a contract, creates a signing key, changes AWS or
Vercel, or enables minting on the live ceremony.

1. Review the contract and mint policy. Test the real MOSS smart-account receiver,
   user approval/rejection, gas payment, and collectible display on testnet before
   enabling mainnet. Local EVM tests do not establish live wallet compatibility.
2. Provision a new secp256k1 signing key for this claim service in the secret
   manager. Its public address becomes the contract's `claimSigner`. Do not reuse
   manifest-root, coordinator, verifier, participant issuer or deployment keys.
   The signer needs no ETH: it signs vouchers, not transactions.
3. Prepare a funded deployment account in a local keystore/hardware wallet and
   choose the contract owner. Compute `keccak256(UTF-8 ceremonyId)` from the
   original signed manifest; this is the constructor's ceremony ID. It is not
   the manifest hash or the slug.
4. Deploy from this package directory using the public constructor arguments.
   These variable names are placeholders for reviewed settings, not secrets to
   paste into chat. `--account` selects an existing local encrypted keystore.
   Deploy the renderer first (it deploys its face renderer), then the badge
   with the renderer's address as the last argument:

   ```sh
   forge create src/BadgeRenderer.sol:BadgeRenderer \
     --rpc-url "$NFT_RPC_URL" --account moss-nft-deployer --broadcast
   forge create src/ContributionBadge.sol:ContributionBadge \
     --rpc-url "$NFT_RPC_URL" --account moss-nft-deployer \
     --constructor-args "$CEREMONY_ID_HASH" "$NFT_CLAIM_SIGNER_ADDRESS" "$NFT_OWNER_ADDRESS" false "$NFT_RENDERER_ADDRESS" \
     --broadcast
   ```

   The badge rejects an address with no code. Check that `renderer()` on the
   deployed badge returns the renderer you deployed before enabling claims.

5. Publish and verify the contract source, address, chain and constructor values.
   Configure the web service (server-only):

   | Variable | Value |
   | --- | --- |
   | `NFT_CLAIMS_ENABLED` | `true`, only once reviewed and deployed |
   | `NFT_NETWORK` | `testnet` initially; `mainnet` for a separately reviewed deployment |
   | `NFT_CONTRACT_ADDRESS` | Deployed contract address |
   | `NFT_RPC_URL` | HTTPS endpoint for the selected chain |
   | `NFT_CLAIM_SIGNER_PRIVATE_KEY` | Dedicated 0x-prefixed 32-byte secret, injected privately |
   | `NEXTAUTH_URL` | Canonical HTTPS website URL, also used for claim Origin checks |

   For local use, set `NFT_CLAIM_SIGNER_PRIVATE_KEY_FILE` instead of the inline
   variable; the file must have mode 0600. Configure exactly one of the two.
   Existing coordinator/root/OAuth settings are reused for receipt verification.
   The network and contract are returned from the server; there is no public
   client-side secret or client-selectable network.
6. Register/approve the exact site origin with MOSS Wallet if embedding requires
   it. Permit only the documented wallet iframe origin; do not enable arbitrary
   frame or RPC sources. Test passkey creation and sign-in on supported browsers.
7. Reproduce and authorize the changed web release using the ceremony release
   process before deploying it. Browser assets change even though cryptographic
   contribution processing does not. Keep the existing accepted chain intact.
8. Do a complete testnet claim using an accepted rehearsal receipt, inspect the
   onchain metadata and MOSS collectible view, retry the same claim, and test
   recovery after a reload. Production needs contract/security review and a
   documented issuer-key rotation and pause procedure.

Until configured, the claim page explains that minting is not open. Contributions,
receipts and ceremony verification continue normally. Minting is optional and
has no role in contribution acceptance or finalization. Retain the claim service
and accepted-receipt access after ceremony closing if late claims are desired.

## Branch validation record (2026-09-29)

Passed repository build, typecheck, full unit/integration tests, wizard e2e,
133 web tests, 8 Foundry contract tests, and `git diff --check`. The Chrome
SDK/iframe simulation passed on desktop and mobile viewport sizes. Contract tests
include smart-account receiver callbacks, replay attempts during callbacks and
rollback when a receiver rejects the NFT.

No contract has been deployed, no live wallet has minted, and no full-size
ceremony contribution was rerun for this UI addition. The actual MOSS passkey,
origin approval, gas payment, testnet receiver and collectible display remain
live acceptance checks before enabling claims.

The production dependency audit reports four existing high-severity findings in
the coordinator's pinned `fast-uri` 3.1.6 / 4.1.3 dependencies (not the new wallet
SDK): [authority injection](https://github.com/advisories/GHSA-qw65-cvwx-89v3) and
[host confusion](https://github.com/advisories/GHSA-58mr-gqgx-xq4g). The existing
CI audit job will remain red until those coordinator dependency overrides are
updated. This feature branch does not change those runtime dependencies.

## Company rehearsal testnet deployment (2026-10-01)

The non-transferable badge is deployed on MegaETH testnet (chain 6343) at
`0xffb913aa10a735ecc8fb2433a34f1b81323a80d2`. See the
[public deployment record](deployments/megaeth-testnet-rehearsal.json) for the
transaction, ceremony binding, owner, dedicated issuer and runtime hash. The
runtime matches the compiled source after masking Solidity immutable locations;
the constructor's immutable configuration was checked separately via RPC.
Sourcify also returned `exact_match` for the published source. This is not an
independent contract audit.

The deployment key is used only for deployment/ownership. A separate unfunded
claim key is configured privately in the rehearsal web service. Neither belongs
in the repository. The existing MOSS Wallet SDK flow issues one badge per accepted
receipt, including separate rehearsal attempts by the same GitHub account.

To test after the authorized website release is active: sign in with the GitHub
account that contributed, open an accepted receipt, choose **Collect with MOSS
Wallet**, connect a testnet wallet, consent to the public association and approve
the mint. The connected wallet needs testnet ETH for gas; funding the deployment
wallet does not fund contributor wallets. Wait for onchain confirmation, then
open the collectible in MOSS. Reloading must show the existing collectible.
Real passkey interaction and user-approved minting still require hands-on testing.
