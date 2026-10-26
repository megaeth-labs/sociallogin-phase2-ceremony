# Mainnet stack

The mainnet ceremony runs on its own stack from the same template as the
rehearsal (`rehearsal.cloudformation.json`). Nothing is shared with the
rehearsal stack: new VPC, database, buckets, CloudFront distribution, roles,
secrets and keys. Follow [README.md](README.md) for every step not covered
here; this file lists only what differs for mainnet.

## Status

Foundation created 2026-10-25 (`CREATE_COMPLETE`, change set
`mainnet-foundation-20261025`, template at 18aec8d) in account `635288116361`.
Services off, review mode on; no images, configuration or database
migrations yet. Circuit inputs copied and verified (below).

| Output | Value |
| --- | --- |
| Coordinator URL | `https://dy87eh5gw5.execute-api.us-east-2.amazonaws.com` |
| Archive domain | `https://d1xydbco3b83a0.cloudfront.net` |
| Archive bucket | `moss-phase2-mainnet-archive-xjdgubapb7up` |
| Quarantine bucket | `moss-phase2-mainnet-quarantine-xfingj1ka9ez` |
| Cluster | `moss-phase2-mainnet-Cluster-N7ZUavUFzBxk` |

The same day the rehearsal backend (stack `moss-rehearsal`) was removed: its
database was deleted after the final snapshot
`moss-rehearsal-snapshot-database-fcznxntrzafc`; its archive, CloudFront
distribution, buckets, images, secrets and logs remain.

## Stack

| Setting | Value |
| --- | --- |
| Stack name | `moss-phase2-mainnet` |
| Region | `us-east-2` |
| Stack tag | `Project=moss-phase2-mainnet` (activate it as a cost-allocation tag) |

| Parameter | Mainnet | Rehearsal default | Why |
| --- | --- | --- | --- |
| `WebOrigin` | `https://ceremony.megaeth.com` | — | Bucket and CloudFront CORS |
| `ProjectName` | `moss-phase2-mainnet` | `moss-phase2-rehearsal` | Budget name and cost filter; budget names are unique per account |
| `MonthlyBudgetUsd` | `750` | `200` | See the estimate below; alerts at 50/75/100% |
| `ApiRateLimit` / `ApiBurstLimit` | `500` / `1000` | `50` / `100` | An open page polls status, history and activity at roughly 0.4 requests per second, so the rehearsal limit throttles at about 125 visitors |
| `DatabaseInstanceClass` | `db.t4g.medium` | `db.t4g.small` | Headroom for public polling |
| `DatabaseMultiAZ` | `false` | `false` | Owner decision (2026-10-25): no standby. A zone outage means restoring from the 7-day backups |
| `VerifierCpu` / `VerifierMemory` | `8192` / `16384` | `4096` / `16384` | The rehearsal verifier needed 8 vCPU for cold-start preparation |
| `EnableServices`, `ReviewMode`, `InitializeCeremony` | `false`, `true`, `false` | same | Change only as in README.md |

## Website

Vercel project `megaeth-ceremony` (team `mega-eth`, created 2026-10-26),
separate from the rehearsal's `zklogin-phase2-ceremony`. Settings copied from
the rehearsal project: root `apps/ceremony`, Node 24, toolbar off, skew
protection 12 hours, Vercel Authentication on everything except custom
domains. No Git connection; releases deploy from the CLI. Its own Upstash
Redis store, `megaeth-ceremony-kv` (free plan, `iad1`), holds CLI sign-in
device codes.

`ceremony.megaeth.com` is attached and verified; Cloudflare needs
`CNAME ceremony → 1313c90e100d136d.vercel-dns-016.com`, DNS only.

Production variables are set for the production-flow test (slug
`moss-phase2-prodflow-test-2026-10`, test root `prodflow-test-root-2026-10`).
`ARTIFACT_ORIGINS` names the CloudFront archive and the quarantine bucket's
own S3 origin, which browsers upload to with presigned URLs. Still to set:
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and, per deployment,
`MOSS_WEB_BUILD_ID`.

## API throttling

Public polling (status, checkpoint, history) shares the stage's default route
budget (`ApiRateLimit`/`ApiBurstLimit`). The contributor and verifier paths have
their own routes with separate budgets, so a crowd of spectators can't throttle
someone mid-contribution: queue join 200/400, queue position 500/1000, offers
100/200, leases, uploads and submissions 200/400 each, and the verifier's
internal API 50/100 (requests per second / burst). Added 2026-10-26, change set
`contributor-routes-20261026`.

## Circuit inputs

The R1CS, PTAU, genesis zkey and Bellman genesis are already in the rehearsal
archive (`moss-rehearsal-archive-qrgf2jkdbkhs`), at the versions the r2
manifest pins. Copy those exact versions server side into the mainnet archive;
nothing is re-uploaded from a laptop and same-region copies have no transfer
charge. Mainnet then depends on its own archive only, not on the rehearsal
distribution staying up.

| Input | SHA-256 | Bytes | Source version |
| --- | --- | --- | --- |
| `circuit.r1cs` | `173eba6b9b7883bb8e761f69f902c334b14cea61a094eba7466f0f548d601692` | 232,099,260 | `_3DnGFLDg2hJY5JjDHP8t7YvfdXMia01` |
| `powersoftau.ptau` | `032647abe127f4562f8118dd5f866ab595c1f2bbd03d0a85ff3739a4a967d9be` | 19,327,435,928 | `wkdMa2unhWGOv6pUDzS9mPWbuLG5aEBe` |
| `genesis.zkey` | `f23c5dadb27613ec3d819c3cb59060804a0dc506fb6d873ab6d3ca5f8357090d` | 567,402,188 | `7ocYg73Rx5b6AMyyNMAvR94.seLqQJc2` |
| `genesis.params` | `600950f4831a93c7907cca96c8e722c4d319401925c353f4ad2ed6aae82d173e` | 368,440,348 | `u7H4QXGeX2s3RFU0P9FpUvAP4no1cQzr` |

Each goes to `inputs/sha256/<sha256>/<file name>` in the mainnet archive:

1. Copy the pinned source version (`--copy-source
   <bucket>/<key>?versionId=<version>`). The PTAU is over 5 GiB, so it needs a
   multipart copy (`aws s3 cp` does this); the others fit one `copy-object`.
2. Put COMPLIANCE retention on the new version, until the same
   `S3_RETENTION_UNTIL` the coordinator uses. Retention can be extended later
   but never shortened.
3. Check the byte length with `head-object`, then hash the bytes through
   CloudFront (`curl … | shasum -a 256`). The PTAU's multipart copy has no
   full-object SHA-256 checksum, so the download hash is the check that
   counts; the verifier repeats it on every start.
4. Record each new version ID. The manifest URLs are
   `https://<ArchiveDomain>/inputs/sha256/<sha256>/<file name>?versionId=<new version>`.

Done 2026-10-25, entirely inside S3. The three inputs under 5 GiB were
single copies whose full-object SHA-256 S3 computed equals the pinned hash.
The PTAU was copied on the source's 16 MiB part boundaries, so its composite
SHA-256 (`2ff5cftCNbZyTpUGiMYVJjNAMoryaCVdw9lT6F0EBGk=-1153`) equals the
source's. All four are served through CloudFront with CORS for the site
origin. They have no Object Lock retention yet; the bucket policy denies
deletes until it is set.

| Input | Mainnet version |
| --- | --- |
| `circuit.r1cs` | `NSqeKG.vaZcg9QnQSp_OaJEcpcPDPRZw` |
| `powersoftau.ptau` | `7loKBCkcC4D3OWLmrKdWClX1yU4bc8MH` |
| `genesis.zkey` | `n8WbeAChgauldwbbBZ3.C8c3PkpGl5Tm` |
| `genesis.params` | `6XHF2OBn0LXLKfJWQM6A2q3jLbbW1C9I` |

The URLs are in `ceremonies/google-rs256-zksync-v3/inputs.draft.json`.

The canonical genesis is a separate object per ceremony ID
(`canonical/<ceremony-id>/sha256/<genesis sha256>.zkey`), seeded as in
README.md, once for the dress rehearsal and once for mainnet.

`web-release.json`, `web-reproduction.json` and the CLI bundle
(`moss-phase2-cli.js`) go to the same `inputs/sha256/…` layout after the
release build.

## Dress rehearsal on this stack

Run the dress rehearsal on this stack before mainnet, with its own logical
database (`ceremony_dress`), throwaway keys, `CEREMONY_MODE=rehearsal` and a
different slug. Then create the mainnet database (`ceremony`), swap the
coordinator and verifier configuration secrets, and initialize once. See
[PRODUCTION_KEYS.md](../PRODUCTION_KEYS.md).

## Estimated monthly cost while running

| Item | USD / month |
| --- | --- |
| Verifier, 8 vCPU / 16 GiB Fargate, always on | ~290 |
| RDS `db.t4g.medium`, single-AZ, 20 GiB gp3 | ~50 |
| Coordinator, 1 vCPU / 2 GiB Fargate | ~36 |
| NAT gateway, plus data processed | ~35+ |
| Internal load balancer | ~18 |
| CloudFront egress, ~368 MB per contribution download | ~31 per 1,000 contributions |
| S3, ~368 MB per accepted contribution, retention-locked | ~9 per 1,000 contributions |
| API Gateway | ~1 per million requests |

Roughly 450–550 USD a month during the ceremony. Locked archive objects keep
costing storage until their retention ends, even after the services stop.
