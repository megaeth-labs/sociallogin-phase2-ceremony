# Local infrastructure

This directory contains the loopback-only development stack. Its default path
provides PostgreSQL, the coordinator's concrete development-only filesystem
artifact backend, and one verifier worker. It is deliberately not
production-shaped: production requires independently administered verifier
operators, immutable object storage, external transcript witnesses, immutable
image digests, and managed signing keys.

The coordinator refuses to use this filesystem backend with
`NODE_ENV=production`, and the separate hosted S3 runtime requires immutable archive configuration
and publication acknowledgements. See [the hosted provisioning request](REHEARSAL_PROVISIONING.md)
and [AWS template instructions](aws/README.md). MinIO remains available only under the optional
`s3-emulator` profile for storage-policy experiments; neither the coordinator
nor verifier reads it.

## Prerequisites

Copy the local-only variable template if you need to change ports or sample
credentials:

```sh
cp infra/.env.example infra/.env.local
```

The coordinator and verifier fail closed unless the artifact directory contains
three nonempty files. Their hashes and lengths are placed in a freshly signed,
local-development manifest generated at startup:

- `genesis.zkey` — a zero-contribution development genesis, never the MOSS
  development-testnet final zkey;
- `circuit.r1cs`;
- `powersoftau.ptau`.

Place them in `infra/dev-artifacts/` or set `MOSS_PHASE2_ARTIFACT_DIR`. They are
ignored by Git and mounted read-only. The first initialization hashes the full
files, including the PTAU, so it can take several minutes.

The generated manifest fixes a three-contribution local policy, one verifier
pass, bounded leases/retries, and the configured maximum artifact length. Its
release references, artifact URLs, drand fields, one-verifier policy, and
default all-zero verifier image digest are development placeholders, not
ceremony evidence. Changing a pinned artifact, signed policy input, or runtime
format requires resetting the Docker volumes instead of silently rotating the
local identity underneath an existing database.

## Start and inspect

```sh
docker compose --env-file infra/.env.local up -d --build
docker compose --env-file infra/.env.local ps
curl --fail http://127.0.0.1:58787/healthz
```

Without a custom env file, the compose defaults are the same documented,
development-only values from `.env.example`. All published ports bind to
`127.0.0.1`. The coordinator permits browser requests only from the exact
origins in `MOSS_LOCAL_CORS_ALLOWED_ORIGINS`.

The one-shot initializer creates random Ed25519 development keys, a unique
operator-bound verifier credential, and the signed manifest in separate Docker
volumes. The coordinator receives a private operator-to-credential map while
the worker receives only its own credential; a production deployment must keep
that separation for every independently operated verifier. The initializer also
creates a separate participant JWT Ed25519 keypair and a 32-byte participant-ID
derivation secret. Private material is never copied into an image or the
repository. The coordinator receives only the participant JWT public key. The
web issuer's private key and derivation secret live in `web_auth_secrets`, which
is not mounted into either coordinator or verifier. A containerized web issuer
can mount that volume read-only and use:

```text
PARTICIPANT_JWT_PRIVATE_KEY_FILE=/run/web-auth/participant-jwt-private.pem
PARTICIPANT_ID_DERIVATION_KEY_FILE=/run/web-auth/participant-id-derivation-key
PARTICIPANT_JWT_ISSUER=moss-phase2-local-web
PARTICIPANT_JWT_AUDIENCE=moss-phase2-local-coordinator
```

The coordinator cannot read the verifier private key, the verifier has no
database network or credential, and the verifier network is internal so it has
no general Internet egress.

The coordinator writes quarantine and canonical objects to the `artifact_data`
volume. The verifier mounts that volume read-only because development verifier
jobs use allowlisted `file:` URLs. Client-facing predecessor and receipt links
use the published loopback coordinator port so a local browser can resolve
them. Production must replace the shared filesystem mechanism with immutable,
version-pinned provider storage and the loopback URL with its public HTTPS
origin.

To start the optional, non-authoritative MinIO emulator separately:

```sh
docker compose --env-file infra/.env.local --profile s3-emulator up -d minio minio-bootstrap
```

Starting MinIO does not enable an S3 coordinator path.

## Reset

The generated local identity is stable across ordinary restarts. Resetting
volumes destroys the local database, filesystem artifacts, optional MinIO
objects, all development keys, and the manifest:

```sh
docker compose --env-file infra/.env.local down --volumes
```

Never use the generated local manifest, credentials, keys, receipts, verifier
reports, or MinIO objects in a real ceremony. See
`PRODUCTION_DEPLOYMENT_CHECKLIST.md` before designing a production deployment.
