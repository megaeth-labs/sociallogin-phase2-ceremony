# Phase 2 artifact storage

`LocalArtifactStore` is an explicit development/test adapter. It requires
`{ allowDevelopmentOnly: true }`, rejects the filesystem root, re-hashes every
promotion, and is restart-safe, but local filesystem copies do not provide
production WORM guarantees.

`S3ArtifactStore` separates quarantine and archive buckets, keeps the public
coordinator upload ID distinct from the provider multipart ID, reconciles a
lost multipart-completion response against the exact checksum and length, and
requires source version IDs and whole-object SHA-256. In production it accepts
only archive copies reported in Object Lock `COMPLIANCE` mode with a canonical
retain-until date at or beyond the configured challenge/archive horizon. Every
canonical signed download is pinned to the exact checked version ID. Upload
grants are persisted by the coordinator in PostgreSQL; the store itself has no
process-memory session authority.

The `S3ArtifactClient` port is intentionally provider-neutral. The concrete `AwsS3ArtifactClient` implements this port with the AWS SDK. It
streams and hashes exact object versions, ignoring ETags, user metadata and
composite checksums. It uses a full-SHA256 conditional `PutObject` with
`If-None-Match: *` for canonical promotion (maximum 5 GiB per contribution).
Repeated or ambiguous promotions resolve the same checked, retention-locked
version. Bucket policy must deny canonical deletes and unconditional writes.
Upload-part grants expire no later than their lease. Provider tests still need
a real AWS account; mocked SDK tests do not certify bucket permissions. Production startup must fail unless a
real adapter implementing multipart presigning, version-pinned copy, checksum
readback, Object Lock readback, and exact-version signed downloads is injected.
Its content-addressed archive copy must also use conditional creation or an
equivalent single-flight protocol: replay after a crash must resolve the same
immutable version instead of creating another locked version. Do not replace it
with a permissive mock outside tests.
