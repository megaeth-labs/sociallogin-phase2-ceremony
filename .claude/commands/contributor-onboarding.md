Walk a new contributor through the Caburé project onboarding. This is for anyone joining the project who needs to understand the full picture — crypto, dev, QA, or general contributor.

Read `CLAUDE.md` at the project root first, then guide them through these steps:

## 1. What is Caburé?

Explain in plain terms:
- Groth16 is a type of zero-knowledge proof. Before a Groth16 circuit can be used in production, it needs a "trusted setup ceremony" where many people contribute randomness. The more contributors, the stronger the security guarantee — as long as ONE participant was honest, the ceremony is secure.
- Caburé is the toolkit that makes running these ceremonies easy. An operator runs one command (`npx @wonderland/create-cabure-ceremony`) and gets a fully deployable ceremony project. Contributors visit a website or use a CLI tool to participate.
- It replaces p0tion + DefinitelySetup, which are in maintenance mode and had significant UX and infrastructure issues.

## 2. The Three Packages

Walk through each package and who owns it:

**`@wonderland/cabure-crypto`** (Lumi)
- The cryptographic engine. Typed exports for every ceremony operation: generate initial zkey, contribute, verify, verify chain, generate entropy, apply beacon.
- Uses snarkjs 0.7.5 under the hood with in-memory I/O (`Uint8Array` in, `{ type: "mem" }` out).
- Includes a WASM build for browser Web Workers.
- This is a published npm package — shared by the wizard, frontend, and CLI.

**`@wonderland/create-cabure-ceremony`** (Ardy)
- The CLI wizard. Asks 7 questions, scaffolds a complete ceremony project.
- Generated project has three independent parts: stateless coordinator (serverless), static frontend (6-screen ceremony flow), and crypto layer (imports from `@wonderland/cabure-crypto`).
- The generated code is yours — edit freely. Only the crypto layer is a dependency.

**`@wonderland/cabure-cli`** (Ardy)
- Headless CLI contributor tool for VMs and servers.
- URL-based discovery: `npx @wonderland/cabure-cli contribute https://ceremony.example.com`
- GitHub OAuth device flow for auth without a browser redirect.
- Streaming support for large circuits (>100 MB zkeys).

## 3. Architecture at a Glance

Present the separated architecture:

```
my-ceremony/
├── coordinator/     ← Stateless serverless function (Cloudflare Worker / Vercel Edge / Docker)
├── frontend/        ← Static site (IPFS / Vercel / GitHub Pages)
├── crypto/          ← Imports from @wonderland/cabure-crypto
├── ceremony.config.json
├── circuits/
├── deploy/
└── README.md
```

Key points:
- Coordinator and frontend deploy **separately**
- Storage is **IPFS-first** (ceremony state + zkeys content-addressed), S3 as alternative
- Coordinator is **stateless** — reads/writes a JSON state file on IPFS
- Entropy requires **user interaction** (mouse/clicks mandatory, CSPRNG alone is not enough)
- Tier assignment is **interactive** (operator chooses during scaffolding)

## 4. How a Ceremony Works

Walk through the lifecycle:
1. Operator runs `npx @wonderland/create-cabure-ceremony`, answers prompts, deploys
2. Contributors visit the frontend → GitHub OAuth → join queue → collect entropy → compute contribution in Web Worker → upload
3. Or contributors use `npx @wonderland/cabure-cli contribute <url>` from the terminal
4. Coordinator verifies each contribution, updates IPFS state, maintains SHA-256 chain hash
5. When target contributions reached, operator applies drand Quicknet beacon to finalize
6. Final zkey is ready for production use

## 5. Useful Commands

Point them to the other Claude Code commands available:
- `/cabure-status` — check Linear milestones and issues
- `/cabure-context` — quick orientation for a dev session
- `/dev-onboarding` — deep dive for TypeScript developers (architecture, conventions, assignments)
- `/qa-onboarding` — deep dive for QA engineers (test plan, environment setup, priorities)

## 7. Key Resources

- **Notion Idea Draft** — central planning document with scope, tasks, and team assignments
- **Notion Tech Design** — detailed technical specification for @wonderland/create-cabure-ceremony and @wonderland/cabure-cli
- **Linear project** — issue tracking across 6 milestones
- **Brebaje** (github.com/p0tion-tools/brebaje) — Nico Serrano's complementary p0tion rebuild, potential future merge

## 8. Questions

Ask:
1. What's your role on the project? (This helps tailor follow-up — point devs to `/dev-onboarding`, QA to `/qa-onboarding`)
2. Are you familiar with Groth16 / trusted setup ceremonies, or would you like a deeper explanation?
3. What would you like to start with?

If $ARGUMENTS contains a role (e.g. "dev", "qa", "crypto"), suggest they also run the specialized onboarding command for that role
