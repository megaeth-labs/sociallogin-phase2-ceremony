# Company dress rehearsal

This epoch is superseded by the [replacement rehearsal](../company-rehearsal-2026-09-r2/README.md)
for the corrected readiness check and explicit override. Its manifest is retained
for audit; no ordinary contributions were accepted.

The [signed manifest](manifest.signed.json) is published, the coordinator and
verifier are ready, and the stable website is open for the first rehearsal
contribution as of September 26, 2026. This is a rehearsal with one internal verifier and a
coordinator-signed primary archive, not an independently witnessed production
ceremony.

Public manifest-root key: [ceremony-root.pub](ceremony-root.pub).
Ed25519 SPKI DER SHA-256 fingerprint:

```text
4e81f8e31db69ade19ddea3cf8acb4897cdf94a633c07d4db940a4d4e2ce7521
```

The committed Ethereum mainnet beacon is block **26,108,000**. Contributions close
**October 2, 2026 at 18:00 UTC**; the beacon is projected no earlier than
**22:58:23 UTC** that day. Missed Ethereum slots delay it. The signed
manifest is authoritative for the schedule and all artifact pins.

[web-release.json](web-release.json) lists the 60 pinned browser assets.
[web-reproduction.json](web-reproduction.json) records their source commit,
Vercel deployment ID and public build inputs. A clean Linux AMD64 rebuild
matched every deployed asset. Automatic Vercel Git builds are paused while this
release is pinned; repository pushes do not deploy a new browser build.

See [deployment status](../../infra/aws/REHEARSAL_STATUS.md) for live checks and
remaining launch work. No private keys, tokens, or binary artifacts belong here.

## First contribution and collaborator handoff

Readiness checks passed. Use the stable
[rehearsal website](https://zklogin-phase2-ceremony-mega-eth.vercel.app), not a
preview deployment URL. Vercel deployment protection is separate from GitHub
participant sign-in; invited testers may need access to the Vercel project.

1. Open the site in desktop Chrome, sign in with your own GitHub account, and
   confirm the displayed account. Keep the computer plugged in and awake.
2. Continue through the browser/storage check. The initial Bellman input is
   368.4 MB; the website checks space for input, output and working headroom.
3. Join the queue. Claim the offered slot within two minutes, then keep the tab
   open while it downloads, computes, uploads and waits for server verification.
   The maximum active contribution window is 90 minutes.
4. Wait for acceptance and download your signed receipt. Confirm that your entry
   appears in contribution history and that the count increases to one.
5. After the first complete pass succeeds, invite the second and third testers
   using separate GitHub accounts. They can join together to exercise queueing;
   each receives the latest accepted artifact when their slot is offered.

If the flow fails, retain the receipt if available and report the stage and
public error text. Do not share browser tokens, signed upload URLs or entropy.
Avoid clearing browser storage while investigating a recoverable attempt.

The rehearsal allows at most ten ordinary accepted contributions and closes at
the signed deadline above. It is not finalized automatically when the beacon
block arrives: after sealing and Ethereum finality, the operator independently
checks the block hash, converts the terminal Bellman transcript to zkey, applies
the committed beacon, verifies the result and publishes the final exports.
This is a rehearsal; its resulting key is not a production deployment key.
