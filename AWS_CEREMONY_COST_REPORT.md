# AWS budget: 5,000 contributions over one month

Prepared 2026-09-23. Currency: USD. Region: us-east-1. On-demand Linux/x86
pricing, without credits, negotiated discounts, taxes, or engineering labor.
This is a planning model, not a provider quote or measured capacity result.

The requested scenario is 5,000 accepted contributions over 30 days. This extends
the earlier two-week scenario in [PUBLIC_CEREMONY_DESIGN.md](PUBLIC_CEREMONY_DESIGN.md)
for costing only; it does not change a signed ceremony schedule.

## Budget to request

- **Ceremony month: $1,500–$3,000.** Includes two independent verifier services,
  application infrastructure, artifact delivery, two archives, and a testing/
  finalization allowance. This is the first-month operating budget; on-demand
  AWS resources do not require a separate hardware purchase or prepaid contract.
- **Afterward: about $64/month for preservation** with one S3 Standard archive
  and one independently controlled Deep Archive copy. Allow another $5–$25/month
  for a small static public index, DNS, and light monitoring; download traffic is
  additional. This assumes the coordinator, workers, RDS instance, NAT gateways,
  and load balancers are shut down after evidence export and recovery checks.
- **Later verification:** receipt signature checks are effectively negligible;
  a full final-zkey check has a roughly $0.475/hour reference compute rate;
  replaying all historical transitions is substantially more work. See below.

No fixed cloud budget guarantees 5,000 successful participants. The single chain
must average at most 8.64 minutes per slot at 100% utilization, or **6.05 minutes
at 70% effective utilization**. That includes contribution transfer/computation,
verification, and witness publication. Faster machines cannot eliminate client
upload time or the dependency on the previous accepted contribution. We need
full-circuit and long-history benchmarks before approving this capacity target.

## Assumptions

- Production uses two independently administered verifier operators, one fresh
  complete pass per candidate per operator, running concurrently. One verifier
  is only the rehearsal exception.
- Primary and mirror buckets are in separate administration domains/accounts
  within us-east-1 for this estimate. Cross-region/provider mirroring costs extra.
- Verifiers keep validated genesis/PTAU inputs on scratch between jobs. Uploads
  go directly to S3; heavy S3 traffic uses free gateway endpoints rather than NAT.
- Queue polling is made scalable before launch. The unmodified three-second
  polling/scheduling path is not assumed to support thousands of waiting clients.
- Application, database, and witness sizing below is provisional. User computers
  perform contribution computation; AWS pays for validation and coordination.
- No unbounded public bandwidth, attack traffic, or large verification-as-a-service
  workload is included. Ordinary retries have an allowance, not an unlimited cap.
- The all-AWS website/session deployment and independent witness are still
  engineering work. The current template is not already this production topology.

## First-month operating breakdown

| Item | Model | Estimated 30-day cost |
| --- | --- | ---: |
| Two verifier services | 8 vCPU/32 GiB each at the low end; 16 vCPU/64 GiB each at the high end; 100 GiB scratch each; 720 hours | $684–$1,355 |
| Coordinator, website/token issuer, and witness compute | Baseline three 1 vCPU/2 GiB tasks; allowance for modest additional capacity | $107–$160 |
| Managed PostgreSQL, storage, backups | Planning allowance; final instance/availability topology must be selected | $75–$150 |
| Networking and HTTPS | Load balancers, limited NAT use, IPv4, DNS; allowance depends on isolated deployment topology | $100–$200 |
| Two hot archives during the month | Approximately $62 with even growth; approximately $123 if nearly all bytes are retained for the whole month | $62–$123 |
| Temporary quarantine copies | Seven-day cleanup, ordinary upload rates; failures/abuse can add more | $10–$20 |
| Participant artifact delivery | About $238 before allowances for one download per accepted participant; rounded up for inputs, retries and incidental downloads | $240–$360 |
| Logs, secrets, images, monitoring, basic edge controls | Explicit planning allowance, not a measured traffic bill | $40–$100 |
| Object requests | Multipart uploads, reads, archive/evidence writes and mirror requests | $5–$15 |
| Benchmarking, finalization and restore drill | Additional short-lived jobs and limited testing allowance | $100–$250 |
| **Calculated subtotal** | | **$1,423–$2,733** |
| **Rounded budget request** | Modest contingency | **$1,500–$3,000** |

Verifier compute is charged for provisioned task runtime, including waiting time.
Do not add another per-contribution verification charge on top of that row.
Independent operators may bill through different accounts; these totals include
both modeled worker services, but no operator labor or commercial service fee.
The allowance for RDS does not promise Multi-AZ failover, and the service count
does not imply a fully redundant application deployment.

Fargate rate calculation from [AWS's us-east-1 pricing example](https://aws.amazon.com/fargate/pricing/):

- CPU: $0.000011244 per vCPU-second = $0.0404784/vCPU-hour.
- Memory: $0.000001235 per GiB-second = $0.004446/GiB-hour.
- Scratch beyond the included 20 GiB: $0.0000000308/GiB-second.
- One 8 vCPU/32 GiB worker with 100 GiB scratch: **$0.4749696/hour**.
- Two such workers for 720 hours: **$683.96**.
- Two 16 vCPU/64 GiB workers with the same scratch: **$1,355.14**.

The remaining rows are allowances, not fabricated exact AWS quotes. Validate
them against the deployed topology using [RDS PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/),
[load-balancer pricing](https://aws.amazon.com/elasticloadbalancing/pricing/), and
[VPC pricing](https://aws.amazon.com/vpc/pricing/). In particular, routing large
artifact reads through NAT adds per-GB processing charges; AWS documents free
gateway endpoints for avoiding that S3 data path cost.

## Archive volume and recurring storage

The frozen genesis is 567,402,188 bytes. The current snarkjs format and fixed
ASCII `moss-<UUID>` names add 435 bytes per ordinary contribution. Model:

```text
N = 5000
acceptedSnapshots = N * 567402188 + 435 * N * (N + 1) / 2
                  = 2,842,449,527,500 bytes
fixedInputs       ≈ 20,696,514,564 bytes
oneArchive        ≈ 2,863,146,042,064 bytes
                  ≈ 2.863 decimal TB = 2,666.513 GiB
```

Fixed inputs include the PTAU, R1CS, genesis and an approximately final-sized
zkey; the beacon record and small public evidence add a little overhead. Build
images, source snapshots and future audit outputs are not included in this byte
total. The model assumes full snapshots, no compression or deduplication.

AWS bills storage in binary GB (GiB). Current us-east-1 Standard is
$0.023/GiB-month; Deep Archive is $0.00099/GiB-month. Rates were checked against
the official public price feeds on the report date.

| Long-term policy | Storage/month | Storage/year | Historical artifact availability |
| --- | ---: | ---: | --- |
| Two independently controlled Standard copies | $122.66 | $1,471.91 | Immediate from either archive |
| One Standard + one independent Deep Archive copy | **$63.97** | **$767.64** | Immediate primary; restore required for backup |
| Two independent Deep Archive copies | $5.28 | $63.36 | Restore required for historical artifacts |

Recommendation: keep both copies hot during the ceremony and initial audit period,
then consider one hot plus one cold. The two-cold option needs an additional small
hot public set for the final zkey, metadata, keys, and instructions. These figures
are preservation costs, not a guarantee of an indefinitely maintained website.

Object Lock retention is separate from storage class. Preserve exact versions and
their hashes, and retain the independent signed evidence when transitioning them.
There is no one-time fee that pays for storage forever. At unchanged rates, ten
years of one-hot/one-cold preservation alone is approximately **$7,676**.
Keep the running services only as long as necessary; leaving the entire deployment
up would continue to incur compute/database/network costs in addition to storage.

Sources: [S3 pricing and billing units](https://aws.amazon.com/s3/pricing/),
[Standard regional feed](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json),
[Deep Archive regional feed](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3GlacierDeepArchive/current/us-east-1/index.json).

## What a later verification costs

There are three different operations. A coordinator signature check is not a
cryptographic check of the zkey, and checking the final zkey is not replaying all
historical artifact transitions.

### 1. Verify a receipt or evidence signatures

Download small JSON/public-key files and verify locally. There is no AWS compute
charge for the user's local work. GET and bandwidth costs are tiny per check.
For reference, Standard GET requests cost $0.0004 per 1,000. An offline check of
already downloaded evidence creates no AWS charge at all.

### 2. Verify the final zkey, including its embedded contribution history

The final ordinary artifact at generation 5,000 is about 569.58 MB, plus a small
beacon record. This check does not require fetching the entire 2.84 TB history.

- If the verifier already has the circuit/PTAU/genesis, downloading the final
  zkey costs its serving account approximately **$0.05** in direct internet
  egress before free allowances.
- If an external verifier needs the whole approximately 20.7 GB verification
  input set, delivery costs roughly **$1.74** before allowances.
- If verification runs on the user's own machine, their computation creates no
  AWS charge for us. If we run it on demand in AWS, use the compute table below.
- Same-region AWS verification avoids S3 data-transfer charges, but still incurs
  compute and requests. A cold object must first be restored.

Reference compute: 8 vCPU/32 GiB, 100 GiB scratch, $0.4749696/hour. Durations
include input setup and computation, and are **scenarios rather than benchmarks**:

| Runtime for one verifier job | One verifier | Two independent verifier jobs |
| --- | ---: | ---: |
| 10 minutes | $0.08 | $0.16 |
| 30 minutes | $0.24 | $0.47 |
| 60 minutes | $0.47 | $0.95 |

The same rate model applies to verifying one historical transition after obtaining
its predecessor and successor, but that is a different job from checking only
the final zkey. Long embedded histories may increase either job's runtime.
Starting a dedicated service also introduces its provisioning/setup overhead.
If an already-paid worker is idle, these are allocated compute costs rather than
an extra per-verification AWS fee.

### 3. Replay all 5,000 historical transitions

This reproduces historical acceptance checks, with evidence/signature validation,
rather than just checking the final output. Download each snapshot once and reuse
it as the next transition's predecessor.

- External download of one complete archive: approximately **$240** in direct
  internet egress before allowances, plus the auditor's own compute.
- Same-region AWS replay: no S3 data-transfer fee; compute remains payable.
- At a hypothetical average of 10 minutes per transition on the reference worker,
  5,000 checks use 833.3 worker-hours and cost approximately **$396** for one full
  replay, or **$792** for two independent replays, excluding retrieval/networking.
- At 30 minutes per transition those compute totals become approximately
  **$1,187 / $2,375**. These are sensitivity calculations, not observed timings.
- Later audit jobs may run in parallel because all historical bytes already exist.
  That reduces elapsed audit time, not total worker-hours, and does not make the
  live contribution chain parallel.

Stock verification processes the accumulated history each time. We therefore
cannot infer total replay cost by multiplying a generation-one benchmark by
5,000; measure the distribution of verification times across the archive.

## Cold restore charges and delivery

Deep Archive cannot serve ordinary GETs until restored. Its documented standard
restore is typically within 12 hours; bulk within 48 hours. Minimum billable
storage duration is 180 days. These are separate from Object Lock retention.
[AWS restore documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/restoring-objects-retrieval-options.html).

For one approximately 2,666.5 GiB archive:

| Restore tier | Data retrieval fee | Approximate restore request fees for ~5,004 objects |
| --- | ---: | ---: |
| Bulk, $0.0025/GiB | $6.67 | $0.13 |
| Standard, $0.02/GiB | $53.33 | $0.50 |

Temporary restored copies also incur Standard storage: roughly $2.04 per day for
the complete archive at a 30-day monthly proration. For example, a two-day bulk
restore holding window adds about $4.09. Downloading the restored bytes externally
then adds approximately $240; running verification inside the same AWS region
avoids that egress. Restoration is charged for the selected archive, not both
copies unless both are restored.

Direct internet delivery uses $0.09/GiB in the first paid tier, before the shared
100 GB/month allowance and any other discounts. S3 uploads and same-region
S3-to-AWS-service transfers do not incur data-transfer fees. CloudFront has its
own delivery pricing; this model does not assume free CDN egress. Public audit
downloads are additional to the monthly ceremony participant-download allowance.
[AWS transfer regional feed](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/us-east-1/index.json).

## Decision and validation

Approve **$3,000 as an initial operating budget**, subject to full-size benchmarks,
and provision an ongoing **$100/month archive-and-light-publication allowance**
if selecting one hot copy plus one cold copy. Additional audit downloads and
hosted verification should have their own budget. These are spending plans, not
automatic hard spending limits; AWS alerts alone do not cap charges.

Before promising 5,000 completions in a month, measure generation 1/100/1,000/
5,000 end-to-end durations and peak memory, including upload and witness time.
If the measured average exceeds six minutes with the chosen reliability margin,
revise participation expectations, duration, or implementation. A larger budget
alone does not prove that the deadline is achievable.

Validation performed: checked official AWS pricing pages and regional price feeds;
recalculated byte counts, worker rates, storage, transfer, restore and runtime
scenarios; checked the document diff. No deployment or application changes were
made. Application tests were skipped for this documentation-only change. No
5,000-contribution benchmark, real-provider load test, or actual billing trial
has been performed. Engineering, security review, operator labor, taxes, domain
purchase, paid support, and cross-region replication are outside this budget.
