Walk the QA engineer through the Caburé project onboarding. This is designed for Laruku but works for any QA person joining the project.

Read `CLAUDE.md` at the project root first, then guide the QA engineer through these steps:

## 1. What You're Testing

Caburé is a Groth16 Phase 2 trusted setup ceremony toolkit. Your job is to make sure the full ceremony flow works end-to-end — from `npx @wonderland/create-cabure-ceremony` all the way to a finalized zkey with an Ethereum RANDAO beacon applied.

Three packages to test:
- `@wonderland/cabure-crypto` — the cryptographic primitives (Lumi built this)
- `@wonderland/create-cabure-ceremony` — the CLI wizard + generated project (Ardy built this)
- `@wonderland/cabure-cli` — the headless CLI contributor tool (Ardy built this)

## 2. Architecture You Need to Know

The generated project is a **single Next.js app** — UI screens and API routes live together:

- **`src/app/screens/`** — participant-facing screens (Landing, Entropy, Tier, Progress, Complete, Verify). Test: entropy collection, Web Worker computation, browser compatibility, screen flow, error states.
- **`src/app/api/ceremony/`** — API routes managing queue, contributions, verification, receipts. Test: queue management, contribution verification, auth flows, timeout handling, race conditions.
- **`@wonderland/cabure-cli`** — headless contributor. Test: GitHub device flow auth, large circuit streaming, progress reporting, error recovery.

Storage is Vercel-first:
- **Vercel Blob** holds zkey files (genesis, intermediate, final).
- **Upstash Redis (Vercel KV)** holds ceremony state (manifest, queue, receipts, chain hashes).

Key things to watch for:
- API routes read/write KV on every request — race conditions on queue/state are possible.
- Entropy requires user interaction (mouse/clicks). The UI should NOT let you proceed without enough entropy.
- Test what happens when KV or Blob is slow, rate-limited, or returns stale data.
- Chain hash integrity — verify the SHA-256 chain is tamper-evident across contributions.
- Per-contribution BN254 pairing verification is mandatory in production. The `verifyContributions` flag in `ceremony.config.ts` only disables it outside production (local dev / CI), never in prod. The finalize script always verifies the full chain before applying the beacon.

## 3. Your Test Plan

Check Linear for QA issues. Use the Linear MCP to list issues in the Caburé project assigned to the QA engineer. Present them with priorities:

- **BES-1356** (Urgent) — End-to-end ceremony test + failure scenarios
  - Full ceremony with toy circuit and 3+ contributors
  - Contributor drops mid-contribution
  - Queue timeout scenarios
  - KV or Blob unavailable during contribution
  - Duplicate contribution attempts

- **BES-1357** (High) — Browser compatibility + CLI tools testing
  - WASM in Chrome, Firefox, Safari (Web Worker must not block main thread)
  - CLI wizard: prompts, scaffolding, deploy scripts
  - CLI contributor: device flow auth, large file streaming, receipt generation

- **BES-1358** (High) — Security review + performance testing
  - Auth bypass attempts (skip queue, fake contribution hash, replay attacks)
  - State tampering (modified KV manifest, swapped Blob URLs, corrupted zkeys)
  - Entropy quality (is the UI actually enforcing the mouse/click threshold?)
  - Large circuits (>100 MB zkeys) — memory, timing, streaming
  - Many contributors (simulate 50+ concurrent queue entries)

- **BES-1359** (Urgent, due Mar 27) — Final sign-off
  - Complete ceremony from `npx @wonderland/create-cabure-ceremony` to finalized zkey
  - Every screen works, every API route works, chain hash is valid, RANDAO beacon is applied
  - This is the gate — nothing ships without your sign-off

## 4. Test Environment Setup

Guide them through getting a local test environment running:
```bash
# 1. Scaffold a test ceremony
npx @wonderland/create-cabure-ceremony
# Use: "QA Test Ceremony", small custom target (e.g. 10), no tiers

# 2. Provision Vercel storage
cd my-ceremony
vercel link                         # link the project
# In the Vercel dashboard → Storage tab:
#   - create a Blob store
#   - create a KV (Upstash) store
vercel env pull .env.local          # pull the generated BLOB/KV env vars

# 3. Start locally
npm install
npm run setup:ptau
npm run init:ceremony
npm run dev
# App: http://localhost:3000

# 4. Test the CLI contributor against the local app
npx @wonderland/cabure-cli contribute http://localhost:3000
```

For the toy circuit, use the smallest possible r1cs file to keep iteration fast. Save the production-size circuits for BES-1358 performance testing.

## 5. What to Prioritize

Testing window is Mar 16 – Mar 27 (2 weeks). Suggested order:
1. **Week 1 (Mar 16–20):** BES-1356 (e2e) + BES-1357 (browser/CLI) — get the happy path solid first
2. **Week 2 (Mar 23–27):** BES-1358 (security/perf) + BES-1359 (final sign-off) — break things, then certify

## 6. Questions

Ask the QA engineer:
1. Do you have a toy circuit (.r1cs) available for testing? If not, Lumi can provide one.
2. Do you have a Vercel account with permission to create Blob and KV (Upstash) stores in the target project?
3. Any specific areas you're concerned about?

If $ARGUMENTS contains a specific focus (e.g. "security", "browser", "e2e"), dive deeper into that area.
