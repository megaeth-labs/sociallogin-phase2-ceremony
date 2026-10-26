# Ceremony operator action items

Updated: 2026-09-25. Implementation merged and pushed to `main`.

This is the decision and provisioning list for Adeva / the ceremony owner.
Implementation work is listed separately below. The ceremony remains closed
until both lists and the [production deployment checklist](infra/PRODUCTION_DEPLOYMENT_CHECKLIST.md)
are complete. This file records public decisions only; keep credentials,
private keys, participant entropy, and artifact binaries out of it and Git.

See the [latest agreed rehearsal scope](infra/REHEARSAL_PROVISIONING.md#latest-agreed-scope-2026-09-25)
for subsequent decisions: snarkjs-only browser participation, deferred Rust CLI,
one internal verifier, primary archive/public checkpoints, AWS-provided HTTPS,
and retention through launch plus one week. Older requirements below describe
the implemented policy or production backlog until explicitly revised.

## Start with these decisions

Confirmed for the hosted rehearsal: AWS region `us-east-2`; one verifier
operator with one complete fresh pass per candidate is sufficient. Production
still requires two independent operators. Explicit hosted rehearsal policy is implemented without weakening production
validation. Vercel hosts
the website/authentication; persistent coordinator/verifier compute, PostgreSQL,
S3 storage, and GitHub OAuth/Upstash configuration are also needed. See
[provisioning request](infra/REHEARSAL_PROVISIONING.md) and
[AWS deployment instructions](infra/aws/README.md).

Engineering can continue without further owner input on Ethereum finalization,
transcript/witness logic, release integrity, and browser benchmark tooling.
Company account `635288116361` and profile `moss-company-rehearsal` are confirmed
by a read-only STS check. No resources have been provisioned. For real AWS
integration tests, the mirror operator/account still needs to be assigned. For the rehearsal, confirm
the verifier and witness operators and representative desktop test machines.
The public ceremony requires browser participation; CLI-only testing is insufficient.
Domains, OAuth setup, retention policy, contribution cap, and exact schedule
must be finalized before deployment and manifest signing. Share public settings
here; provision credentials through the secret manager.

- [ ] **Choose storage and its owner.** Name the provider, account owners,
  region, archive/quarantine buckets, delivery domains, and retention period.
  Require versioning, Object Lock, immutable version-specific reads, conditional
  promotion, and a separately administered mirror. This unblocks the concrete
  storage adapter and browser CORS/CORP work. Provision access through the
  secret manager; share only public configuration in the repository.
- [ ] **Recruit the second independent verifier operator for production.** Confirm two
  separately administered operators, their technical contacts and availability.
  Two processes or keys under the same team do not satisfy independence.
  Each operator will supply its public verification key and reviewed image
  digest, and run one complete fresh verification pass per candidate. Both
  operators must approve the same candidate.
- [ ] **Assign an independent transcript witness and mirror owner.** Decide who
  stores, acknowledges, and independently timestamps the signed transcript and
  checkpoints. Publish their public identity and endpoint once the witness
  protocol is implemented. A coordinator-controlled mirror is insufficient.
- [ ] **Choose the contribution count and launch window.** The relation draft
  says 100 contributors while `inputs.draft.json` says 25. Resolve this mismatch
  and choose opening time, sealing time, and challenge-window end in UTC.
  Schedule the launch after the rehearsal and independent review.

The contribution count currently acts as a hard cap on accepted ordinary
contributions: the manifest requires `targetContributions` to equal
`maximumContributions`. Failed attempts and the terminal beacon do not count.
The cap must be chosen before signing the final manifest and opening the
ceremony. Reaching it stops new offers; sealing still follows the signed time.
There is no requirement to fill every slot: the finalizer permits fewer than
the cap, but requires at least one ordinary contribution. A time-only policy or
a separate minimum/target/cap would require a protocol change before launch.

## Before the dress rehearsal

The planned first, second, and third contribution walkthrough is in
[REHEARSAL.md](REHEARSAL.md), including how to seal and conclude the rehearsal.

Circuit/source correlation and the existing ZKsync public-test artifact
verification are recorded in [PROVENANCE.md](ceremonies/google-rs256-zksync-v3/PROVENANCE.md).
No owner action is required for this item. The verified Mac-built R1CS remains
authoritative. The downloaded Linux AMD64 Circom 2.2.3 binary is an optional
reproduction tool; it does not impose a Linux rebuild requirement.

- [ ] **Finish the Ethereum beacon policy.** The intended source is a future
  Ethereum mainnet block hash. After choosing the schedule, select a future
  block comfortably after sealing, independent RPC sources, and a finality /
  reorg / unavailable-source policy. Ethereum finalization is implemented;
  hosted verification remains to be exercised. Review and benchmark the
  draft iteration setting before freezing it. Publish the exact commitment
  before opening; never select a replacement after seeing the randomness.
- [ ] **Arrange artifact publication.** Have the authorized artifact custodian
  mirror the pinned R1CS, PTAU, and genesis to immutable, version-pinned URLs.
  Record only reviewed URLs, hashes, byte lengths, and public provenance in the
  manifests. The PTAU currently has no working public source recorded here;
  independently downloadable copies are a launch requirement.
- [ ] **Assign signing-key custody and root-key distribution.** Name the
  manifest-root custodian, the coordinator custodian, and each verifier's
  custodian. Freeze one coordinator key per epoch. Keep the OAuth/token issuer
  separately administered; give the coordinator only its public verification
  material. Decide how contributors independently obtain the manifest-root
  fingerprint. Exchange public keys only through repository updates.
- [ ] **Choose domains, hosting, and OAuth ownership.** Supply public web,
  coordinator, artifact, and witness origins. Create the GitHub OAuth App with
  reviewed callback URLs and Device Flow if the CLI uses it. Assign hosting,
  PostgreSQL backup/restore, monitoring, incident response, and on-call owners.
  The web CSP needs the final coordinator/artifact origins at build time.
- [ ] **Assign the release owner.** Decide how immutable web and CLI releases
  and verifier images will be distributed. Configure MOSS-owned npm publishing
  / trusted publishing only if npm distribution is chosen; inherited Caburé
  package publishing is not automatically a MOSS release process. Review new
  CI checks in branch protection after the workflow update is pushed.
- [ ] **Arrange rehearsal resources and independent review.** Secure access to
  the exact production artifacts and representative contributor machines.
  Public launch requires desktop-browser contribution; mobile is out of scope.
  Provide representative supported browser/OS/hardware classes; leave contributions
  disabled until they pass. Include low disk/quota, interruption, resume,
  verifier retry, storage failure, and restore scenarios. Appoint the reviewer
  who checks the chain and final exported verifier independently.

## Final owner sign-off

- [ ] **Revisit the ceremony names and circuit pin before signing.** Deferred
  by the owner on 2026-10-25; no change for now. The manifest's slug
  (`moss-google-rs256-zksync-v3`), circuit `profile` (`google-rs256-zksync-v3`)
  and `relationId` (`google-rs256-zksync-v3-groth16-bn254-2`), and
  `sourceRepository` (`Moonsong-Labs/zksync-social-login-circuit` at
  `5461ae81…`) are public through the site's bootstrap response and the
  coordinator API, and are fixed once the coordinator is initialized. The slug
  is a one-line change in `inputs.draft.json` plus `CEREMONY_SLUG`. The profile
  and relationId are pinned in `packages/protocol/src/validation.ts:168`;
  renaming them must keep accepting the old names for the signed rehearsal
  manifests and would diverge from the names MOSS uses in moss-zk and
  `MossZkLogin.sol`. The 13 upstream circuit files at that commit match the
  compiled closure byte for byte (checked 2026-10-25).
- [ ] Review and publish the complete root-signed manifest, public keys,
  immutable artifacts, software/image digests, schedule, contribution policy,
  and future-block commitment before opening. Get independent witness evidence.
- [ ] Recruit contributors and publish clear CLI/browser instructions and
  support contacts. Do not request scalar precommitments or secret disclosure;
  ordinary contributors must generate and keep their randomness privately.
- [ ] After sealing, commission independent chain replay, beacon verification,
  verification-key/Solidity reproduction, deployed-bytecode comparison, and
  valid/invalid proof tests. Honor the announced challenge window before
  approving onchain verifier activation.

## Engineering work (not tasks for the ceremony owner)

Implementation is committed and pushed to `main`. AWS/Vercel deployment and live acceptance
tests have not run. The independent witness service is implemented under `apps/witness`; it is a
separate deployment and is not supplied by the primary rehearsal template.

| Work | Status / acceptance condition |
| --- | --- |
| Select and integrate the public browser engine | [Bellman/Rust prototype results](experiments/bellman/RESULTS.md): full-size mixed-engine cryptographic checks pass and transport is 35% smaller. The full-circuit snarkjs OPFS browser prototype passed at 45 seconds compute with about 2.25 GiB sampled Chrome process-tree RSS (14 workers). Rust WASM took six minutes with 1.93 GB WASM linear memory; these memory metrics are not directly comparable. See the [memory investigation](experiments/bellman/MEMORY_INVESTIGATION.md). Direct Bellman acceptance, signed format policy, browser worker integration and final-only zkey import are implemented; see [integration status](BELLMAN_INTEGRATION.md). Complete full-size/browser acceptance, authenticated hosted integration, and the browser/hardware matrix before enabling public participation. |
| Implement public admission and readiness | [Public UI](PUBLIC_CEREMONY_UI.md) implemented locally: community lobby, browser preflight, explicit expiring slot claims, contribution stages and development-only interactive preview. Server readiness groups, fairness/requeue, multi-day recovery and load handling remain. [Ethereum KZG reuse map](PUBLIC_CEREMONY_REUSE.md) identifies public code and test scenarios. Adapt readiness, bounded claims/requeue and load handling to our existing durable queue; do not replace database leases with KZG's in-memory slot ownership. |
| Repair GitHub CI and dependency audit | Implemented locally: Node 24, frozen lockfile, all workspace gates, correct CLI build, patched dependencies; audit reports no known vulnerabilities. Code is published; confirm the hosted CI run before release. |
| Recover after verifier process errors | Implemented and regression-tested: retained errors allow a valid retry without counting as passes; invalid reports veto acceptance. |
| Enforce the contribution maximum transactionally | Implemented and unit-tested under the ceremony row lock for offers and acceptance, and in the canonical-head CAS. Real PostgreSQL contention testing remains outstanding. |
| Implement Ethereum-block finalization | Authority now accepts the signed Ethereum commitment, including explicit rehearsal opt-in. Resolver/authority tests pass; hosted full-artifact finalization remains to run. |
| Implement provider storage | AWS SDK adapter and S3 coordinator runtime implemented with exact-version hashing, bounded presigning, Object Lock and conditional retry-safe promotion. Actual AWS permissions/failure tests remain. |
| Implement transcript publication and witness gates | Coordinator publishes evidence and persists signed witness acknowledgements; offers check the exact head under the row lock. Independent witness/mirror service is implemented with signature/continuity checks and retention-checked S3 writes. Separate deployment, actual AWS failure tests and cross-service recovery remain. |
| Finish schedule enforcement | Five-second autonomous maintenance now runs sealing/recovery/publication independently of clients. External sealed-checkpoint archival and live restart/boundary tests remain. |
| Bind complete compiler/release provenance | Bind the recorded O2 compilation profile into the signed relation; the verified Mac-built R1CS remains authoritative. The Linux compiler pin is optional reproduction metadata. Pin the CLI worker and runtime dependencies as well as its entry point. |
| Harden web release verification | Reject unpinned inline/external scripts, tighten CSP, and enforce artifact origins in the client. |
| Finish production isolation and operations | Worker resource/network limits, upload/temporary-file cleanup, rate limits, readiness, recovery, and observability. |
| Run the production acceptance matrix | Real PostgreSQL concurrency, provider failure tests, full-size CLI/browser runs, two-operator rehearsal, transcript replay, and final proof checks. |

Reference inputs: [relation definition](ceremonies/google-rs256-zksync-v3/definition.draft.json),
[operating inputs](ceremonies/google-rs256-zksync-v3/inputs.draft.json),
[runbook](RUNBOOK.md), and [client plan](IMPLEMENTATION_PLAN.md).

## Validation of the first batch

On Node 25.2.1 and pnpm 10.29.2: frozen-lockfile install, `pnpm build`,
`pnpm typecheck`, `pnpm test` (309 tests), `pnpm test:e2e` (3 scaffold-wizard
tests), `pnpm audit --prod --audit-level high`, and `git diff --check` pass.
The new CI workflow targets Node 24; its hosted run has not happened yet.

The database regressions use an in-memory query harness. Docker is not running
and no standalone PostgreSQL server is available here, so live PostgreSQL
concurrency was not tested. Production artifacts, real provider storage,
independent operators, and the browser/hardware matrix were not exercised.
The local web build has no production coordinator origin and is not a release
artifact for deployment.

## Hosted engineering validation (2026-09-23)

The current hosted implementation passes the repository build, typecheck,
workspace tests and scaffold end-to-end tests. Additional infrastructure tests
cover private runtime materialization and rehearsal manifest assembly/signing.
The CloudFormation template passes `cfn-lint`; coordinator and Linux AMD64
verifier images build, and the bootstrap works in a read-only, non-root container.

This does not constitute AWS provider acceptance, an RDS restore drill, deployed
Vercel OAuth validation, independent witness operation, a full-size hosted
contribution/finalization, or browser/hardware acceptance. Those checks remain
pending the resources and operators in the provisioning request. The local
Moonsong epoch and its existing contribution have not been reset.
