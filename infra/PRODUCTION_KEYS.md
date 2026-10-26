# Production keys

Every key below is new for the mainnet ceremony. Never reuse a rehearsal key,
a development key from `infra/docker/prepare-local-runtime.mjs`, or anything
already stored in a rehearsal secret.

Generate keys on a trusted machine with a current OpenSSL (3.x) and Node 24.
`node infra/generate-secrets.mjs --out <new directory>` produces keys 2–7 below
in one step and prints their public fingerprints. Add `--with-root` only for a
test ceremony; the mainnet root is generated offline (section 1).
Private keys never enter the repository, a container image, a log or chat.
`secrets/` is ignored by git; the manifest inputs read public keys from it.
File-mounted secrets must be mode `0600`: the site, coordinator and verifier
reject group- or world-readable secret files.

The services load private keys from files or environment variables; none of
them signs through KMS. Store each private key in AWS Secrets Manager (or
Vercel's encrypted environment for site keys) and grant read access only to
the one service that uses it.

## Before the manifest is signed

These public keys are frozen into the signed manifest. Changing one afterwards
means a new manifest, so generate all of them first.

### 1. Manifest root key (offline)

Signs the manifest, every operational update (web and CLI releases, heartbeat grace)
and the final completion record. Generate and use it only on an offline
machine.

```sh
openssl genpkey -algorithm ed25519 -out manifest-root.key
openssl pkey -in manifest-root.key -pubout -out manifest-root.pub
openssl pkey -pubin -in manifest-root.pub -outform DER | shasum -a 256
```

- Choose a key ID, for example `moss-phase2-root-2026-11`. It is passed to
  `infra/sign-manifest.mjs --key-id`, and `sign-manifest` prints the same SPKI
  SHA-256 as the last command.
- Keep at least two encrypted copies of `manifest-root.key` on separate
  offline media in separate places. Losing it means no further site releases,
  no heartbeat changes and no signed completion record.
- Publish the key ID and SPKI SHA-256 through a channel separate from the site,
  for example a MegaETH blog post and the GitHub release, before opening.
  Participants and the finalizer check the root against this fingerprint.
- Site and coordinator receive only the public key: `MANIFEST_ROOT_KEY_ID`,
  `MANIFEST_ROOT_PUBLIC_KEY` (PEM) and `MANIFEST_ROOT_PUBLIC_KEY_SPKI_SHA256`
  on Vercel; `MANIFEST_ROOT_PUBLIC_KEY_FILE` on the coordinator.

### 2. Coordinator signing key

Signs receipts, events and checkpoints. Exactly one per ceremony.

```sh
openssl genpkey -algorithm ed25519 -out secrets/coordinator-1.key
openssl pkey -in secrets/coordinator-1.key -pubout -out secrets/coordinator-1.pub
```

- Public key: `coordinatorKeys[0].publicKeyFile` in the inputs (already
  `../../secrets/coordinator-1.pub`).
- Private key: AWS Secrets Manager, mounted only into the coordinator as
  `COORDINATOR_PRIVATE_KEY_FILE`.

### 3. Verifier signing key and image digest

Signs each verification report. One operator (`verifier-a`).

```sh
openssl genpkey -algorithm ed25519 -out secrets/verifier-a.key
openssl pkey -in secrets/verifier-a.key -pubout -out secrets/verifier-a.pub
```

- Public key: set `verifierKeys[0].publicKeyFile` to
  `../../secrets/verifier-a.pub`.
- Private key: mounted only into the verifier as `VERIFIER_PRIVATE_KEY_FILE`.
  The coordinator must not be able to read it.
- `verifierImageDigest` is the pushed image digest of the verifier built from
  the release commit:

  ```sh
  docker buildx build --platform linux/amd64 -f infra/docker/Dockerfile \
    --target verifier-worker -t <registry>/moss-verifier:<commit> --push .
  docker buildx imagetools inspect <registry>/moss-verifier:<commit> \
    --format '{{.Manifest.Digest}}'
  ```

  Record it as `sha256:<64 hex>`. Deploy that exact digest, never a tag.

## Not in the manifest

These can be rotated without re-signing, but rotating some of them during the
ceremony has consequences, noted below.

### 4. Verifier bearer token

Authenticates the verifier to the coordinator's internal API.

```sh
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' > secrets/verifier-a.token
```

- Verifier: `INTERNAL_VERIFIER_BEARER_TOKEN_FILE` pointing at the token file.
- Coordinator: `INTERNAL_VERIFIER_BEARER_TOKENS_FILE` pointing at a JSON object
  whose keys exactly match the signed operator IDs:
  `{"verifier-a": "<same token>"}`.

### 5. Participant JWT issuer key

The site signs participant tokens; the coordinator checks them.

```sh
openssl genpkey -algorithm ed25519 -out secrets/participant-jwt.key
openssl pkey -in secrets/participant-jwt.key -pubout -out secrets/participant-jwt.pub
```

- Vercel: `PARTICIPANT_JWT_PRIVATE_KEY` (PEM).
- Coordinator: `PARTICIPANT_JWT_PUBLIC_KEY_FILE`.
- Both: the same `PARTICIPANT_JWT_ISSUER` and `PARTICIPANT_JWT_AUDIENCE`, for
  example `moss-phase2-web` and `moss-phase2-coordinator`.
- Rotating it signs everyone out of the CLI and site; it does not affect
  receipts.

### 6. Participant ID derivation key

Turns a GitHub account into the stable pseudonymous participant ID.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

- Vercel: `PARTICIPANT_ID_DERIVATION_KEY` (43 base64url characters).
- **Do not rotate it during the ceremony.** A new key gives every account a new
  participant ID, so returning participants no longer match their queue
  entries or receipts. Back it up with the same care as the root key.

### 7. Session secret

```sh
openssl rand -base64 32
```

- Vercel: `NEXTAUTH_SECRET`. Rotating it signs everyone out.

### 8. GitHub OAuth app

A megaeth-labs org owner creates the OAuth app (callback
`https://<domain>/api/auth/callback/github`, Device Flow enabled) and
generates the client secret.

- Vercel: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

### 9. Collectible

Owner decision (2026-10-24): the collectible ships, owned by an EOA. Generate
two separate keys:

```sh
cast wallet new   # claim signer
cast wallet new   # contract owner
```

- Claim signer: Vercel `NFT_CLAIM_SIGNER_PRIVATE_KEY` (`0x` + 64 hex). Its
  address is the signer passed to the contract constructor. It signs a mint
  voucher for each accepted receipt.
- Owner: passed as the constructor's owner. It can only pause minting, rotate
  the claim signer and transfer ownership (two-step). Keep it off Vercel and
  every server, like the root key; a leaked owner key could rotate the signer
  and mint false badges.

## Provisioned, not generated

The database credentials, `DATABASE_CA_FILE`, the Upstash `KV_REST_API_TOKEN`
and the AWS roles come from their providers. Restrict each to the one service
that needs it, as listed in [the AWS guide](aws/README.md).
