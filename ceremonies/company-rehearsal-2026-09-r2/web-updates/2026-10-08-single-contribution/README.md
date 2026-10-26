# Single-contribution verification guide

Source commit: `d8c01b7059d6ecb10d426b2b6de0b5eff844ad87`.

The public guide distinguishes authenticating one signed receipt from verifying
one artifact transition, fills in the authenticated browser release source commit,
and names the history download buttons and local filenames. It explains that
contribution N uses N−1 as its predecessor; only contribution 1 uses genesis.
The full-ceremony audit guidance was removed at the owner's request.

Stable site: https://zklogin-phase2-ceremony-mega-eth.vercel.app

Deployment: `zklogin-phase2-ceremony-8yv7m0yg2-mega-eth.vercel.app`.
Use the stable site for coordinator access and OAuth.

All 41 browser assets match the independent Linux build. Root-authorized update 5
adds this browser release only; checkpoint state, generation, head hash/length and
event hash/sequence remain unchanged.

Build, typecheck, tests, e2e and diff checks passed. The final-zkey proof tests were
not rerun for this documentation/UI change; their positive and negative coverage
is recorded in ../../FINALIZATION.md.
