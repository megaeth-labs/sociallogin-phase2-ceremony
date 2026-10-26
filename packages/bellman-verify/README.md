# Direct Bellman transition verifier

Isolated native verifier pinned to MystenLabs phase2-bn254 revision
`f10c8a41ae019fb68c66fae0276159900b3a128c`. The locked dependency supplies
checked BN254 decoding, exact prior contribution-prefix comparison, proof of
knowledge, delta consistency and randomized H/L pairing checks. The wrapper
bounds vector framing against file length before decoding, enforces the exact
expected contribution count and EOF, and suppresses data-bearing diagnostics.

Build: `cargo build --release --locked --manifest-path packages/bellman-verify/Cargo.toml`.
After building `@moss/phase2-zkey-inspect`, run:
`node packages/bellman-verify/tests/transition.mjs`.

Invocation: `moss-bellman-verify PREDECESSOR CANDIDATE PREDECESSOR_COUNT`.
Exit 0 prints only the verified public BLAKE2b-512 contribution identifier;
exit 1 rejects input; exit 2 is a verifier failure, never acceptance. Callers
must enforce file-size, execution-time and memory limits and independently
hash immutable input files. Rust expects its infinity encoding; the bounded
`normalizeBellmanForRust` helper creates disposable decoder copies, while
original uploaded bytes remain the hash/archive authority.

Bellman does not embed contributor names. Identity/name attribution belongs in
the signed receipt, linked to this independently observed hash and index.
The byte-level inspector is only structural; it MUST NOT replace this verifier.

The signed `bellman-transition-v1` policy now connects this verifier to worker
reports and canonical acceptance. See [integration status](../../BELLMAN_INTEGRATION.md)
for the remaining release gates. No existing epoch may switch formats midway.
Retain the original pinned genesis zkey, R1CS/PTAU, Bellman genesis and all accepted
Bellman snapshots for independent replay.

For downloaded snarkjs Bellman files, the offline helper normalizes disposable
copies and prints verified public file digests and the contribution identifier:

```sh
pnpm --filter @moss/phase2-verifier-worker... build
cargo build --release --locked --manifest-path packages/bellman-verify/Cargo.toml
node packages/bellman-verify/verify.mjs predecessor.params contribution.params PREDECESSOR_COUNT
```

Replace `PREDECESSOR_COUNT` with the candidate contribution number minus one.
Authenticate the signed manifest/receipts separately and compare both file hashes,
lengths and the contribution identifier. Keep input files unchanged during the
check and allow disk space for two temporary normalized copies. The helper
checks hashes again afterwards and removes temporary copies. Validity is relative
to the predecessor; checking an entire ceremony requires a pinned genesis and
all transitions. This command does not establish final transcript inclusion.

Dependencies retain their upstream MIT/Apache-2.0 licenses; see Cargo.lock for
exact revisions. No cryptographic arithmetic is forked by this wrapper.
