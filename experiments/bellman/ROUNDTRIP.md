# No-contribution genesis round trip

Question: does `genesis.zkey → Bellman .params → zkey`, without adding any
contribution, reproduce the original zkey byte for byte?

The experiment uses snarkjs 0.7.6 and the Rust-compatible infinity normalization
already used by the browser prototype. Import also takes the original genesis
zkey: Bellman is not a standalone lossless replacement for every zkey section.
The importer copies static sections, including circuit coefficients, from that
original zkey.

## Reproduction

```sh
node experiments/bellman/roundtrip.mjs
node experiments/bellman/roundtrip.mjs --production
```

The production command checks the exact genesis, R1CS and PTAU hashes/lengths
before starting. Both commands export freshly, normalize infinity encodings,
import without adding a contribution, compare entire files and every section's
payload using bounded-buffer byte comparisons, compare exported verification
keys, and run `verifyFromR1cs`. Only public hashes, sizes, section IDs and equality
results enter reports. Outputs stay in fresh ignored `runs/roundtrip-*` directories.
No live ceremony state or pinned genesis is overwritten.

The synthetic test additionally imports the raw, unnormalized Bellman export and
requires that output to be byte-identical to the normalized import. This isolates
the encoding adapter from the observed zkey round-trip difference. It does not
assert that the entire round-tripped file must equal the original: that result
is reported explicitly. It requires the verification key and all payloads other
than H to match, and full R1CS/PTAU verification to pass.

## Synthetic result

The 2,580-byte fixture has a different whole-file SHA-256 after the round trip.
Nine section payloads are byte-identical; only section 9 (H) differs. Section
order changes from `[1,2,4,3,9,8,5,6,7,10]` to
`[1,2,3,4,9,8,5,6,7,10]`. Verification keys are identical and full R1CS/PTAU
verification passes. Raw and infinity-normalized imports are byte-identical.
Final synthetic measurements: ignored `runs/roundtrip-zmUIXE/report.json`.

## Production-sized comparison

Tested the pinned Moonsong genesis without adding any contribution:

| Property | Result |
| --- | --- |
| Original and reconstructed size | 567,402,188 bytes each |
| Whole-file byte equality | **False** |
| Section payload byte equality | Nine of ten match; only H (section 9) differs |
| Section order | Same reordering of sections 3 and 4 as the synthetic test |
| Exported verification key | **Identical**, compared structurally |
| Full R1CS/PTAU verification | **Passed** |

Original SHA-256:
`f23c5dadb27613ec3d819c3cb59060804a0dc506fb6d873ab6d3ca5f8357090d`.
Reconstructed SHA-256:
`67f071e3f9723510e944bed2d8e603f13a1fc9901d24962701fd45c17b9f1fcf`.

Measurements are in ignored `runs/roundtrip-OZq4So/report.json`, with a separate
successful `compareVerificationKeys` measurement in
`verification-key-comparison.json`. The production run started with the initial
harness, which asserts every section payload is identical at the end; its
negative identity assertion must not be confused with a cryptographic verifier
failure. The current harness reports byte inequality explicitly and separately
requires unchanged non-H payloads, equal verification keys, and setup validity.

## Why a difference is expected

The pinned upstream exporter performs an FFT and scaling to express H in the
Bellman basis, then removes its last element: the quotient polynomial has degree
at most `domainSize - 2`, so the last basis element is unused. The importer pads
that missing element with the identity point, then applies the inverse conversion.
This preserves the relevant proving relation but does not restore the original
H-query bytes. This explanation comes from the conversion code; validity is
separately tested, not inferred solely from that explanation.

The importer also writes sections 3 and 4 in a different order from `newZKey`.
Reordering them alone would change the whole-file hash, but **does not explain
all the differences**: H section 9 changes too.

Source: pinned local snarkjs 0.7.6 `src/zkey_export_bellman.js` (H conversion and
last-element removal), `src/zkey_import_bellman.js` (identity padding, inverse
conversion and static-section copies), and `src/zkey_verify_frominit.js`
(`sameRatioH` samples a zero last quotient coefficient).

## Implication for the public ceremony

Do not call Bellman conversion byte-lossless or publish the reconstructed zkey
under the original genesis hash. Preserve and pin the original genesis; record
separate hashes for Bellman transport and reconstructed zkeys. Unchanged
verification keys and successful validity checks establish different properties
from identical artifact bytes. Existing exact-predecessor acceptance and format
conversion review remain necessary before integrating Bellman into production.

## Validation

Synthetic and production-sized setup validity checks passed; the byte-identity
hypothesis failed for both. The synthetic raw/normalized import control and
both verification-key equality checks passed. Repository `pnpm build`,
`pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, and `git diff --check` passed.
No hosted/browser acceptance or real-proof generation was rerun for this test.
Artifacts remain local and ignored; no ceremony state or production code changed.
