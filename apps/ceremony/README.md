# Ceremony web client

This is the Caburé-derived contributor UI for the single MOSS Google RS256
zkLogin relation. It is a client of `@moss/phase2-coordinator`; it does not own
the transcript, queue, zkeys, verification, or finalization state.

The browser path uses OPFS-backed input/output files and a dedicated worker.
It is disabled unless `NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED=true`; leave it
disabled until the exact release passes the production-size browser benchmark.
The signed CLI remains the recommended contribution path.

## Required configuration

Copy `.env.example` and provide:

- GitHub OAuth/NextAuth settings;
- the coordinator's client-facing base URL and ceremony slug;
- the pinned manifest-root key id, public-key file, and SPKI SHA-256;
- the participant-token Ed25519 private-key file, issuer, and audience;
- a separate 32-byte participant identity derivation key file;
- Upstash Redis settings only when the GitHub CLI device-flow endpoint is used.

The root-signed manifest is fetched and verified by the web server before it is
exposed to client code. Browser sessions are exchanged for short-lived EdDSA
coordinator tokens. The raw GitHub subject is replaced with a keyed UUID and
keyed subject hash before it reaches the coordinator.

The CLI device-flow login code is polled in a POST body rather than a URL and
the completed bearer is atomically consumed. Browser contribution identifiers
and local verification evidence are journaled in origin-local storage. After a
refresh, the UI reconciles that journal with the participant-scoped coordinator
state and recovers an accepted receipt only after verifying its signature and
bindings.

Run from the repository root:

```sh
pnpm --filter @moss/phase2-ceremony-web dev
pnpm --filter @moss/phase2-ceremony-web typecheck
pnpm --filter @moss/phase2-ceremony-web test
pnpm --filter @moss/phase2-ceremony-web build
```

Artifact initialization, coordinator operation, recovery, and finalization are
documented in the root `RUNBOOK.md`. The removed Caburé Vercel Blob/KV ceremony
routes and scripts are not valid authority paths for this deployment.
