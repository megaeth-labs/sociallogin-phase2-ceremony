# Independent publication witness

Run under a separate operator/account from the coordinator. This service verifies
the pinned root-signed manifest, coordinator receipt/event signatures, exact
predecessor continuity, verifier signatures/policy and artifact binding. It
fetches and SHA-256 checks accepted artifact bytes, retains them in its own S3
Object-Locked archive, then stores the exact canonical evidence and signs an
acknowledgement. It does not independently repeat contribution curve arithmetic.

State is the immutable sequence of evidence/acknowledgement objects. Each
sequence has one conditional `If-None-Match: *` acknowledgement key, and each new
sequence requires the previously signed acknowledgement and its exact bundle.
This prevents concurrent forks and permits crash/retry recovery without a
mutable database head. Identical retries return the original acknowledgement.
A mirror failure never produces an acknowledgement. Local tests use isolated
in-memory archives and mocked AWS responses; provider validation is outstanding.

## Deployment

Build `infra/docker/Dockerfile --target witness` for Linux AMD64, pin the image
digest, and deploy behind HTTPS at the endpoint committed in the manifest.
The coordinator's primary template does not deploy this independently operated
service. It needs one private versioned Object-Lock S3 archive, immutable public
version-specific delivery, outbound access to approved artifact origins, and
scratch larger than the largest accepted artifact. No PostgreSQL is required.
Mirror R1CS/PTAU, original zkey and finalization evidence separately as part of
archive provisioning; the live endpoint mirrors canonical contribution heads.

Use the task's own scoped IAM role. Allow bucket versioning/Object Lock reads,
object GET/version GET/retention reads and conditional PUT with retention in the
witness archive only. Deny deletes/retention shortening and enforce conditional
creation through bucket policy. The public delivery cache must include versionId.
Test these policies against AWS before accepting public participants.

The Docker bootstrap consumes `CEREMONY_RUNTIME_CONFIG` from the witness's own
secret, with `environment` and `files` objects. Never reuse coordinator secrets.

Environment names:
- `CEREMONY_MODE`: rehearsal or production.
- `WITNESS_ARCHIVE_BUCKET`, `WITNESS_ARCHIVE_PUBLIC_URL` (HTTPS base).
- `WITNESS_RETENTION_UNTIL`: canonical UTC date beyond the beacon/review window.
- `WITNESS_ARTIFACT_ORIGINS`: comma-separated exact HTTPS origins.
- `MANIFEST_ROOT_PUBLIC_KEY_SPKI_SHA256`: independently confirmed public fingerprint.

Files (contents in the private config; materialized mode 0600):
- `CEREMONY_MANIFEST_ENVELOPE_PATH`
- `MANIFEST_ROOT_PUBLIC_KEY_FILE`
- `WITNESS_PRIVATE_KEY_FILE`

AWS_REGION and task credentials come from the runtime. For direct local process
startup, set those file paths and AWS_REGION explicitly; HOST defaults to
127.0.0.1 and PORT to 8789. No developer AWS profile is required or selected by
local tests. The container bootstrap listens on port 8787.

`POST /v1/publications` accepts canonical JSON, at most 4 MiB. `GET /healthz`
reports startup readiness. The process admits one publication at a time; other
requests receive 503. A first large mirror can outlast the coordinator's HTTP
timeout: copying continues and its retry retrieves the durable acknowledgement.
Failed validation/provider operations return a generic 409 without private logs.

Run `pnpm --filter @moss/phase2-witness build` and `pnpm --filter @moss/phase2-witness test`.
