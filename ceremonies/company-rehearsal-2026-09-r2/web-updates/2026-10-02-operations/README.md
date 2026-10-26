# Audited operational updates and verification guidance

Source: `d3bd60f5ad36c3f7ab67d68ef43741dc5198d816`.
Deployment: `dpl_A6rXZxKWyrqCxajXBu2dTKq3XnxK`.
[Immutable web deployment](https://zklogin-phase2-ceremony-q9yqaepgn-mega-eth.vercel.app).

This release makes the history pagination compact, replaces the stale Bellman
preparation message with local-client and download guidance, and adds direct
genesis downloads and predecessor-receipt guidance to local verification.

The coordinator now supports root-signed, append-only operational updates for
bounded heartbeat changes and additional authorized browser releases. See
RUNBOOK.md for the signing, submission and verification workflow. Migration
006 completed successfully before the new coordinator started. The immutable
coordinator image is recorded in coordinator-image.json. The existing
supplemental rehearsal authorization remains available for the previous site.

Operational update 1 authorizes this reproduced browser release only. The
ceremony was already SEALED when it was applied. It does not change heartbeat
grace, schedule, beacon or cryptographic acceptance policy, and does not reopen
contributions. The five-minute rehearsal grace remains unchanged. Finalization
was not triggered by this deployment.

The root-signed update and public applied history are included here. Authorization
and order are signature-authenticated; application timestamps and archive pins
in the history are coordinator-reported. The version-pinned public archive copy
was downloaded and its hash and envelope checked against the applied update.

Rollout checks confirmed zero active queue tickets, leases and submissions both
before and after coordinator drain. AWS completed the stack update with one
running coordinator and no pending tasks. The original signed manifest and
generation-7 accepted head remained unchanged:

- Manifest payload SHA-256: `b6fd9543e3ebacfb8fab7b43ccdbb3670d1e16552bf6a8b494c44efdc65a6289`.
- Accepted head SHA-256: `68b6997ed5aec31231f0e162d132ec9bf84dc8a316a342e5466e9870eb3beb3d`.

Build, typecheck, full tests, e2e and whitespace checks passed before rollout.
Real PostgreSQL integration tests covered update persistence, immutability,
concurrent updates, archive failure rollback, lease grace behavior and web-only
updates after sealing. All 37 browser assets matched the independent Linux
AMD64 reproduction. The staged bootstrap selected the new authorized release
before promotion to the stable site.

Live Chrome checks passed with the actual public coordinator and normal CSP:
seven accepted entries, five per page, next/previous navigation, corrected
Advanced guidance, the verification-screen genesis link and no mobile overflow
at 390px. Desktop and mobile screenshots were inspected. The documented offline
receipt command also verified the public receipt for contribution 7.

No new full-artifact contribution, full-size native transition verification,
wallet transaction, background-tab run or Safari/Firefox hardware matrix was
performed for this deployment. Operational heartbeat changes were tested in
integration tests; no live heartbeat change was applied to the sealed rehearsal.
