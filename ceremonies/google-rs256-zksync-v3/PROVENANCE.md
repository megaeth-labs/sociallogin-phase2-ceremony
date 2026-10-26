# Recorded circuit and build provenance

Recorded 2026-09-22 from the existing MOSS circuit verification report. This
records completed work; it does not request another circuit correlation from
the ceremony owner.

## Source and compilation profile

- Upstream source: `Moonsong-Labs/zksync-social-login-circuit`, revision
  `5461ae81208d7e9d6331865b4a8c841546134018`.
- MOSS integration revision: `b6dbfd1eb07281adac61ab25d1c09c4934d1bc80`.
- Vendored source SHA-256:
  `e019eb42112d2b9295ce06f2bf1c4b7993cc1b9664299a50f29a5aed6ab13ddf`.
- Recursive include closure: 46 files, SHA-256
  `53268998b4edd328bc5b8e205760a95f9a601c012f4ace741418a3bc0bdf2ac0`.
- Dependencies: `@zk-email/circuits` 6.3.2 and `circomlib` 2.0.5.
- Selected compilation profile: Circom 2.2.3, explicit `--O2`, BN254.
- Reproduced R1CS SHA-256:
  `173eba6b9b7883bb8e761f69f902c334b14cea61a094eba7466f0f548d601692`.
- R1CS dimensions: 960,780 constraints, 941,659 wires, 20 public inputs.

The existing report records that independent Circom 2.2.2 and 2.2.3 builds
produced byte-identical O2 R1CS files. The ceremony selects the 2.2.3 profile.

## Existing ZKsync public-test artifact correlation

The existing report records successful `snarkjs zkey verify` using the
reproduced O2 R1CS and the following public test artifacts:

| Artifact | Public location | SHA-256 |
| --- | --- | --- |
| ZKsync public test zkey | `https://storage.googleapis.com/test-sso-oidc-recovery/jwt-tx-validation.final.zkey` | `503b85338f7a1cfb6acbdfd107a6daefbdbc5407522d8ae568aa95d76f61df5d` |
| Upstream Phase 1 file | `https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_20.ptau` | `560412532a1205145d5f21585274fb2cef61273496ddc7186aec855aab01a8cd` |

The recorded verification returned `ZKey Ok!` and reproduced the public
circuit/setup hash:

```text
5d891e08e13ca0593f4a99bc1dbfaf65268e2112ab288f3b8be2d4100bc5bac90bf8f0969ee5495ac8b7ace65e1a070337a0d9e4bd132d6255f671d9ca593a04
```

These are correlation references, not this ceremony's genesis or PTAU. The
ceremony's power-24 PTAU and zero-contribution genesis remain those pinned in
[definition.draft.json](definition.draft.json). No artifact was downloaded,
inspected, or regenerated to transcribe this report. This correlation does not
assert that a deployed Solidity verifier matches, or that the public test
ceremony is suitable for production.

## Pinned compiler release

On 2026-09-22, downloaded the official [Circom v2.2.3 release](https://github.com/iden3/circom/releases/tag/v2.2.3)
Linux AMD64 executable and independently calculated its SHA-256 and byte length.
Both match the release asset metadata returned by GitHub.

- File: `circom-linux-amd64`.
- SHA-256: `85342c7ff332d948df7c0c50ecf201e6129349aef550ce873f3c811b79fe53a3`.
- Byte length: 13,145,432.
- GitHub release asset ID: `309324748`.
- Release source commit: `ad44e915a12bb047b05745c2884aad9cc8326bc6`.
- Download: `https://github.com/iden3/circom/releases/download/v2.2.3/circom-linux-amd64`.
- Compilation profile: `--O2`, BN254, the source/dependency closure recorded above.

This is an optional compiler for reproduction on Linux. Its digest is now
recorded as `circomBinarySha256` in the draft definition. The executable is
cached outside the repository; only public release metadata is recorded here.

The earlier report did not identify its executable. This release pin is not a
claim that the historical build used these exact executable bytes. The Linux
compiler was downloaded and hash-checked on a macOS ARM64 host; no compilation
was run in this step. `circomBinaryReproductionVerified` is `false` to record
that this optional reproduction was not performed; it is not a launch gate.
The existing Mac-built, verified R1CS remains authoritative. A Linux rebuild
is not required. Binding the recorded O2 compilation profile into the signed
manifest remains engineering work.

## Existing verification report provenance

The source report is `circuits/zksync-social-login-v3/README.md` in the adjacent
MOSS checkout. Its correlation section was an uncommitted local change when
recorded, so the integration commit above is not claimed to contain that report.
The report's SHA-256 at transcription is recorded below for identification.

`d15f71addc1b5e2d87824d2c31608a39bf22236eae2a623aebc63989640abf6e`

The existing report establishes the previously recorded circuit correlation.
The new compiler release pin and its verification status are documented
separately above; neither asks the ceremony owner to repeat that correlation.
