# Replacement company rehearsal

**Completed October 4, 2026.** The final key passed circuit/PTAU verification,
fresh proof tests and local Solidity verification. The live site now displays
root-verified completion and final downloads. See the [finalization report](FINALIZATION.md)
and [completion UI release](web-updates/2026-10-04-completion/README.md). The coordinator
retains its sealed contribution checkpoint; completion is attested separately.

## Rehearsal launch history

This epoch replaces the empty September 26 rehearsal to pin the corrected browser
readiness check and explicit “Proceed with ceremony anyway” override. The original
signed manifest and database are retained. The replacement is live: the verifier
was ready at 21:44 UTC on September 28, and the stable website passed its readiness
and override interaction checks. No contribution was submitted by these checks.

[Signed manifest](manifest.signed.json), [public root](ceremony-root.pub),
[browser assets](web-release.json), [reproduction](web-reproduction.json). All 60
assets matched an independent Linux build. Root SPKI SHA-256:

```text
4e81f8e31db69ade19ddea3cf8acb4897cdf94a633c07d4db940a4d4e2ce7521
```

The website has [root-authorized UI updates](web-updates/2026-10-02-pagination/README.md)
for MOSS branding, optional testnet collectibles and rehearsal repeat participation,
in addition to clearer progress, pending-contribution recovery and receipt history. The original manifest and
accepted contributions remain unchanged. After leaving the waiting screen, return
to the landing page and choose **View contribution progress**. Accepted entries
provide **View receipt**, including after signing back in.

Use the [stable site](https://zklogin-phase2-ceremony-mega-eth.vercel.app). On the
readiness screen, click **Check browser & storage**. The result estimates browser
storage quota and feature availability; it does not measure RAM or promise that
a contribution will finish. Browser quota can be lower than free disk space.
Both browser and local clients need disk space for input and output files.

After a failed check, select **Proceed with ceremony anyway** to attempt the
contribution. This bypasses the advisory checks at queue entry and in the worker;
actual file operations, entropy generation, artifact hashes and verification
still apply. Rerunning the check clears the override.

Contributions close October 2, 2026 at 18:00 UTC. The committed Ethereum beacon
block remains 26,108,000, strictly after closing. One internal verifier and the
primary immutable archive are used for this rehearsal.

## Contribute and invite collaborators

1. Sign in with GitHub, choose **Check readiness**, then click **Check browser &
   storage**. Keep the computer awake and confirm the two acknowledgements.
2. If the check fails and you want to try, select **Proceed with ceremony anyway**.
   Choose **Continue to contribution setup**, complete the setup and join the queue.
3. Claim your offered slot within two minutes. Keep the tab in the foreground
   and your computer awake through download, computation and upload. Once server
   verification begins, you can leave and check back later. The active slot lasts
   at most 90 minutes.
4. After acceptance, download your receipt and confirm your history entry. Then
   invite the second and third contributors using their own GitHub accounts.

The site is password-protected. Ask the organizer for the shared rehearsal password;
GitHub participant sign-in remains separate. Finalization
is an operator step after closing and beacon finality; it is not automatic at
block time. The rehearsal key is not a production deployment key.

## Repeated participation during rehearsal

The rehearsal UI/backend update allows another sequential attempt after an
accepted contribution from the same GitHub account. The page identifies this as
rehearsal-only functionality. Each attempt gets a fresh queue ticket, predecessor,
randomness, verification and signed receipt. Existing receipts remain available;
no accepted artifact or original manifest is rewritten. Production still enforces
one accepted contribution per account. The signed total cap of ten accepted
contributions and October 2 closing time still apply, including repeat attempts.

The backend requires database migration `005_rehearsal_repeat_contributions.sql`.
It preserves historical contribution rows and production identity uniqueness.
The browser release must be authorized before rollout, as for earlier UI updates.

## Rehearsal heartbeat grace

As of October 2, active rehearsal slots tolerate five minutes without a heartbeat.
This is a documented rehearsal-only relaxation of the original manifest's
15-second allowance; that original manifest and accepted history are preserved.
The 90-minute slot deadline and closing time are unchanged. An expired slot
cannot be revived: return to the ceremony, check for an already submitted or
accepted contribution, and otherwise rejoin for a fresh slot. The foreground-tab
advice remains because browsers may suspend or discard background pages.
