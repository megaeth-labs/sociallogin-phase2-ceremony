# MOSS ceremony design pass

The ceremony is a MOSS Wallet product. This pass brings its public lobby,
contribution journey, account controls, history, verification and collectible
screens into the wallet's visual language. It builds on the wallet/NFT branch;
no deployment, ceremony policy, OAuth or contribution protocol changed.

## References reviewed

- [MOSS connect](https://account.megaeth.com/connect): live desktop browser;
  rounded light surface, deep green controls, restrained sans-serif type,
  MOSS wordmark and rabbit artwork.
- [MegaETH](https://megaeth.com): live desktop browser; MegaETH mark and clear
  product identity. The wallet is the primary reference for application controls.
- [MOSS](https://joinmoss.megaeth.com): live desktop browser; wordmark and
  approachable product voice.
- [MegaETH documentation](https://docs.megaeth.com): live desktop browser;
  readable information hierarchy and progressive technical detail.
- `megaeth-labs/wallet-design-system`: tokens, fonts and Button / AssetsListCard
  components in local revision `92e2af335f1ba007a2fd68c2c23fcc949407e19d`;
  checked against the 0.1.18 worktree at
  `bbbe9929ce4b480dbc27e330dee3367d1945f74b`. The relevant palette and family match.
- `megaeth-labs/wallet`: connect and HomeScreen dashboard source at
  `e09e975475e5276e7691c6a53bdb6adb17d745f8`. The authenticated dashboard was
  reviewed through source/components, not a connected personal wallet.
- Figma connection is available, but a wallet file/frame URL was not supplied.
  No claim of Figma component parity is made pending that reference.

## Assets and implementation

`apps/ceremony/public/brand/moss.svg` and `mega.svg` come from the wallet's
`public/images/logo.svg` and `mega.svg`. `rabbit.webp` is a static frame at two
seconds from `rabbit-browsing.webm`, resized to 720px wide and compressed to
approximately 62 KB. It is decorative and has empty alt text. The static asset
avoids an animated video competing with contribution work.

Helvetica Neue Light, Roman, Medium and Bold are copied from the existing wallet
design system and self-hosted with Next's local font loader. These are existing
company product assets; their upstream font/brand terms continue to apply.
They are not relicensed by this project.

The ceremony retains its small React/CSS-module components. Only the relevant
wallet tokens and styles are adapted; importing the whole component package
would also introduce its Tailwind reset, motion and Lottie dependencies.
Focus rings, readable line heights, reduced-motion support and existing native
controls remain. The collectible art itself is unchanged to remain consistent
with the contract's onchain artwork.

## Local review

Run `pnpm --filter @moss/phase2-ceremony-web dev --port 3110`, then open
<http://localhost:3110/preview>. The development-only preview labels all data as
simulated and lets reviewers visit readiness, queue, offer, expired offer,
download, computation, upload, verification, accepted, sealed, finalized and
error states. It does not reserve a real slot or make a contribution.

Release still requires the signed web-release procedure. A visual pass is not
real-artifact browser acceptance, and no live rehearsal was changed.

## Validation (2026-09-30)

- `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, and
  `git diff --check` passed. Web suite: 133 tests; the root e2e command covers
  the setup wizard, not a real ceremony contribution.
- Chrome preview checks visited all 13 selectable states at 390, 768 and 1440px
  with reduced motion: no horizontal overflow or page errors. Readiness remained
  disabled until checks/acknowledgements; computation remained indeterminate.
- `pnpm --filter @moss/phase2-ceremony-web test:wallet-ui` passed against the
  production build: actual npm SDK with synthetic wallet/RPC, explicit approval,
  confirmed status/reload recovery, scoped CSP and desktop/mobile layouts.
- Full-artifact contribution, real wallet minting, Safari/Firefox and live signed
  release deployment were not performed for this visual-only change.
