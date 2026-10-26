# Full-page rehearsal walkthrough

Source commit: `7c1e747c2618f4f3b24d7e5a61cc61c39c910d17`.

Review screens use their native page layouts: normal contribution content width,
full-screen randomness, and the standalone wallet layout. A floating walkthrough
control provides Previous, Next, a screen selector, and hide/show controls.
Shareable screen URLs and simulated wallet actions are preserved.

Review: https://zklogin-phase2-ceremony-mega-eth.vercel.app/review

Vercel deployment: `zklogin-phase2-ceremony-kt86jnupk-mega-eth.vercel.app`.
Use the stable review address above for coordinator access and GitHub OAuth.

All 41 assets matched an independent Linux build. Root-authorized operational
update 4 adds only this browser release. The signed checkpoint's state,
generation, head hash/length and event hash/sequence remain unchanged.

Validation: build, typecheck, the full test suite, repository e2e suite and
`git diff --check` passed. The CLI tests initially blocked by sandbox networking
were rerun successfully after access was restored. Browser checks covered native
page dimensions, full-screen randomness, navigation, hidden controls, deep links,
preview mint isolation, mobile overflow and runtime errors. Cryptographic
contribution/proof generation was not rerun for this UI-only release.
