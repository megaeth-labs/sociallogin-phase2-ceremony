# Local verifier artifact mount

Place only local, untracked development artifacts in this directory when
exercising the coordinator/verifier stack. Compose mounts it read-only at
`/artifacts`. The coordinator checks and seeds the genesis zkey into its
development artifact volume; the verifier independently checks the mounted
genesis and PTAU against the signed local manifest.

Expected production-style names are configured through compose variables:

- `genesis.zkey`
- `circuit.r1cs`
- `powersoftau.ptau`

Do not substitute the MOSS development-testnet final zkey for the ceremony's
zero-contribution genesis zkey. No circuit, witness, proving, or setup artifact
belongs in Git.
