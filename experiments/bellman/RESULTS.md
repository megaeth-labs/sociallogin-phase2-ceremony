# Bellman prototype results

Run date: 2026-09-23 (local time). Apple M4 Pro, 24 GiB RAM, macOS 27.0,
Chrome 153.0.8010.53. Native Rust 1.96.1; WASM Rust 1.85.1 and wasm-bindgen
0.2.100; snarkjs 0.7.6. The Rust dependency is pinned to Sui's revision
`f10c8a41ae019fb68c66fae0276159900b3a128c`, with the two documented build-only
fixes for WASM. These are experimental measurements, not launch acceptance.

A separate no-contribution export/import test is documented in
[ROUNDTRIP.md](ROUNDTRIP.md). Cryptographic validity must not be confused with
byte-for-byte identity of the reconstructed zkey.

## Confirmed findings

- The pinned 567,402,188-byte Moonsong genesis exports to a 368,440,348-byte
  Bellman file: **35.07% fewer bytes**. One contribution adds 384 Bellman bytes.
- Rust and snarkjs contributions interoperate after normalizing their differing
  infinity encodings. The synthetic four-contribution chain passes both engines'
  checks and final R1CS/PTAU verification. Seven negative controls reject
  unchanged/skipped/reversed transitions, wrong names, and truncated files.
- A Rust WASM worker computes a contribution on the full production circuit.
  The first browser output passed Rust transition verification, our exact-append
  check after import, and snarkjs verification against the pinned genesis/PTAU.
- The initial whole-buffer upload flow is unsuitable: an isolated repeat
  reported a renderer crash after computation. The proposed mitigation writes
  output to OPFS and terminates the compute worker before uploading the File.

## Browser measurements

| Run | Input | Compute time | Allocated WASM memory after compute | Outcome |
| --- | ---: | ---: | ---: | --- |
| Synthetic isolated Chrome | 2,140 bytes | 8 ms | 1,179,648 bytes | All verification gates passed |
| Synthetic OPFS handoff | 2,140 bytes | 10 ms | 1,179,648 bytes | All verification gates passed |
| Full-size whole-buffer upload | 368,440,348 bytes | 373,989 ms (6m 14s) | 1,925,513,216 bytes (1.79 GiB) | All server checks passed; renderer crashed; not an end-to-end browser pass |
| Full-size OPFS handoff, long upload response | 368,440,348 bytes | 366,583 ms (6m 7s) | 1,925,513,216 bytes (1.79 GiB) | No renderer crash; all server checks passed; UI reported failure despite eventual verification |
| Full-size OPFS handoff + status polling | 368,440,348 bytes | 365,696 ms (6m 6s) | 1,925,513,216 bytes (1.79 GiB) | **End-to-end browser pass**, all three server verification gates and OPFS cleanup passed |

The WASM number is linear-memory allocation, **not total browser RSS**. JS
input/output buffers and browser internals add memory beyond that number.
OPFS currently reduces memory retained during upload/verification, not peak
memory during computation. The crash's precise cause has not been established;
the mitigation targets the large retained heap and request-buffer copies.
The OPFS handoff exposed another lifecycle issue: the test initially held its
upload response open during conversion/verification and coupled cleanup errors
to the final success indicator. The revised server acknowledges upload with
HTTP 202, exposes a separate verification status, and reports cleanup separately.
The full-size rerun of that revised flow passed, including the page's final
success indicator and OPFS cleanup. This is one successful run on one hardware
class, not evidence of support across desktop machines.

Runs used loopback downloads/uploads. Conversion jobs and other tests shared
the machine, so these timings are not controlled performance comparisons or
internet slot-time measurements. Only one browser/hardware class was exercised.

## snarkjs Bellman browser comparison

The follow-up uses the same full circuit, normalized Bellman input, loopback
server, and verification gates. It bundles pinned snarkjs 0.7.6 Bellman arithmetic
with the existing OPFS adapter. Input download and output stay on disk throughout
computation. The production application still uses its existing engine.

| Measurement | Full-circuit snarkjs OPFS browser run |
| --- | ---: |
| Computation, including curve initialization | **45,056 ms (45.1 seconds)** |
| Input / output bytes | 368,440,348 / 368,440,732 |
| ffjavascript worker concurrency | 14 |
| Main WASM instance allocation after computation | 1,638,400 bytes; excludes worker heaps |
| Sampled peak summed Chrome process-tree RSS | **2,354,160 KiB (2.25 GiB)** |
| RSS sampling | 836 samples, nominally every 500 ms |
| Browser outcome | **End-to-end pass**, OPFS cleanup succeeded |
| Server outcome | Rust transition, exact append, snarkjs from genesis/PTAU all passed |

A synthetic run also passed: 65 ms computation, same main WASM allocation and
14 workers. Raw full-size measurements are ignored under
`runs/snarkjs-browser-jWrs98/browser-report.json`; server results are in that
directory's `browser-verification.json`. The synthetic run is under
`runs/interop-GtCDse/`, which also passed the complete mixed chain and seven
negative controls.

The earlier Rust run took 365,696 ms, but this is not an isolated arithmetic
comparison: Rust is single-threaded, checked-decodes every query point, and has
a different I/O model. snarkjs copies unchanged sections without decoding them.
Both candidate outputs undergo the same server gates. The snarkjs timer includes
curve initialization; the Rust timer excludes WASM initialization. Neither is
public-network or complete-slot time. Other processes were active on the Mac;
repository checks ran during subsequent server verification, after browser compute.

The memory numbers are **not directly comparable**. Earlier Rust measurements
covered its WASM linear memory only; this new process sampler covers the isolated
Chrome browser and descendants, including JS, workers and browser overhead.
Summing RSS can count shared pages repeatedly and miss short peaks; it excludes
the separate conversion/verifier processes. There is no matching historical Rust
process-tree RSS sample, so this experiment does not establish a percentage
reduction in total browser RAM. The small main snarkjs heap is not total memory.

This makes snarkjs Bellman with OPFS the stronger **candidate default browser
engine**, chiefly on observed computation time and its bounded file I/O. It does
not yet establish a low-memory public client. Rust remains valuable as an
independent implementation; its browser memory improvements are separately
investigated in [MEMORY_INVESTIGATION.md](MEMORY_INVESTIGATION.md).

## Native and conversion benchmark

The full-size harness checks all three artifact hashes and sizes before using
the existing genesis. It exercises Rust → snarkjs Bellman → Rust → ordinary
snarkjs, imports and validates each Bellman transition, and verifies the final
zkey against R1CS/PTAU. **The complete production-sized run passed**, including
all seven negative controls. Only four contributions were exercised; long-history
verification costs are not measured.

| Operation | Observed elapsed time |
| --- | ---: |
| Native Rust contribution (two runs) | 19.9–40.2 seconds |
| Native Rust transition verification (four valid transitions) | 24.8–49.3 seconds |
| Native Node snarkjs Bellman contribution | 55.4 seconds |
| Native Node ordinary zkey contribution | 80.8 seconds |
| snarkjs verify from genesis/PTAU | 20.2–35.3 seconds |
| Final snarkjs verify from R1CS/PTAU | 202.0 seconds |
| Export zkey to Bellman | 296.4–371.8 seconds |
| Import Bellman to zkey | 346.7–711.3 seconds |

These are individual samples under differing concurrent load, not a controlled
language/engine comparison. Node snarkjs is not the browser client. Native Rust
uses multicore work; this WASM build is single-threaded. Node verification peaked
at about 5.22 GiB RSS in this run; browser WASM memory is a different measurement.

Local raw measurements are in ignored `runs/interop-BPdJjL/report.json`. That
run began before the harness's report-scope label was fixed and incorrectly
labels itself synthetic; its recorded 567,402,188-byte genesis, invocation with
`--production`, and successful pin checks establish the actual tested inputs.
The committed harness now labels production-sized runs correctly.

Export/import changes the H-query representation and is expensive. The
prototype imports every intermediate output to test compatibility with existing
acceptance. A ceremony that keeps Bellman parameters canonical could export once
and import at finalization, but that requires reviewed changes to the acceptance
and archival protocol. No production check was removed by this experiment.

## Decision and remaining work

This supports pursuing Bellman transport and Rust implementation diversity.
It does **not** establish a lightweight browser client or a production launch.

1. Repeat the full-size OPFS/browser acceptance checks on an idle
   machine, then on representative desktop Chrome/Edge machines with lower RAM.
   Safari/Firefox, interruption, quota exhaustion and recovery remain untested.
2. Reduce compute memory and time; the current Rust WASM contribution path is
   single-threaded and uses whole-file buffers. Review threading and streaming
   changes. The snarkjs OPFS browser comparison above now passes; repeat it across
   supported machines and collect matching total-memory samples for both engines
   before making the final engine decision.
3. Decide whether to keep Bellman canonical or convert each candidate to zkey.
   Preserve exact-predecessor validation, independent verification, immutable
   bytes, transactional head advancement and witnessed publication either way.
4. Review point encoding/subgroup handling and conversion bindings. Preserve
   contribution names and beacon metadata in the signed transcript; Bellman
   records alone do not retain those zkey metadata fields.
5. Integrate the selected worker with authenticated leases, signed artifact
   pins, hosted multipart uploads, cancellation/recovery, and release integrity.

At 70% utilization, 5,000 accepted contributions require an average complete
slot of 2.82 minutes over 14 days or 6.05 minutes over 30 days. The observed
Rust browser computation takes about six minutes; snarkjs OPFS takes 45 seconds
on this Mac. Network transfers, server conversion/verification and publication
still count toward the slot. Multi-minute per-candidate zkey import remains a
bottleneck. These results do not justify either capacity promise; a reviewed
acceptance design and an isolated end-to-end benchmark are necessary.

Queue/public-operations reuse is mapped in
[PUBLIC_CEREMONY_REUSE.md](../../PUBLIC_CEREMONY_REUSE.md). Reproduction commands
and build/encoding adaptations are in [README.md](README.md).

## Validation and scope

Passed: native and WASM release builds; three encoding/framing tests; three
HTTP upload/status tests (including invalid and oversized candidates), plus a
fourth fixed-route test for the snarkjs comparison worker; synthetic
and production-sized mixed-engine chains with seven negative controls each;
synthetic and full-size Chrome OPFS/status-polling contribution flows. The final
Rust browser result is recorded locally under ignored `runs/browser-poll-NwgbY6/`.
The follow-up snarkjs bundle build, seven combined HTTP/encoding tests, synthetic
mixed chain, and synthetic/full-size snarkjs browser flows also passed. All five
repository gates were rerun successfully for this follow-up. Rust memory
optimizations are source-analysis proposals only; no Rust arithmetic changes
were made or tested in this follow-up.

Repository gates passed: `pnpm build`, `pnpm typecheck`, `pnpm test`,
`pnpm test:e2e`, and `git diff --check`. The repository E2E suite covers the
scaffolder; it is not a hosted ceremony acceptance test.

Not exercised: other hardware/browser classes, hosted OAuth/S3 multipart/resume,
real PostgreSQL contention, independent operators/mirrors, long contribution
histories, final beacon orchestration, or a new cryptographic/dependency audit.
No live coordinator state, signed manifest, production acceptance path, or web
feature flag was changed. Generated artifacts remain ignored and uncommitted.
