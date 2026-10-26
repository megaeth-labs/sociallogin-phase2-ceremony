Load the Caburé project context for the current development session.

1. Read `CLAUDE.md` at the project root to load all architecture decisions, naming conventions, and project knowledge.

2. Present a brief orientation:

**You're working on Caburé** — a Groth16 Phase 2 trusted setup ceremony toolkit.

Three packages:
- `@wonderland/cabure-crypto` — ceremony primitives (Lumi)
- `@wonderland/create-cabure-ceremony` — CLI wizard (Ardy)
- `@wonderland/cabure-cli` — headless contributor tool (Ardy)

Key conventions:
- Separated architecture (coordinator / frontend / crypto)
- IPFS-first storage
- snarkjs 0.7.5 in-memory I/O pattern
- Interactive tier assignment
- User interaction required for entropy
- GitHub OAuth device flow for CLI

3. If $ARGUMENTS mentions a specific package or area (e.g. "crypto", "coordinator", "frontend", "cli"), focus the context on that area and list relevant details from CLAUDE.md.

4. Ask what the developer wants to work on today.
