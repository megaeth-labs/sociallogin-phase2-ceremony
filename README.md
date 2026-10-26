# MOSS social login Phase 2 ceremony

This is the public Groth16 Phase 2 trusted setup ceremony for the MOSS social
login (Google RS256 zkLogin) circuit. It is a fork of
[Caburé](https://github.com/defi-wonderland/cabure-wizard) at
`8c50b9b175097b553afb2e6dfedc34055226da70`, and its MIT notices are preserved.

The ceremony runs a signed protocol: a root-signed manifest fixes the circuit,
schedule, beacon and accepted client releases; a coordinator runs the queue,
leases, uploads and signed receipts; a verifier checks every contribution
before it is accepted; and an offline finalizer applies the closing beacon.

## The ceremony

| | |
|---|---|
| Website | https://ceremony.megaeth.com |
| Coordinator | `https://dy87eh5gw5.execute-api.us-east-2.amazonaws.com` |
| Slug | `moss-social-login-phase2` |
| Opens | 2026-10-26 20:20 UTC |
| Seals | 2026-11-05 04:59 UTC |
| Beacon | Ethereum mainnet block 26346911, 2^10 iterations |
| Manifest root key | `moss-social-login-root-2026-10` |
| Root key SPKI SHA-256 | `71e1eafb6cfed35c2278d7eb1dc9a7c8d57127bec5dc6e983f8fb06b2129865d` |

The signed manifest, its inputs, the public root key and every signed website
update are under [ceremonies/moss-social-login-phase2](ceremonies/moss-social-login-phase2/).
Check the root key fingerprint against the one the ceremony organizers publish
through their own channels; a copy in this repository alone does not prove who
owns it.

Each GitHub account can make one accepted contribution. You can contribute from
the website in a desktop browser, or from the command line below.

## Contribute from the CLI

The CLI suits a terminal, a headless machine, or a long unattended wait in the
queue. You need Node.js 24 or newer, Git, and about 1 GB of free disk space.

```sh
git clone https://github.com/megaeth-labs/sociallogin-phase2-ceremony.git
cd sociallogin-phase2-ceremony
corepack enable
pnpm install --frozen-lockfile
pnpm --filter "@moss/phase2-ceremony-cli..." build
./status.sh
./contribute.sh
```

Both scripts first print two hashes. Check them against the values the
ceremony organizers publish:

```text
CLI SHA-256:           62bcd42a3e9a28e8e0d1adcfba3000710c758d7b2eb961f2a8520abaf53722da
Root key SPKI SHA-256: 71e1eafb6cfed35c2278d7eb1dc9a7c8d57127bec5dc6e983f8fb06b2129865d
```

The CLI also refuses to contribute unless its own hash is authorized by the
signed manifest. `status.sh` verifies the signed manifest and the
coordinator's signed checkpoint, then prints the state, the current head, the
number of contributions and the queue.

`contribute.sh` prints a GitHub device code. Enter it at
https://github.com/login/device to sign in; the resulting ceremony token is
cached in `~/.moss-phase2-ceremony/auth.json` with owner-only permissions. Then
the CLI:

1. joins the queue and claims its slot when offered;
2. downloads the current contribution file (about 368 MB) and checks it against
   the coordinator's signed checkpoint;
3. computes one contribution in a separate process, using operating-system
   entropy;
4. uploads the result and waits for the verifier; and
5. verifies the signed receipt and saves it under
   `~/.moss-phase2-ceremony/receipts/`.

Keep the machine awake and online until the receipt is saved. Pressing Ctrl-C
while still queued leaves the queue. After the slot is claimed, rerunning
`./contribute.sh` resumes it; a contribution that was already computed is
uploaded without being recomputed. Your secret randomness is generated in
memory, used once and wiped; it is never written to disk. The downloaded file
and your result are kept under `~/.moss-phase2-ceremony/work/` until the
contribution is accepted, then deleted.

The manifest names the commit the CLI release was built from,
`e827b61f581c721f71628c4cd89dfbad4c8cb9d8`; building that commit gives the same
hash. The published copy of the release is at
`https://d1xydbco3b83a0.cloudfront.net/inputs/sha256/62bcd42a3e9a28e8e0d1adcfba3000710c758d7b2eb961f2a8520abaf53722da/moss-phase2-cli.js?versionId=5B8J1E8wvLhY04IOnrR7KVUV5gjICLfk`.
It is a checksum reference: the CLI also needs its contribution worker and
`snarkjs` from this repository. See [packages/cli](packages/cli/README.md) for
every option and recovery detail.

## How a contribution is accepted

1. The website and the CLI verify the root-signed ceremony manifest against a
   pinned root key.
2. GitHub sign-in gives each account a stable, keyed participant ID and a
   short-lived coordinator token. Renaming a GitHub account does not reset its
   limit; different accounts are not proven to be different people.
3. The coordinator queues participants in order and offers one slot at a time.
   An offer must be claimed within 2 minutes, a claimed slot must send a
   heartbeat at least every 5 minutes, and a slot lasts at most 30 minutes.
4. The client checks the current file against a fresh signed checkpoint, then
   creates one ordinary Phase 2 contribution locally.
5. The result is uploaded to a quarantine bucket. The coordinator checks its
   SHA-256, exact size and storage version before scheduling verification.
6. The verifier hashes both files, checks that the predecessor is unchanged and
   exactly one 384-byte contribution record was appended, and runs the pinned
   Rust Bellman transition check. It returns a signed report.
7. On an approving report, and only before the signed sealing time, a database
   transaction advances the head, appends the hash-chained event and issues a
   signed receipt. Each accepted head's evidence and signed checkpoint are
   written to the Object-Locked archive before the next slot is offered.
8. After sealing and once the committed beacon block exists, the offline
   finalizer audits the sealed records, imports the contribution chain into
   the pinned genesis zkey, verifies it against the R1CS and PTAU, applies the
   beacon, verifies again, and exports the verification key and Solidity
   verifier.

## Trust

The final parameters are sound if at least one accepted contributor kept their
contribution secret and destroyed it. The closing beacon makes the ending
unbiased and precommitted; it is not secret randomness.

The website's code is part of that trust boundary: malicious JavaScript could
leak a contributor's entropy. Every website release is a reproducible build of
a public commit, authorized by a root-signed update and recorded under
`ceremonies/moss-social-login-phase2/web-updates/`. The CLI release hash it
reports to the coordinator is an allowlist, not proof of the code that ran;
building it yourself from the pinned commit is the stronger check.

## Pinned relation

- Moonsong circuit revision:
  `5461ae81208d7e9d6331865b4a8c841546134018`
- relation: `google-rs256-zksync-v3-groth16-bn254-2`
- Groth16 over BN254 with 20 public inputs
- Circom `2.2.3` with `--O2`; snarkjs `0.7.6`
- R1CS SHA-256:
  `173eba6b9b7883bb8e761f69f902c334b14cea61a094eba7466f0f548d601692`
- R1CS: 232,099,260 bytes, 960,780 constraints, 941,659 wires,
  transform domain 1,048,576
- PTAU: `powersOfTau28_hez_final_24.ptau`, 19,327,435,928 bytes,
  BLAKE2b-512
  `fa404d140d5819d39984833ca5ec3632cd4995f81e82db402371a4de7c2eae8687c62bc632a95b0c6aadba3fb02680a94e09174b7233ccd26d78baca2647c733`,
  SHA-256
  `032647abe127f4562f8118dd5f866ab595c1f2bbd03d0a85ff3739a4a967d9be`
- zero-contribution genesis zkey SHA-256:
  `f23c5dadb27613ec3d819c3cb59060804a0dc506fb6d873ab6d3ca5f8357090d`,
  567,402,188 bytes
- Bellman genesis (the file contributors download first): 368,440,348 bytes;
  each contribution adds 384 bytes

The relation is the `--O2` compilation profile. The earlier O1 profile (R1CS
SHA-256 `740d3ade…`) is superseded and must not be used; an O1 key cannot be
converted to O2. Source and compiler provenance is recorded in
[PROVENANCE.md](ceremonies/google-rs256-zksync-v3/PROVENANCE.md).

Contributions stay in Bellman format and are verified with the native
transition check; only the sealed chain is imported into the original zkey for
finalization. See [packages/bellman-verify](packages/bellman-verify/README.md).

## Components

- `apps/ceremony` — Next.js contributor website and GitHub sign-in issuer.
- `apps/coordinator` — public `/v1` API, queue, leases, uploads, receipts and
  signed checkpoints.
- `apps/verifier-worker` — isolated verification worker that signs its reports.
- `apps/finalizer` — offline audit, beacon and finalization.
- `packages/cli` — command-line contributor.
- `packages/crypto` — pinned snarkjs arithmetic with bounded-memory browser
  file storage.
- `packages/bellman-verify` — pinned Rust Bellman transition verifier.
- `packages/protocol` — canonical schemas, signatures and policy checks.
- `packages/zkey-inspect` — strict BN254 Groth16 framing and append checks.
- `packages/db` — PostgreSQL schema and transactional state transitions.
- `packages/storage` — local and production storage.
- `infra` — local Compose stack, AWS deployment template and release tooling.

## Development

Requirements are Node.js 24+, pnpm 10.29.2 and Docker.

```sh
pnpm install --frozen-lockfile
pnpm dev:artifacts
pnpm dev:stack
curl --fail http://127.0.0.1:58787/healthz
```

`dev:artifacts` creates a tiny multiplier-circuit epoch for local integration
testing. See [RUNBOOK.md](./RUNBOOK.md) for local contribution, operations,
signed updates and finalization.

Before sending a change:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
git diff --check
```

## License

MIT. Caburé copyright and license notices are preserved in [LICENSE](./LICENSE).
