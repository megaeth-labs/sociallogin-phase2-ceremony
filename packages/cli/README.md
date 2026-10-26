# MOSS Phase 2 contributor CLI

This is the filesystem-backed contributor for the single MOSS Google RS256
Groth16 Phase 2 ceremony. It suits contributors who prefer a terminal, a
headless machine, or a long unattended wait in the queue.

The CLI verifies the root-signed ceremony manifest and coordinator-signed head
checkpoint before accepting a lease. It streams and hashes the predecessor,
uses operating-system entropy, runs the pinned snarkjs contribution in a child
process, uploads the successor, and saves the signed receipt. The signed
manifest's verification method decides the artifact format: a
`bellman-transition-v1` ceremony contributes to Bellman parameters (`.params`,
about 368 MB for the Moonsong circuit) with the same snarkjs 0.7.6 Bellman
arithmetic as the browser; otherwise the CLI contributes to a zkey. R1CS and PTAU
files are verifier/operator inputs and are not downloaded by contributors.

## Build

From the repository root:

```sh
pnpm --filter @moss/phase2-ceremony-cli build
node packages/cli/dist/index.js --help
```

## Status

Pass the coordinator origin, ceremony slug, and an independently obtained
Ed25519 manifest-root public key:

```sh
node packages/cli/dist/index.js status https://coordinator.example \
  --slug moss-google-rs256-zksync-v3 \
  --manifest-root-key ./manifest-root-public.pem
```

The command verifies the signed manifest and signed checkpoint before printing
the state, canonical head, queue depth, and sealing time. Production use rejects
reduced development policy.

## Contribute

```sh
node packages/cli/dist/index.js contribute https://coordinator.example \
  --slug moss-google-rs256-zksync-v3 \
  --manifest-root-key ./manifest-root-public.pem \
  --auth-url https://ceremony.example
```

`--auth-url` is the web origin exposing `/api/ceremony/auth/cli`. It defaults to
the coordinator origin when both services share one public origin. GitHub Device
Flow must be enabled for the OAuth app. The returned EdDSA participant token is
delivered through a one-shot, no-store POST poll and cached in
`~/.moss-phase2-ceremony/auth.json` with owner-only permissions.

For controlled automation, provide an already issued coordinator-compatible
token through a mode-0600 file:

```sh
node packages/cli/dist/index.js contribute https://coordinator.example \
  --slug moss-google-rs256-zksync-v3 \
  --manifest-root-key ./manifest-root-public.pem \
  --token-file ./participant.jwt
```

The inline `--token` flag exists for compatibility but can expose a bearer token
through shell history or process inspection, so `--token-file` is preferred.

During contribution the CLI:

1. joins the FIFO queue and claims a bounded lease;
2. verifies that the lease predecessor matches a fresh signed checkpoint;
3. checks disk capacity, resumes the predecessor download, and verifies its
   exact SHA-256 and byte length;
4. creates one ordinary Groth16 Phase 2 contribution while heartbeats continue
   in the parent process. A zkey contribution embeds the lease-bound
   contribution name; a Bellman file carries no name, so the signed receipt
   records it. For Bellman, the CLI then checks that the successor is the
   predecessor plus exactly one 384-byte record with every fixed section
   unchanged, and that snarkjs's identifier is the BLAKE2b-512 of that record;
5. rechecks the signed head, uploads to coordinator quarantine, and submits the
   exact predecessor, successor, and contribution hash;
6. waits for the required independent verifier reports; and
7. verifies and saves the coordinator-signed receipt.

Pressing Ctrl-C (or sending SIGTERM) while the CLI is still waiting for its
turn, queued or offered but not yet claimed, leaves the queue so the next
person is offered the slot, then exits non-zero; a rerun joins at the end of the
line. Once a claim has been sent, an interrupt leaves the slot reserved until it
lapses, and rerunning the command resumes it. A second Ctrl-C exits without
waiting for the leave request.

The temporary workspace holds the downloaded predecessor and the computed
successor, both public once uploaded. The contribution's randomness exists only
in the worker's memory and is wiped after use; it is never written to disk. The
workspace is deleted when the contribution is accepted, and retained on
failure: if the CLI stops after computing but before the coordinator holds the
upload, rerunning it on the same lease re-hashes the retained predecessor and
successor against the journal and uploads that successor without drawing new
randomness or recomputing; any mismatch discards it and computes afresh.

Queue-ticket, lease, upload, submission, receipt, and local verification
identifiers are atomically journaled under
`~/.moss-phase2-ceremony/journals/` with owner-only permissions. On restart,
the CLI reconciles that journal with the authenticated
`GET /v1/ceremonies/:slug/me/state` view. An accepted receipt is recovered
only when its signature and every locally journaled contribution field match.
If upload completion succeeded before the client crashed, the CLI queries the
participant-scoped upload record and submits without recomputing only when the
durable artifact and all journaled lease/evidence fields match exactly.

For the loopback-only reduced policy, add `--allow-development-manifest`. The
flag is rejected for non-loopback coordinators.

## Verification

```sh
pnpm --filter @moss/phase2-ceremony-cli typecheck
pnpm --filter @moss/phase2-ceremony-cli test
pnpm --filter @moss/phase2-ceremony-cli build
```
