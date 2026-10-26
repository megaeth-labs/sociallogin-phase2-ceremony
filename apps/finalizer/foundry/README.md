# Exported verifier harness

Foundry tests for the exact `Verifier.sol` the finalizer exports. They run on
Foundry's local EVM only; nothing is deployed. solc is pinned to 0.8.28 and
`forge test` runs offline, so the compiler must already be installed
(`forge build` once with network, or `svm install 0.8.28`).

Do not run this directory directly. The proof test copies it to a temporary
directory, adds the verifier as `src/Verifier.sol` and its calldata fixture as
`fixture/fixture.json`, then runs `forge test --offline --json`:

```sh
node apps/finalizer/dist/proof-test/cli.js ... --solidity-verifier finalized/Verifier.sol
```

The four tests check that the fresh proof is accepted, and that changing any
one public input, negating the proof's A point, or passing an out-of-field
input is rejected. The public-input count comes from the fixture.
