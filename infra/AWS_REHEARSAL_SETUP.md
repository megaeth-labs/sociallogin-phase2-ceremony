# AWS rehearsal setup

Status: implementation prepared locally; not deployed. The AWS adapter,
coordinator publication gate, Ethereum finalizer authority and deployment
template are implemented. Live integration and an independently operated
witness/mirror service remain required. Use the [provisioning request](REHEARSAL_PROVISIONING.md)
and [deployment instructions](aws/README.md).

Owner decision (2026-09-22): workload region `us-east-1`. AWS account ID,
provisioning role/profile, domains and independent mirror operator are pending.
The account ID is the 12-digit identifier for the AWS account owning the
resources, visible in the console account menu. It is not an access credential.

Owner decision (2026-09-23): one verifier operator is sufficient for this
rehearsal, with one complete fresh pass per candidate. Owner decision
(2026-10-22): mainnet also runs one internal verifier operator. Hosted rehearsal support requires a signed rehearsal purpose and explicit
client/server opt-in.

Vercel will host the website and OAuth issuer. The current coordinator and
verifier need persistent backend compute, with PostgreSQL for ceremony state.
S3 alone does not supply these services. Vercel monorepo build configuration and secret loading are implemented; public
coordinator/trust settings and private deployment configuration still need provisioning.

## Access to provide

Use a dedicated rehearsal account or an approved role scoped to rehearsal
resources. For human provisioning, prefer IAM Identity Center (SSO). There is
no separate "S3 account", and contributors do not need AWS accounts or keys.
Runtime services use their own scoped IAM roles, not the human provisioning
identity.

Ask your AWS administrator for:

- The account ID, SSO start URL, SSO region, and assigned provisioning role.
- Permission to create/configure the rehearsal S3 buckets and their policies,
  versioning, Object Lock, encryption, CORS, logging and lifecycle settings.
- Permission to create scoped runtime roles, or an administrator who will
  create them from the reviewed deployment policies.
- A hosting owner for HTTPS web/coordinator services, PostgreSQL and verifier
  compute. Storage permissions alone do not provide that infrastructure.

Configure the local AWS CLI in your own terminal:

```sh
aws configure sso --profile moss-rehearsal
aws sso login --profile moss-rehearsal
```

Share the profile name, account ID, chosen workload region and role ARN. Do not
paste access keys, session credentials, or secrets into chat or tracked files.
AWS documents the [SSO setup flow](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html).

## Buckets and roles

Choose globally unique bucket names after the account and region are known:

| Bucket | Purpose | Configuration |
| --- | --- | --- |
| `moss-rehearsal-<account>-<region>-quarantine` | Pending contribution uploads | Versioning; private; encryption; incomplete-upload cleanup; temporary-object lifecycle |
| `moss-rehearsal-<account>-<region>-archive` | Pinned inputs, accepted contributions, transcript and final outputs | Versioning; Object Lock; private; encryption; immutable version-specific references |
| Separate operator's mirror bucket | Independently retained public ceremony evidence | Separate account/admin; versioning; Object Lock; verified copies |

Use Bucket owner enforced ownership (ACLs disabled), Block Public Access, and
TLS-only bucket policies. Public artifact delivery will be configured through
the approved delivery path; do not make quarantine public to simplify downloads.

Object Lock is permanent at the bucket level. The default retention must be
agreed before uploading ceremony material; use compliance mode for the hosted
rehearsal, covering its review and recovery window. Do not assume the proposed
production retention duration is also appropriate for test material. Enabling
Object Lock alone does not establish a retention period.
See [AWS Object Lock configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-configure.html).

Keep provisioning privileges separate from runtime permissions:

- Coordinator: scoped multipart uploads, exact-version reads and immutable
  archive promotion. No bucket-policy administration or retention bypass.
- Verifiers: exact-version reads of required artifacts; no artifact writes.
- Mirror operator: source reads and writes to its independently controlled
  destination; the coordinator has no authority to delete mirror copies.
- Contributors: short-lived, lease-bound upload authorization from the
  coordinator; no IAM users or permanent AWS credentials.

The precise runtime IAM policies will accompany the concrete AWS adapter and
its provider tests. Do not attach S3FullAccess to runtime services as a substitute.

## Other inputs before hosting

- Public HTTPS web and coordinator domains and DNS/hosting ownership.
- Rehearsal GitHub OAuth App: homepage is the web origin; callback is
  `https://<web-domain>/api/auth/callback/github`; enable Device Flow for CLI.
- The current CLI login implementation also needs Upstash REST Redis
  (`KV_REST_API_URL`, `KV_REST_API_TOKEN`) configured privately on the web issuer.
- Artifact custodian/location for the pinned genesis, R1CS and PTAU.
- One rehearsal verifier operator and an independent witness/mirror owner.
- A three-contributor schedule and future Ethereum block commitment, frozen
  only once deployment and verification are ready.

OAuth secrets, issuer/signing keys and runtime credentials belong in private
configuration or the deployment secret manager. The final public manifest
contains public keys, hashes, lengths, immutable references and policy only.

## End-to-end sequence

1. Publish the signed manifest and immutable genesis/input references.
2. Adeva authenticates with GitHub, joins the queue, downloads the pinned
   predecessor and computes one contribution locally with fresh secret entropy.
3. Upload to quarantine; the rehearsal verifier validates the immutable
   candidate, including its exact predecessor-plus-one relationship.
4. Accept transactionally, archive, publish/witness the new head and issue a
   signed receipt. An upload completing is not acceptance.
5. Collaborators repeat sequentially for contributions 2 and 3.
6. Seal at the published time, wait for the committed Ethereum block/finality,
   then apply the terminal public beacon and independently verify the result.
7. Archive the final key/verifier and evidence, exercise recovery, record the
   rehearsal findings, then stop compute after the review window. Keep the
   archives according to the agreed policy. Never deploy this rehearsal key
   as the production verifier.
