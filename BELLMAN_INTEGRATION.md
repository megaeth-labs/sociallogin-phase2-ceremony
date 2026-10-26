# Direct Bellman ceremony integration

Implemented and merged to `main`. The company rehearsal uses only the explicit
`moss-company-rehearsal` profile. No existing ceremony has been reset, re-signed,
or switched formats.

## Frozen policy and lifecycle

A fresh Bellman epoch signs `verifierPolicy.verificationMethod` as
`bellman-transition-v1` and separately pins `relation.genesisBellman`. It keeps
`relation.genesisZkey`, R1CS and PTAU unchanged for final import/verification.
The Bellman genesis must be the exact snarkjs 0.7.6 export of that original zkey;
each verifier independently reproduces the export at startup. The legacy absent
method means `snarkjs-zkey-v1`, and cannot accept Bellman reports.

Ordinary contributions stay in Bellman format. Each operator independently hashes
candidate/predecessor bytes, checks bounded framing, fixed sections and exact
transcript prefix, then invokes the checked, revision-pinned Rust transition
verifier. Its public hash must match the independently hashed appended record
and submission claim. Bellman reports explicitly set `verifyFromInit: false`
and `bellmanTransition: true`; they cannot satisfy zkey policy or vice versa.
Participant names remain signed receipt metadata, not falsely observed artifact
fields. The independently observed name is null in Bellman reports.

Acceptance still requires the signed operator policy, immutable promotion,
transactional head CAS, signed receipts, and witness acknowledgement before
another lease. Rehearsal can use one operator; production requires unanimity
from at least two independent operators.

After sealing, the offline finalizer takes the original pinned genesis via
`--genesis-zkey`. It reproduces and checks the Bellman genesis, checks the sealed
head's framing and unchanged fixed sections, imports the whole chain once,
verifies the resulting zkey against R1CS/PTAU, applies the committed beacon, and
verifies again. It publishes `sealed-import.zkey` and its digest in addition to
the final artifacts. The sealed checkpoint continues to identify the original
Bellman bytes. Imported zkeys need not be byte-identical to the original genesis;
see `experiments/bellman/ROUNDTRIP.md`. Names are recovered from signed receipts,
not synthesized into the imported cryptographic transcript.

## Browser and deployment

The browser worker chooses Bellman only from the server's root-verified manifest
and runs the pinned snarkjs Bellman arithmetic with OPFS I/O. It checks predecessor
SHA-256/length and requires exactly 384 output bytes per appended record. The
worker terminates its arithmetic workers before returning the OPFS output.
This release leaves participation disabled pending actual browser acceptance.
The filesystem CLI follows the same signed policy: in a Bellman epoch it runs
the same pinned snarkjs Bellman arithmetic in a child process, checks the exact
384-byte append and identifier, and reuses a retained output after a restart.
Offline receipt verification supports both policies.

The verifier Docker target includes the separately built locked native binary
at `/usr/local/bin/moss-bellman-verify`. Local verifier runs set
`BELLMAN_VERIFIER_PATH` to the absolute release-binary path. Verifier
`GENESIS_ZKEY_PATH` still means original zkey. Coordinator local genesis seeding
uses its existing `GENESIS_ZKEY_PATH` setting for the canonical contribution
artifact (Bellman for a Bellman epoch); hosted canonical genesis is prepublished.
Legacy object keys and some internal field/file names still use `.zkey`; those
are opaque storage identifiers, not format detection. The signed policy decides
format and user-facing history downloads use `.params` for Bellman.

## Validation and remaining gates

Completed: checked native wrapper and malformed-input/transition regressions;
three synthetic direct contributions followed by one final import and full
verification before/after a beacon; OPFS Bellman contribution/import validity;
policy separation; worker signed-report behavior; finalizer import lifecycle.
The regression uses the finalizer's tracked-handle backend because raw repeated
snarkjs operations leak file handles under Node 25.

Still required: full coordinator integration and browser runs across supported machines,
provider uploads and recovery, independently operated witness/mirror, actual
PostgreSQL concurrency and hosted OAuth, final release/manifest publication and
full dress rehearsal. A successful synthetic test does not certify these gates.

## Browser upload recovery increment

Browser S3 multipart uploads now use bounded 64 MiB Blob slices, fresh part
capabilities for retry, credential-free HTTPS requests to release-allowlisted
origins, and an explicit ETag CORS check. ETags are completion metadata only;
coordinator byte hashing/immutable-version checks still decide acceptance.
`ARTIFACT_ORIGINS` must include the exact quarantine bucket origin as well as
canonical artifact origins. The existing bucket template exposes ETag.

Completed output stays in OPFS on failure. The journal binds its filename to
manifest, identity, lease, predecessor and independently computed output digest.
Retry hashes that retained file before reuploading the same bytes. Completed part
metadata is journaled before requesting completion so an ambiguous completion
can be retried. Partial uploads currently re-send all parts; skipping already
uploaded parts is an optimization, not implemented. Successful receipt handling
removes the output. A closed/evicted browser may lose OPFS data; recovery then
fails and requires a new slot rather than accepting a client claim.

The Linux AMD64 verifier image builds locally with the locked Rust dependency.
Actual AWS permissions, CORS, interruptions, and retention remain provider tests.

## Independent witness increment

`apps/witness` now implements manifest/receipt/event/report verification,
predecessor continuity, artifact mirroring with independent hashing, locked S3
retention checks and conditional immutable acknowledgements. Retry and restart
recover from the retained sequence; a conflicting bundle cannot overwrite an
acknowledgement. The separate witness Docker target builds for Linux AMD64.
Local tests cover signatures, missing predecessors/reports, retention failures,
ambiguous writes and changed artifact bytes. Actual AWS and independent-operator
validation remain outstanding; no AWS account was accessed.

## Full-size local validation — 2026-09-24

Using the existing hash-pinned Moonsong genesis, R1CS and PTAU (no new genesis):

- Three direct Bellman contributions passed native verification and four negative
  transition/count controls rejected. The chain was imported once at the end,
  verified against R1CS/PTAU, given a fixed **test-only** beacon, and verified again.
- A separate headless desktop Chrome run used the actual built OPFS contribution
  worker for three sequential full-size contributions. Each was checked by the
  integrated native `BellmanPassRunner`; no intermediate zkey import occurred.
  Download plus computation took 60.402, 55.874 and 60.879 seconds on this Mac.
  Output lengths were 368,440,732; 368,441,116; and 368,441,500 bytes. These times
  exclude upload and native verification and are not public-network estimates.
- The browser harness used isolated loopback transfers. It did not exercise OAuth,
  coordinator leases, PostgreSQL acceptance, S3 multipart, receipts or witness
  publication. It is not a completed dress rehearsal or a hardware matrix.
- The synthetic regression additionally exercises the integrated runner, offline
  helper, 12 negative controls, and final import/beacon verification.

Reproduction: build packages and the locked native verifier, then run
`node packages/bellman-verify/tests/transition.mjs` (synthetic) or add
`--production` (requires the ignored, pinned local artifact paths). The browser
harness is `experiments/bellman/browser-direct.mjs`; pass an exported zero-count
Bellman genesis path and an installed Playwright module path. It uses installed
macOS Chrome and disposable local artifacts; it does not access AWS.

Final repository checks: `pnpm build`, `pnpm typecheck`, `pnpm test`,
`pnpm test:e2e`, and `git diff --check` pass. The existing `test:e2e` script
covers the setup wizard, not the live ceremony. Linux AMD64 verifier and witness
images also built locally. AWS provider checks, real PostgreSQL concurrency,
GitHub OAuth, independent-operator deployment, long-history scaling and the
supported browser/hardware matrix remain untested in this increment.

## Closed hosted review and single archive (2026-09-25)

The default AWS deployment is a separate closed review server. It has health and
setup/readiness endpoints only; all ceremony paths return 423. It has no signed
epoch, schedule maintenance, queue or upload handlers. Vercel review mode
requires both `CEREMONY_MODE=rehearsal` and `REHEARSAL_REVIEW_MODE=true`; it
presents explicitly simulated flow screens alongside real backend readiness and
an optional real GitHub login test. Disabling a button is not the closure boundary.

For a subsequent signed rehearsal, `primaryPublication.archiveBaseUrl` selects
single-archive publication. It is mutually exclusive with the legacy witness
policy and requires explicit rehearsal opt-in. The coordinator retains each
evidence bundle and deterministic signed checkpoint in immutable storage before
recording publication. The transactional next-offer gate checks the checkpoint
signature and exact head. The public publications API supplies these records and
version-pinned bundle URLs. This does not assert independent witnessing or
prove an externally observed publication time. External observers should retain
checkpoints during the ceremony. The production policy is unchanged pending its
own review; an independent production verifier remains desired.
