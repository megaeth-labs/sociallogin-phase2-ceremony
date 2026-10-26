# Offline Phase 2 finalizer

This package performs path-based, offline finalization of a sealed MOSS
Groth16 Phase 2 ceremony. It never downloads the R1CS, PTAU, sealed zkey,
manifest, checkpoint, or signing keys. The only network operation is resolving
the manifest-pinned future drand round from operator-supplied public HTTPS
endpoints.

## Authority and artifact inputs

The finalizer requires:

- a signed production ceremony manifest;
- the independently authenticated Ed25519 root key ID and SPKI SHA-256;
- a signed `SEALED` checkpoint from a coordinator key authorized by the
  manifest;
- an independently expected sealed-head SHA-256 and byte length;
- local sealed-head, exact R1CS, and exact PTAU paths;
- a new output directory path that does not already exist; and
- two to eight distinct HTTPS drand API v1 origins.

The sealed checkpoint must contain at least one ordinary contribution. A
public beacon contributes no private toxic-waste entropy and is not allowed to
be the ceremony's only Phase 2 contribution.

The finalizer accepts a sealed generation from 1 through the manifest's signed
`maximumContributions`; it does not require equality with
`targetContributions`. This preserves a deliberate operational choice to seal
below target rather than lose all valid contributions. If reaching the target
is a launch invariant, the coordinator's irreversible seal transition and the
independent checkpoint review must enforce it.

## drand verification and derivation

`drand-client` is exact-pinned to `1.4.2`. For every configured endpoint the
resolver:

1. fetches `/{chainHash}/info` and `/{chainHash}/public/{round}` with bounded,
   timed, redirect-free requests;
2. independently recomputes the official drand chain-info hash as
   `SHA256(uint32be(periodSeconds) || int64be(genesisTime) || publicKey ||
   groupHash || nonDefaultBeaconIdUtf8)`;
3. uses `drand-client` to verify the expected round, scheme-specific BLS
   signature, and `randomness == SHA256(signature)`; and
4. requires identical normalized chain and beacon evidence from every
   configured, distinct HTTPS origin.

The drand round's nominal time is derived from chain info as
`genesisTime + (round - 1) * periodSeconds`. It must be strictly later than the
signed ceremony sealing time, and the signed `beacon.expectedAt` cannot predate
it. Operators must still demonstrate that the signed manifest was publicly
committed before that round; a finalizer cannot prove when an offline file was
first published.

`MOSS_PHASE2_BEACON_V1` supplies exactly these 32 bytes to `snarkjs zkey
beacon`:

```text
SHA256(
  UTF8("MOSS_PHASE2_BEACON_V1") ||
  0x00 ||
  chainHash[32] ||
  uint64be(round) ||
  randomness[32]
)
```

There is no CLI flag for arbitrary beacon hex.

## Run

Use at least two independently operated drand origins. Endpoint values are API
base URLs; the finalizer appends the manifest chain hash and v1 paths.

```sh
pnpm --filter @moss/phase2-finalizer build
node apps/finalizer/dist/cli.js \
  --manifest /independent/manifest.signed.json \
  --root-key /independent/manifest-root-public.pem \
  --root-key-id reviewed-root-key-id \
  --root-key-spki-sha256 reviewed-64-hex-fingerprint \
  --sealed-checkpoint /independent/sealed-checkpoint.signed.json \
  --sealed-head /artifacts/sealed-head.zkey \
  --sealed-head-sha256 independently-reviewed-64-hex-hash \
  --sealed-head-byte-length independently-reviewed-byte-length \
  --r1cs /artifacts/relation.r1cs \
  --ptau /artifacts/powers-of-tau.ptau \
  --drand-url https://api.drand.sh \
  --drand-url https://drand.cloudflare.com \
  --drand-timeout-ms 15000 \
  --output-dir /new/path/finalized
```

Every configured endpoint must succeed. Add up to eight for independent
cross-checking, but remember that requiring more origins also reduces
availability. `--drand-timeout-ms` is optional and accepts 1000 through 120000
milliseconds.

## Outputs

On success the fresh output directory contains:

- `final.zkey`;
- `verification_key.json` in canonical JSON;
- `Verifier.sol` generated from snarkjs 0.7.6's pinned Groth16 template;
- `drand-evidence.json`, canonical normalized chain/beacon/source evidence;
  and
- `final-artifacts.json`, a canonical deterministic summary with input,
  authority, evidence, toolchain, and output hashes.

The evidence file is written once, read-only, and its exact SHA-256 and byte
length are bound into the summary. The same SHA-256 appears in the summary's
beacon section.

Before emitting the summary, the finalizer verifies the sealed head against
the exact R1CS/PTAU, rejects any pre-existing beacon record, applies one beacon
to a fresh path, verifies an exact predecessor-plus-one beacon append, verifies
the final zkey again from the R1CS/PTAU, and requires a BN254 Groth16
verification key with exactly 20 public inputs. Any failure removes outputs
created by the current run; a pre-existing output directory is never reused.

## Hosted rehearsal and Ethereum finalization

The finalization authority accepts either supported signed beacon commitment:
`drand` or `ethereum-block`. Ethereum requires the committed mainnet block and
finalized evidence checked by the Ethereum resolver; it does not accept an
operator-selected replacement hash. Use the existing `--eth-rpc-url` options for
independently operated endpoints.

For Ethereum, `expectedAt` is an estimated arrival time, not a deadline for the
committed block. A late block remains eligible once finalized by both providers.
Its actual consensus timestamp must still be strictly after the signed closing
time; the committed chain ID and block number cannot change.

A manifest signed with `purpose: "rehearsal"` requires the standalone
`--allow-rehearsal` flag. This permits its explicitly signed one-operator policy
while retaining all artifact, root, checkpoint and beacon checks. The default
finalizer rejects rehearsal manifests. Never deploy rehearsal outputs onchain.

## Ceremony audit and transition replay

`moss-phase2-audit` checks a sealed ceremony from its signed records and
replays every contribution. Run it before the beacon is applied, and publish
the report with the final artifacts so anyone can rerun it. It trusts the
coordinator only as far as its signatures; it supports the
`bellman-transition-v1` method with the coordinator-signed
`primaryPublication` archive.

It verifies:

- **Authority.** The root-signed manifest against an independently supplied
  root key ID and SPKI fingerprint; the signed `SEALED` checkpoint and the
  independently expected sealed head; every root-signed operational update and
  its Object-Locked archive copy.
- **Publications.** One coordinator-signed publication record for every head
  from genesis (sequence 0) to the sealed head, none missing, duplicated or
  later; each evidence bundle's hash, manifest and head; and the archived
  `checkpoint-<bundle>.json` copy of each record, byte for byte.
- **Receipts and transcript.** Each receipt's coordinator signature, position,
  manifest binding, schedule window and ordering; the transcript event's
  signature, hash and link to the previous event; and the event, receipt,
  bundle and publication record agreeing on every field. With `--receipts` or
  `--coordinator-url`, the coordinator's receipt list must equal the archive.
- **Verifier reports.** Signature by an authorized operator key, the signed
  image digest and method, binding to the accepted submission, completion
  before acceptance, and the signed verifier policy.
- **Client releases.** When the manifest pins client releases, each
  contribution's reported release was authorized (manifest or a root-signed
  update dated no later than the acceptance). This is the reported release,
  not remote attestation of the code that ran.
- **Artifact linkage.** Genesis Bellman, each predecessor and successor, one
  384-byte record per contribution, ending exactly at the sealed head and event.
- **Replay.** For every transition, both snapshots are hashed against the
  signed receipt, the pinned native verifier (`packages/bellman-verify`) checks
  the append on disposable normalized copies, and its contribution identifier
  must equal the receipt's. Inputs are hashed again afterwards.

It does not check: the snarkjs import of the sealed chain, R1CS/PTAU
verification or the beacon (the finalizer does those); that `genesisBellman`
is the export of `genesisZkey` (the finalizer re-exports it); when records were
first published; or what code a browser actually ran.

```sh
cargo build --release --locked --manifest-path packages/bellman-verify/Cargo.toml
pnpm --filter @moss/phase2-finalizer build
node apps/finalizer/dist/audit/cli.js \
  --manifest /independent/manifest.signed.json \
  --root-key /independent/manifest-root-public.pem \
  --root-key-id reviewed-root-key-id \
  --root-key-spki-sha256 reviewed-64-hex-fingerprint \
  --sealed-checkpoint /independent/sealed-checkpoint.signed.json \
  --sealed-head-sha256 independently-reviewed-64-hex-hash \
  --sealed-head-byte-length independently-reviewed-byte-length \
  --coordinator-url https://coordinator.example \
  --work-dir /scratch/audit \
  --jobs 4
```

Records come from `--coordinator-url` (the public publications, contributions
and operational-updates endpoints) or from saved files: `--publications`
(required), `--operational-updates` (required; an empty history is
`{"updates":[]}`) and optionally `--receipts`. Files may hold an array, an API
page or an array of pages. Artifacts and bundles download over credential-free
HTTPS from their pinned URLs, with retries and hash checks; `--mirror DIR`
reads a local copy laid out by URL path (a bucket sync) or `DIR/by-sha256/<sha256>`
instead. `--records-only` skips replay and reports `"scope": "records"`.
Rehearsal manifests need `--allow-rehearsal`, and their separate browser
authorizations go in repeated `--web-release-authorization` flags.

Replay is resumable: valid transitions are appended to
`<work-dir>/replay-state.jsonl`, keyed by both artifact hashes, the expected
identifier and the verifier binary hash, so rerunning the same command skips
finished work. That file is the auditor's own record; delete it to replay from
scratch. `--jobs N` runs N workers over contiguous chunks (`--chunk-size`,
default 16), so each artifact is fetched about once. Each worker holds at most
two snapshots and two normalized copies, about 1.5 GB at production size, plus
the native verifier's memory. SIGINT stops cleanly; the report then fails.

Outputs, both in `--work-dir`:

- `ceremony-audit.json`: canonical JSON, type `moss.phase2.ceremony-audit.v1`.
  It holds no wall-clock time, path or resume detail, so an independent run
  with the same records and toolchain produces identical bytes; compare its
  SHA-256. `result` is `"passed"` only if every check ran and nothing failed;
  otherwise every failure is listed by check and generation.
- `ceremony-audit-run.json`: start and finish times, per-transition seconds,
  which transitions were resumed, and the SHA-256 of the report above.

Exit status is 0 for a pass, 1 for a failed audit and 2 when it cannot run.
