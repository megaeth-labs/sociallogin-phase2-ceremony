# @wonderland/cabure-crypto

Typed Groth16 Phase 2 ceremony primitives for [Caburé](https://github.com/defi-wonderland/cabure-wizard). Wraps [snarkjs](https://github.com/iden3/snarkjs) with `Uint8Array` in / `Uint8Array` out APIs and a browser-friendly Web Worker entry point.

This package is consumed by the Caburé wizard, the generated ceremony app, and `@wonderland/cabure-cli`. It is published to npm and can be used directly by any Groth16 Phase 2 tool.

## Install

```bash
npm install @wonderland/cabure-crypto
```

## API

The functions below accept the input types shown in the table and return either `Uint8Array`, `boolean`, or a verification-key object. snarkjs's file-based I/O is handled internally via temp directories (Node) or memFS (browser worker).

```ts
import {
  generateInitialZkey,
  contribute,
  verify,
  verifyChain,
  verifyChainForCircuit,
  generateEntropy,
  applyBeacon,
  exportVerificationKey,
} from "@wonderland/cabure-crypto";
```

| Function | Purpose |
| --- | --- |
| `generateInitialZkey(ptau, r1cs)` | Generate the genesis zkey from Powers of Tau + R1CS |
| `contribute(prevZkey, entropy, name?)` | Apply a contribution; returns `{ zkey, contributionHash, zkeyHash }` |
| `verify(r1cs, ptau, zkey)` | Verify a zkey extends a chain rooted in (r1cs, ptau) |
| `verifyChain(ptau, initialZkey, latestZkey)` | Verify the chain embedded in `latestZkey` reaches `initialZkey` (taken as trusted) |
| `verifyChainForCircuit(r1cs, ptau, initialZkey, latestZkey)` | Same as `verifyChain` but first checks `initialZkey` is a valid genesis for `(r1cs, ptau)` |
| `generateEntropy(sources?)` | Combine WebCrypto CSPRNG with optional additional sources |
| `applyBeacon(zkey, beaconHash, numIterationsExp?)` | Apply a public randomness beacon to finalize; returns `{ zkey, contributionHash, zkeyHash }` |
| `exportVerificationKey(zkey)` | Extract the Groth16 verification key |

### Browser worker

The package ships a self-contained Web Worker bundle for browser callers:

```ts
import {
  RequestType,
  ResponseType,
  type WorkerRequest,
  type WorkerResponse,
} from "@wonderland/cabure-crypto/protocol";

const worker = new Worker(
  new URL("@wonderland/cabure-crypto/worker", import.meta.url),
  { type: "module" },
);
```

Use the typed `WorkerRequest` / `WorkerResponse` discriminated unions when posting messages. The worker implements `contribute()` and a CSPRNG `generateEntropy` request.

## Entropy encoding across Node and browser

`contribute()` is non-deterministic by design. snarkjs combines the user-supplied entropy with 64 fresh bytes from `getRandomBytes()` via Blake2b before deriving the trapdoor, so two runs with identical user entropy on the same machine produce different contribution hashes. This is the property the `produces different zkeys on repeat calls with identical entropy` test guards against regressions.

What the Node API and the browser worker DO share is the encoding of user entropy before it reaches snarkjs. Both paths use the prefix-free lowercase hex encoder `bytesToHexRaw` from `hex.ts`; the `0x`-prefixed `toHex` is reserved for hash outputs and display. snarkjs reads the entropy string via `TextEncoder`, so a divergence between Node and browser in the literal characters would change snarkjs's RNG mixing input on one path only. Keeping a single encoder is a regression guard for encoder parity, not a determinism claim about the output contribution.

## Toxic waste and zeroization

A Phase 2 contribution involves a fresh trapdoor τ derived from your entropy. If τ leaks, an attacker can forge proofs for the resulting circuit; correctly destroying it is essential.

This library makes a **best-effort** attempt to zero the input entropy buffer after each contribution. **It is not a guarantee.** Be honest with yourself about the limits:

- snarkjs (as of 0.7.x) accepts entropy only as a string. `contribute()` therefore converts the input `Uint8Array` to a hex string before handing it off. JavaScript strings are immutable and live in V8's heap until the garbage collector runs (and even then, freed string buffers are not reliably wiped). The library cannot zero those copies.
- snarkjs internally re-encodes the entropy string via `TextEncoder` into its own `Uint8Array`, then mixes it via Blake2b with 64 bytes from `getRandomBytes`. Those internal buffers are not zeroed by snarkjs either.
- The `entropy.fill(0)` call in `contribute()` zeros only the caller's original buffer. It is a defense-in-depth measure, not a complete erasure.

What this means in practice:

1. The buffer you pass in is still useful to zero — it prevents accidental persistence in long-running callers (e.g. CLI processes that don't exit immediately).
2. The most reliable defense is **process isolation**: run `contribute()` in a short-lived Node process or a Web Worker, and exit / terminate it as soon as the result is consumed. The OS will reclaim the memory pages and reuse them for unrelated workloads.
3. snarkjs mixes its own `getRandomBytes(64)` into the trapdoor before you ever see it, so leaking only the user-supplied entropy does not by itself reconstruct τ — but do not rely on this as a primary defense.

If your threat model includes a memory-scraping attacker on the same host while the contributor is online, do not contribute from that host.

### Recommended caller patterns

**CLI / Node:**

```ts
// In a child process or a one-shot script:
const result = await contribute(prevZkey, entropy, name);
// Persist result, then exit immediately.
process.exit(0);
```

**Browser:**

```ts
// In the main thread:
const worker = new Worker(/* ... */);
worker.postMessage(/* ... */, [entropy.buffer, prevZkey.buffer]);
// On receiving the result:
worker.terminate();
```

Transferring the buffers (rather than copying) means the main thread no longer holds the entropy after `postMessage`. Terminating the worker after the result kills the only context that still holds the snarkjs internals.

## Dependencies and standalone installs

This fork pins `snarkjs@0.7.6`. snarkjs pulls in `bfj -> jsonpath -> underscore`, and `underscore` versions `<= 1.13.7` carry the [GHSA-qpx9-hpmf-5gmw](https://github.com/jashkenas/underscore/security/advisories/GHSA-qpx9-hpmf-5gmw) advisory. The root workspace overrides the affected transitive dependency so it does not appear in this repository's install graph.

This package intentionally does NOT ship an `overrides` field of its own: per the [npm docs](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides), overrides are only respected in the **consuming project's** root `package.json` and are ignored when defined inside an installed dependency. The Caburé monorepo and the project template emitted by `@wonderland/create-cabure-ceremony` pin `underscore` to `1.13.8` in their own root overrides. If you install this package standalone, add the same override in your `package.json`:

```jsonc
// npm v8.3+
{
  "overrides": {
    "underscore@<=1.13.7": "1.13.8"
  }
}

// pnpm
{
  "pnpm": {
    "overrides": {
      "underscore@<=1.13.7": "1.13.8"
    }
  }
}

// yarn
{
  "resolutions": {
    "underscore": "1.13.8"
  }
}
```

Verify the install graph is clean:

```bash
pnpm --filter @wonderland/cabure-crypto audit  # or `npm audit --omit=dev`
```

## License

MIT
