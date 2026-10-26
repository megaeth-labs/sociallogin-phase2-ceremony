# Proof-test fixture circuit

`circuit.circom`, `circuit.r1cs`, `circuit_js/circuit.wasm` (here `circuit.wasm`)
and `input.json` are copied unchanged from the `test/circuit` fixture of
`circom_runtime@0.1.28` (Apache-2.0, iden3), which snarkjs 0.7.6 depends on.
The circuit has 1,000 constraints and 4 public signals (`d`, `a`, `b`, `c`), so
the proof-test tests run end to end in seconds with a locally generated
power-10 PTAU. It stands in for the ceremony relation only in tests.

| File | SHA-256 |
| --- | --- |
| `circuit.circom` | `be5f8d837128158127d9837b753701af270edee39b765a7e532e04cab975e070` |
| `circuit.r1cs` | `33807cbd74e3d84b3ae85bab09cc9bb0a57ec18f5665ee50655defc75bb277b9` |
| `circuit.wasm` | `9b4272d53697a122081e5218bdc50ec394d0bb42cd07278513d5f08898283063` |
| `input.json` | `abdf33c9dbe51a38c58551d6b7e3c7421f4f6e0663acf0eba8ed053bd502246b` |
