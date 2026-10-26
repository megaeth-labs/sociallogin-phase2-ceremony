# Public ceremony: admission, throughput, and archival costs

Research date: 2026-09-23. Reviewed local implementation: `e9a4e7e` on
`moss/production-hardening`. This is a design proposal, not an implemented policy
change or a launch-readiness claim. Existing signed manifests remain unchanged.

Owner constraint: public ceremony duration is at most two weeks. The capacity
calculations below allow a full 14 days for contributions as an optimistic upper
bound. If the two weeks must also include beacon finality and finalization, reserve
that time and shorten contribution admission accordingly.

## Recommendation

Public-launch requirement confirmed by the owner: contribution must work entirely
in a desktop browser. Mobile support is not required. The CLI can remain available
for testing and specialist use; it does not satisfy public-launch acceptance.

Keep one active contribution against the canonical head. Use a durable public
registration queue, a small ready-to-contribute group, short claim windows, and
bounded execution leases. Publish estimated waiting ranges, not guaranteed
appointment times. Benchmark the full circuit and long contribution histories
before choosing a public window or promising thousands of accepted contributions.

Preserve every accepted zkey and its signed evidence in two independently
controlled archives initially. The storage bill at 1,000–10,000 contributions is
modest compared with the operational complexity of deleting intermediate states.
Choose a long-term hot/cold policy explicitly after the public audit period.

## What Ethereum KZG actually did

For reusable source files, licensing, and adaptation work, see
[PUBLIC_CEREMONY_REUSE.md](PUBLIC_CEREMONY_REUSE.md).

The Ethereum Foundation reports 141,416 contributions over 208 days, with GitHub
or Ethereum authentication. Historical Ethereum transaction counts were used as
an admission hurdle. The team explicitly warned that this was not a reliable
unique-person list. Its final transcript was 242 MB and was published on GitHub
and IPFS. These are useful operational lessons, not throughput promises for MOSS.
[EF retrospective](https://blog.ethereum.org/2024/01/23/kzg-wrap).

I inspected archived sequencer commit
`2538f2f08d4db880d7f4608e964df0b695bc7d2f`. Its lobby defaults were a 180-second
contribution deadline, 30-second check-ins, and 1,000 lobby members. These are
source defaults, not proof of the settings used throughout the deployed ceremony.
The first eligible request to acquire the free active slot won: this source does
not implement a FIFO reservation or a verifiable lottery. A mutex protected the
single active contributor, and expired slots were released.
[Lobby implementation](https://github.com/ethereum/kzg-ceremony-sequencer/blob/2538f2f08d4db880d7f4608e964df0b695bc7d2f/src/lobby.rs),
[claim endpoint](https://github.com/ethereum/kzg-ceremony-sequencer/blob/2538f2f08d4db880d7f4608e964df0b695bc7d2f/src/api/v1/lobby.rs).

KZG's transcript retains the latest powers plus per-participant running products,
public keys, and signatures. It does not need a full historical powers file per
participant in that final transcript. Its compact format cannot simply be
substituted for our Groth16 zkeys and operational evidence.
[KZG transcript specification](https://github.com/ethereum/kzg-ceremony-specs/blob/master/docs/sequencer/sequencer.md).

## Admission and slot reservation for MOSS

Proposed flow:

1. Authenticate, check published eligibility rules, and register one durable
   ticket per account. Display a queue position and a broad waiting estimate.
   Registration does not reserve a particular predecessor artifact.
2. Ask the next small group to confirm readiness. They can load the reviewed
   browser client, check disk space, and test connectivity before occupying the slot.
   Do not make everyone download the changing head while waiting.
3. Offer the oldest ready ticket a short claim window, initially 60–120 seconds
   subject to testing. Missing a notification should release the offer, with
   a documented requeue/cooldown policy rather than a permanent ban.
4. Bind the claimed lease to the current generation, hash, and immutable object
   version. The contributor downloads, computes locally, and uploads within
   an absolute deadline selected from measured slow-but-supported machines.
   Heartbeats show liveness; they cannot extend the slot forever or prove honest
   progress. A timeout discards stale work and returns capacity to the queue.
5. Both production operators verify the same candidate independently, in
   parallel. Accept transactionally, archive and witness the result, then offer
   the next slot. Keep publication acknowledgement on the critical path under
   the existing policy; include its latency in throughput measurements.

Two clients contributing to the same predecessor produce competing successors.
Our current chain cannot accept both or merge them later. Multiple application
servers can serve the lobby; they cannot bypass this dependency. An aggregate
entropy service or parallel ceremony would be a separate cryptographic design.

Use account age/activity and per-account admission limits, bounded retries,
upload/job quotas, and sensible network-level rate limits. GitHub login is an
anti-spam hurdle, not proof of one human. Avoid promising airdrop eligibility or
other incentives based on contribution count. Do not penalize shared-IP users
solely for sharing a network. Publish operator cancellations and admission policy
changes without exposing tokens, IP addresses, or private account identifiers.

## Throughput is the first sizing gate

Slot time includes download, local computation, upload, server hashing, the slower
of the two independent verifier paths, durable publication/mirroring, and handoff.
More verification workers do not parallelize the sequential chain. Two operators
need not double elapsed verification time if they run concurrently.

These are idealized capacity scenarios, NOT measured performance:

| Average complete slot | Accepted/day at 100% utilization | Days for 1,000 | Days for 5,000 | Days for 10,000 |
| --- | ---: | ---: | ---: | ---: |
| 5 minutes | 288 | 3.5 | 17.4 | 34.7 |
| 10 minutes | 144 | 6.9 | 34.7 | 69.4 |
| 20 minutes | 72 | 13.9 | 69.4 | 138.9 |
| 60 minutes | 24 | 41.7 | 208.3 | 416.7 |

At 70% effective utilization, multiply daily capacity by 0.7 and duration by
1/0.7. For example, 5,000 contributions averaging 20 minutes need about 99 days,
which is outside the agreed window. At that speed 1,000 people ahead in the queue
means nearly 14 ideal days of waiting; a permanently open browser tab is not an
adequate UX.

For the agreed two-week limit:

| Average complete slot | Ideal 14-day maximum | At 70% effective utilization |
| --- | ---: | ---: |
| 5 minutes | 4,032 | about 2,822 |
| 10 minutes | 2,016 | about 1,411 |
| 20 minutes | 1,008 | about 706 |
| 60 minutes | 336 | about 235 |

To finish 1,000 in 14 days at 70% utilization, average slot time must be at most
14.1 minutes. For 5,000 it must be at most 2.82 minutes; for 10,000, 1.41 minutes.
These budgets include both internet transfers and independent verification and
publication. Neither 5,000 nor 10,000 is a supported launch promise today.
Ten thousand interested registrants is a different requirement from ten thousand
accepted cryptographic contributions. Publish estimated admission capacity and
stop taking ready-slot reservations that cannot realistically finish before seal.

The pinned snarkjs verifier iterates over every prior contribution. Repeating
full verification at every generation gives a quadratic cumulative history-check
term, in addition to the circuit work. Benchmark generations 1, 100, 1,000,
5,000, and 10,000; a first-contribution timing is insufficient. Incremental
verification would require a separately reviewed design preserving all current
acceptance guarantees, not merely skipping these checks.
[snarkjs verifier](https://github.com/iden3/snarkjs/blob/v0.7.6/src/zkey_verify_frominit.js).

## Storage and download model

Baseline: 567,402,188 bytes per genesis zkey. With the current fixed ASCII
`moss-<UUID>` contribution names, each ordinary record adds 435 bytes in the
pinned format. For N accepted contributions, excluding genesis and fixed inputs:

`archiveBytes = N * 567402188 + 435 * N * (N + 1) / 2`

This is a source-derived sizing model, not a measured 10,000-contribution run.
At 10,000 contributions the final ordinary zkey is about 571.75 MB, not 5.7 TB;
5.7 TB is the sum of all historical snapshots. The approximately 19.3 GB PTAU,
232 MB R1CS, genesis, and finalized output are fixed additional archive inputs.
Participants need the current zkey, not a fresh PTAU download each time.

Rates checked for us-east-1 on 2026-09-23: S3 Standard $0.023/GiB-month,
Deep Archive $0.00099/GiB-month. TB below is decimal; billing calculations use
GiB (2^30 bytes). Estimates exclude requests, retrieval, tax, evidence JSON,
temporary quarantine copies, rejected attempts, and fixed inputs.

| Accepted contributions | Historical zkeys, one copy | Two Standard copies/month | One Standard + one Deep Archive/month | Two Deep Archive copies/month |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 0.568 TB | $24.32 | $12.68 | $1.05 |
| 5,000 | 2.842 TB | $121.77 | $63.51 | $5.24 |
| 10,000 | 5.696 TB | $244.01 | $127.26 | $10.50 |

These are end-of-ceremony monthly holdings, not a one-time purchase or total
ceremony cost. For 10,000 contributions, two hot copies cost about $2,928/year
at these rates; one hot and one cold cost about $1,527/year, before other charges.
An archive that grows steadily has a lower average storage bill during collection.
Separate administrators/accounts are required for independence; different regions
add disaster resilience and transfer charges, but are not priced in this table.

Sources: [S3 pricing](https://aws.amazon.com/s3/pricing/),
[Standard price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json),
[Deep Archive price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3GlacierDeepArchive/current/us-east-1/index.json).

For bandwidth, budget roughly one artifact download per accepted participant
plus retries, auditors, and out-of-region operators. Using the first direct
internet egress tier of $0.09/GiB gives approximately $48 / $238 / $477 for one
complete participant pass at 1,000 / 5,000 / 10,000 contributions, before free
allowances. Downloading every historical artifact once for an external audit
adds roughly another such pass. Each 1,000 downloads of the final ~572 MB zkey
adds about $48 at that tier. Charges depend on aggregate monthly usage.
[Transfer price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/us-east-1/index.json).

S3 ingress and same-region S3-to-AWS-service transfer are free of data-transfer
charges, including across accounts; requests and networking appliances can still
cost money. CloudFront changes the delivery bill; S3-to-CloudFront origin transfer
being free does not mean viewer delivery is unconditionally free. Use appropriate
S3 network endpoints to avoid paying NAT processing for large verifier downloads.
The current coordinator proxies public artifact downloads: moving them to direct
version-bound object/CDN delivery is an engineering task, not already achieved
merely by provisioning CloudFront.

As an illustrative compute baseline, two continuously running Linux/x86 Fargate
verifiers at 4 vCPU/16 GiB each are about $340/month for 730 hours, before scratch,
logs, and networking. This is a price calculation, not a capacity recommendation.
Coordinator, website, database, witness, monitoring, load balancer, and any NAT
are additional. Benchmark before committing a total operating budget.
[Fargate pricing](https://aws.amazon.com/fargate/pricing/).

## Preserving auditability without paying hot-storage prices forever

Keep these easily downloadable: signed manifest/root distribution evidence,
source and release pins, genesis, final zkey and verification artifacts, receipts,
verifier reports, hash-chained events, witness acknowledgements, sealed checkpoint,
beacon evidence, and final artifact hash inventory. Preserve the circuit and PTAU
and document their independent availability. No private entropy or signing keys
belong in the public archive.

Preserve every accepted intermediate zkey in the initial two-copy archive policy.
This lets someone reproduce the actual transitions and investigate a disputed
receipt without trusting the coordinator's attestations. Failed uploads and scratch
files need bounded incident retention, not permanent Object Lock. Clean up
noncurrent quarantine versions and incomplete multipart uploads as well as current
objects. The current seven-day quarantine lifecycle causes temporary duplicate
storage that the table excludes.

The final snarkjs zkey contains a contribution proof history: checking final
cryptographic validity does not inherently require downloading all intermediate
zkeys. However, preserving only that final file sacrifices exact historical-byte
and operational replay. A signed receipt or hash alone cannot reconstruct missing
bytes. Any compact-only policy must state what future auditors can no longer do.

After an explicit public audit window, prefer one hot copy plus an independent
cold copy if instant historical access matters. Two cold copies are much cheaper,
but auditors need a working restore-request process, a retrieval budget, and a
stated availability SLA. Deep Archive standard restores typically take up to
12 hours; bulk up to 48 hours, with retrieval fees and a 180-day minimum storage
charge. It must not hold the active head needed by the next contributor.
[AWS retrieval options](https://docs.aws.amazon.com/AmazonS3/latest/userguide/restoring-objects-retrieval-options.html).

Optionally investigate lossless deduplication later: snarkjs copies sections 3–7
unchanged and transforms L/H plus header/history data. A section archive could
preserve byte-exact reconstruction while avoiding repeated static data. It needs
restore tests and signed reconstruction manifests; ordinary whole-file hashes
do not automatically deduplicate objects. No savings from this are assumed above.
[Contribution implementation](https://github.com/iden3/snarkjs/blob/v0.7.6/src/zkey_contribute.js).

## Concrete changes before opening to the public

| Area | Existing behavior | Needed change |
| --- | --- | --- |
| Counts | Target must equal maximum; finalizer only requires at least one contribution | Separate finalization minimum, aspirational target, and optional operational cap. Change protocol/DB/CLI/UI together. |
| Closing | One signed seal time, no separate admission cutoff | Add an earlier registration/offer cutoff and drain window, with all acceptance finished before immutable sealing and the future beacon. Under-minimum outcome must be declared before opening; never extend after observing beacon randomness. |
| Queue | Transactional FIFO, one live ticket/account, one live lease/ceremony | Persist readiness, cancellation/requeue reasons and fair scheduling; expire absent ready users without forcing everyone to stay online for days. |
| Polling | CLI polls every 3 seconds; `getMyQueue` calls scheduler; scheduler updates/locks shared state | Make queue reads read-only/cached, schedule centrally, add jitter/backoff or push updates. 10,000 waiting clients currently imply ~3,333 polls/second before web traffic. |
| Auth | GitHub identity and fixed token per CLI client instance | Add reviewed eligibility and rate policies, multi-day credential renewal/re-authentication and restart recovery without losing the ticket. |
| Heavy work | Full history verification per contribution, pinned inputs available | Benchmark long histories, keep verified input caches, isolate candidate parsing, measure queue/compute/mirror delays separately. |
| Storage | Full snapshots, AWS adapter, conditional retries, version pins | Real-provider load/recovery tests, direct artifact delivery, publication inventory, archival lifecycle and restore tooling. |
| Audit | Receipt/event signatures, verifier reports, witness gate | Finish independent witness service and sealed/final output publication; add an offline archive checker and paginated public explorer. |
| UX | Target-based progress, CLI flow, development countdown | Show registration vs readiness vs slot, ETA ranges, lease deadline, verification and witness stages, definitive finalization state and downloads. |

A maximum is not a cryptographic necessity. Removing the participant cap does
not remove the need for upload byte limits, timeouts, queue bounds, and spending
controls. No promises of thousands of completed contributions until measurement
supports the signed schedule. Begin with a bounded public pilot before broad
promotion; retain both independent production verifier operators.

## Desktop-browser requirement and Sui precedent

Sui reports 82 browser contributions out of 111 for its zkLogin Phase 2 ceremony,
using snarkjs in the browser and a separate Rust implementation for Docker.
This establishes a relevant Groth16 browser precedent, not a measured performance
result for our circuit or a 5,000-person ceremony.
[Sui retrospective](https://www.sui.io/blog/crs-ceremony-zklogin).

Its published reproduction procedure exports the initial zkey into Bellman-compatible
`.params`, contributes using either implementation, then imports the final parameters
back into the initial zkey. This was documented for interoperability. It is not
evidence that Sui used our exact browser memory strategy or transferred only changed
sections. The current snarkjs Bellman exporter still includes static A/B/IC data.
[Sui Phase 2 recipe](https://github.com/sui-foundation/zklogin-ceremony-contributions/blob/main/phase2/README.md),
[snarkjs Bellman exporter](https://github.com/iden3/snarkjs/blob/v0.7.6/src/zkey_export_bellman.js).

The reviewed Moonsong/ZKsync social-login repository provides circuit/setup tooling;
I did not find a documented public desktop-browser ceremony or performance results
for that circuit. This is a limit of the evidence found, not proof none occurred.
[Moonsong circuit repository](https://github.com/Moonsong-Labs/zksync-social-login-circuit).

Our browser already has a dedicated worker, streamed hash-checked downloads,
OPFS disk-backed input/output, and preflight storage checks. The initial artifact
needs approximately 1.2 GB of origin storage for input, output and headroom; that
is a disk estimate, not a peak-RAM promise. The participant does not download the
19.3 GB PTAU. Full-size browser acceptance is unproven, and browser contribution
is currently disabled in deployment configuration.

The immediate functional blocker is `apps/ceremony/src/lib/api.ts:uploadZkey`:
it supports `local-proxy` uploads but rejects the hosted multipart method. The
existing completed-upload journal does not establish resumable S3 part uploads.

Desktop-browser launch work, in order:

1. Benchmark the real 567 MB artifact in the existing browser worker, including
   late-history files. Propose desktop Chrome/Edge on macOS/Windows initially;
   document exact tested versions and machines before claiming support. Do not
   silently treat Safari/Firefox or low-memory laptops as supported.
2. Implement bounded-memory S3 multipart upload from OPFS-backed files, retries,
   resume and expiry recovery, plus provider CORS and exact-version downloads.
3. Add browser readiness checks before slot claim, tab/sleep handling, honest
   progress, interruption guidance, safe output recovery, and receipt downloads.
   Never promise secure erasure from JavaScript memory or disk-backed browser data.
4. Review the immutable browser release and worker integrity, pinning and network
   policy. Secrets remain local to the contributor; uploading entropy for the
   server to perform the contribution is not the browser contribution design.
5. Run the whole path through both independent verifiers and the witness. Enable
   the public browser route only after it passes; CLI completion is insufficient.

If full-file transfer dominates, evaluate authenticated transfer of only changing
sections and byte-exact server reconstruction separately. That requires a versioned
transport design and unchanged full-candidate validation. It is not achieved by
switching the UI flag or exporting Bellman parameters. No transfer savings or
browser throughput promises are assumed in the current budget.

Validation for this research: reviewed source and primary documentation, checked
current AWS price feeds, and calculated sizing scenarios. No application behavior,
manifest, artifact, or infrastructure was changed. Full-size long-history runs,
load tests, actual provider bills, and browser/hardware acceptance remain untested.
