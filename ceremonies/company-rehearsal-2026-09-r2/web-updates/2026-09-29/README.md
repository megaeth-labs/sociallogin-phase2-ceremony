# Rehearsal contribution-progress UI release

Source: `83a7b8fc625edf60041c2a3585aa04ab0b3b4dda`.
Live deployment: `dpl_J7z7PWGgtKd8Rt4N4z5EYwkiLnKR`.

This release adds a 5–10 minute contribution estimate excluding queue time,
measured per-step download and integrity-check percentages, and an indeterminate
computation indicator. Bellman computation emits start/end events only; no
percentage or remaining-time countdown is invented. The input integrity check
after computation remains in the contribution stage instead of reverting to
“downloading”. Upload and server verification remain indeterminate.

- [Root-signed authorization](web-release-authorization.signed.json)
- [Browser asset hashes](web-release.json)
- [Independent build reproduction](web-reproduction.json)
- [Immutable archive references](published-releases.json)

All 60 deployed browser assets matched the independent Linux AMD64 build.
The reproduction used a clean Git archive and the frozen dependency lockfile,
with dependency cache from the previous independent build.

The authorization binds the unchanged original manifest and root key. It
supersedes the September 28 supplemental authorization; both published release
records remain available for receipt audits. The original manifest-pinned browser
release remains authorized. This mechanism is rehearsal-only.

Build, typecheck, full repository tests, wizard e2e checks and whitespace checks
passed. This update does not repeat a full-size contribution or establish the
supported-browser/hardware matrix.

The deployment is promoted to the [stable ceremony site](https://zklogin-phase2-ceremony-mega-eth.vercel.app).
Read-only aggregate checks before and after draining the coordinator confirmed
zero queued/offered/leased tickets, active leases or pending submissions. The
coordinator was briefly stopped to prevent new attempts during authorization
replacement, then restored to one task using its existing image. The verifier
was not restarted. The original manifest and generation-two accepted head
matched before and after activation.

Chrome checks on both staged and stable URLs passed the signed bootstrap,
5–10 minute guidance, real readiness probe, explicit failed-check override,
pending-contribution recovery, detach and refresh. Authentication and pending
state were synthetic; no contribution or lease was created. Live release-policy
checks confirmed original/new labels remain allowed and an unlisted label is
rejected. Password protection still covers all deployments. Existing open tabs
should reload before starting another contribution.
