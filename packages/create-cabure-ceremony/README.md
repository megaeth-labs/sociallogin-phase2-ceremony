# @wonderland/create-cabure-ceremony

> **Upstream reference only.** This inherited generic scaffolder is retained to
> keep the Cabure fork reviewable, but it is not an authority component of the
> MOSS ceremony and must not be used to deploy it. Its generated Vercel
> Blob/KV flow does not implement this repository's signed PostgreSQL
> coordinator, exact append verification, verifier unanimity, immutable
> storage boundary, receipt recovery, or drand finalizer. Use the root
> `README.md` and `RUNBOOK.md` for the MOSS system.

CLI wizard that scaffolds a deploy-ready Groth16 Phase 2 trusted setup ceremony app in one command.

## What it generates

- A single Next.js app (frontend + API routes)
- `ceremony.config.ts` with ceremony settings (name, circuits, tiers, dates, UI copy)
- `circuits/` directory — populated automatically with `.r1cs` files when you provide a circuit path in prompt #4, otherwise empty for manual setup
- API route stubs under `app/api/ceremony/*`
- Operator scripts: `setup:ptau`, `init:ceremony`, `finalize:ceremony`, `reset:ceremony`
- Minimal `vercel.json` and `.env.example`

### Wizard prompts

1. Project name
2. Target contributions (`100`, `500`, `1000`, or custom)
3. End date (optional `YYYY-MM-DD`)
4. Circuit artifacts path (optional)
   - If provided, `.r1cs` files are discovered and copied into `circuits/`
   - If skipped, `circuits/` remains empty

## Usage

```bash
npx @wonderland/create-cabure-ceremony
```

After generation:

```bash
cd <generated-project-slug>
npm install

# If you skipped prompt #4, copy your .r1cs files into ./circuits first
npm run setup:ptau          # downloads the correct PPoT .ptau and updates config

# Configure .env (see generated README for full details)
npm run init:ceremony       # generate genesis zkey and upload to storage
npm run dev
```

### Key scripts in generated project

| Script                      | Description                                                            |
| --------------------------- | ---------------------------------------------------------------------- |
| `npm run setup:ptau`        | Detect circuit constraints, download the correct PPoT ptau, and update config |
| `npm run init:ceremony`     | Generate genesis zkey, upload to Blob, write manifest to KV. Saves local copies and transcript to `public/genesis/` |
| `npm run finalize:ceremony` | Apply beacon (Ethereum RANDAO by default), verify zkeys. Saves final zkeys, vkeys, and transcript to `public/finalize/` |
| `npm run reset:ceremony`    | Wipe all KV keys and Blob zkeys for a fresh start |

Initialization generates `public/genesis/init-transcript.json` and `public/genesis/{circuitId}.genesis.zkey` for each circuit.

Finalization uses the RANDAO reveal from the latest finalized Ethereum beacon chain slot by default for public verifiability. Outputs are saved to `public/finalize/` (transcript, verification keys, finalized zkeys). See the generated project README for advanced beacon options.

## Local development (inside this monorepo)

From repository root:

```bash
pnpm --filter @wonderland/create-cabure-ceremony build
pnpm --filter @wonderland/create-cabure-ceremony test
```
