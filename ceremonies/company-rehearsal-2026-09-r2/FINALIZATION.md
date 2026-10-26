# Company rehearsal finalization — 2026-10-04

Cryptographic finalization, published-artifact checks, and fresh proof tests passed.
This is rehearsal material and must not be used as production proving material.

## Published outputs

- [Final artifact index](https://d1lqbpxesw1yqu.cloudfront.net/finalization/bf4e9f78-441b-4a24-96c1-b7990e77e150/2026-10-03/sha256/69146a214e9338b22835a47b6819d4549dbb0770d4121e5c8265a4cabad0826c/publication-index.json?versionId=M6JS2vPpab4vtY8j8S3JcZ1GX9Ntnmr2) — SHA-256 `69146a214e9338b22835a47b6819d4549dbb0770d4121e5c8265a4cabad0826c`.
- [Final zkey](https://d1lqbpxesw1yqu.cloudfront.net/finalization/bf4e9f78-441b-4a24-96c1-b7990e77e150/2026-10-03/sha256/eb73e75d9e1108e7a1b6323431ef5d7cf23b0b1ada6eeda5784343fc1c647f69/final.zkey?versionId=deaag2F6NiF8t7jHM_fh1MnvRCo1z5.3) — 567,405,389 bytes; SHA-256 `eb73e75d9e1108e7a1b6323431ef5d7cf23b0b1ada6eeda5784343fc1c647f69`.
- [Proof test evidence and sample proofs](https://d1lqbpxesw1yqu.cloudfront.net/finalization/bf4e9f78-441b-4a24-96c1-b7990e77e150/2026-10-03/sha256/1ca59abd5720f8722dea1c61a2dd77bf0c0dd8c198a4350e4c7887bc2496a7b3/proof-verification-index.json?versionId=el07syxnuZe4ZAQprsPm38dVaTTGNWIO) — SHA-256 `1ca59abd5720f8722dea1c61a2dd77bf0c0dd8c198a4350e4c7887bc2496a7b3`.

The artifact index pins the verification key, Solidity verifier, imported sealed
key, beacon evidence, finalizer summary and ceremony audit metadata by hash,
byte length and immutable S3 version. The proof index includes the machine-readable
checks and two freshly generated proofs with their public signals. Both indexes
and the evidence were downloaded and hash-checked after publication.

## Checks completed

- All seven ordinary contributions passed native Bellman transition replay.
- Root-signed authority, receipt links, transcript chain, publication bundles,
  verifier policy/signatures and historical browser-release authorizations passed.
- The sealed Bellman chain was imported into the pinned genesis zkey and passed
  exact circuit/PTAU verification before the beacon.
- Ethereum mainnet block 26,108,000 supplied the committed beacon. Exactly one
  beacon contribution was appended with the rehearsal's immutable exponent 32.
- Final circuit/PTAU verification returned true at 2026-10-04 02:46:14 UTC.
  The verification key and Solidity verifier were exported successfully.
- Published final and imported zkeys were independently streamed and hashed;
  summary, authority, beacon and transition-replay bindings passed.

## Fresh proof test

Recompiled the pinned source/dependency closure with Circom 2.2.3 `--O2 --r1cs
--wasm`. The new R1CS is byte-identical to the ceremony's pinned R1CS:
`173eba6b9b7883bb8e761f69f902c334b14cea61a094eba7466f0f548d601692`. The include-closure hash is
`53268998b4edd328bc5b8e205760a95f9a601c012f4ace741418a3bc0bdf2ac0`.
The official macOS compiler binary SHA-256 is
`e006332b3fe225f11c3b87bd2debbf5d7f568d6efbde25e5a6a12cd6988c8ecb`.
The generated WASM SHA-256 is `becc9739324256bd373acc8f46dafc8c0ebdf32f3b11cd0be5f51b7864f5d08e`.

Used the existing synthetic `moss-prover-challenge-participant/public-fixture`
input and its expected output array. Input SHA-256:
`730296e28d64e3f350e002dec7df326e522ae8c89c24f25c27a2e83a2c13f918`. This is one fixture, with two fresh prover
randomizations; it does not claim coverage of the challenge's hidden fixtures.
No challenge proving key or old O1 witness was used.

With snarkjs 0.7.6:

1. Generated a fresh O2 witness and checked it against the pinned R1CS.
2. Exported the verification key from the downloaded final zkey and matched it
   against the published verification key.
3. Generated two distinct proofs; each verified and matched all 20 expected
   public inputs. Proving plus verification took approximately 54 seconds each
   locally using the single-thread proving option.
4. Rejected each of 20 individually modified public inputs and a proof with its
   G1 A point negated.

Compiled the exact exported Solidity verifier with solc 0.8.28 and exercised it
in Foundry's local EVM. All four tests passed: valid proof acceptance, rejection
of all 20 individually modified inputs, rejection of the negated proof point,
and rejection of an out-of-field public input. No contract was deployed to a
network.

## Publication recovery and remaining integration work

The AWS worker failed during ancillary publication after cryptographic checks
and all six final output uploads had succeeded. Recovered publication by reusing
those immutable S3 versions, publishing missing metadata and creating a new
content-addressed index. No contribution, beacon commitment or final key changed.
The failed worker event remains in its audit logs; recovery is recorded separately.
Publication retries should be made idempotent before production.

The finalization and verifier tasks are no longer running; the coordinator remains
online. The coordinator checkpoint remains SEALED. The completion UI now verifies the
[root-signed offline completion record](finalization.signed.json) against the live
sealed checkpoint and manifest before displaying the final artifacts. This does
not rewrite coordinator state or claim a coordinator FINALIZED transition. No
database state was manually changed. The record is rehearsal-only and is rejected
for production manifests, different chains, mismatched beacons or invalid signatures.

An independently administered audit, network deployment/runtime-bytecode check,
and broader fixture/browser matrix were not performed. The broad application
build/typecheck/test/e2e suite was not rerun for this operational proof check and
report-only commit. Focused real-artifact checks above and `git diff --check` passed.
