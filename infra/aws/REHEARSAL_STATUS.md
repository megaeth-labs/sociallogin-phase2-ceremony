# Company rehearsal deployment status

Updated 2026-09-29. **The replacement rehearsal is live on the stable website.
The corrected browser readiness check, explanatory storage guidance and explicit
override are deployed and independently reproduced. The coordinator is OPEN at
generation two with no pending work at deployment; two contributions are accepted.**

The [replacement manifest](../../ceremonies/company-rehearsal-2026-09-r2/manifest.signed.json)
pins all 60 new browser assets. The old epoch had zero accepted contributions and
an empty queue at replacement. Its database and signed manifest are retained;
`ceremony_rehearsal_r2` is a separate logical database on the same RDS instance,
with the existing reviewed migrations and application-role grants. Isolation is
necessary because artifact SHA-256 is globally unique within a ceremony database.
The shared pinned circuit/PTAU inputs are reused, with a separate locked canonical
genesis object for the replacement ceremony ID.

Chrome confirms that Window does not expose the synchronous OPFS method while a
dedicated worker can open it. The corrected probe cleans up its temporary file.
After failure, **Proceed with ceremony anyway** bypasses advisory checks in the
queue-entry path and worker. Actual I/O, entropy, artifact hashes and verifier
policy remain enforced. Rerunning the check resets the override.

Both the exact staged deployment and promoted stable URL passed a Chrome
browser interaction check using synthetic
authentication and read-only coordinator access: real readiness probe, 368.4 MB
artifact guidance and the failed-probe override. No contribution was submitted.
Full build, typecheck, unit/integration, end-to-end and whitespace checks passed.
The initial live smoke test missed the readiness button; this is now exercised.

The replacement epoch passed the real publication-outage drill: an IAM denial on
its genesis evidence kept the queued participant from receiving a slot; removing
the denial restored publication and the offer automatically. The temporary policy
was removed and the test ticket canceled. Manifest/checkpoint verification,
archive bundle hash, range/CORS and a two-person queue handoff also passed at
generation zero. The verifier now has 8 vCPU / 16 GiB for cold-start preparation.
It became ready at 21:44:00 UTC on September 28 after approximately 21.5 minutes;
subsequent polling reported no failures. The replacement generation-zero RDS
snapshot is available. One-time initialization is disabled again.

The first full hosted contribution has now been accepted. The full
supported-browser/hardware contribution matrix has not been completed; the live
interaction check used synthetic authentication and did not retest GitHub OAuth.

## Upload-start request fix (September 28)

The first user attempt reported HTTP 415 after downloading the artifact. The
public API reproduced this on the bodyless upload-initiation route: proxy framing
invoked the unsupported-media parser, whose empty-control allowlist omitted that
route. Coordinator commit `8dbe8d6` adds upload initiation to that allowlist.
No browser assets, signed manifest, verifier image or ceremony epoch changed.

Regression tests cover empty framed requests with absent/form/unknown media types,
authentication and lease dispatch, and continued rejection of unsupported nonempty
bodies and protocol payloads. Build, typecheck, tests, end-to-end tests and
`git diff --check` passed. The rebuilt Linux AMD64 coordinator was deployed through
CloudFormation. Live authenticated requests with a nonexistent lease now reach
lease lookup (404), unauthenticated requests return 401, and unsupported nonempty
bodies still return 415. These checks created no contribution or lease. Signed
status remained OPEN at generation zero with an empty queue. A full hosted
contribution and the broader browser/hardware matrix remain to be completed.

## Participant recovery UI and access protection (September 28)

Vercel project password protection is enabled for all deployment URLs. A fresh
Chrome context confirmed the password form, rejection of an incorrect password,
and access using the organizer-supplied password. The password is not stored in
this repository. GitHub still identifies contributors after the site gate.

The signed coordinator checkpoint now confirms one accepted contribution. The
new participant-activity UI is now deployed on the stable URL: a pending-submission card, reopening verification without another claim
or submission, polling through to a verified receipt, and viewing previous
receipts. Detaching verification no longer sends a queue cancellation request.
Account-scoped recovery checks identity and signatures; existing local evidence
must still match. Receipt browsing on another device does not claim local
computation or file cleanup.

Recovery implementation: `69179f8`; deployed release and rehearsal authorization
support: `54198dec8925d822f392c35e8f5181d865b55793`. Build, typecheck, repository tests, end-to-end
tests and whitespace checks passed. Chrome exercised pending verification,
returning to the landing page, a reload, reopening progress, automatic transition
to a signed receipt and reopening a past receipt, using synthetic authenticated
state and real test signatures. No coordinator mutation was sent. This did not
run another full-size contribution or repeat the hardware/browser matrix.

**The recovery UI is live.** A [root-signed supplemental rehearsal authorization](../../ceremonies/company-rehearsal-2026-09-r2/web-updates/2026-09-28/README.md)
binds the new release to the unchanged original manifest. All 60 assets matched
an independent build before publication to locked, version-pinned archive objects.
The exact deployment `dpl_2WDGA1eaqVSZv7v4Z7oxXYd7wkVJ` is promoted to the stable URL.
Only the coordinator was updated; the verifier image, database, ceremony schedule,
original manifest and accepted artifact chain are unchanged. This release-update
mechanism is rejected for production ceremonies.

The live coordinator accepts the original and newly authorized browser labels and
rejects an unlisted label; labels remain declarations, not code attestation.
Fresh Chrome checks on both staged and stable URLs passed signed bootstrap,
readiness, the explicit override, pending-submission recovery, detaching and
refreshing without any contribution mutations. Password entry still gates the
stable site. The post-deployment manifest and generation-one artifact hash match
the pre-deployment values; CloudFormation reached UPDATE_COMPLETE. No additional
full-size contribution was submitted. Automatic Git deployments remain disabled
to protect the signed release; publishing another UI requires a reviewed release
and authorization update.

## Contribution-progress UI update (September 29)

Release `83a7b8fc625edf60041c2a3585aa04ab0b3b4dda` is live as deployment
`dpl_J7z7PWGgtKd8Rt4N4z5EYwkiLnKR`. It adds the 5–10 minute estimate excluding
queue time and replaces the misleading computation 0% with indeterminate
progress. Download and integrity checks show their measured byte percentages;
the post-computation input check no longer reverts to the download stage.

[Signed release evidence](../../ceremonies/company-rehearsal-2026-09-r2/web-updates/2026-09-29/README.md)
records 60/60 independently reproduced browser assets and locked, version-pinned
publication. The September 28 authorization is retained for audits and superseded
by the new supplemental authorization. No active attempt was interrupted:
read-only aggregate checks before and after stopping the coordinator confirmed
zero active work. Desired count was restored to one with the same coordinator
image; the verifier, original manifest, database and accepted chain were preserved.
The signed manifest and generation-two head matched before and after activation.

Staged/live Chrome checks passed bootstrap, estimate/readiness guidance, override,
and pending recovery/detach/refresh with synthetic authentication and no
contribution mutations. Live release-label checks passed; password protection
remains enabled on all deployments. Build, typecheck, full tests, wizard e2e and
whitespace checks passed. Full-size browser contribution testing was not repeated.
Reload an existing tab before starting another contribution on the new release.

## Previous epoch deployment record

Updated 2026-09-26. **The stable website is open for the first dress-rehearsal
contribution. The real coordinator and single native verifier are ready.
Generation remains zero; infrastructure tests consumed no contribution.**

The selected Ethereum mainnet beacon is block **26,108,000**, with contributions
closing **2026-10-02 18:00 UTC**. Using reference block 26,057,083 (timestamp
1790370899), its earliest projected arrival is October 2 at 22:58:23 UTC;
missed slots delay it. Two RPC providers agreed on the reference block. The
[signed manifest](../../ceremonies/company-rehearsal-2026-09/manifest.signed.json)
is published and is the authoritative commitment.
Published rehearsal inputs are locked through **2026-10-05 00:00 UTC**, allowing
time after the beacon for finalization and review.

## Public deployment references

- Company account: `635288116361`; region: `us-east-2`.
- Explicit local profile: `moss-company-rehearsal`. No personal profile or default
  credential configuration was used or changed.
- CloudFormation stack: `moss-rehearsal`.
- Website: <https://zklogin-phase2-ceremony-mega-eth.vercel.app>.
- Backend: <https://28ia0ofkx1.execute-api.us-east-2.amazonaws.com>.
- Archive delivery origin: <https://d1lqbpxesw1yqu.cloudfront.net>.
- Resource tags: `Project=moss-phase2-rehearsal`, `Environment=rehearsal`.

## Provisioned and checked

The isolated VPC, private PostgreSQL, ECS cluster, ECR repositories, API Gateway
HTTPS endpoint/private ALB, versioned quarantine, Object Lock archive,
CloudFront, Secrets Manager configuration and CloudWatch log groups exist.

The one-shot migration task completed with exit code zero. It applied the
checked-in schema migrations and created a separate application DML role over
verified TLS. The live service cannot retrieve the RDS administrator secret.
No canonical epoch was initialized by migration.

The real coordinator has initialized generation zero from the signed rehearsal
manifest. One-time initialization has been disabled again. Its public manifest,
checkpoint, versioned artifact delivery and immutable genesis evidence have
passed live checks. The pinned launch build has been promoted to the stable alias. Bootstrap,
Chrome hydration and the local-verification guide interaction passed without
integrity/runtime errors.

The user's GitHub sign-in/callback test passed earlier. OAuth credentials were
preserved. Fresh session and participant-ID derivation secrets and a separate
participant JWT issuer key were installed privately.

The actual coordinator IAM role passed a one-shot provider test using a 6 MiB
synthetic fixture: multipart retry, full-byte SHA-256, COMPLIANCE retention,
conditional promotion, repeated promotion, recovery through a fresh adapter,
browser upload/download CORS, and unconditional overwrite denial. This test
created no ceremony, participant, or contribution. Exact immutable object
digests are cached after a full read so dashboard polling does not repeatedly
download the entire 368 MB artifact; HEAD still checks version and retention.

An encrypted RDS snapshot was restored into a separate private temporary
instance. The actual application role successfully queried the restored schema
over verified TLS in a read-only transaction. The temporary instance was then
deleted; the primary database and snapshot were preserved.

The R1CS, original genesis zkey, freshly exported raw Bellman genesis and
19.3 GB PTAU are published into version-pinned locked archive objects. The
root-signed manifest binds these exact versions and the reproduced client release.
The verifier completed its pinned input hashes, PTAU BLAKE2b check and fresh
Bellman genesis reproduction at 04:50:26 UTC. Cold startup took approximately
37.5 minutes at 4 vCPU / 16 GiB; plan for this on restarts. Its subsequent job
polling reported no cycle failures. An additional encrypted generation-zero
database recovery snapshot is available (`moss-rehearsal-signed-genesis-20260926`).

A clean Linux build at Vercel's `/vercel/path0` path, with the exact public
deployment ID, reproduced all **60/60** deployed static assets byte-for-byte.
See the release reproduction instructions in the deployment guide. The final
launch deployment also passed 60/60 comparisons and its release reference is
published. Vercel's Ignored Build Step is temporarily `exit 0`: automatic Git
builds are frozen to preserve the reviewed release while repository work
continues. Restore the previous default only when intentionally reviewing a
new deployment; a new deployment ID changes the pinned bytes.

The deployed Linux AMD64 verifier image also passed an isolated full-size check
against the historical snarkjs browser fixture whose normalized genesis matches
this rehearsal. Exact append and native curve/pairing checks succeeded, and an
unchanged predecessor was rejected. The verification portion took 191 seconds
at 4 vCPU / 16 GiB. This was not submitted to the real ceremony and is not a
live browser-to-queue-to-receipt acceptance test.

Participant download URLs and signed receipt artifact references now name the
exact committed version through CloudFront. Stable coordinator artifact links
redirect there for history/audit compatibility. Large artifact bytes must not
pass through the API Gateway control endpoint. Focused tests cover version
binding, foreign-ceremony rejection, loopback compatibility and redirects.

Empty POST/DELETE requests forwarded through API Gateway exposed a Fastify
415 response during the live queue check. The backend now accepts truly empty
unsupported body formats only on the explicit bodyless control routes. Nonempty
unsupported payloads and protocol-payload routes retain strict validation. The
regression and full repository checks passed, followed by a successful provider
recheck using the browser-compatible bodyless requests.

The live two-participant queue check passed: exclusive offer, idempotent join,
cancellation and slot handoff. Root-signed manifest, coordinator checkpoint,
immutable evidence bundle hash, direct artifact range/CORS, audit redirect and
unauthenticated rejection also passed. Test participants were canceled; generation
remains zero and the queue is empty. Coordinator replacement with initialization
disabled preserved the signed manifest and canonical genesis.

The attempted genesis publication outage drill did not establish its intended
preconditions before publication recovered. Its temporary IAM denial was removed;
this drill is not recorded as passed. Publication fail-closed behavior has local
integration coverage; repeat the provider outage drill in a separate test epoch
or with a deliberately coordinated later contribution.

## Cost controls

The approved budget is **$200**. AWS Budgets has monthly actual-spend alerts at
$100/$150/$200 to `arun@megaeth.com`, filtered to the rehearsal project tag.
The `Project` cost allocation tag was activated on September 26. Cost reporting
may lag activation; check attributed spending before relying on filtered alerts.
Alerts do not stop resources, and monthly budgets do not enforce an aggregate
cap across September/October. Track total rehearsal spending as well.

Review resources incur charges while waiting for feedback. Disabling ECS alone
does not remove NAT gateway, ALB or database charges. The verifier is running and ready.

## First contribution and remaining rehearsal checks

- Password protection covers all Vercel deployment URLs. Invited testers use the
  organizer-supplied password, then their own GitHub participant sign-in.
- Exercise the remaining full browser-to-S3 contribution pipeline checks:
  interrupted upload/retry, acceptance, immutable publication, slot handoff,
  process restart/recovery and independently checked receipts.
- Complete a full desktop browser contribution, then invite collaborators.
  Terminal Bellman-to-zkey conversion, beacon application and final verification
  are a separate finalization step; they do not run automatically at block time.

The archive checkpoint is signed by our coordinator, not an independent witness.
All intermediate artifacts and evidence remain available for later audit.
An independently administered production verifier remains a desired follow-up.

## Teardown

Keep the final export and audit evidence through the agreed deadline before
teardown. Disable services first and review a stack deletion plan. The database
has deletion protection and a final snapshot policy; buckets, images and secrets
may be retained. Removing the stack is not sufficient to delete all retained
resources or stop their storage charges. Object-locked versions cannot be
removed before their retention expires. Delete only resources belonging to this
stack/project after confirming the recovery/export requirements.

## Validation limits

Repository build, typecheck, unit/integration tests, wizard end-to-end tests,
infrastructure guard tests, CloudFormation lint and whitespace checks passed.
The web authentication closure change additionally passed all 88 web tests.
The final gateway compatibility change also passed the full build, typecheck,
unit/integration and end-to-end checks. These do not replace the first full
hosted browser contribution, the supported-browser/hardware matrix, or the
provider publication-outage drill described above.

## Toolbar integrity incident

A post-deployment browser check exposed a webpack SRI failure: Vercel appended
its toolbar loader to the runtime after Next.js calculated the digest. Removing
that appended loader exactly reproduced the expected SHA-256. Toolbar injection
is now disabled at project level for Production and Preview and via
`VERCEL_PREVIEW_FEEDBACK_ENABLED=0`; the site is redeployed with SRI preserved.
HTML-only smoke checks missed the browser hydration failure. Deployment checks
must compare actual script bytes and exercise a browser interaction as described
in the deployment guide.
