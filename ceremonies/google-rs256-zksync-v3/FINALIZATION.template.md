# MOSS Google RS256 Phase 2 finalization — <YYYY-MM-DD>

<!--
Template for the production write-up. Copy to FINALIZATION.md, run the steps
below in order, and replace every <placeholder>. Delete a section only when the
step genuinely did not run, and say so in "Not performed". Every hash is
lowercase hex SHA-256 unless it says otherwise.
-->

<One-paragraph result: sealed with <N> ordinary contributions, one beacon
contribution applied, all checks below passed, final artifacts published.>

## Published outputs

- [Final artifact index](<index url with ?versionId=>) — SHA-256 `<index sha256>`.
- [Final zkey](<url>) — <byte length> bytes; SHA-256 `<sha256>`.
- [Verification key](<url>) — SHA-256 `<sha256>`.
- [Solidity verifier](<url>) — SHA-256 `<sha256>`.
- [Ceremony audit report](<url>) — SHA-256 `<sha256>`.
- [Proof test evidence and sample proofs](<url>) — SHA-256 `<sha256>`.
- [Root-signed completion record](finalization.signed.json) — payload type
  `moss.phase2.finalization.v1`, signed by root key `<root key id>`.

The artifact index (`moss.phase2.final-publication-index.v1`) pins every file
above plus the imported sealed key, the beacon evidence and the finalizer
summary by hash, byte length, object key and immutable S3 version. Each was
downloaded back through `<public origin>` and hashed after publication.

## Authority

| Item | Value |
| --- | --- |
| Ceremony ID | `<ceremonyId>` |
| Manifest envelope SHA-256 | `<sha256>` |
| Manifest root key ID / SPKI SHA-256 | `<keyId>` / `<sha256>` (published out of band at <where>) |
| Sealed checkpoint | generation `<N>`, event sequence `<n>`, event hash `<hash>`, signed by `<coordinator key id>` |
| Sealed head | `<sha256>`, `<byte length>` bytes (Bellman) |
| Beacon | Ethereum mainnet block `<blockNumber>`, hash `<blockHash>`, exponent `<numIterationsExp>` |

## Steps and checks

Work in a fresh directory on a machine that holds no ceremony signing keys
except, at step 6 only, the offline root key. Build once from the release
commit `<commit>`:

```sh
pnpm install --frozen-lockfile
pnpm -r --filter './packages/**' build
pnpm --filter @moss/phase2-finalizer build
cargo build --release --locked --manifest-path packages/bellman-verify/Cargo.toml
```

### 1. Inputs

Download the signed manifest, the signed `SEALED` checkpoint, the R1CS, the
PTAU, the original genesis zkey, the Bellman genesis and every accepted
Bellman snapshot from the archive. Check each against the manifest pins
before using it.

- R1CS `173eba6b9b7883bb8e761f69f902c334b14cea61a094eba7466f0f548d601692`.
- PTAU SHA-256 `032647abe127f4562f8118dd5f866ab595c1f2bbd03d0a85ff3739a4a967d9be`,
  BLAKE2b-512 `fa404d14…c733` (the snarkjs README reference value).
- Genesis zkey `f23c5dadb27613ec3d819c3cb59060804a0dc506fb6d873ab6d3ca5f8357090d`.
- Genesis Bellman `<sha256 from the manifest>`.

### 2. Transition replay and records audit

```sh
node apps/finalizer/dist/audit/cli.js \
  --manifest manifest.signed.json \
  --root-key manifest-root-public.pem \
  --root-key-id <root key id> \
  --root-key-spki-sha256 <root SPKI sha256> \
  --sealed-checkpoint sealed-checkpoint.signed.json \
  --sealed-head-sha256 <sealed head sha256> \
  --sealed-head-byte-length <sealed head byte length> \
  --coordinator-url <coordinator origin> \
  --mirror <archive sync directory> \
  --bellman-verifier <absolute path to moss-bellman-verify> \
  --work-dir audit --jobs <N>
```

- All <N> ordinary contributions passed native Bellman transition replay.
- <Receipts, transcript chain, publication bundles and checkpoints, verifier
  reports and signatures, operational updates and web-release authorizations
  passed.>
- Audit report `ceremony-audit.json` SHA-256 `<sha256>`.

### 3. Beacon and finalization

Run after block `<blockNumber>` is finalized on Ethereum mainnet.

```sh
node apps/finalizer/dist/cli.js \
  --manifest manifest.signed.json \
  --root-key manifest-root-public.pem \
  --root-key-id <root key id> \
  --root-key-spki-sha256 <root SPKI sha256> \
  --sealed-checkpoint sealed-checkpoint.signed.json \
  --sealed-head sealed-head.params \
  --sealed-head-sha256 <sealed head sha256> \
  --sealed-head-byte-length <sealed head byte length> \
  --genesis-zkey genesis.zkey \
  --r1cs circuit.r1cs \
  --ptau powersOfTau28_hez_final_24.ptau \
  --eth-rpc-url <independent RPC 1> \
  --eth-rpc-url <independent RPC 2> \
  --output-dir finalized
```

- The sealed Bellman chain was imported into the pinned genesis zkey and passed
  exact R1CS/PTAU verification before the beacon.
- Block `<blockNumber>` supplied the committed beacon; exactly one beacon
  contribution was appended with exponent `<numIterationsExp>`.
- Final R1CS/PTAU verification returned true at `<UTC time>`.
- Finalizer summary `final-artifacts.json` SHA-256 `<sha256>`.

### 4. Fresh proof test and Solidity verifier

Recompile the pinned closure (`include-closure.json`, closure hash
`53268998b4edd328bc5b8e205760a95f9a601c012f4ace741418a3bc0bdf2ac0`) with
circom 2.2.3:

```sh
circom main.circom --O2 --r1cs --wasm -o build
shasum -a 256 build/main.r1cs   # must be 173eba6b…1692
```

Then prove with the downloaded final key and run the Foundry harness against
the exact exported verifier (needs `forge` and solc 0.8.28 installed):

```sh
node apps/finalizer/dist/proof-test/cli.js \
  --final-zkey finalized/final.zkey \
  --verification-key finalized/verification_key.json \
  --r1cs build/main.r1cs \
  --wasm build/main_js/main.wasm \
  --expected-r1cs-sha256 173eba6b9b7883bb8e761f69f902c334b14cea61a094eba7466f0f548d601692 \
  --circom-version 2.2.3 --circom-optimization O2 \
  --circom-binary-sha256 <circom binary sha256> \
  --input <fixture input.json> --expected-public <fixture expected-public.json> \
  --solidity-verifier finalized/Verifier.sol \
  --output-dir proof-tests
```

- Compiler binary SHA-256 `<sha256>`; generated WASM SHA-256 `<sha256>`; the
  recompiled R1CS is byte-identical to the ceremony's.
- Fixtures: <name each, with input SHA-256>. <Say plainly which fixtures these
  are and what they do not cover.>
- <k> fresh proofs verified and matched all 20 expected public inputs; each of
  the 20 modified inputs and a negated A point were rejected for every proof.
- The exported verification key equals the published one; `Verifier.sol` is
  the pinned snarkjs 0.7.6 export of the final key.
- Foundry (`<forge version>`, solc 0.8.28, local EVM only): valid proof
  accepted; all 20 modified inputs, the negated proof point and an
  out-of-field input rejected. No contract was deployed.
- Proof index `proof-tests/proof-verification-index.json` SHA-256 `<sha256>`.

### 5. Publication

Credentials come from the operator's own environment; the command names no
profile. Rerun the same command after any failure: it reuses what is already
stored and converges on the same index.

```sh
node apps/finalizer/dist/publish/cli.js \
  --finalizer-output finalized \
  --audit-report ceremony-audit.json \
  --proof-evidence proof-tests/proof-verification-index.json \
  --bucket <archive bucket> --region <region> \
  --public-base-url https://<archive origin>/ \
  --label <YYYY-MM-DD> \
  --minimum-retention-until <ISO date> \
  --journal publication-journal.json \
  --index-out publication-index.json
```

- Index `<index url>`; SHA-256 `<sha256>`.
- Every object is under COMPLIANCE Object Lock until at least `<date>`.

### 6. Completion record

```sh
node infra/finalization-record.mjs build \
  --manifest manifest.signed.json --root-public-key manifest-root-public.pem \
  --checkpoint sealed-checkpoint.signed.json --finalizer-output finalized \
  --audit audit/ceremony-audit.json \
  --proof-index proof-tests/proof-verification-index.json \
  --publication-index publication-index.json \
  --artifact-index-url '<index url>' \
  --out finalization.payload.json
# On the offline root machine:
node infra/finalization-record.mjs sign \
  --manifest manifest.signed.json --root-public-key manifest-root-public.pem \
  --checkpoint sealed-checkpoint.signed.json --record finalization.payload.json \
  --root-private-key <offline root key> --out finalization.signed.json
```

- Record `finalization.signed.json` signed offline by `<root key id>`; it binds
  the manifest, the sealed checkpoint, the beacon, the publication index, the
  audit report and the proof evidence.
- The site shows the completed ceremony after the signed web update
  `<update id>`.

## Not performed

<List every check that did not run — for example an independently administered
audit, a network deployment and runtime-bytecode check, a broader fixture or
browser matrix — and anything recovered by hand, with what changed and what
did not.>
