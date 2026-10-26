# Agent workflow

## Sources of truth

- Read `README.md` for architecture, trust assumptions, and project status.
- Read `RUNBOOK.md` before changing operational commands or ceremony state.
- Read the active file under `ceremonies/` before changing relation or artifact
  metadata.
- Preserve Cabure provenance and the `upstream` remote.

## Change workflow

- Keep work local unless the user explicitly asks for a commit, push, pull
  request, GitHub fork, or deployment.
- Inspect `git status -sb` before editing and preserve unrelated changes.
- Use focused package boundaries. Add tests for protocol, state, storage,
  browser-worker, server, or CLI behavior changes.
- Report checks run and checks skipped in the final handoff.

## Security boundaries

- Never print, inspect, log, or commit environment values, OAuth tokens,
  signing keys, entropy, zkeys, R1CS/PTAU binaries, upload capabilities, or
  local database/object-store state.
- Public manifests may contain only reviewed public hashes, byte lengths,
  immutable URLs, public keys, release metadata, and policy.
- Never accept a candidate using a client claim, object-store ETag, Redis
  update, or generic zkey validity alone.
- Production acceptance requires exact predecessor-plus-one validation,
  immutable candidate bytes, verifier-policy unanimity, and a transactional
  canonical-head compare-and-swap.
- Production must fail closed if artifact pins, verifier identities, signing
  keys, schedule, beacon commitment, object versioning/lock, or transcript
  publication are incomplete.
- Do not claim secure erasure from JavaScript memory or SSD-backed OPFS.

## Artifacts

- Do not commit `.r1cs`, `.ptau`, `.zkey`, `.wtns`, contribution outputs,
  quarantine objects, local transcripts, or generated signing material.
- The development-testnet zkey in `moss-zk` is not a ceremony genesis.
- Generate production genesis material only from a clean, hash-pinned source
  checkout and publish its hashes before opening the ceremony.

## Local verification

Run focused tests first. Before a broad handoff run:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
git diff --check
```

Full browser acceptance additionally requires real-artifact runs on every
supported browser and hardware class. State explicitly when those artifacts or
machines are unavailable.
