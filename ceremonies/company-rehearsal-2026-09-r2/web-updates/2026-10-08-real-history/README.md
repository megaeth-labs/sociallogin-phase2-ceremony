# Real rehearsal history in the walkthrough

Source commit: `0ac8eb16ee266e9cc988371b0c24d6e747304556`.

The walkthrough uses the live contribution history component and real signed
rehearsal records, with a note distinguishing these from simulated participation
states. Cards include acceptance timestamps, verification details and downloads.

Stable site: https://zklogin-phase2-ceremony-mega-eth.vercel.app/review

Deployment: `zklogin-phase2-ceremony-g3wdhe3ib-mega-eth.vercel.app`.
Use the stable site for coordinator access and OAuth.

All 41 browser assets match the independent Linux build. Root-authorized update 6
adds this browser release only; checkpoint state, generation, head hash/length and
event hash/sequence remain unchanged.

Build, typecheck, tests, e2e and diff checks passed. Live browser checks covered
seven records paginated five/two, expanded verifier details, signed receipt
download, artifact link presence, mobile overflow and absence of runtime errors.
Cryptographic proof tests were not rerun for this UI-only change.
