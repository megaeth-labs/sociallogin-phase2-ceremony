# Clearer readiness instructions

Source commit: `8f0ccbbd57b8946744d0a92e35d0c90afe036ed4`.

Readiness instructions now separate the time estimate, keeping the tab visible
through upload, and leaving during server verification. The requested disk/RAM
and local-client storage notes were removed.

Stable site: https://zklogin-phase2-ceremony-mega-eth.vercel.app/review?screen=readiness

Deployment: `zklogin-phase2-ceremony-dtsszkp62-mega-eth.vercel.app`.
Use the stable site for coordinator access and OAuth.

All 41 browser assets match the independent Linux build. Root-authorized update 7
adds this browser release only. Ceremony checkpoint state, generation, head
hash/length and event hash/sequence remain unchanged.

Build, typecheck, tests, e2e and diff checks passed. Live browser checks confirmed
the new instructions, removal of both requested notes, no mobile overflow and
no runtime errors. Real-artifact contributions and cryptographic proof tests were
not rerun for this copy/layout-only update.
