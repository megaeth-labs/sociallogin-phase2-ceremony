# Three-contributor dress rehearsal

Run order: Adeva, collaborator A, collaborator B. Each uses a separate GitHub
account and their own device. This exercises the actual 567 MB relation from
genesis through finalization.

Current owner preference: the first local contribution test uses the pinned
Moonsong O2 relation, not the synthetic multiplier fixture. See the full-size
local instructions below. This still uses development trust policy; completing
it is not completion of the hosted rehearsal.

Owner decision (2026-09-23): the hosted rehearsal may use one verifier operator,
running one complete fresh verification pass per candidate. Production still
requires two independent operators. Hosted rehearsal policy is implemented with signed `purpose: "rehearsal"`,
server `CEREMONY_MODE=rehearsal`, and CLI `--allow-rehearsal`. NODE_ENV remains
production; the production operator minimum is unchanged.

## Readiness

For the AWS account, bucket, role and OAuth preparation, see
[AWS rehearsal setup](infra/AWS_REHEARSAL_SETUP.md).

The AWS adapter/runtime, coordinator publication gate, Ethereum authority and
deployment template are implemented locally. Live AWS/Vercel integration, an
independently operated witness/mirror service, and hosted recovery/full-size
tests remain launch blockers. Start with the [provisioning request](infra/REHEARSAL_PROVISIONING.md).
The default loopback Compose fixture uses a tiny synthetic circuit; the separate
full-size local epoch described below uses the actual Moonsong artifacts. Both
use one development verifier and are local tests. Do not expose them to
collaborators. See [RUNBOOK.md](RUNBOOK.md) for the local workflow.

Prepare a dedicated rehearsal with:

- a new ceremony ID/slug, separate signing keys, database state and storage;
  start from the pinned zero-contribution genesis, never a contributed key;
- HTTPS coordinator/web endpoints and GitHub OAuth with CLI Device Flow;
- one verifier operator, one complete fresh pass per candidate, with its
  approval required; the two-operator independence test remains a production prerequisite;
- locked canonical storage, independent mirror, transcript publication and
  witness acknowledgement;
- reviewed client releases and an independently distributed root public key;
- a signed manifest with target and maximum contributions both set to 3;
- opening and sealing times allowing all three contributions plus recovery
  time, and a precommitted future Ethereum block after sealing.

Freeze the manifest before opening. If the schedule or beacon must change,
create a new ceremony epoch and document the abandoned attempt. Never choose a
replacement beacon after observing its randomness.

Use the CLI first. Browser contributions remain disabled until the full-size
storage/memory/interruption matrix passes. The eventual browser flow is sign
in, capability check, queue, download, local computation, upload, and receipt.

## Current local test: full-size Moonsong circuit

The three artifacts were moved from Downloads into the ignored directory
`artifacts/moonsong-local/`. Their sizes and SHA-256 hashes match
[the relation definition](ceremonies/google-rs256-zksync-v3/definition.draft.json),
and the PTAU's BLAKE2b-512 also matches:

- `genesis.zkey`: 567,402,188 bytes, zero-contribution ceremony genesis.
- `circuit.r1cs`: 232,099,260 bytes, authoritative Mac-built O2 R1CS.
- `powersoftau.ptau`: 19,327,435,928 bytes, power-24 transcript.

Use a separate Compose project so the synthetic epoch's volumes remain intact.
Both projects use the same loopback ports, so stop the synthetic services first:

```sh
docker compose stop
MOSS_PHASE2_ARTIFACT_DIR=./artifacts/moonsong-local \
  docker compose -p moss-phase2-moonsong-local up -d --build
```

Always supply this project name and artifact directory when restarting the
full-size stack. Do not run `pnpm dev:artifacts` for this test. The development
slug remains `moss-phase2-local-development`, but its ceremony UUID, database,
signing keys, and storage are separate from the synthetic epoch.

The operator exports the new public root and local issuer material into
`infra/work/moonsong/`, updates the ignored web configuration to reference
those files and the new public root fingerprint, and issues a private test
credential at `infra/work/moonsong/local-participant.jwt`. The synthetic token
does not authenticate to this epoch.

After the new stack and credential are ready, run from the repository root:

```sh
node packages/cli/dist/index.js status http://127.0.0.1:58787 \
  --slug moss-phase2-local-development \
  --manifest-root-key infra/work/moonsong/manifest-root-public.pem \
  --allow-development-manifest

node packages/cli/dist/index.js contribute http://127.0.0.1:58787 \
  --slug moss-phase2-local-development \
  --manifest-root-key infra/work/moonsong/manifest-root-public.pem \
  --allow-development-manifest \
  --token-file infra/work/moonsong/local-participant.jwt
```

The CLI generates entropy on your machine, downloads and hashes the full-size
predecessor, computes, uploads, and waits for the development verifier's full
pass before saving its signed receipt. Keep Docker running. This is not a
browser benchmark and no full-size duration is promised. The test has one
verifier, three contribution slots and a seven-day schedule from initialization;
its development beacon is not the hosted Ethereum finalization policy.

## Optional local synthetic circuit

This is a smoke test on your machine; no S3 account is needed. It does not
replace the hosted rehearsal below. Follow [RUNBOOK.md](RUNBOOK.md) to start
the loopback stack, export the public root and configure the web issuer.

For a local test without GitHub, the operator can prepare a development
participant credential using the local issuer and save it to the ignored,
mode-0600 file `infra/work/local-participant.jwt`. With that file already
prepared, use this command instead of the GitHub-authenticated command below:

```sh
node packages/cli/dist/index.js contribute http://127.0.0.1:58787 \
  --slug moss-phase2-local-development \
  --manifest-root-key infra/work/manifest-root-public.pem \
  --allow-development-manifest \
  --token-file infra/work/local-participant.jwt
```

This exercises real local contribution and verification with a synthetic test
identity. It does not test GitHub authentication. The CLI verifies the signed
receipt itself; the website’s "Verify locally" guide explains how to recheck
the saved receipt offline without signing in. Do not print or commit the credential;
it expires and will also stop working if the local epoch's issuer keys change.

For interactive CLI authentication through GitHub, configure the local OAuth App in
the ignored `apps/ceremony/.env.local`, enable Device Flow on that app, and
configure `KV_REST_API_URL` and `KV_REST_API_TOKEN` for Upstash REST Redis in
the same file. Browser sign-in alone does not require Redis; CLI Device Flow
currently does. Keep browser contributions disabled until their acceptance
matrix passes. Restart the web process after configuring authentication.

From the repository root, build the CLI and check signed status:

```sh
pnpm --filter @moss/phase2-ceremony-cli... build
node packages/cli/dist/index.js status http://127.0.0.1:58787 \
  --slug moss-phase2-local-development \
  --manifest-root-key infra/work/manifest-root-public.pem \
  --allow-development-manifest
```

Then run your first contribution yourself so the client generates the secret
entropy on your machine:

```sh
node packages/cli/dist/index.js contribute http://127.0.0.1:58787 \
  --slug moss-phase2-local-development \
  --manifest-root-key infra/work/manifest-root-public.pem \
  --allow-development-manifest \
  --auth-url http://localhost:3000
```

Complete the GitHub authorization requested by the CLI and wait for acceptance
and a saved signed receipt. This local epoch uses one development verifier and
seals seven days after initialization; hitting its cap of three does not seal
it early. Do not use its development manifest or keys for the hosted rehearsal.

## First contribution

Give each participant the reviewed release/source commit, rehearsal slug,
coordinator/web URLs, and root public key. Confirm the root fingerprint through
an independent trusted channel. Contributors never need private signing keys.

For a reviewed source checkout, use Node 24+ and pnpm 10.29.2:

```sh
pnpm install --frozen-lockfile
pnpm --filter @moss/phase2-ceremony-cli... build
```

The following URLs and slug are placeholders for the hosted rehearsal. Save the
authenticated public root key as `./rehearsal-root.pub`. Do not use
`--allow-development-manifest` for this hosted rehearsal.

Check that the signed status is open, at generation 0, with the pinned genesis:

```sh
node packages/cli/dist/index.js status https://coordinator.rehearsal.example \
  --slug moss-rehearsal-1 \
  --manifest-root-key ./rehearsal-root.pub
```

Adeva runs:

```sh
node packages/cli/dist/index.js contribute https://coordinator.rehearsal.example \
  --slug moss-rehearsal-1 \
  --manifest-root-key ./rehearsal-root.pub \
  --allow-rehearsal \
  --auth-url https://ceremony.rehearsal.example
```

Complete the GitHub Device Flow using your own account. The CLI queues, checks
disk capacity, downloads and verifies the predecessor, computes locally,
uploads, waits for verification, and verifies/saves the signed receipt. Allow
roughly 567 MB down and 567 MB up, plus sufficient local working disk space.

Success is `Contribution #1 accepted.` and a saved signed receipt, not merely
an upload completing. Recheck signed status at generation 1. As operator,
confirm the rehearsal verifier's approval and independent publication/witness
acknowledgement before handing over to collaborator A.

For an interrupted attempt, retain the working state and journal and rerun on
the same machine to exercise recovery. Never force acceptance by editing the
database. Save the receipt before following cleanup guidance; local deletion is
not a secure-erasure guarantee.

## Second and third contributions

Invite collaborator A after contribution 1 is accepted and witnessed. They use
the same commands with their own GitHub account. Confirm receipt 2's predecessor
equals receipt 1's successor, and signed status shows generation 2.

Then invite collaborator B. Confirm receipt 3 extends receipt 2 and signed
status shows generation 3. Inviting each person sequentially makes the intended
order explicit. Preserve all three receipts and corresponding verifier reports.
Failed attempts do not consume accepted-contribution slots.

## Conclude the rehearsal

1. **Seal at the signed time.** The cap prevents a fourth ordinary contribution,
   but does not seal early. There is no current administrator "finish now"
   command. Confirm an independently witnessed, signed `SEALED` checkpoint
   containing generation 3.
2. **Retrieve independent evidence.** Compare the signed manifest, checkpoint,
   sealed-head hash and length through independently controlled publication.
   Exactly three ordinary contributions is a rehearsal success criterion:
   the generic finalizer permits fewer than the configured maximum.
3. **Wait for the committed Ethereum block and finality.** Follow the frozen
   evidence/finality policy; do not change the block or weaken checks because
   an RPC provider is unavailable.
4. **Run the offline finalizer.** Supply the signed authority evidence, sealed
   head, pinned R1CS/PTAU, independent Ethereum RPC sources, and a new output
   directory. The CLI already has `--eth-rpc-url`, but authority validation
   still rejects Ethereum commitments. Add and validate the exact runnable
   finalization command here when that blocker is fixed. The runbook's drand
   example is not an Ethereum finalization command.
5. **Verify and archive the result.** Preserve the final zkey, verification key,
   Solidity verifier, beacon evidence and hash summary in both archives.
   Independently replay the chain and reproduce the exported verifier. Test
   valid proofs and mutated proofs/public inputs. The beacon follows the three
   ordinary contributions; it is not a fourth human contribution.
6. **Finish the rehearsal review window, then stop compute.** Record findings,
   finish any recovery, and shut down the contributor API and verifier workers.
   Keep the archive/mirror under the agreed retention policy. Clean up quarantine
   and incomplete uploads after the recovery window; stopping compute does not
   mean deleting the archive.

Mark the rehearsal passed only after these checks succeed. Never activate its
verifier as the production verifier. The real ceremony uses a new epoch and
fresh ordinary contributions from the zero-contribution genesis, not the
rehearsal's final key.
