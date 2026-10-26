# Independent publication witness contract

The coordinator sends a canonical JSON `moss.phase2.publication.v1` bundle to
`manifest.publication.endpoint` over HTTPS. It first stores identical bytes in
an immutable primary archive version. The body is limited to 4 MiB and contains:

- the root-signed manifest;
- the head generation, SHA-256, byte length, transcript sequence and event hash;
- the original coordinator-signed receipt and transcript event (null at genesis);
- the original signed verifier reports for that accepted submission.

The independent operator must pin the manifest root outside the coordinator,
verify the root signature and all event/receipt/report signatures and bindings,
retain the ordered chain, reject forks/rollback, fetch and hash the corresponding
canonical contribution, and mirror the artifact and exact bundle in independently
controlled retention-locked versions **before** acknowledging. Genesis also needs
mirroring and acknowledgement. The input R1CS/PTAU and finalization evidence must
be independently retained as part of the same archive arrangement.

The response is a protocol `SignedEnvelope` signed by the manifest's witness
key, domain `MOSS_PHASE2_PUBLICATION_ACK_V1`, with this public payload:

```json
{
  "type": "moss.phase2.publication-ack.v1",
  "ceremonyId": "<signed ceremony UUID>",
  "eventSequence": 1,
  "eventHash": "<64 lowercase hex>",
  "bundleSha256": "<SHA-256 of exact canonical request bytes>",
  "mirror": {
    "url": "https://<independent-archive>/<object>?versionId=<version>",
    "versionId": "<immutable evidence version>",
    "sha256": "<same bundle SHA-256>"
  },
  "witnessedAt": "<canonical UTC ISO timestamp>"
}
```

The endpoint must be retry-safe. Return the original acknowledgement for the
same bundle, and reject different bundles for the same ceremony/sequence.
It must not sign based solely on a coordinator's assertion of successful copy.
The coordinator verifies the signature, ceremony/head/bundle binding and mirror
pin, persists the acknowledgement, then permits a lease under the ceremony row
lock. Receipt signing itself does not prove witness publication; the next-lease
gate enforces ordering.

This repository implements the coordinator publisher/acknowledgement gate and
the [independent witness service](../../apps/witness/README.md). The witness must
be deployed under separate administration and provider-tested before the hosted
rehearsal opens. Local tests are not proof of a running independent operator.

Public discovery: `GET /v1/ceremonies/<slug>/publications` returns up to 50 signed
acknowledgements, starting with genesis. Continue with `?after=<eventSequence>`.
The acknowledgement's mirror URL must contain the exact `versionId` query
parameter. Verify its signature under the root-signed witness key, then hash
the downloaded bundle against `bundleSha256` before replaying the evidence.
