# Rehearsal screen review release

Source commit: `318511dc35d62b2aa592e159695817b192d08d68`.

The `/review` gallery (also available at `/preview`) exposes the ceremony screens
with shareable `?screen=` links. Wallet connection, minting and collectible actions
are simulated; no wallet SDK actions or mint API calls occur in preview mode.
The real rehearsal remains finalized and participation remains closed.

All 41 browser assets matched an independent Linux build. The immutable release
and reproduction references are recorded in `published-releases.json`.
Root-authorized operational update 3 adds this browser release only. The signed
ceremony checkpoint's state, generation, head hash/length and event hash/sequence
were unchanged after applying it.

Deployment: https://zklogin-phase2-ceremony-bn0sofilq-mega-eth.vercel.app

Stable review: https://zklogin-phase2-ceremony-mega-eth.vercel.app/review

## Archive retention maintenance

The original coordinator retention deadline had expired, so S3 rejected archiving
a new authorization. The rehearsal coordinator's write retention deadline was
extended to 2026-10-21T00:00:00.000Z. Its eight canonical artifact versions had
their COMPLIANCE retention extended to meet that horizon as well. Artifact bytes,
version IDs, manifest, beacon and acceptance policy were not changed.
A coordinator restart briefly interrupted service; the first replacement failed
its retention checks before the canonical locks were extended. The replacement
then served the existing ceremony and accepted update 3.

## Validation

The source change passed `pnpm build`, `pnpm typecheck`, `pnpm test`,
`pnpm test:e2e`, and `git diff --check`. Browser checks cover gallery navigation,
deep-link reloads, simulated mint isolation, mobile overflow and runtime errors.
Cryptographic contribution/proof generation was not rerun for this UI release.

## Deployment hostname access

The coordinator allowlist now includes the exact reviewed deployment origin,
`https://zklogin-phase2-ceremony-bn0sofilq-mega-eth.vercel.app`, as well as the
existing stable rehearsal origin. Previously the signed bootstrap succeeded but
browser requests to the coordinator from this deployment hostname returned 403.
No wildcard origins were added. GitHub OAuth remains configured for the stable
rehearsal address.

Coordinator rolling deployments now use 100% minimum healthy and 200% maximum
capacity, allowing the replacement to become healthy before stopping the old
task. Steady-state desired count remains one.
