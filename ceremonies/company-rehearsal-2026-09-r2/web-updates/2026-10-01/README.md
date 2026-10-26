# MOSS design, wallet collectible and rehearsal repeats

Released source: `a4068174c3497b5fbccbae771a560d7c389b89c7` (merged into main).
Vercel deployment: `dpl_5hoMeeUJvtLKe99qJh5zT8HAg7QH`.
[Immutable deployment](https://zklogin-phase2-ceremony-o7ahwb6ih-mega-eth.vercel.app),
[stable site](https://zklogin-phase2-ceremony-mega-eth.vercel.app).

All 37 browser assets matched an independent Linux AMD64 build. The root-signed
supplemental release authorization and version-pinned archive references are
alongside this record. The original signed manifest is unchanged. The new
coordinator image is recorded in `coordinator-image.json`; the CloudFormation
coordinator image parameter was updated. The verifier image remains unchanged.

Migration 005 was applied through the scoped AWS migration task. The coordinator
was stopped only after aggregate activity checks found no queued/offered/leased
participants or pending verifications. A second check after stopping confirmed
zero active work. After restart, the canonical head was still generation 3 with
SHA-256 `4e7b54ea62f62b6d4fa5615aed01c50ca9b5cb78f266aebc706976c81b75fd12`.
The manifest hash remained
`b6fd9543e3ebacfb8fab7b43ccdbb3670d1e16552bf6a8b494c44efdc65a6289`.

## Behavior

- The interface uses MOSS Wallet/MegaETH typography, colors and brand assets.
- Rehearsal participants may join another sequential attempt after acceptance.
  A notice explains that repeat contributions are rehearsal-only. Each attempt
  resets queue idempotency and recovery identifiers after saving the verified
  receipt. The signed ten-contribution total cap and closing time still apply.
- Production retains identity uniqueness at both queue admission and the database.
- Accepted receipts link to the MOSS Wallet collectible page. The separate
  testnet badge contract and issuer configuration are enabled for this rehearsal.
  See [deployment and mint instructions](../../../../packages/contribution-nft/README.md).
- Wallet connection, public-address association and minting require explicit user
  actions. The connected wallet pays testnet gas. No contribution secrets or
  ceremony signing keys are shared with the wallet or collectible issuer.

## Validation

Repository build, typecheck, unit/integration tests, wizard e2e and whitespace
checks passed, as did 134 web tests, 29 database tests and eight Solidity tests.
An isolated PostgreSQL test exercised the real migration: existing rows survive,
rehearsal repeats work and a forged exemption flag cannot bypass production
uniqueness. The deployed contract matched local runtime and Sourcify exact-match
verification.

Chrome checked the deployed signed bootstrap, readiness override, pending
recovery, detach/reload and the repeat notice with a real public signed receipt
and synthetic authentication. Those browser checks did not submit contributions.
The actual npm Wallet SDK also passed the synthetic wallet approval/confirmation,
reload and desktop/mobile layout checks locally. A human passkey login and
user-approved live testnet mint remain to be tested; no full-size contribution or
Safari/Firefox acceptance run was repeated for this release.

The stable domain was promoted and both live browser checks passed. CloudFormation
reached `UPDATE_COMPLETE` with one healthy coordinator. During the first live
check, an in-flight request at browser teardown exposed the automation bypass
header in a library diagnostic. That Vercel test-access token was revoked and
regenerated; the old token now returns HTTP 401. The test harness now drains its
routes and suppresses private diagnostics. No wallet or ceremony signing key was
involved, and the site's password protection remains enabled.
