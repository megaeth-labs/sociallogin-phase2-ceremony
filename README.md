# MOSS zkLogin Phase 2 ceremony

This is a standalone public Groth16 Phase 2 ceremony for the remediated MOSS
Google RS256 zkLogin relation. It is a local fork of
[Caburé](https://github.com/defi-wonderland/cabure-wizard) at
`8c50b9b175097b553afb2e6dfedc34055226da70`; that repository remains the
`upstream` Git remote and its MIT notices are preserved.

The inherited browser contribution engine and CLI have been adapted to a
persistent MOSS-specific coordinator. The active system now includes a signed
protocol, PostgreSQL queue and lease state, bounded uploads, independent
verifier workers, exact predecessor-plus-one checks, signed receipts and
checkpoints, a filesystem-backed CLI, an OPFS-backed browser path, and an
offline finalizer.

## Status

The loopback development stack is runnable. It is intentionally **not ready for
a production ceremony**. Production startup fails closed until the remaining
launch work is completed, chiefly:

- bind the recorded O2 compilation profile into the signed manifest; the
  verified R1CS is authoritative and does not require a Linux rebuild;
- publish immutable artifact and reproducible web/CLI release references;
- deploy and provider-test the implemented AWS adapter with version-pinned
  reads, Object Lock and conditional, crash-idempotent promotion;
- deploy two independently administered verifier operators and an external
  transcript/checkpoint witness whose acknowledgement gates the next lease;
- complete the supported-browser/hardware matrix for the 368,440,348-byte
  Bellman genesis and growing public transcript;
  and
- publish and independently review the final signed schedule, keys, policy, and
  future beacon commitment.

Completed 2026-09-18: the clean `--O2` R1CS metadata, the PTAU SHA-256, and the
zero-contribution genesis zkey are frozen and recorded under **Pinned
relation**. The genesis was generated with the pinned snarkjs 0.7.6 from the
`--O2` R1CS and the power-24 transcript, verified with `snarkjs zkey verify`,
and independently reproduces the byte-identical baseline key generated on a
second machine. The company rehearsal now has immutable version-pinned input storage and a
primary transcript archive. An independent production witness remains outstanding
— see `IMPLEMENTATION_PLAN.md`.

The existing MOSS development-testnet final zkey is not a ceremony genesis and
must never be substituted for one.

The hosted rehearsal uses Vercel, RDS PostgreSQL and one ECS Fargate verifier.
See [what to provision](infra/REHEARSAL_PROVISIONING.md) and the
[AWS deployment template](infra/aws/README.md). The company rehearsal infrastructure is deployed and provider checks are
recorded in [deployment status](infra/aws/REHEARSAL_STATUS.md). Its signed
manifest is under [company rehearsal](ceremonies/company-rehearsal-2026-09-r2/README.md).

Owner decisions and the engineering backlog are tracked in
[OPERATOR_ACTION_ITEMS.md](./OPERATOR_ACTION_ITEMS.md).

## Pinned relation

- MOSS integration revision:
  `b6dbfd1eb07281adac61ab25d1c09c4934d1bc80`
- Moonsong remediated circuit revision:
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

The relation is the `--O2` compilation profile. The earlier O1 profile
(R1CS SHA-256 `740d3ade…`, 1,081,440 constraints, 1,062,285 wires, transform
domain 2,097,152) is superseded and must not be used; an O1 key cannot be
converted to O2. The compilation profile, not only the Circom version, is part
of the relation identity — record the compiler binary digest and the
optimization flag rather than relying on a compiler default.

The draft relation definition and unresolved values live under
`ceremonies/google-rs256-zksync-v3/`.
The existing source and ZKsync public-test artifact correlation is recorded in
[PROVENANCE.md](ceremonies/google-rs256-zksync-v3/PROVENANCE.md), including the
optional downloaded compiler release pin and the remaining manifest-binding work.

Direct Bellman integration is implemented: ordinary contributions remain in
Bellman format and use checked native transition verification. Only the sealed
chain is imported into the original zkey for finalization. Three full-size
Chrome/OPFS contributions have passed native verification locally; hosted
acceptance and the wider browser matrix remain release gates. See
[BELLMAN_INTEGRATION.md](BELLMAN_INTEGRATION.md) for policy and validation details.

## Happy path

Production participation is limited to one live queue entry/slot and one accepted
contribution per GitHub account per ceremony. Joining from another tab returns
the existing entry without changing its queue position. Expired or failed
attempts can be retried until a contribution is accepted. These limits use
GitHub's stable account ID, so renaming an account does not reset them; they do
not establish that different accounts belong to different people. Repeated
accepted contributions are allowed only through the explicit rehearsal policy.

1. Contributors independently pin the manifest-root public key. The web server
   and CLI verify the root-signed immutable ceremony manifest.
2. GitHub OAuth is converted by the separately operated web issuer into a
   stable keyed participant ID and a short-lived Ed25519 coordinator token.
3. The coordinator places the participant in a PostgreSQL FIFO queue and offers
   a bounded lease for the current canonical artifact.
4. The client claims the lease, verifies its predecessor against a fresh
   coordinator-signed checkpoint, streams and hashes the artifact, and creates one
   ordinary Phase 2 contribution locally using OS/WebCrypto entropy.
5. The successor is uploaded to lease-bound quarantine. The coordinator checks
   its independently calculated SHA-256, exact byte length, and immutable object
   version before scheduling verification. Browser and CLI journals can recover
   a completed upload and submit those same bytes after a client restart.
6. Every manifest-authorized verifier operator claims work with its own
   operator-bound credential and renews a bounded job lease. The signed policy
   selects native Bellman transition verification or legacy snarkjs zkey checks.
   Both enforce the unchanged contribution prefix and exactly one append; every
   report binds the immutable inputs and observed contribution hash/index.
   Bellman names belong in signed receipts, not artifact metadata.
7. Only after verifier unanimity, and strictly before the manifest's signed
   sealing instant, does a PostgreSQL transaction compare-and-swap the canonical
   head, append the signed hash-chained event, and issue a signed receipt. A
   participant-scoped recovery view and the idempotent acceptance boundary
   recover interrupted clients and coordinator restarts.
8. At the signed closing time the coordinator seals. After the committed future
   beacon is available, the offline finalizer checks independent sealed-head
   evidence. For Bellman it imports the chain once into the original pinned
   genesis zkey and verifies against R1CS/PTAU. It applies exactly one derived
   beacon contribution, verifies again, and exports the 20-input verification
   key and Solidity verifier.

The public browser path downloads the current Bellman artifact (genesis:
368,440,348 bytes; +384 bytes per contribution) and uploads its successor. It
never needs the R1CS or 19.3 GB PTAU. Browser quota checks reserve two artifacts
plus working headroom. Browser participation remains disabled pending release
acceptance. Its arithmetic is pinned snarkjs with bounded-memory OPFS I/O;
server verification uses the separately pinned Rust implementation.

The filesystem contribution CLI supports legacy zkey epochs and rejects Bellman
epochs. Browser and CLI legacy contributions share snarkjs arithmetic and are
not independent cryptographic implementations. Offline receipt verification
supports either policy; the native Bellman helper supports local transition
checks. See [packages/bellman-verify](packages/bellman-verify/README.md).

## Optional contribution collectible

The wallet/NFT feature branch adds an optional commemorative collectible after
acceptance, using the published MOSS Wallet SDK. Minting is disabled until a
separate contract and claim issuer are configured. See
[the collectible setup and testing guide](packages/contribution-nft/README.md).
It does not change contribution acceptance, the ceremony manifest or finalization.

## Components

- `apps/ceremony` — Caburé-derived Next.js contributor UI and OAuth issuer.
- `apps/coordinator` — public `/v1` API, queue, leases, uploads, receipts, and
  signed checkpoints.
- `apps/verifier-worker` — isolated, signed-report verification worker.
- `apps/witness` — independently operated publication validation and locked S3 mirror.
- `apps/finalizer` — offline sealed-head and future-beacon finalization.
- `packages/crypto` — pinned snarkjs arithmetic plus bounded-memory OPFS I/O.
- `packages/cli` — filesystem-backed contributor client.
- `packages/protocol` — canonical schemas, JCS, signatures, and policy checks.
- `packages/zkey-inspect` — strict BN254 Groth16 framing and append validation.
- `packages/db` — PostgreSQL schema and transactional state transitions.
- `packages/storage` — local development and production storage boundaries.
- `infra` — loopback Compose runtime and production deployment checklist.

## Local API stack

Requirements are Node.js 24+, pnpm 10.29.2, and Docker.

```sh
pnpm install --frozen-lockfile
pnpm dev:artifacts
pnpm dev:stack
curl --fail http://127.0.0.1:58787/healthz
```

`dev:artifacts` creates a tiny ignored multiplier-circuit epoch solely for local
integration testing. The default stack starts PostgreSQL, the coordinator, and
one development verifier. See [RUNBOOK.md](./RUNBOOK.md) for the signed CLI
status check, real GitHub web setup, reset/recovery, production preparation, and
offline finalization.

## Acceptance and trust

A candidate is accepted only if its immutable bytes match the lease and every
required independent verifier attests to the exact append and full zkey
verification, followed by a transactional canonical-head compare-and-swap.
Production policy requires unanimity from at least two independently
administered verifier identities. The ceremony draft requires one complete,
fresh verification pass per identity; both operators must approve.

Final soundness still requires at least one accepted ordinary contributor to
keep their contribution secret and destroy it. A terminal public beacon is
useful for an unbiased, precommitted ending but is not secret toxic-waste
entropy. The hosted browser bundle is consequently part of the trust boundary:
malicious JavaScript could exfiltrate a contributor's entropy, and a client
release hash reported to the coordinator is evidence/allowlisting, not remote
attestation of the code actually executed.

## Development gate

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
git diff --check
```

Full acceptance additionally requires the production-size artifacts, real
GitHub OAuth, independently deployed verifier operators, provider storage, and
the browser/hardware benchmark matrix.

## License

MIT. Caburé copyright and license notices are preserved in [LICENSE](./LICENSE).
