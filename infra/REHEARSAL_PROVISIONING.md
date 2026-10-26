# Hosted rehearsal: what to provision or ask for

Owner: Adeva. Region: `us-east-2`. Website: Vercel. Backend: AWS.
This is a 5–10-contribution rehearsal using the pinned Moonsong circuit and one
verifier operator, with one fresh native Bellman transition verification pass per candidate.
Production retains its two-independent-operator requirement.

## Latest agreed scope (2026-09-25)

These decisions supersede the older three-person/full-mirror plan. The closed
review foundation is deployed; see [live deployment status](aws/REHEARSAL_STATUS.md)
for completed checks and remaining contribution-pipeline work.

- Support one contribution implementation: desktop browser snarkjs Bellman with
  OPFS. Do not add a browser engine selector for this rehearsal. The Rust/WASM
  browser experiment remains a prototype; a standalone Rust contribution CLI is
  deferred. The existing zkey CLI cannot contribute to Bellman epochs.
- Retain the native Rust server verifier and snarkjs final verification. This
  provides different contribution/verification implementations, not two supported
  contributor clients. Desktop browser/hardware acceptance remains required.
- Plan for 5–10 rehearsal contributions, using one internal verifier and one
  versioned, locked primary archive with full intermediate artifacts and signed
  audit evidence. The explicit rehearsal-only
  `primaryPublication` policy now replaces the mandatory full-mirror witness gate.
- Publish checkpoints during the ceremony and arrange independent final review.
  A genuinely independent production verifier remains desired; a duplicate
  internal verifier is not the rehearsal target.
- Use the deployed AWS-provided HTTPS backend address. No company DNS dependency is required for rehearsal.
- Retention ends one week after rehearsal launch, not one week after provisioning.
  Fix the absolute date once launch is agreed; plan finalization/review within
  that window. Do not accidentally apply a shorter pre-launch lock period or
  assume locked objects can be deleted early.
- Prepare a closed flow-review setup first. Do not activate contribution offers
  or a timed ceremony opening without the owner's explicit instruction.

## Confirmed access and current plan (2026-09-25)

- Company AWS account: `635288116361`.
- Explicit CLI profile: `moss-company-rehearsal`; deployment region: `us-east-2`.
- STS account checks succeeded. The isolated `moss-rehearsal` stack is deployed.
  The migrated database and closed review backend have passed live health checks.
- Do not use personal profiles or change the default profile/global AWS settings.
  Explicitly select the company profile and region and verify the expected account
  before deployment. Profile names are selectors, not security boundaries.
- Isolate rehearsal resources, roles and secrets under a dedicated rehearsal
  stack. Do not reuse production resources or signing keys.
- Use desktop browser contributions with the production Moonsong circuit and
  the signed Bellman policy. The contribution CLI does not support Bellman epochs.
  Import the sealed chain into the original genesis zkey once, at finalization.

### Work sequence

1. Completed: company/Vercel access, OAuth settings, AWS HTTPS address,
   one-week post-launch retention choice and $200 budget with `arun@megaeth.com`
   alerts. Activate the new billing allocation tag when AWS exposes it.
2. Completed: isolated networking, RDS, ECR, S3, delivery, scoped roles and
   secrets. Only the closed review coordinator is enabled; verifier stays off.
3. Build and publish pinned images; publish the existing R1CS/PTAU/original zkey
   and exact Bellman genesis to immutable storage. Create fresh rehearsal keys,
   configure web authentication privately, and migrate PostgreSQL.
4. Test real S3 multipart/CORS, immutable reads/retention, worker capacity,
   signed primary publication, simultaneous slot claims, interrupted uploads,
   service restart/recovery and database restore. Use disposable test epochs;
   keep the participant rehearsal closed until these checks pass.
5. Freeze the reviewed rehearsal epoch, release digests, schedule, root key and
   future Ethereum beacon commitment. Publish authenticated materials and enable
   browser participation for the reviewed release.
6. Adeva contributes first through GitHub login and the browser; collaborators
   contribute second and third. Each keeps their signed receipt. Verify that
   the next participant receives the accepted predecessor only after the
   signed publication gate completes.
7. At the signed deadline, seal; wait for the committed post-deadline block and
   required finality. Run the offline finalizer: one Bellman import, R1CS/PTAU
   verification, beacon application, then verification and output publication.
   Closing is automatic; running the finalizer is an operator action.
8. Audit receipts/transcript/final outputs and record failures and recovery
   results. Stop compute after review. Teardown must explicitly handle RDS
   deletion protection/final snapshots and retained buckets/ECR; stack deletion
   alone does not remove everything. Locked objects remain until retention ends.

### What Adeva needs to do next

- Review the [closed site](https://zklogin-phase2-ceremony-mega-eth.vercel.app),
  use its real GitHub sign-in test and give feedback on the simulated flow.
- Confirm the launch window after hosted contribution checks pass; no schedule
  or future beacon block is pinned yet.
- Arrange desktop availability and Vercel access for collaborators. Exact
  contribution times can wait until the hosted smoke tests pass.

Company AWS access, Vercel access, OAuth credentials, backend hostname choice,
retention preference, budget and alert recipient are supplied. No independent
mirror operator or Upstash service is required for this browser rehearsal.

Engineering owns resource provisioning, service keys, artifact uploads, manifest
assembly, tests, deployment and the step-by-step contribution walkthrough. No
circuit rebuild or new compiler provenance work is requested from Adeva.

## Original resource request (access now granted)

> Please provide an IAM Identity Center / SSO role for deploying the MOSS Phase 2
> rehearsal in us-east-2, preferably in a dedicated rehearsal account. We need
> to deploy S3 buckets, RDS PostgreSQL, ECS Fargate services, ECR images, an HTTPS
> application load balancer, Secrets Manager secrets, and CloudWatch logs, plus
> their VPC, security groups, IAM service roles and certificate/DNS configuration.
> Please scope iam:PassRole to the ceremony runtime roles. We need either scoped
> provisioning permission for these resources or an administrator who can apply
> the reviewed infrastructure configuration. Runtime roles must not have account
> administration permissions.
>
> Business justification: host and test the three-contributor cryptographic
> ceremony, including large artifact uploads, independent verification, signed
> receipts, recovery, and finalization before the production ceremony.
>
> Please send the account ID, SSO start URL and region, role name/ARN, approved
> VPC/subnets (if existing), domain/DNS owner, and any budget or deployment-policy
> constraints. Credentials should be supplied through SSO, not chat or Git.

## Resources

| Resource | Rehearsal configuration / purpose |
| --- | --- |
| RDS PostgreSQL | Private Single-AZ instance; encrypted storage; automated backups (suggest 7 days for rehearsal); TLS with server certificate validation; application credentials in Secrets Manager. Only the coordinator/migration task can connect. |
| ECS coordinator | One long-running Fargate service behind an HTTPS load balancer. Separate task role, log group and health check. |
| ECS verifier | One long-running Fargate worker, no public inbound listener; separate task role and signing identity. Start with 100 GiB ephemeral scratch. CPU/RAM remain subject to full-size measurement, not a verified capacity promise. |
| ECR | Private repositories for coordinator and verifier images; deploy reviewed image digests. |
| S3 quarantine | Private, encrypted, versioned upload bucket; abort incomplete multipart uploads and clean up expired candidates. |
| S3 archive | Private, encrypted, versioned bucket with Object Lock; accepted artifacts and ceremony evidence. Agree the rehearsal retention end date before uploading: compliance retention cannot be shortened. |
| Independent mirror | A separately administered account/operator retains and checks ceremony evidence. One verifier does not remove this publication/recovery requirement. |
| Networking | Private DB, scoped security groups, HTTPS certificate and coordinator DNS; outbound access for AWS services and required public endpoints. Account for load-balancer/NAT costs as well as worker compute. |
| Secrets / logs | Separate coordinator, participant-issuer and verifier secrets; least-privilege secret access. Logs must exclude keys, tokens, upload URLs and contribution bytes. |

S3 contains the large artifacts; PostgreSQL contains metadata and state.
Worker scratch is disposable and must be reconstructed from pinned S3 objects
on restart. The PTAU is approximately 19 GB; it must not be bundled into images.
No contributor needs an AWS account or IAM key.

## Vercel and GitHub

- Provide the Vercel team/project and stable rehearsal web domain. Use a fixed
  origin for login and the signed release; arbitrary preview origins are not
  ceremony endpoints.
- Create a rehearsal GitHub OAuth App: homepage `https://<web-domain>`; callback
  `https://<web-domain>/api/auth/callback/github`. Device Flow is only needed if separately testing legacy CLI login.
- Configure its client ID/secret privately in Vercel. Do not paste the secret
  into chat or commit it.
- Browser OAuth does not require Upstash. Redis settings only apply if separately
  enabling the legacy CLI device-auth flow, which is outside this rehearsal.
- Engineering supplies the remaining trust, issuer, coordinator and release
  settings. Enable browser contributions only after hosted Bellman acceptance checks.

## Decisions still needed from Adeva

Review the flow and agree a launch window after the remaining hosted checks.
Freeze the schedule, absolute retention deadline and future Ethereum block then.
No additional AWS account, domain, mirror or compiler setup is requested.

The pinned genesis, R1CS and PTAU already exist locally. No new compiler
provenance exercise or circuit rebuild is needed.

## Engineering owns

- AWS storage adapter and integration tests, version-pinned reads, multipart
  uploads and crash-safe immutable promotion.
- Explicit hosted rehearsal policy; retain production validation and HTTPS.
- Infrastructure configuration, deployment images, secret loading, DB migrations
  and Vercel monorepo configuration.
- Initial artifact publication/hash checks, fresh rehearsal keys and signed
  manifest preparation, reviewed CLI/web releases and root-key distribution.
- Transcript publication/witness acknowledgement, automatic sealing, Ethereum
  finalization, restore testing and the contribution walkthrough.

Local unit/integration tests do not certify AWS permissions, Object Lock, RDS
restore, Vercel OAuth or the full-size worker. Those require the provisioned
services and a hosted smoke test before inviting collaborators.

## Provisioning order

1. Grant SSO and project access; confirm domains and retention.
2. Apply reviewed infrastructure; publish pinned images and input artifacts.
3. Configure private secrets, migrate the DB and run hosted storage/worker tests.
4. Prepare and independently check the public manifest/root fingerprint.
5. Open the rehearsal; Adeva contributes first, then collaborators A and B.
6. Seal/finalize, verify and archive evidence, exercise restore, then stop compute
   after review. Preserve archives for the agreed retention period.

Do not create a production epoch or deploy the rehearsal output onchain.

## Vercel project settings

Set Root Directory to `apps/ceremony` and include files outside that directory
in the build. Its `vercel.json` builds the workspace dependency closure.
Keep Vercel’s automatic system environment variables enabled: the reproducible
web build ID uses `VERCEL_GIT_COMMIT_SHA` when the build has no `.git` directory.
An explicit `MOSS_WEB_BUILD_ID` takes precedence for reviewed external builds.
Use the pinned pnpm version and Node.js 24. Restrict secrets to the rehearsal
project/environment; do not share them with untrusted preview deployments.

Set these server-only variables through Vercel's private configuration:

- `CEREMONY_MODE=rehearsal`, `CEREMONY_SLUG`, `COORDINATOR_BASE_URL` (HTTPS).
- `MANIFEST_ROOT_KEY_ID`, `MANIFEST_ROOT_PUBLIC_KEY` (public PEM), and
  `MANIFEST_ROOT_PUBLIC_KEY_SPKI_SHA256` (independently checked fingerprint).
- `PARTICIPANT_JWT_PRIVATE_KEY` (PEM), `PARTICIPANT_ID_DERIVATION_KEY` (32-byte
  canonical base64url), `PARTICIPANT_JWT_ISSUER`, `PARTICIPANT_JWT_AUDIENCE`.
- `NEXTAUTH_URL` (web origin), `NEXTAUTH_SECRET`, `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.
- `ARTIFACT_ORIGINS` (dedicated HTTPS artifact origins used by CSP), and
  `NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED=false`.

Inline material and its corresponding `_FILE` setting are mutually exclusive.
Only public settings may use `NEXT_PUBLIC_` prefixes. Coordinator origin and
artifact origins must be configured at build time for the CSP. Engineering
will supply reviewed values/keys privately and test the deployed login flow.
Rehearsal CLI commands require `--allow-rehearsal`; this is separate from the
loopback-only `--allow-development-manifest` option.

## Implementation handoff (2026-09-23)

Implemented locally: AWS SDK storage adapter and coordinator integration;
explicit signed one-verifier rehearsal mode; Vercel secret loading/build
configuration; RDS/ECS/S3/CloudFront CloudFormation template; worker pinned-input
downloads; coordinator evidence publication, signed acknowledgement storage and
lease gating; periodic sealing/recovery; Ethereum finalization authority.

The optional witness service is implemented in `apps/witness`; the chosen
rehearsal uses a single primary archive with coordinator-signed checkpoints.
The AWS foundation and closed review backend are deployed. Outstanding work is
full-size capacity/failure/restore testing, publication of reviewed inputs and
releases, and the final signed rehearsal schedule.
See [deployment status](aws/REHEARSAL_STATUS.md) and [deployment guide](aws/README.md).

Manifest tooling accepts `--allow-rehearsal` for both `build:manifest` and
`sign:manifest`; the generated template still contains placeholder policy and
three contributors. Override it with the reviewed participation policy and
`primaryPublication` archive origin before signing. Never sign the placeholder
template or reuse the loopback development epoch.

GitHub credentials may instead use `GITHUB_OAUTH_CLIENT_ID` and
`GITHUB_OAUTH_CLIENT_SECRET` (the current Vercel rehearsal configuration). If
either new name is present, both credentials come from that naming family;
legacy `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` entries are ignored.
