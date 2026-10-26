# Hosted rehearsal infrastructure

Start with [the owner provisioning request](../REHEARSAL_PROVISIONING.md).
`rehearsal.cloudformation.json` provisions an isolated rehearsal VPC and
AWS-provided HTTPS coordinator address. The company foundation is deployed;
see [deployment status](REHEARSAL_STATUS.md) for what has actually been exercised.
The mainnet stack uses the same template with different parameters; see
[PRODUCTION.md](PRODUCTION.md).

## Foundation

Apply in `us-east-2`, explicitly using company profile
`moss-company-rehearsal` and verifying account `635288116361`. Do not use ambient
credentials or change the default profile. Set `WebOrigin` to the stable Vercel
HTTPS origin. Leave `EnableServices=false`, `ReviewMode=true`, and
`InitializeCeremony=false` initially. The template creates its own subnets,
NAT gateway, security groups and VPC link; no certificate or custom DNS is needed.

The formatted template exceeds CloudFormation's inline size limit. Serialize
it as compact JSON to a temporary file before passing `--template-body`, and
review the change set before execution. Never put secrets in stack parameters.

The template creates private PostgreSQL 17 on RDS, separate ECS roles, ECR
repositories, log groups, API Gateway HTTPS with a private ALB, quarantine/archive buckets and a CloudFront
archive origin. The archive cache forwards and keys on `versionId`; pinned
public artifact URLs must include that exact query parameter. Buckets remain
private. Quarantine is never publicly delivered. Canonical/evidence writes must
use `If-None-Match: *`; archive deletes are denied. Retention cannot be shortened.

Database backups retain seven days; deletion protection and a final snapshot
protect teardown. Buckets and ECR repositories are retained. This is not a
production HA template or an independent mirror deployment.

## Vercel asset integrity

Disable Vercel Toolbar for **both Production and Preview** in the project's
General settings (`enableProductionFeedback=false`, `enablePreviewFeedback=false`).
Also set `VERCEL_PREVIEW_FEEDBACK_ENABLED=0` for both environments and redeploy.
See [Vercel's toolbar controls](https://vercel.com/docs/vercel-toolbar/managing-toolbar).
Keep Next.js `experimental.sri` enabled and preserve the script CSP.

The toolbar can append JavaScript to the emitted webpack runtime after Next.js
has calculated its SHA-256. The browser then correctly blocks the modified file,
preventing hydration even though HTML and backend health checks succeed.
Turning the toolbar off in a browser session does not repair deployed bytes.

After deployment, fetch the actual HTML and every referenced script carrying
an integrity attribute; hash the exact script response bytes and compare. Use
the script URL including its deployment query. Check the page in a browser and
exercise a flow control to confirm hydration, not just server-rendered text.
For a signed ceremony release, additionally run `infra/web-release.mjs --check`
against its published release manifest. Do not mask toolbar problems with the
`x-vercel-skip-toolbar` test header or by removing integrity checks.

## Closed flow review

With `ReviewMode=true`, enabling services starts only the review coordinator.
`GET /healthz` confirms process health; `GET /v1/rehearsal/setup` checks a real
TLS database connection and reports no schedule or beacon. Every ceremony
operation returns 423. No verifier service or ceremony maintenance runs.

Set Vercel `CEREMONY_MODE=rehearsal`, `REHEARSAL_REVIEW_MODE=true`,
`NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED=false`, and `COORDINATOR_BASE_URL`
to the stack's HTTPS output. The root page shows an explicitly simulated flow
and a separate real GitHub sign-in test. Configure a fresh `NEXTAUTH_SECRET`
and 32-byte base64url `PARTICIPANT_ID_DERIVATION_KEY` privately; remove the
corresponding `_FILE` setting when using inline secret injection. Existing
GitHub OAuth credentials remain unchanged. Browser login does not require Redis.
Contribution-token and CLI device-auth issuance remain closed.

Review runtime configuration needs only `CEREMONY_MODE`, `DATABASE_URL`, and
`DATABASE_CA_FILE`. Do not prepare a signed timed epoch merely to preview the UI.

## Images and private configuration

Build the Dockerfile's `coordinator` and `verifier-worker` targets for
`linux/amd64`, publish to the corresponding template-created ECR repositories,
then record the image digests. Runtime image parameters require `@sha256:...`.
The worker's signed `VERIFIER_IMAGE_DIGEST` must match its deployed image.

Populate the two template-created Secrets Manager secrets, one per service. Each contains JSON with
`environment` and `files` objects. The container bootstrap permits only the
listed configuration names; it writes files into a private scratch directory
with mode 0600, removes the injected config variable, and keeps NODE_ENV set to
production. Values are supplied privately, never included in stack parameters,
logs or Git. Use the default Secrets Manager encryption key, or extend each
execution role with narrowly scoped decrypt permission for a chosen custom key.

Coordinator `environment` entries:

- `CEREMONY_MODE`: `rehearsal`.
- `DATABASE_URL`: application role connection string, **no ssl/sslmode query
  parameters**; certificate validation is configured separately.
- `PUBLIC_BASE_URL`, `COORDINATOR_KEY_ID`, `CORS_ALLOWED_ORIGINS`.
- `PARTICIPANT_JWT_ISSUER`, `PARTICIPANT_JWT_AUDIENCE`.
- `S3_QUARANTINE_BUCKET`, `S3_ARCHIVE_BUCKET`, `S3_RETENTION_UNTIL` (canonical UTC
  ISO date beyond the beacon plus the agreed review/recovery window).

Coordinator `files` entries (contents, not laptop paths):

- `CEREMONY_MANIFEST_ENVELOPE_PATH`, `MANIFEST_ROOT_PUBLIC_KEY_FILE`.
- `COORDINATOR_PRIVATE_KEY_FILE`, `PARTICIPANT_JWT_PUBLIC_KEY_FILE`.
- `INTERNAL_VERIFIER_BEARER_TOKENS_FILE`: JSON mapping the signed verifier key ID
  to its private bearer token.
- `DATABASE_CA_FILE`: trusted AWS RDS regional CA bundle (maximum 64 KiB).

Verifier `environment` entries:

- `CEREMONY_MODE`: `rehearsal`; `COORDINATOR_URL`: HTTPS coordinator origin.
- `VERIFIER_OPERATOR_KEY_ID`, `VERIFIER_IMAGE_DIGEST`.
- `VERIFIER_ALLOWED_ARTIFACT_ORIGINS`: comma-separated dedicated HTTPS origins,
  including coordinator, archive CDN and exact S3 bucket origins used by jobs.
- Optional `MAX_ARTIFACT_BYTE_LENGTH`, `VERIFY_PASS_TIMEOUT_MS`, `POLL_INTERVAL_MS`.

Verifier `files` entries:

- `CEREMONY_MANIFEST_ENVELOPE_PATH`, `MANIFEST_ROOT_PUBLIC_KEY_FILE`.
- `VERIFIER_PRIVATE_KEY_FILE`, `INTERNAL_VERIFIER_BEARER_TOKEN_FILE`.

The verifier downloads and hashes genesis/PTAU from the root-verified manifest
on startup. Scratch is ephemeral; restarts redownload inputs. Initial allocation
is 4 vCPU / 16 GiB RAM / 100 GiB scratch, subject to the full-size benchmark.
The coordinator starts at 1 vCPU / 2 GiB RAM. Both services use one task and
stop-before-start deployments, so a deployment causes rehearsal downtime.

## Database and artifact preparation

After supplying a pinned coordinator image, run the stack's `MigrationTask`
once on its private subnets and coordinator security group, with no public IP.
It injects the RDS administrator secret only into that one-shot task, applies
hash-tracked migrations, and creates the separate `ceremonyapp` DML role. The
coordinator execution role cannot read the administrator secret. A successful
migration does not initialize a ceremony. Check the task exit code before
enabling the closed review service.

For non-ECS deployments, run all checked-in migrations using a temporary
migration identity with DDL privileges and verified TLS from the VPC. `infra/postgres/run-migrations.sh`
tracks migration hashes; mount the SQL files at `/migrations`. Grant a distinct
non-superuser coordinator role DML on ceremony tables and the sequences it
uses. The verifier never receives database credentials. The RDS master secret
is for provisioning/migrations, never the coordinator runtime.

Publish the already-pinned R1CS, PTAU and genesis into locked archive versions.
Inputs larger than 5 GiB (PTAU) require a provisioning multipart upload; the
runtime contribution promotion path deliberately caps individual outputs at
5 GiB. Record and independently check hashes/lengths and exact version IDs.
Seed genesis at `canonical/<ceremony-id>/sha256/<genesis-sha256>.zkey`, using a
conditional PUT and a full-object SHA-256 checksum. The coordinator verifies
that canonical object at startup and will not generate a replacement genesis.
Do not pass binary data or private material to command-line logging tools.

## Open contributions only after flow review

1. Complete actual AWS artifact-storage and worker integration checks.
2. Put `primaryPublication: { archiveBaseUrl: "https://<archive-domain>" }`
   in the signed manifest (rehearsal or production). Each accepted
   head must have an immutable evidence bundle and coordinator-signed checkpoint
   before the next lease. This is not an independent witness attestation.
3. Include immutable input/release references, the one-operator policy, the
   reviewed participation policy, schedule and committed future Ethereum block
   strictly after contribution close. Recheck that the chosen block is still
   safely in the future before signing if preparation takes longer than expected.
4. Fill the remaining coordinator and verifier configuration privately. Supply
   both reviewed image digests. Switching `ReviewMode=false` starts real ceremony
   services; do this only after launch authorization. For initial creation only,
   explicitly set `InitializeCeremony=true`, then return it to false.
5. Confirm input checks, checkpoint publication, full-size browser contribution,
   native verification, slot handoff and independently checked receipt before
   inviting collaborators. Switch the website out of simulated review mode only
   when the real backend is ready.

The older `publication` policy remains available for an independently operated
witness/mirror; it cannot coexist with `primaryPublication`. Owner decision
(2026-10-23): the mainnet ceremony uses `primaryPublication` without an
independent witness. See [the witness contract](WITNESS_CONTRACT.md).

Maintenance runs every five seconds in the real coordinator, independently of
website polling, to advance sealing, expire leases, recover accepted verification
and publish the head. It does not run in review mode. An offline finalizer still
performs terminal Ethereum beacon application and exports final artifacts;
enabling ECS does not automatically finalize.

## Validation and remaining live checks

### Reproducing the Vercel web release

Vercel's public `NEXT_DEPLOYMENT_ID` and absolute build path affect Next.js
chunk bytes and module IDs. The Git-derived build ID alone is insufficient.
`infra/docker/Dockerfile.web-release` reproduces the Linux AMD64 build at
`/vercel/path0`, using Node 24 and the locked pnpm version. Create a clean
temporary build context containing a `git archive <release-commit>` saved as
`source.tar` and a copy of that Dockerfile. Do not copy local environment files
or runtime material. Build with `--platform linux/amd64` and these public args:

- `MOSS_WEB_BUILD_ID`: the deployed release build ID.
- `NEXT_DEPLOYMENT_ID`: the exact Vercel deployment ID, including `dpl_`.
- `COORDINATOR_BASE_URL` and `ARTIFACT_ORIGINS`: the deployed public origins.
- `NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED=true` for the live browser client.
- `NODE_IMAGE`: use the recorded digest from the public reproduction metadata
  to preserve the exact Linux build environment.

Extract `/web-release.json` from the resulting image and compare every asset
against that exact deployment before publishing its immutable release reference.
Before pinning a release, `node infra/web-release-reproducibility.mjs --commit
<release-commit> --runs 3` (same public args as environment variables) rebuilds
it from clean and fails unless every `web-release.json` is byte-identical.
Deployment-protected rehearsal assets require authenticated Vercel tooling;
never place bypass tokens in the public release or repository. Use curl's
`--globoff` for paths such as `[...nextauth]`. Retain the source commit, deployment
ID and public build arguments with the release evidence. A later redeployment
changes the deployment ID and therefore requires a new release review/pin;
do not casually redeploy during a signed ceremony epoch.
For this rehearsal, the project's Ignored Build Step is frozen at `exit 0`
after release verification. Git pushes still reach both repositories but do
not automatically replace the site. Restore the prior default when preparing
the next reviewed release. See [Vercel's build-step documentation](https://examples.vercel.com/kb/guide/how-do-i-use-the-ignored-build-step-field-on-vercel).

Participant/status/receipt links use the manifest-authorized CloudFront archive
and the exact accepted S3 version. Legacy coordinator artifact links issue a
307 redirect to that same immutable URL. Keep large artifact downloads off the
API Gateway endpoint; it is the control plane. Browser uploads go directly to
bounded presigned quarantine multipart URLs.

Run `cfn-lint infra/aws/rehearsal.cloudformation.json` and the repository checks.
Before launch exercise actual AWS bucket policies/retention, interrupted uploads
and promotion, worker resource use/restarts, RDS restore, publication outage and
recovery, browser OAuth and final export. See deployment status for completed
checks. A healthy closed review backend is not a tested contribution pipeline.

## Budget and retention

By default the stack creates a $200 monthly budget filtered by
`Project=moss-phase2-rehearsal`, with actual-spend email alerts at 50%, 75% and
100% ($100, $150 and $200). `ProjectName` and `MonthlyBudgetUsd` change both. This is an alert, not an
automatic stop or an all-time spending cap. Activate the `Project` cost allocation
tag once it appears in billing (new tags may take time to appear), and track
aggregate spend if the rehearsal crosses a month boundary.

Object Lock is enabled without a default retention duration. Choose the absolute
retention deadline at launch, at least one week after launch and beyond beacon
finalization/review. Apply it to every immutable write; do not start that clock
when provisioning an empty review environment.

### Rehearsal browser release updates

An active rehearsal may authorize one additional browser release without rewriting
its original signed manifest or accepted receipts. This mechanism is deliberately
unavailable for production ceremonies. Build and reproduce the new release, then
publish its asset manifest to a content-addressed, version-pinned locked object.

The original manifest root signs a `moss.phase2.rehearsal-web-release.v1` payload
under `MOSS_PHASE2_REHEARSAL_WEB_RELEASE_V1`. The payload binds the ceremony ID,
original manifest payload hash, original web-release hash, authorization timestamp,
and the new release's full source commit, byte length, hash and immutable URL.
Publish this signed authorization alongside the release evidence before activating
it. It is an additive authorization, not a replacement ceremony manifest.

Supply the public signed JSON through `REHEARSAL_WEB_RELEASE_AUTHORIZATION_FILE`
in the coordinator runtime configuration. Startup verifies it with the original
manifest-root public key and requires explicit rehearsal mode. The public
`GET /v1/ceremonies/:slug/web-release-authorization` endpoint exposes the envelope
(or JSON null when none is installed). The coordinator continues to allow the
original browser label and additionally permits the signed new release label.
Labels are not attestation of the code actually executed; independently comparing
served bytes with the published asset manifest remains necessary.

The website independently verifies the authorization and requires its
`MOSS_WEB_BUILD_ID` to match the selected release's source commit. Deploy the new
coordinator, install the reviewed authorization, then promote the exact reproduced
web deployment. Keep the original pinned deployment available for existing tabs.
Do not replace an existing supplemental authorization while a participant using it
has an active attempt; this first version supports one supplemental release only.
Keep every published authorization and its referenced release for receipt audits.
No database migration, manifest rewrite, artifact regeneration, verifier restart,
or new epoch is needed for this update.
