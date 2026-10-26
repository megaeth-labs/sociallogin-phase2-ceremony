# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Caburé

Caburé is an open-source CLI wizard and toolkit for running Groth16 Phase 2 trusted setup ceremonies, replacing p0tion + DefinitelySetup.

## Packages

| Package | Purpose |
|---------|---------|
| `@wonderland/cabure-crypto` | Published npm package — typed exports for all Groth16 Phase 2 ceremony operations |
| `@wonderland/create-cabure-ceremony` | CLI wizard that scaffolds a fully deployable ceremony project |
| `@wonderland/cabure-cli` | CLI contributor tool for headless/VM environments |

**Naming**: Always use these exact names. Never use `elixir-wizard`, `elixir-ceremony`, `@wonderland/elixir-wizard`, `@cabure/crypto`, or `@cabure/cli` — those are outdated.

## Architecture Constraints (non-negotiable)

1. **`@wonderland/cabure-crypto` is a published dependency** — shared across wizard, frontend, CLI. Never embed or vendor it.
2. **Single Next.js application** — Generated projects are a single Next.js app containing both the UI and API routes:
   - `src/app/api/ceremony/` — API routes managing queue, contributions, verification, receipts
   - `src/app/screens/` — Participant-facing screens (Landing, Entropy, Tier, Progress, Complete, Verify)
   - `src/hooks/` — Contribution flow, entropy collection, ceremony status
   - `src/lib/` — Server utilities (auth, blob storage, KV, ceremony state)
3. **Vercel-first storage** — Zkey files stored in Vercel Blob, ceremony state and receipts in Upstash Redis (Vercel KV). No IPFS.
4. **User interaction required for entropy** — Minimum threshold of mouse movement/click entropy. Passive CSPRNG alone is insufficient.
5. **GitHub OAuth device flow** for CLI — Enables headless/VM auth without browser redirect.
6. **Target contribution options**: 100 (default) / 500 / 1,000 / custom.

## @wonderland/cabure-crypto API

All functions accept `Uint8Array` inputs. snarkjs file I/O is handled internally via temp directories.

```typescript
generateInitialZkey(ptau: Uint8Array, r1cs: Uint8Array): Promise<Uint8Array>

contribute(
  prevZkey: Uint8Array,
  entropy: Uint8Array,
  name?: string,
): Promise<ContributionResult>
// ContributionResult = {
//   zkey: Uint8Array;
//   contributionHash: string;  // snarkjs Blake2b hash over the contribution pubkey
//   zkeyHash: string;          // SHA-256 of the new zkey binary
// }

verify(r1cs: Uint8Array, ptau: Uint8Array, zkey: Uint8Array): Promise<boolean>

verifyChain(
  ptau: Uint8Array,
  initialZkey: Uint8Array,
  latestZkey: Uint8Array,
): Promise<boolean>

verifyChainForCircuit(
  r1cs: Uint8Array,
  ptau: Uint8Array,
  initialZkey: Uint8Array,
  latestZkey: Uint8Array,
): Promise<boolean>

generateEntropy(sources?: EntropySource[]): Promise<Uint8Array>

applyBeacon(
  zkey: Uint8Array,
  beaconHash: string,
  numIterationsExp?: number,
): Promise<BeaconResult>
// BeaconResult = {
//   zkey: Uint8Array;
//   contributionHash: string;  // snarkjs Blake2b hash for the beacon contribution
//   zkeyHash: string;          // SHA-256 of the finalized zkey binary
// }

exportVerificationKey(zkey: Uint8Array): Promise<object>
```

## Generated Project Structure

`npx @wonderland/create-cabure-ceremony` outputs:

```
my-ceremony/
├── src/
│   ├── app/
│   │   ├── api/ceremony/       # API routes
│   │   │   ├── status/         # GET ceremony status
│   │   │   ├── queue/          # POST join queue
│   │   │   ├── circuits/[id]/  # zkey download, upload, contribute
│   │   │   └── receipt/        # GET contribution receipt
│   │   ├── screens/            # Landing, Entropy, Tier, Progress, Complete, Verify
│   │   └── components/         # Header, Button, ScreenWrapper, ErrorBoundary
│   ├── hooks/                  # useContributionFlow, useEntropyCollector, etc.
│   ├── lib/                    # api, auth, blob-store, kv-store, ceremony-state
│   ├── types/                  # ceremony types, next-auth extensions
│   └── utils/                  # cn, entropy, format helpers
├── scripts/                    # setup-ptau, init-ceremony, finalize-ceremony, reset-ceremony
├── circuits/                   # .r1cs files and downloaded .ptau
├── ceremony.config.ts          # Ceremony name, circuits, tiers, storage keys
├── package.json
└── README.md
```

## Ceremony API Endpoints

API routes live under `src/app/api/ceremony/` in the generated project.

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/ceremony/status` | GET | Ceremony progress, circuit states, queue lengths |
| `/api/ceremony/queue` | POST | Join the contribution queue (GitHub OAuth required) |
| `/api/ceremony/queue` | GET | Get authenticated participant's queue position (`?circuitId=...`) |
| `/api/ceremony/circuits/[id]/zkey` | GET | Download current zkey (binary or JSON info) |
| `/api/ceremony/circuits/[id]/upload` | POST | Upload contributed zkey to Vercel Blob |
| `/api/ceremony/circuits/[id]/contribute` | POST | Submit contribution (verify, store, advance chain) |
| `/api/ceremony/receipt` | GET | Retrieve contribution receipt for a participant |

## Wizard Prompts (4 questions)

1. **Project name** — Displayed in the ceremony UI
2. **Target contributions** — Select from 100 (default) / 500 / 1,000 / custom
3. **End date** — Optional YYYY-MM-DD deadline
4. **Circuit artifacts path** — Optional path to .r1cs files; if provided, files are copied into `circuits/`

The target contributions step defaults to 100 when the user presses Enter.

## Ceremony Scripts

Generated projects include four operator scripts in `scripts/`:

| Script | npm command | Purpose |
|--------|-------------|---------|
| `setup-ptau.ts` | `npm run setup:ptau` | Download matching Powers of Tau file for each circuit |
| `init-ceremony.ts` | `npm run init:ceremony` | Generate genesis zkeys, upload to Blob, write manifest to KV. Saves local copies and transcript to `public/genesis/` |
| `finalize-ceremony.ts` | `npm run finalize:ceremony` | Apply Ethereum RANDAO beacon, export verification keys. Saves final zkeys and transcript to `public/finalize/` |
| `reset-ceremony.ts` | `npm run reset:ceremony` | Clear all KV state and Blob storage for a fresh start |

## Ceremony Flow

Operator scaffolds → runs `setup:ptau` → runs `init:ceremony` → deploys to Vercel → contributors visit the UI or use CLI → each contribution: download zkey → collect entropy → compute in Web Worker/CLI → upload → verify → when target is reached, operator runs `finalize:ceremony` to apply an Ethereum RANDAO beacon and produce final parameters.

## Verification

- Per-contribution BN254 pairing checks are **mandatory in production** (C-1b); the `verifyContributions` flag in `ceremony.config.ts` only disables them outside production (local dev / CI). Large circuits that exceed the serverless time limit should verify on an external worker, not skip the check.
- The finalize script verifies the full contribution chain (genesis → latest, with the pinned genesis hash checked first) before applying the beacon, then verifies the finalized zkey
- SHA-256 hash chain from genesis to latest
- SHA-256 integrity check on every zkey download (genesis hash seeded at init)
- Ethereum RANDAO beacon for finalization randomness

## Linear Project

- Team: **Internal / Public Goods** (key: BES)
- Project: **Caburé** (target: Mar 27, 2026)
- 6 milestones: Idea Draft, Tech Design, @wonderland/cabure-crypto Development, @wonderland/create-cabure-ceremony Development, CLI Contributor Development, QA

## Brebaje Alignment

Nico Serrano's Brebaje (github.com/p0tion-tools/brebaje) is a complementary p0tion rebuild. Caburé focuses on wizard + CLI contributor; future merge is possible but not decided.

## Commits
- Always use commitlint convention.
- NEVER add coauthors.
