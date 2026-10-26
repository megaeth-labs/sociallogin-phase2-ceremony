# Ceremony runbook

This runbook covers the runnable loopback stack, contributor clients, reset and
recovery, production preparation, and offline finalization. The loopback stack
uses a tiny synthetic circuit and development-only keys. It is not a rehearsal
with the MOSS production relation.

For the planned hosted rehearsal with Adeva and two collaborators, see
[REHEARSAL.md](REHEARSAL.md) for readiness, contribution handoffs, and finalization.

## 1. Install and verify

Requirements are Node.js 24 or newer, pnpm 10.29.2, and Docker with Compose.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
git diff --check
```

The `upstream` remote should remain Cabure and a release must use a reviewed
commit rather than a mutable branch:

```sh
git remote -v
git rev-parse HEAD
```

## 2. Start the loopback API stack

Create a zero-contribution genesis for the repository's small multiplier test
fixture, then start PostgreSQL, the coordinator, and one verifier worker:

```sh
pnpm dev:artifacts
pnpm dev:stack
docker compose ps
curl --fail http://127.0.0.1:58787/healthz
```

`pnpm dev:artifacts` refuses to overwrite an existing local epoch. The generated
R1CS, PTAU, and genesis zkey are ignored by Git. Compose generates separate
manifest-root, coordinator, verifier, and participant-issuer keys in private
volumes, migrates PostgreSQL, signs a development manifest, and mounts the
artifact store read-only into the verifier.

New development epochs use one verification pass. The production draft requires
one complete pass from each of two independent operators, with both approvals
required. A previously signed manifest requiring more passes is still enforced.
When restarting an existing development epoch, keep the worker pass count equal
to that epoch's manifest; the new default does not rewrite existing manifests.
Use section 6 only when deliberately creating a fresh development epoch.

The default artifact backend is a coordinator-owned local filesystem. Optional
MinIO is an emulator for storage-policy experiments only; the coordinator does
not use it:

```sh
docker compose --profile s3-emulator up -d minio minio-bootstrap
```

All published ports bind to loopback. Do not expose this topology or its sample
database credentials to another host.

## 3. Verify signed local status with the CLI

The status command needs an independently obtained copy of the public manifest
root. Copying this public key does not expose any ceremony secret:

```sh
mkdir -p infra/work
docker compose cp \
  local-runtime-init:/runtime-config/manifest-root-public.pem \
  infra/work/manifest-root-public.pem
pnpm --filter @moss/phase2-ceremony-cli build
node packages/cli/dist/index.js status http://127.0.0.1:58787 \
  --slug moss-phase2-local-development \
  --manifest-root-key infra/work/manifest-root-public.pem \
  --allow-development-manifest
```

The command verifies both the root-signed manifest and coordinator-signed
checkpoint before printing state. A reduced development manifest is rejected
without the explicit loopback-only flag.

## 4. Run the web client locally

The web app is optional for API-stack development. A real browser sign-in needs
a GitHub OAuth App whose callback is:

```text
http://localhost:3000/api/auth/callback/github
```

Copy `apps/ceremony/.env.example` to the ignored
`apps/ceremony/.env.local`. Fill the GitHub and NextAuth values, coordinator URL,
slug, and manifest-root pin. Export the local issuer material from the private
Compose volume into the ignored work directory without printing it:

```sh
mkdir -p infra/work/web-auth
docker compose cp \
  local-runtime-init:/web-auth-secrets/participant-jwt-private.pem \
  infra/work/web-auth/participant-jwt-private.pem
docker compose cp \
  local-runtime-init:/web-auth-secrets/participant-id-derivation-key \
  infra/work/web-auth/participant-id-derivation-key
chmod 600 infra/work/web-auth/*
```

Use these paths in `.env.local`:

```text
COORDINATOR_BASE_URL=http://127.0.0.1:58787
CEREMONY_SLUG=moss-phase2-local-development
MANIFEST_ROOT_KEY_ID=manifest-root-dev
MANIFEST_ROOT_PUBLIC_KEY_FILE=../../infra/work/manifest-root-public.pem
PARTICIPANT_JWT_PRIVATE_KEY_FILE=../../infra/work/web-auth/participant-jwt-private.pem
PARTICIPANT_ID_DERIVATION_KEY_FILE=../../infra/work/web-auth/participant-id-derivation-key
PARTICIPANT_JWT_ISSUER=moss-phase2-local-web
PARTICIPANT_JWT_AUDIENCE=moss-phase2-local-coordinator
NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED=false
```

Compute the public SPKI fingerprint, review it, and place the resulting
lowercase hex value in `MANIFEST_ROOT_PUBLIC_KEY_SPKI_SHA256`:

```sh
openssl pkey -pubin \
  -in infra/work/manifest-root-public.pem \
  -outform DER | openssl dgst -sha256
```

Then start the app:

```sh
pnpm dev:web
```

Leave browser contributions disabled until the exact production-size release
passes the browser memory, quota, interruption, and resume matrix. GitHub CLI
Device Flow additionally requires the two Upstash variables and Device Flow
enabled on the OAuth App. Browser OAuth itself does not use Upstash.

## 5. Contribute with the filesystem CLI

When browser contributions are disabled, the landing page shows **Contribute
from your computer** in place of browser sign-in/start controls. It includes
the reviewed-source build steps, root-key pinning instructions, current
coordinator/slug commands, disk and transfer requirements, and recovery/receipt
guidance. The command uses GitHub Device Flow for hosted ceremonies and a
private token file for loopback development. Replace the displayed sample key
and token paths with your actual files; the existing full-size local test paths
are recorded in [REHEARSAL.md](REHEARSAL.md).

Both website guides start with cloning/fetching the repository and selecting
the organizer's reviewed commit. `REVIEWED_RELEASE_COMMIT` is an explicit
placeholder until the reviewed revision is published; current worktree commits
must be pushed before collaborators can fetch them. Build steps list the
protocol and CLI separately to avoid confusing pnpm's `...` dependency selector
with truncated text.

The contribution guide supplies a public-root download and its SPKI fingerprint.
The current local Moonsong epoch's public key and fingerprint are also recorded
under [ceremonies/local-moonsong](ceremonies/local-moonsong/README.md). This is a
development-only public key, not production signing material. Confirm the
fingerprint independently; neither a website download nor a repository copy
alone authenticates its owner.

The full-size CLI contribution has been exercised locally. That is not evidence
of browser viability: leave browser contributions disabled until the exact
artifact has passed the supported-browser memory, OPFS quota, interruption and
recovery matrix. The website remains usable for status, contribution history
and public receipt inspection while participation happens in the CLI.

For a deployed ceremony, the CLI obtains an EdDSA participant token through the
web issuer's GitHub Device Flow:

```sh
node packages/cli/dist/index.js contribute https://coordinator.example \
  --slug moss-google-rs256-zksync-v3 \
  --manifest-root-key ./independently-pinned-root.pem \
  --auth-url https://ceremony.example
```

For controlled local automation, use an already issued coordinator-compatible
token through a mode-0600 file and add `--allow-development-manifest`. Do not put
bearer tokens on a command line. The CLI checks disk capacity, resumes and
hashes the predecessor, contributes in a child process while heartbeats remain
active, uploads the exact successor, waits for all verifier reports, verifies
the signed receipt, and saves it locally.

The working directory contains zkey material and remains after a failure for
recovery. Remove it deliberately after retaining the public receipt and any
needed diagnostic evidence.

## Inspect accepted contributions and receipts

The landing page's **Contribution history** polls accepted receipts and shows
participant pseudonyms, acceptance times, client kinds, predecessor/output
hashes, sizes and transcript event hashes. Expand an entry to download its
signed receipt. The browser checks every receipt signature and artifact
continuity from genesis through a fresh signed coordinator head. The public
endpoint is `GET /v1/ceremonies/:slug/contributions?after=<generation>` and
returns at most 50 receipts per page; it exposes no participant auth IDs or
pending upload capabilities.

**Verify locally** provides downloads of the signed manifest and public root
key, the root fingerprint, and offline commands. Confirm the root fingerprint
independently; obtaining it from the same website is not an independent trust
anchor. Download a signed receipt and optional accepted zkey from its history
card. Cards describe the signed manifest's acceptance policy and show the
coordinator-signed acceptance time, not a separate verifier completion time.
They do not claim to replay or publish the individual verifier reports.

Build the reviewed CLI, then verify downloaded files without contacting the
coordinator or logging in:

```sh
node packages/cli/dist/index.js verify-receipt ./receipt.json \
  --manifest ./ceremony-manifest.json \
  --manifest-root-key ./ceremony-root.pub \
  --slug moss-google-rs256-zksync-v3
```

For the local development epoch, use its slug
`moss-phase2-local-development` and add `--allow-development-manifest`.
The command supports raw signed envelopes, CLI files with `receiptEnvelope`
and `localEvidence`, browser exports with `signedReceipt`, and receipt arrays.
It verifies the root-signed manifest and coordinator signature, ceremony and
manifest binding, and supplied local evidence. It rejects mismatches and exits
nonzero. It does not establish final-chain inclusion or rerun cryptographic
artifact verification. The CLI's contribution path separately compares the
receipt to its locally computed output before reporting acceptance.

For an optional artifact check, compare its SHA-256 and byte length to the
verified receipt. A full `snarkjs zkey verify` additionally needs the pinned R1CS
and PTAU; the page gives the command and distinguishes generic zkey validity
from the server's exact predecessor-plus-one check. The local development
manifest does not publish R1CS/PTAU URLs; the local operator supplies those files.

## 6. Stop, restart, and reset

An ordinary stop preserves the database, keys, manifest, and accepted files:

```sh
pnpm dev:down
pnpm dev:stack
```

If signed inputs or local artifacts change, destroy the entire development
epoch instead of mixing them with the old database and keys:

```sh
docker compose down --volumes
```

After a full reset, remove the three ignored files under `infra/dev-artifacts/`
only if a fresh synthetic setup is intended, then run `pnpm dev:artifacts` and
`pnpm dev:stack` again.

The coordinator recovers expired offers, leases, verifier jobs, and the
verified-report-to-head-update boundary from PostgreSQL. Browser and CLI clients
query the participant-scoped ceremony state after restart, then cross-check the
recovered ticket, lease, submission, and receipt links before resuming. When a
candidate was already uploaded, they also query its participant-scoped durable
upload record and submit without recomputation only if the manifest, lease,
predecessor, name, contribution hash, successor SHA-256, and byte length all
match the local journal. Verifier workers authenticate as one signed-policy
operator, renew their own bounded job lease, and bind every report to that exact
job attempt. Never repair ceremony state with ad hoc SQL. Preserve logs and
signed evidence, stop the affected service, and diagnose the failed invariant
before restarting it.

## 7. Prepare a production epoch

Do not use the MOSS development-testnet final zkey as a genesis. Starting from
the exact revisions in the ceremony definition:

1. reproduce the complete remediated Circom include closure with pinned tools;
2. compile and independently check the clean R1CS metadata and hash;
3. independently acquire and hash the canonical BN254 Powers of Tau file;
4. create a new zero-contribution Groth16 genesis zkey from that R1CS and PTAU;
5. publish immutable, version-pinned copies of the R1CS, PTAU, and genesis;
6. fill every unresolved field in
   `ceremonies/google-rs256-zksync-v3/definition.draft.json`;
7. freeze exactly one coordinator key, the verifier identity (one internal
   operator for mainnet) with its own signing key and internal credentials,
   production release/image digests, the schedule, and the precommitted future
   Ethereum mainnet beacon block; and
8. independently review, sign, mirror, and timestamp the final manifest before
   opening.

The epoch remains `DRAFT` while any field is unresolved. Schedule transitions
are enforced from the signed times; this version has no administrator endpoint
that may bypass verifier unanimity or canonical-head compare-and-swap.

Before production deployment, complete every item in
`infra/PRODUCTION_DEPLOYMENT_CHECKLIST.md`. In particular, this repository still
needs a concrete versioned/Object-Locked provider adapter with conditional,
crash-idempotent promotion. The mainnet manifest uses `primaryPublication`:
each accepted head's evidence bundle and coordinator-signed checkpoint must be
in the Object-Locked archive before the next lease. Owner decision
(2026-10-23): there is no independent transcript witness. The coordinator
intentionally refuses its development filesystem backend under
`NODE_ENV=production`.

## 8. Seal and finalize

### Updating operational settings and fixing the website

Production manifests can preauthorize bounded operational changes with
`operationalPolicy`: `minHeartbeatGraceSeconds`, `maxHeartbeatGraceSeconds`, and
`allowWebReleaseUpdates`. The manifest builder defaults to 30–600 seconds and
allows browser updates. Existing production manifests without this policy remain
immutable. Legacy rehearsals explicitly opt in through rehearsal mode and purpose.

Before first use, apply migration `006_operational_updates.sql`, deploy the updated
coordinator and web bootstrap, and keep the root private key offline. This is a
one-time rollout; subsequent signed setting/release updates require no coordinator
restart or queue drain. The published company rehearsal is not automatically
migrated by committing this code.

Only heartbeat grace, additional browser releases and, when the manifest sets
`operationalPolicy.allowCliReleaseUpdates`, additional CLI releases are
adjustable. Circuit and artifact pins, verifier requirements, keys, closing
schedule, beacon, absolute slot deadline and contribution cap cannot be changed
through this API. Release updates only add builds; earlier ones stay authorized.
A browser build can affect contributor security: reproduce and review every
release, then publish immutable `web-release.json` and reproduction evidence
before authorizing it. Do not disable SRI or hash checks to ship a fix.

The public endpoint is `GET /v1/ceremonies/SLUG/operational-updates`. Save its JSON
response as `history.json`, and prepare a public `change.json`, for example:

```json
{"reason":"Reduce abandoned-slot queue delay","heartbeatGraceSeconds":120}
```

For a website fix, replace `heartbeatGraceSeconds` with `webRelease`, containing
the reviewed release's SHA-256, byte length, immutable URLs and full source commit.
Use a distinct commit for a different bundle; deployments of the same commit may
still produce different asset bytes. For a CLI fix, use `cliRelease` with the
same fields for `packages/cli/dist/index.js` built on the fix commit; the CLI
fetches and verifies this history itself when its build is not in the manifest.
Several fields may be included together.

From a reviewed checkout (never put key contents in commands, logs or Git):

```sh
pnpm --filter @moss/phase2-protocol build
node infra/operational-update.mjs sign \
  --manifest ceremony-manifest.json --root-public-key ceremony-root.pub \
  --root-private-key /private/offline/root.key \
  --history history.json --change change.json --out update.signed.json
node infra/operational-update.mjs submit \
  --coordinator https://COORDINATOR_HOST --slug CEREMONY_SLUG \
  --update update.signed.json
```

Review the public signed output before submitting. The endpoint authenticates
the root signature, ceremony/manifest binding, sequence, predecessor hash and
bounds; a GitHub session or verifier credential cannot authorize changes. The
private root key never leaves the signing machine. The coordinator archives the
authorization in a version-pinned immutable object before committing its
append-only database record. A failed transaction can leave an unapplied archive
object: the public applied history distinguishes those from active updates.

Download history again and independently verify it with:

```sh
node infra/operational-update.mjs verify \
  --manifest ceremony-manifest.json --root-public-key ceremony-root.pub \
  --history history.json
```

Every update has a public reason, authorization time and sequence. Application
timestamps and archive version pins are also returned, but are coordinator-reported.
Old/new settings can be reconstructed from the manifest and ordered updates.
Concurrent conflicting updates are rejected; reload history and review/sign again.
Retrying an identical accepted update is idempotent. The audit chain permits at
most 256 updates, each at most 8 KiB, for the epoch.

Heartbeat increases apply to still-live slots immediately. Decreases only affect
newly claimed slots: existing active slots retain their greatest promised grace.
Already expired slots never revive, absolute deadlines remain enforced, and
heartbeat changes are rejected once contributions close. Browser and CLI clients
send heartbeats at most five seconds apart while running normally. Suspended
browsers may still miss the grace window.

New root-authorized browser releases become eligible immediately, while prior
authorized builds remain eligible for in-flight participants. Stage the site,
reproduce/check its assets, publish the release descriptors, submit its signed
update, and only then promote the deployment. The web bootstrap chooses the
authorized release matching its build commit. Website updates may be authorized
after closing to repair final-results pages. Revoking a compromised old build is
not implemented here: use the incident procedure to pause participation and
review affected contributions, rather than silently rewriting the audit history.

The company rehearsal permits five minutes without a participant heartbeat
before expiring an active slot. This is an explicit rehearsal-only operational
relaxation of the original manifest's 15-second allowance, enabled only when
both the signed purpose and coordinator mode are rehearsal. The original
manifest, accepted chain, 90-minute absolute slot deadline and closing time are
preserved. It does not revive already expired slots or change verification.
Production uses the signed allowance exactly; newly generated manifests default
to 300 seconds. Test background-tab scheduling before production launch: this
grace period cannot keep a suspended browser computing or prevent tab eviction.

At the signed sealing time the coordinator stops issuing new work and signs a
`SEALED` checkpoint. Independently retrieve and compare the signed manifest,
sealed checkpoint, head SHA-256, and byte length before moving public artifacts
to the offline finalizer host.

The mainnet manifest precommits a future Ethereum mainnet block and uses
Bellman contributions. Do every step below on the offline finalizer host, and
rehearse the whole sequence on the dress-rehearsal stack before opening.

1. **Audit and replay** every signed record and every transition from the
   archive. Run it before the beacon block arrives; it does not depend on it.
   Use `--jobs` to split the replay (about 22 seconds per transition on an
   M4 Pro, 200 seconds on the rehearsal's AWS worker). A crash resumes from
   `<work-dir>/replay-state.jsonl`.

   ```sh
   pnpm --filter @moss/phase2-finalizer build
   cargo build --release --locked --manifest-path packages/bellman-verify/Cargo.toml
   node apps/finalizer/dist/audit/cli.js \
     --manifest /independent/manifest.signed.json \
     --root-key /independent/manifest-root-public.pem \
     --root-key-id reviewed-root-key-id \
     --root-key-spki-sha256 reviewed-64-hex-fingerprint \
     --sealed-checkpoint /independent/sealed-checkpoint.signed.json \
     --sealed-head-sha256 independently-reviewed-64-hex-hash \
     --sealed-head-byte-length independently-reviewed-byte-length \
     --coordinator-url https://COORDINATOR \
     --mirror /artifacts/archive-sync \
     --bellman-verifier "$PWD/packages/bellman-verify/target/release/moss-bellman-verify" \
     --work-dir /new/path/audit --jobs 8
   ```

   It exits 0 only when every check passed with a full replay, and writes the
   deterministic `ceremony-audit.json` plus timings in `ceremony-audit-run.json`.

2. **Finalize** once the committed block is finalized on Ethereum, with at
   least two independently operated RPC endpoints. `--genesis-zkey` is the
   original pinned genesis zkey: the finalizer re-exports the Bellman genesis
   from it, imports the sealed Bellman chain once, and verifies the result
   against the R1CS and PTAU before and after the beacon.

   ```sh
   node apps/finalizer/dist/cli.js \
     --manifest /independent/manifest.signed.json \
     --root-key /independent/manifest-root-public.pem \
     --root-key-id reviewed-root-key-id \
     --root-key-spki-sha256 reviewed-64-hex-fingerprint \
     --sealed-checkpoint /independent/sealed-checkpoint.signed.json \
     --sealed-head /artifacts/sealed-head.params \
     --sealed-head-sha256 independently-reviewed-64-hex-hash \
     --sealed-head-byte-length independently-reviewed-byte-length \
     --genesis-zkey /artifacts/genesis.zkey \
     --r1cs /artifacts/relation.r1cs \
     --ptau /artifacts/powers-of-tau.ptau \
     --eth-rpc-url https://FIRST-PROVIDER \
     --eth-rpc-url https://SECOND-PROVIDER \
     --output-dir /new/path/finalized
   ```

   The output holds `final.zkey`, `verification_key.json`, `Verifier.sol`,
   `sealed-import.zkey`, `ethereum-block-evidence.json` and the hash summary
   `final-artifacts.json`. See `apps/finalizer/README.md` for the derivation.

3. **Proof tests.** Compile the circuit with Circom 2.2.3 `--O2 --r1cs --wasm`
   (the R1CS must be byte-identical to the pinned one), then prove with the
   final key, check every public input, reject mutations, and run the Foundry
   tests against the exported verifier on a local EVM. Nothing is deployed.

   ```sh
   node apps/finalizer/dist/proof-test/cli.js \
     --final-zkey /new/path/finalized/final.zkey \
     --verification-key /new/path/finalized/verification_key.json \
     --solidity-verifier /new/path/finalized/Verifier.sol \
     --r1cs /artifacts/relation.r1cs --wasm /build/circuit.wasm \
     --expected-r1cs-sha256 173eba6b9b7883bb8e761f69f902c334b14cea61a094eba7466f0f548d601692 \
     --circom-version 2.2.3 --circom-optimization O2 \
     --input fixture.input.json --expected-public fixture.public.json \
     --output-dir /new/path/proof-tests
   ```

4. **Publish** the outputs, the audit report and the proof index to the
   Object-Locked bucket. Each file goes to a hash-addressed key, is reused if
   identical bytes already exist, and is re-downloaded and hashed through the
   public origin. If anything fails, rerun the same command with the same
   journal.

   ```sh
   node apps/finalizer/dist/publish/cli.js \
     --finalizer-output /new/path/finalized \
     --audit-report /new/path/audit/ceremony-audit.json \
     --proof-evidence /new/path/proof-tests/proof-verification-index.json \
     --bucket ARCHIVE-BUCKET --region REGION --public-base-url https://ARCHIVE/ \
     --label YYYY-MM-DD --journal /new/path/publish-journal.json \
     --index-out /new/path/publication-index.json \
     --minimum-retention-until RETENTION-ISO-DATE
   ```

   `ceremonies/google-rs256-zksync-v3/FINALIZATION.template.md` is the write-up
   to fill in from these outputs.

### Publish the completion record

The coordinator stays `SEALED`; it never holds the root key and is never moved
to `FINALIZED`. Completion is an offline record signed by the manifest root
(`moss.phase2.finalization.v1`, domain `MOSS_PHASE2_FINALIZATION_V1`) that the
website verifies against the live sealed checkpoint. A production record is
rejected for a rehearsal manifest, and the rehearsal record for production.

1. Complete steps 1–4 above. The record needs a full-scope, passing
   `ceremony-audit.json`, a `proof-verification-index.json` that includes the
   Solidity tests, and the `publication-index.json` the publisher wrote, with
   the index's own versioned URL from the publisher's output.
2. Build the unsigned record. The tool refuses unless every published file
   matches the local bytes, the summary matches the sealed checkpoint, the audit
   replayed every transition and checked every receipt, and the proof tests passed
   against this final key:

   ```sh
   pnpm --filter @moss/phase2-protocol build
   node infra/finalization-record.mjs build \
     --manifest ceremony-manifest.signed.json --root-public-key ceremony-root.pub \
     --checkpoint sealed-checkpoint.signed.json --finalizer-output /new/path/finalized \
     --audit ceremony-audit.json --proof-index proof-verification-index.json \
     --publication-index publication-index.json \
     --artifact-index-url 'https://ARCHIVE/…/sha256/<hex>/publication-index.json?versionId=…' \
     --out finalization.payload.json
   ```

3. Review the payload, then sign it on the offline root machine. The tool
   verifies the result against the out-of-band public key and never overwrites:

   ```sh
   node infra/finalization-record.mjs sign \
     --manifest ceremony-manifest.signed.json --root-public-key ceremony-root.pub \
     --checkpoint sealed-checkpoint.signed.json --record finalization.payload.json \
     --root-private-key /private/offline/root.key --out finalization.signed.json
   ```

4. Commit the signed record three times, byte-identical: as
   `apps/ceremony/src/lib/ceremony-finalization.json` (replacing `null`),
   `apps/ceremony/public/finalization.signed.json`, and under the ceremony's
   directory in `ceremonies/`. The site test requires the first two to match.
5. Build the release from that commit, describe it with `pnpm web:release`,
   publish the descriptor at an immutable URL, and authorize it with a root-signed
   `webRelease` operational update (above). Submit the update, then deploy that
   exact commit with `MOSS_WEB_BUILD_ID=<commit>` at build and run time. The
   site rejects an unauthorized build ID.
6. Confirm the live homepage shows **Ceremony complete**, every download link
   resolves to the pinned bytes, and
   `node infra/finalization-record.mjs verify … --record finalization.signed.json`
   passes from an independent checkout.

## 9. Production release gate

Before activating an onchain verifier:

1. replay every accepted append from immutable archived bytes (step 1 of §8;
   owner decision 2026-10-24: the team runs it, with no outside replay);
2. reproduce and compare the terminal verification key and Solidity verifier;
3. compare deployed runtime bytecode with the reviewed build;
4. accept a known-valid proof and reject mutated proofs and public inputs;
5. keep the signed transcript, receipts, reports, beacon evidence, and final
   hashes in the team's Object-Locked archive (owner decision 2026-10-24: no
   independently administered mirror); and
6. keep the announced challenge window open before activation.

The terminal public beacon prevents a coordinator from choosing the final
contribution after seeing its randomness. It does not provide secret toxic-waste
entropy. Soundness still requires at least one accepted ordinary contributor to
have generated, kept private, and destroyed their contribution secret.

## Rehearsal repeat-participation update

Sequential repeat contributions are permitted only for an explicitly enabled,
root-signed rehearsal manifest. Deploy migration
`005_rehearsal_repeat_contributions.sql` before the updated coordinator. Drain
active queue/lease/verification work before replacing a browser release or
restarting the coordinator. Keep the signed manifest, existing accepted chain,
closing time and total contribution cap unchanged. Production's database index
continues to reject repeat accounts even if queue admission is bypassed.

Test the migration in an isolated PostgreSQL database with
`psql -v ON_ERROR_STOP=1 -f packages/db/tests/rehearsal-repeat.sql`.
