# Reusing public ceremony implementations

Reviewed 2026-09-23. Recommendation: use Ethereum KZG's coordination code and
tests as references for the public lobby, while retaining MOSS's durable
PostgreSQL leases, Groth16 acceptance, immutable artifacts, and publication gate.
No queue policy or ceremony state is changed by this research.

## Ethereum's published components

| Component | Public source | Relevant reuse |
| --- | --- | --- |
| Rust sequencer | [ethereum/kzg-ceremony-sequencer](https://github.com/ethereum/kzg-ceremony-sequencer) | Authentication, lobby limits, heartbeat/rate-limit handling, slot expiry, contribution API, receipts, integration scenarios |
| Browser application | [zkparty/trusted-setup-frontend](https://github.com/zkparty/trusted-setup-frontend) | Sign-in → waiting room → worker computation → submission → receipt UX; reproducible/IPFS release process |
| Protocol specification | [ethereum/kzg-ceremony-specs](https://github.com/ethereum/kzg-ceremony-specs) | Client/sequencer contracts and interoperability expectations |
| Operations/audits | [ethereum/kzg-ceremony](https://github.com/ethereum/kzg-ceremony) | FAQ, special contribution periods, client diversity, audit reports and public transcript |

The sequencer is MIT-licensed (retain its copyright/license if copying code).
It was archived in August 2025; it is a historical implementation rather than
a maintained ceremony service. The inspected frontend has no root license file
or package license declaration, so establish reuse terms before copying its
code. Reference its behavior and architecture meanwhile. Old audit coverage is
commit-specific and does not cover our changes.

Reviewed sequencer revision: `2538f2f08d4db880d7f4608e964df0b695bc7d2f`.
Reviewed frontend revision: `5f539451bd8ed9cb182539af0d1834612557db08`.

## Slot reservation: what is actually implemented

The sequencer's [`src/lobby.rs`](https://github.com/ethereum/kzg-ceremony-sequencer/blob/2538f2f08d4db880d7f4608e964df0b695bc7d2f/src/lobby.rs)
tracks live sessions and a single active contributor, with expiry and bounded
re-downloads. Source defaults are 180 seconds to contribute, 30-second lobby
check-ins with two seconds of tolerance, a 1,000-member lobby, and a separate
session cap. These are defaults, not verified historical deployment settings.

[`src/api/v1/lobby.rs`](https://github.com/ethereum/kzg-ceremony-sequencer/blob/2538f2f08d4db880d7f4608e964df0b695bc7d2f/src/api/v1/lobby.rs)
implements `try_contribute`: an eligible request tries to acquire the free slot.
This revision is not a durable FIFO appointment system or an explicit fair
lottery. Its in-memory mutex protects ownership within one process; transplanting
it would weaken our existing database-backed concurrency/restart guarantees.

Useful test references include lobby capacity, early polling, unknown sessions,
active-owner retries, timeout, wrong-owner submission, and concurrent claim
attempts. See the sequencer's `src/api/v1/lobby.rs`, `src/lobby.rs`, and
[`tests/integration_test.rs`](https://github.com/ethereum/kzg-ceremony-sequencer/blob/2538f2f08d4db880d7f4608e964df0b695bc7d2f/tests/integration_test.rs).

For MOSS, preserve a durable registration ticket; admit a small ready group;
offer the oldest ready ticket a short claim window; bind its execution lease to
the exact canonical predecessor. Separate lobby heartbeats, claim expiry,
computation/upload deadline, and verifier deadlines. Size execution deadlines
using our measured artifact and supported hardware, not KZG's default.

## Browser and publication reuse

The frontend's `src/hooks/useTryContribute.ts` and `src/pages/lobby.tsx` are
concrete references for polling and waiting-room transitions; `public/wasm/wasm-worker.js`
shows computation isolated from the UI. Its README describes rebuilding Rust
WASM and publishing a reproducible frontend through IPFS, including a separately
identified audited build. These practices reduce reliance on a mutable hosted
bundle and fit our release-pinning requirements.

Do not carry over its contribution data model, entropy persistence, or memory
model blindly. Our artifacts are much larger. Use our OS/WebCrypto entropy
policy, OPFS/streaming design, resumable multipart uploads, and deadline/recovery
tests. Never claim JavaScript or SSD-backed secure erasure.

KZG's BLS12-381 powers-of-tau verifier and compact transcript are not a Groth16
BN254 phase-2 verifier or archive format. MOSS must still establish exactly one
valid append against immutable predecessor/candidate bytes, unanimous operator
reports, transactional canonical-head advancement, and witnessed publication.

## Sui: stronger cryptographic interoperability reference

Sui published its [Rust contribution client](https://github.com/sui-foundation/zk-ceremony-client)
and [phase-2 reproduction instructions](https://github.com/sui-foundation/zklogin-ceremony-contributions/blob/main/phase2/README.md).
These demonstrate mixed snarkjs/Rust participation using Bellman parameters.
I have not located a public Sui ceremony coordinator implementation in those
repositories; they do not provide the reusable server queue we need.

The local [Bellman prototype](experiments/bellman/README.md) tests that
cryptographic interoperability separately from queue engineering.

## Implementation order

1. Establish desktop-browser compute/memory/transfer timings with Bellman and
   complete hosted multipart upload/recovery.
2. Implement ready-group admission and bounded claim/requeue behavior on the
   existing database queue; adapt the KZG failure scenarios into our tests.
3. Add cached lobby status, jittered polling/backoff, admission limits, and
   an estimated wait range; load-test thousands of idle registrants.
4. Exercise stale submissions, sleep/network interruptions, coordinator and
   verifier restarts, mirror delays, and the signed ceremony cutoff.
5. Publish reviewed client builds, contribution evidence, monitoring/runbooks,
   and an explicit capacity policy before admitting the public.
