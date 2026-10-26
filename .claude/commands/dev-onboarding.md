Walk the developer through the Caburé project onboarding. This is designed for Ardy (TypeScript dev) but works for any new developer joining the project.

Read `CLAUDE.md` at the project root first, then guide the developer through these steps:

## 1. Project Overview

Explain Caburé in 3 sentences: what it is (Groth16 Phase 2 trusted setup toolkit), what it replaces (p0tion + DefinitelySetup), and the three packages (`@wonderland/cabure-crypto`, `@wonderland/create-cabure-ceremony`, `@wonderland/cabure-cli`).

## 2. Architecture Walkthrough

Walk through the separated architecture:
- **coordinator/** — stateless serverless function, IPFS state, queue management, GitHub OAuth
- **frontend/** — static site, 6-screen ceremony flow, entropy collection, Web Worker computation
- **crypto/** — imports from `@wonderland/cabure-crypto` (published package maintained by Lumi)

Emphasize: the coordinator is NOT Next.js API routes. The frontend is NOT server-rendered. They deploy independently.

## 3. Key Conventions

Walk through naming, patterns, and decisions the dev MUST follow:
- Package names: `@wonderland/cabure-crypto`, `@wonderland/create-cabure-ceremony`, `@wonderland/cabure-cli` — never use `elixir-wizard`
- snarkjs 0.7.5 in-memory I/O: `Uint8Array` in, `{ type: "mem" }` output ref
- IPFS-first storage (S3 is the alternative, not the default)
- Interactive tier assignment (wizard asks Y/n, not automatic)
- Entropy requires user interaction (mouse/clicks mandatory, CSPRNG alone is not enough)
- GitHub OAuth device flow for CLI contributor
- Chain hash: SHA-256 with format `"${previousChainHash}:${contributionHash}:${participantId}:${timestamp}"`

## 4. Your Assignments

Check Linear for the developer's assigned issues. Use the Linear MCP to list issues in the Caburé project filtered by assignee. Present them grouped by milestone:
- **@wonderland/create-cabure-ceremony Development** (BES-1347 through BES-1354)
- **CLI Contributor Development** (BES-1355)

For each issue, show the identifier, title, priority, and current status. Highlight which ones are urgent or high priority.

## 5. Getting Started

Suggest a practical first step based on the developer's assignments:
- If starting @wonderland/create-cabure-ceremony: begin with BES-1347 (coordinator state schema + IPFS) since everything else depends on it
- If starting CLI contributor: begin with BES-1355 after @wonderland/create-cabure-ceremony is further along
- Remind them about BES-1346 (handoff walkthrough with Lumi) — they should understand `@wonderland/cabure-crypto` exports before building

## 6. Questions

Ask the developer:
1. Have you done the handoff walkthrough with Lumi on `@wonderland/cabure-crypto`?
2. Which milestone are you starting with?
3. Any blockers or questions about the architecture?

If $ARGUMENTS contains a specific topic (e.g. "coordinator", "frontend", "cli"), focus the onboarding on that area.
