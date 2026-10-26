# Completed rehearsal UI

Source: `23adb86c10ab97569d87a3e14dfe4c48f7eb912d`.
Deployment: `dpl_5oqGnEFQ4gWuBnYPnVJLXuNwMe4F`.
[Immutable deployment](https://zklogin-phase2-ceremony-e435lz21w-mega-eth.vercel.app).
[Stable ceremony site](https://zklogin-phase2-ceremony-mega-eth.vercel.app).

The homepage shows **Rehearsal complete**, the final zkey, verification key,
Solidity verifier, immutable artifact index and proof-test evidence. An expandable
section supplies the final key hash, beacon details and signed completion record.
The closed participation flow and seven accepted contribution receipts remain.

Before displaying completion, the browser verifies the separate manifest-root
signature and binds the record to the actual manifest hash, sealed head, event
hash/sequence, contribution count and beacon commitment. Production manifests and
conflicting checkpoints are rejected. This is an offline operator attestation;
the website does not rerun cryptographic finalization and does not change the
coordinator's SEALED checkpoint to FINALIZED.

Root-authorized operational update 2 changes only the browser release. Its public
history was fetched and verified, and the sealed checkpoint fields were compared
before/after authorization. No database edit or coordinator restart was required.
All 37 browser assets matched the independent Linux AMD64 build.

Validation: build, typecheck, full tests, e2e and whitespace checks passed, with
18 focused lifecycle/signature/rendering tests passing after the final changes.
Chrome checks on the stable deployment confirmed the signed completion view,
all five immutable download URLs, exact completion-record download, all seven
accepted contributions with five/two pagination, and a 390px layout without
horizontal overflow. No browser runtime errors occurred. Desktop and mobile
screenshots were inspected. The existing site protection remains enabled.

No new full-artifact contribution or Safari/Firefox hardware run was performed
for this closed-ceremony presentation update. Real final-key proof and Solidity
verification results are recorded in [the finalization report](../../FINALIZATION.md).
