# Wallet embedding referrer fix

Source: `7e2ebb47d73e8e90889a92f9f4f59f5bc51a0d75`.
Deployment: `dpl_Gx3LdZLqyixpb4vghpiU6gZ1Cun7`.
[Immutable deployment](https://zklogin-phase2-ceremony-jpw6gzmu9-mega-eth.vercel.app).

The collectible document inherited `Referrer-Policy: no-referrer`. MOSS Wallet
identifies its Penpal peer from `document.referrer`; an empty referrer prevented
the handshake and caused the SDK's 15-second initialization timeout. Testing
the real production wallet reproduced the timeout with the old header and
opened the wallet's Sign In / Create Account screen with an origin-only referrer.

Only `/collect` now overrides the header to `strict-origin`. The wallet receives
only the embedding origin, never the receipt ID, URL path or query. Contribution
pages retain `no-referrer`, `frame-src 'none'` and full document navigation to the
collectible. No SDK version, wallet allowlist, contract or verifier changed.
The earlier synthetic wallet fixture hard-coded its peer origin and missed this
requirement; it now asserts the actual origin-only `document.referrer` before
establishing Penpal.

The full build, typecheck, unit/integration and e2e checks passed, including 134
web tests. Chrome exercised the actual npm SDK against the updated synthetic
wallet for approval/confirmation and reload recovery, and separately connected
to the real production MOSS Wallet using synthetic ceremony authentication.
No passkey login, transaction signing, NFT mint or full-size contribution was
performed by these checks. Safari/Firefox were not rerun.

All 37 served browser assets match the independent Linux AMD64 build. The new
root-signed authorization and immutable archive references are recorded here.
The coordinator was drained after zero-activity checks and restarted to load the
authorization; its image, signed manifest, database and accepted artifacts were
preserved.

This follows the [branding, wallet and rehearsal-repeat release](../2026-10-01/README.md).
After restart the coordinator served the new authorization with the original
manifest and generation-four accepted head unchanged. The fixed deployment was
promoted to the stable rehearsal domain.
The live-domain check also passed against the real `account.megaeth.com` wallet:
origin-only referrer, successful handshake, and Sign In / Create Account visible.
