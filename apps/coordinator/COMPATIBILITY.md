# Caburé client migration

The coordinator's authoritative API is `/v1`. The MOSS browser and CLI now use
these endpoints directly; the table records how the inherited Caburé calls were
replaced:

| Cabure call | v1 call |
| --- | --- |
| `GET /api/ceremony/status` | `GET /v1/ceremonies/:slug/status` |
| `POST /api/ceremony/queue` | `POST /v1/ceremonies/:slug/queue` with `Idempotency-Key` |
| queue polling | `GET /v1/ceremonies/:slug/queue/me` |
| current zkey | use `status.head.downloadUrl` and verify its SHA-256 and byte length |
| create upload | `POST /v1/leases/:leaseId/uploads` |
| recover upload | `GET /v1/uploads/:id` (participant-scoped durable state) |
| upload | local: `PUT /v1/uploads/:id/content`; S3: request part URLs, upload parts directly |
| complete upload | `POST /v1/uploads/:id/complete` |
| submit | `POST /v1/leases/:leaseId/submit` with `Idempotency-Key` |
| receipt | poll submission, then `GET /v1/receipts/:id` |

The participant bearer is an Ed25519/`EdDSA` JWT validated by the coordinator,
not a trusted proxy header. Required claims are `iss`, `aud`, `exp`, UUID `sub`,
display-safe `name`, and `ash` (a keyed HMAC-SHA-256 of the provider and its
immutable subject). The raw provider subject is known only to the independently
operated web issuer. Legacy Caburé HMAC tokens are rejected.

S3 uploads are quarantined multipart objects. The client requests unique part
numbers from `POST /v1/uploads/:id/parts`, uploads each part to its signed URL,
then completes with the ordered `{partNumber, etag}` list plus its independently
calculated whole-file SHA-256 and byte length. Multipart ETags are never treated
as whole-file hashes. The server checks the object-store SHA-256 and exact
version before accepting a submission.
