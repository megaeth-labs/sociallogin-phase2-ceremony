# Production deployment checklist

The Docker Compose stack is for loopback development only. It deliberately has
one coordinator administration domain, one verifier process, generated local
credentials, a mutable filesystem artifact volume, and an optional MinIO
emulator. It is not evidence of a production ceremony. The concrete AWS adapter and hosted runtime are implemented, but real provider
integration/recovery tests remain launch blockers. Hosted startup requires
immutable storage configuration, verified PostgreSQL TLS, and a signed
publication policy; leases remain gated on the published, signed evidence for
the current head. Owner decision (2026-10-23): the mainnet ceremony uses
`primaryPublication`, the coordinator's own signed checkpoint in the
Object-Locked archive, instead of an independent transcript witness.

## Authority and role separation

- [ ] Deploy the coordinator, the verifier operator, immutable archive and
  release signer under separately administered identities. Owner decision (2026-10-22): the mainnet ceremony runs one
  internal verifier operator, as the rehearsal did. The signed manifest states
  this, so contributors can see that verification is not independent.
- [ ] Give the coordinator database DML rights but no database-owner,
  superuser, role-management, extension-management, or backup-deletion rights.
- [ ] Give verifier workers no database credentials and no coordinator signing
  key. Workers may claim bounded jobs and submit signed reports only through the
  authenticated internal API.
- [ ] Use different keys for coordinator receipts/checkpoints and verifier
  reports. Freeze exactly one coordinator key for this ceremony epoch and pin
  every public key ID in the signed manifest before opening. A
  coordinator-key change requires aborting and publishing a new ceremony epoch;
  v1 does not preserve signer IDs for in-epoch coordinator-key rotation.
- [ ] Keep private keys non-exportable in independently administered KMS/HSM
  boundaries where possible. Exercise rotation and revocation before opening;
  freeze the permitted ceremony keys afterward.
- [ ] Generate every production key fresh, as listed in
  [PRODUCTION_KEYS.md](PRODUCTION_KEYS.md), before building the manifest.
- [ ] Administer the OAuth/web participant-token issuer separately from the
  coordinator. Give the coordinator only the pinned Ed25519 verification key;
  never give it the participant-token signing key or participant-ID derivation
  secret. Bind issuer, audience, key ID/rotation policy, and account-recovery
  behavior before opening.
- [ ] Require verifier-policy unanimity and the canonical-head compare-and-swap.
  No administrator, retry handler, or emergency endpoint may bypass either.
- [ ] Make sealing/finalization multi-party administrative actions and publish
  their records to the Object-Locked archive before proceeding.

## Object storage and immutability

- [ ] Use separate quarantine and archive buckets with public access blocked,
  TLS required, ownership enforced, access logging enabled, and credentials
  scoped to exact actions and prefixes.
- [ ] Enable versioning on both buckets. Enable Object Lock before creating the
  archive bucket and use compliance-mode default retention long enough for the
  ceremony, challenge period, audit, and incident-response window.
- [ ] Deny `DeleteObjectVersion`, retention shortening,
  `BypassGovernanceRetention`, ACL changes, and bucket-policy changes to all
  application roles. Remember that Object Lock protects a version, not the
  logical key: every protocol reference must bind bucket, key, version ID,
  SHA-256, and byte length.
- [ ] Replicate accepted artifacts and transcript checkpoints into an
  independently controlled, versioned, Object-Locked account. Test restoration
  from that mirror before opening.
- [ ] Upload only to random, lease-bound quarantine keys. The server owns
  multipart initiation/completion, enforces a full-object checksum and byte
  limit, computes SHA-256 independently, pins the resulting version, and aborts
  expired multipart uploads eagerly.
- [ ] Promote with conditional creation to a content-addressed archive key.
  Crash replay must resolve the same exact version ID and must not create a
  second locked version. Never use ETag as a content hash and never make a
  mutable `latest.zkey` object the source of truth.
- [ ] Test overwrite, new-version, delete-marker, multipart replay, stale lease,
  and mutation-between-hash-and-verification scenarios against the real storage
  provider rather than only an emulator.

## Verifier isolation

- [ ] Run each verifier in a dedicated account/cluster with default-deny
  ingress and egress. Permit only immutable artifact reads and the narrow
  coordinator claim/report endpoint; do not allow package downloads, arbitrary
  DNS, metadata-service access, or interactive administration during jobs.
- [ ] Mount the canonical genesis zkey, clean R1CS, and exact PTAU read-only by
  immutable digest. Verify those digests before accepting work and fail closed
  on any missing pin.
- [ ] Run untrusted zkey parsing and snarkjs child processes as non-root with a
  read-only root filesystem, no Linux capabilities, `no-new-privileges`, a
  private temporary workspace, and hard CPU, memory, process, file-size, disk,
  and wall-clock limits.
- [ ] Use an immutable verifier image digest and signed SBOM. Disable shells,
  debug endpoints, core dumps, runtime dependency installation, and host mounts
  in the production worker image.
- [ ] Require exact-predecessor-plus-one checks in addition to generic
  `snarkjs zkey verify`. Record both whole-file SHA-256 and the distinct snarkjs
  contribution hash.
- [ ] Run the manifest-required operators and fresh passes. Treat
  false returns, parser errors, timeout, signal, OOM, truncated output, missing
  report fields, and signature failure as rejection.
- [ ] Fuzz malformed section tables, contribution counts, metadata lengths,
  point encodings, and oversized inputs inside the same sandbox used in
  production.

## Configuration and release evidence

- [ ] Set `COORDINATOR_BASE_URL` and `ARTIFACT_ORIGINS` **at web build time**,
  not only at deploy time. Next serialises the Content-Security-Policy into
  `routes-manifest.json` during `next build`, so these two are build-time
  inputs while every other consumer of `COORDINATOR_BASE_URL` reads it per
  request. Building without them ships `connect-src 'self'`: the same-origin
  bootstrap route still answers, then every coordinator call is blocked with
  nothing but a console violation. Building with a staging value silently
  allowlists the wrong origin. After deploying, fetch any page and confirm the
  `Content-Security-Policy` header names the production coordinator and
  artifact origins.
- [ ] Point `ARTIFACT_ORIGINS` only at origins an attacker cannot write to. A
  shared multi-tenant object-store endpoint is an exfiltration sink even
  without a wildcard, because an attacker can provision their own bucket on the
  same origin and a compromised bundle may then post entropy to it from inside
  the policy. Wildcard hosts are rejected by the config.
- [ ] Inject secrets through the deployment secret manager, never image layers,
  environment templates, CI logs, command-line arguments, or public manifests.
- [ ] Production startup must reject local/sample credentials, MinIO endpoints,
  mutable image tags, mock authentication, skipped verifier operators or passes,
  unsigned manifests, unresolved launch blockers, and development artifacts.
- [ ] Replace the development `file:` candidate path and shared artifact volume
  with version-pinned immutable provider reads. Do not enable production merely
  by changing `ARTIFACT_BACKEND`; the current binary intentionally rejects it.
- [ ] Pin production images by digest, restrict registries, require signed
  provenance, scan dependencies, and retain the exact deployed images for
  independent review.
- [ ] Exercise crash recovery at every boundary: upload completion, hashing,
  verifier report, archive copy, database CAS, receipt signing, transcript
  publication, and the signed checkpoint. Never issue the next lease from an
  unpublished head.
- [ ] Before opening, publish and externally timestamp the signed ceremony
  manifest, software/image hashes, public keys, schedule, immutable genesis,
  R1CS/PTAU hashes, verifier policy, and future-beacon derivation.
- [ ] Before activating the final verifier, independently replay the complete
  chain from archived artifacts, validate final ordinary-contribution inclusion
  and terminal-beacon ordering, reproduce the verification key/Solidity
  verifier, compare deployed runtime bytecode, and run valid and mutated proof
  tests.
- [ ] Rehearse the completion release before opening: build and sign a
  completion record from a dress-rehearsal finalization with
  `infra/finalization-record.mjs`, ship it in a root-authorized web release, and
  confirm the site moves from "Contributions closed" to "Ceremony complete". The
  coordinator stays `SEALED`; the root key stays offline (RUNBOOK §8, "Publish
  the completion record").
