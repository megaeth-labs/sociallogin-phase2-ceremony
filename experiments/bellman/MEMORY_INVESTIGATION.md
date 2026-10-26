# Browser memory investigation

This is source analysis of the pinned experiment, not a claim that the proposed
Rust optimizations are implemented or reviewed. Production arithmetic and
acceptance have not changed.

## Why the Rust WASM path allocates so much

At the pinned MystenLabs revision
`f10c8a41ae019fb68c66fae0276159900b3a128c`:

1. `phase2/src/lib.rs::contribute` takes an entire serialized `Vec<u8>`, parses
   `MPCParameters`, then serializes into a growing output `Vec<u8>`. The JS
   binding also copies input into WASM and output out of WASM.
2. `bellman/src/groth16/mod.rs::Parameters::read` retains every query as decoded
   affine points, including the unchanged A/B queries. Its vectors grow by
   pushing points rather than reserving the declared lengths first.
3. `phase2/src/parameters.rs::MPCParameters::contribute` copies **both** H and L
   arrays with `to_vec()` while retaining the originals in `Arc`s.
4. Its WASM `batch_exp` allocates a projective-point vector as large as the
   entire section, computes into it, normalizes it, then copies back to affine.
5. WASM linear memory does not shrink just because these allocations are freed.
   The reported allocation after compute reflects the heap's high-water growth,
   not the amount of currently live point data.

OPFS output handoff fixed the observed full browser flow, but happens after
computation and does not address these allocations.

## Why the snarkjs experiment differs

The experiment bundles the unmodified pinned snarkjs 0.7.6 Bellman contribution
source and replaces `fastfile` with our existing OPFS adapter. Download goes
straight into OPFS and the contribution reads/writes through synchronous file
handles. It does not retain complete serialized input/output arrays.

`src/mpc_applykey.js::applyKeyToChallengeSection` computes its chunk size as
`floor((1 << 20) / pointBytes)`: for G1, 16,384 points / 1 MiB of encoded input
per batch. The upstream comment saying “128Mb chunks” does not match that code.
There are multiple conversion and arithmetic buffers per batch, and each
ffjavascript worker has a separate WASM instance, so 1 MiB is **not** a bound on
all computation memory. Unchanged query sections are copied in 2 MiB chunks
with the adapter's default page size. Contribution history is still accumulated
in memory; long histories have not been benchmarked.

The snarkjs main WASM heap measurement excludes its child workers. Compare
browser-process-tree RSS when available, not that heap against Rust's whole
single-instance heap. Our 500 ms RSS sampler sums Chrome and descendants;
shared pages may be counted repeatedly, short peaks can be missed, and macOS
memory compression affects residency. It excludes the separate server/verifier.

## Ordered Rust optimization options

1. **Streaming serialized I/O:** expose Rust `Read`/`Write` adapters over OPFS,
   with bounded buffers crossing the JS/WASM boundary. Keep the existing checked
   parser and contribution function. This removes whole serialized input/output
   copies, but still retains all decoded queries and whole-section temporaries.
   Measure it before claiming a target RAM budget.
2. **Bound point-work buffers and avoid unnecessary copies:** process H/L
   projective points in chunks, reuse storage, and mutate uniquely owned affine
   arrays instead of cloning them. Reserve validated vector lengths during
   parsing. These touch the dependency and need deterministic differential tests
   against the unchanged implementation, including identity points, chunk edges,
   malformed inputs, and ordinary/beacon transitions.
3. **Fully streamed parameter transformation:** retain only header/transcript
   metadata; validate/copy unchanged query sections and transform H/L in chunks.
   This can avoid holding all decoded parameters, but changes more protocol-facing
   parsing and transcript plumbing. Preserve every existing point/subgroup check,
   transcript ordering, and exact predecessor-plus-one verification. Do not
   replace checked parsing with unchecked decoding to improve benchmark numbers.
4. **Parallel computation:** assess threads separately after memory work. More
   workers can improve time while increasing RAM and impose browser isolation
   requirements. The current Rust WASM build is single-threaded; browser snarkjs
   used 14 workers on the measured Mac. Their timing difference is not solely a
   language or arithmetic-library comparison. Rust also checked-decodes every
   query point, while snarkjs copies unchanged query sections without decoding
   them. Both outputs go through the same server verification gates in this
   experiment; these are not identical client-side workloads.

Recommended next engineering priority: use the OPFS snarkjs Bellman path as the
candidate default browser engine, validate it across supported machines, and
retain Rust as the independent native implementation while improving its browser
path separately. A reviewed Bellman-canonical verification/archival path is still
needed to avoid multi-minute zkey conversion after each public contribution.
This recommendation does not enable browser participation or waive acceptance
checks. See [RESULTS.md](RESULTS.md) for measured results and scope.
