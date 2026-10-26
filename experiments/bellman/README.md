# Bellman interoperability prototype

Isolated research only: these files are not imported by the coordinator, web
client, verifier worker, or production build. Local outputs live in ignored
`runs/`; never publish them as ceremony contributions.

See [RESULTS.md](RESULTS.md) for measured outcomes and remaining launch gates.

The native dependency is the exact `phase2-bn254` revision pinned by
[Sui's client](https://github.com/sui-foundation/zk-ceremony-client/blob/main/Cargo.toml):
`f10c8a41ae019fb68c66fae0276159900b3a128c`. Cargo.lock pins the resolved
transitive dependencies for this experiment, not Sui's historical build.
The JS side uses our existing snarkjs 0.7.6 and ffjavascript 0.3.1.

## Reproduce the synthetic chain

From the repository root, with Node/pnpm installed and the existing ignored
multiplier R1CS/PTAU test fixtures available:

```sh
pnpm install --frozen-lockfile
pnpm --filter @moss/phase2-zkey-inspect build
cargo build --release --locked --manifest-path experiments/bellman/Cargo.toml
node --test experiments/bellman/encoding.test.mjs
node experiments/bellman/build-browser.mjs
node --test experiments/bellman/browser-server.test.mjs
node experiments/bellman/interop.mjs
```

The harness exports a synthetic genesis, makes Rust → snarkjs Bellman → Rust
contributions, imports and verifies each exact append, resumes ordinary zkey
contribution, exports back to Bellman, and verifies that transition with Rust.
It finally verifies against the R1CS/PTAU. Negative controls reject unchanged
input, skipped predecessors, reversed transitions, wrong contribution names,
and truncated transport files. Per-operation JS timing and process maxRSS are
written to an ignored report; native timings include process startup.

Use `node experiments/bellman/interop.mjs --production` for the same sequence
against `artifacts/moonsong-local/`. It checks all three SHA-256 and length pins
from the draft definition before processing existing inputs. It never regenerates
genesis or touches a live head. Outputs go to a fresh ignored run directory.

## Browser worker prototype

Prerequisites: Rust 1.85.1 with the `wasm32-unknown-unknown` target, and
wasm-bindgen CLI 0.2.100. These tools are isolated from the production app.

```sh
node experiments/bellman/wasm/prepare.mjs
cargo +1.85.1 build --release --locked --target wasm32-unknown-unknown \
  --manifest-path experiments/bellman/wasm/Cargo.toml
wasm-bindgen --target web --out-dir experiments/bellman/wasm/pkg \
  experiments/bellman/wasm/target/wasm32-unknown-unknown/release/moss_bellman_wasm_prototype.wasm
node experiments/bellman/browser-server.mjs experiments/bellman/runs/interop-REPLACE
```

Use the run directory printed by the native harness. Add `--production` to the
browser-server command for production-sized inputs. Open the printed loopback
URL once. Each server accepts one output and refuses to overwrite files; use a
fresh experiment directory for another test. Stop the server with Ctrl-C.

The worker obtains 64 bytes from WebCrypto and contributes locally. It writes
the result to OPFS in bounded chunks; the page terminates the compute worker
before uploading the OPFS File. Upload returns HTTP 202 and the page polls
verification status rather than holding a long upload request open. The isolated
test server verifies the Rust transition, imports to zkey, checks exactly one
append, and verifies from genesis/PTAU before the page reports success. It exposes
only fixed test routes, not the repository or local ceremony state.

The dependency's WASM feature initially failed to build: default multicore
conflicts with WASM, and a chunk-size helper unconditionally references optional
`num_cpus`. `wasm/prepare.mjs` fetches the pinned revision and applies two explicit
build fixes; no arithmetic changes. A separate Cargo.lock pins WASM dependencies.

Computation still uses whole-file buffers; OPFS bounds the output/upload stage.
`wasmMemoryBytes` is allocated WASM linear memory after computation, not total
browser RSS; JS buffers/overhead are extra.
Loopback transfers do not establish public-network slot time.

Small-fixture browser result: Chrome 153 on macOS, 2,140-byte input, 2,524-byte
output, 9 ms compute, 1,179,648 bytes WASM memory. Rust transition, exact append,
and snarkjs verification all passed. This only establishes functional browser
interop, not production-sized performance.

For isolated automation on macOS, install `playwright-core@1.56.1` in a separate
temporary tools directory and run:

```sh
node experiments/bellman/isolated-browser.mjs http://127.0.0.1:REPLACE_PORT \
  /absolute/path/to/playwright-core/index.mjs
```

This launches its own installed Google Chrome, waits up to 30 minutes, checks
the verified result, and closes that browser. The server saves browser-reported
timing/memory separately from verification results. An isolated small-fixture
rerun passed at 8 ms with the same memory/size measurements. The native harness
also checkpoints completed measurements to `progress.json` for interrupted runs.

## Findings (2026-09-23)

- The unmodified Rust client rejected the first snarkjs 0.7.6 export.
- wasmcurves' uncompressed encoder emits infinity as all zeroes; the pinned
  Rust pairing decoder expects `0x40` followed by zeroes. `encoding.mjs`
  translates only infinity point encodings, with bounded buffers and strict
  file framing. It does not validate points or contributions.
- With this normalization, all four mixed-chain transitions and seven negative
  controls passed. This includes our existing exact-append inspection and
  snarkjs verification against the genesis/PTAU, plus final R1CS verification.
- The wrapper obtains randomness through the library's native OsRng path,
  without secrets in command arguments or environment variables. Library output
  is suppressed by the harness. The wrapper exits nonzero on verification error;
  upstream's example binaries only print the error and return success.
- This is meaningful arithmetic implementation diversity, although initialization,
  format conversion, and final zkey verification still use snarkjs.
- Stock Rust WASM bindings take whole input/output `Vec<u8>` buffers. Their
  existence alone does not establish browser memory viability.
- A full-size whole-buffer worker computed and uploaded a valid contribution,
  but an isolated repeat recorded a renderer crash after computation (373,989 ms,
  1,925,513,216 bytes WASM memory). This motivated the OPFS handoff and worker
  termination before upload. The crash is an observation, not a proven allocation
  failure diagnosis. OPFS does not reduce peak memory during computation.
- The first full-size OPFS run passed every server check without a renderer
  crash, but the page still reported failure afterward. Upload/verification are
  now separated with status polling, and OPFS cleanup failures are reported
  separately from cryptographic success. HTTP tests cover verified/failed states,
  origin rejection, and duplicate uploads.
- The full-size OPFS/status-polling rerun passed end to end in Chrome: 365,696 ms
  compute, 1,925,513,216 bytes WASM memory, all server checks and cleanup passed.
  This single Mac result does not replace the supported-browser/hardware matrix.

Do not change production acceptance or advertise browser support based on this
experiment. Next gates: production-sized measurements, WASM/worker benchmark,
encoding review including malformed points/subgroups, conversion/hash binding,
and browser interruption/quota/recovery tests. The ordinary ceremony artifacts,
manifest, live queue and frontend feature flags are untouched.

## Integration implications

The experiment imports after every contribution to exercise the existing zkey
checks. This is deliberately stronger interoperability coverage than merely
importing a final file; it is not a throughput-optimized ceremony design.
Export/import includes a change of H-query representation with significant
computation. A Bellman-native ceremony could export once and import at the end,
as Sui documented, but would need a reviewed acceptance path over canonical
Bellman bytes and independent verification. Do not silently drop existing
zkey checks just to improve a benchmark.

The transport adapter produces different file hashes for equivalent point
encodings. Pin one canonical encoding and bind transport/conversion outputs in
signed evidence. Bellman contribution records also omit zkey names and beacon
metadata; preserve that information separately in the transcript. Successful
import alone is not evidence of a valid transition: the Rust predecessor check
and the zkey acceptance checks remain separate gates in this prototype.

Smaller transfers do not automatically reduce archive bills. Retaining both
every Bellman file and every reconstructed zkey increases storage; changing the
canonical archive format/reconstruction policy is a separate decision.

## snarkjs Bellman browser comparison

Build the isolated comparison bundle and select it explicitly:

```sh
node experiments/bellman/build-browser.mjs
node --test experiments/bellman/encoding.test.mjs experiments/bellman/browser-server.test.mjs
node experiments/bellman/browser-server.mjs experiments/bellman/runs/interop-REPLACE --snarkjs
```

Use a fresh run directory and add `--production` for the production-sized
inputs, as above. The same Rust transition, exact-append, and snarkjs verification
gates apply. Only the contribution worker changes. The bundle uses pinned
snarkjs 0.7.6 Bellman arithmetic, ffjavascript's browser implementation, and our
existing OPFS fastfile adapter. Download, input, and output are disk-backed;
point arithmetic uses upstream batches. No production worker is replaced.

`isolated-browser.mjs` also accepts an optional fourth argument: the path for a
new JSON report (it refuses overwrite). It samples the isolated Chrome process
tree's RSS every 500 ms, including child workers and browser overhead, excluding
the test server. Summed RSS can double-count shared pages and miss shorter peaks;
it is not a precise live-allocation or required-physical-RAM measurement.
`wasmMemoryBytes` for snarkjs covers only its controlling instance, **not** its
worker heaps. The snarkjs timer includes curve initialization; the earlier Rust
timer excludes WASM initialization. Both exclude download/upload and server
verification. See [MEMORY_INVESTIGATION.md](MEMORY_INVESTIGATION.md) for the
allocation analysis and remaining Rust optimization options.

## No-contribution round trip

Run `node experiments/bellman/roundtrip.mjs` for the synthetic fixture, or append
`--production` for a fresh export/import of the pinned Moonsong genesis. This
separates whole-file identity, per-section identity, verification-key equality,
and full R1CS/PTAU validity. See [ROUNDTRIP.md](ROUNDTRIP.md) for findings and the
reason that a valid conversion need not reproduce the original file bytes.

## Local CLI end to end

`node experiments/bellman/local-cli-e2e.mjs --work NEW_DIR` runs Bellman CLI
contributions against the real coordinator, PostgreSQL and verifier worker
without Docker. It creates a throwaway PostgreSQL 16 cluster (TCP only, random
localhost port), applies `packages/db/migrations`, creates the scoped
coordinator role with `infra/postgres/init-roles.sh`, signs a development
`bellman-transition-v1` manifest over the multiplier test circuit, and runs one
CLI contribution per participant (`--contributions N`, default 2). It then
verifies each saved receipt offline and replays every transition from the
coordinator's stored artifacts with the native verifier. Build the workspace
and the native verifier first; `--pg-bin` points at the PostgreSQL binaries.
Every key and token is generated per run and the work directory is removed on
success unless `--keep` is given.

The local artifact backend never publishes evidence bundles, so the ceremony
audit cannot run against this stack; that needs the S3 archive.
