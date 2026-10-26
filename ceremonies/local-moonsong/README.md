# Local Moonsong ceremony public root

This is the public manifest-root key for the current full-size local Moonsong
test epoch, initialized on 2026-09-22. It is not a rehearsal or production key.
No private signing material is stored here.

SHA-256 of the public key's SPKI DER encoding:

`fdb6a311c28d2e17b8a128c92b18094ff63023983b0c91bed59f500c801be360`

From the repository root, copy the supplied key for the displayed CLI commands:

```sh
cp ceremonies/local-moonsong/ceremony-root.pub ceremony-root.pub
openssl pkey -pubin -in ceremony-root.pub -outform DER | openssl dgst -sha256
```

Confirm the fingerprint through an independent trusted channel. A key and its
fingerprint fetched from the same compromised source do not establish trust.

If the local epoch is reset, explicitly review and update this public key and
fingerprint. A hosted ceremony must publish its own separately reviewed root.
