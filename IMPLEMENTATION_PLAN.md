# Client implementation plan — browser contributions and CLI

Scope: the two contributor clients and the diversity claim made about them.
Ceremony operations, storage, verifier deployment, and finalization are covered
by `RUNBOOK.md` and `infra/PRODUCTION_DEPLOYMENT_CHECKLIST.md`.

Status date: 2026-09-18.

## 0. Current state

Both clients exist. The browser path is deliberately disabled.

| | CLI | Browser |
|---|---|---|
| package | `packages/cli` | `apps/ceremony` + `packages/crypto` |
| arithmetic | snarkjs 0.7.6 `zKey.contribute` | snarkjs 0.7.6 `zkey_contribute` |
| curve math | ffjavascript 0.3.1 | ffjavascript 0.3.1 |
| I/O | node fs / fastfile | OPFS adapters |
| runtime | forked child process | web worker |
| state | working | gated off at `useContributionFlow.ts:456` |

`packages/crypto/build.mjs` resolves `@cabure/snarkjs-phase2-contribute` to
snarkjs's own `zkey_contribute.js` source and substitutes only
`@iden3/binfileutils` with the OPFS adapter. Node `crypto` and `readline` are
shimmed solely for imports originating inside snarkjs.

## 1. The diversity claim

### 1.1 What is actually true

The two clients share the entire cryptographic core. They differ in I/O layer
and runtime. A defect in snarkjs's Phase 2 arithmetic or in ffjavascript
affects both identically; a defect in the OPFS adapters affects only the
browser.

This is **runtime diversity, not implementation diversity**. Sui's ceremony had
implementation diversity: snarkjs for browser contributors, Kobi's Rust
implementation for Docker contributors, with genuinely different curve
arithmetic.

`README.md` currently describes the CLI as "the default fallback and
independent implementation". That overstates it and must be corrected.

### 1.2 Options

**(a) Document honestly.** Publish `docs/trust-boundary.md` naming the shared
surface exactly (snarkjs 0.7.6 `zkey_contribute`, ffjavascript 0.3.1) and the
divergent surface (I/O, runtime, entropy plumbing). Correct the README.
Cost: hours.

**(b) Independent verifier in another language.** A Rust/arkworks tool that
reads genesis, PTAU and the final zkey and independently verifies the chain.
Read-only, so there is no byte-exact write framing to match — far lower risk
than an independent contributor, and it still catches a snarkjs arithmetic
defect. Cost: days.

**(c) Independent contributor client in Rust.** See section 5.
Cost: weeks.

**(d) Claim nothing.**

Recommended: **(a) now, (b) if budget allows.** (b) delivers most of the
diversity value for a fraction of (c)'s cost and risk.

## 2. Browser — unblocking work

Ordered by dependency. Items 2.1–2.3 are independent and can start immediately.

### 2.1 Narrow `connect-src` — DONE 2026-09-18

`next.config.ts` emitted `connect-src 'self' https:`. The `https:` wildcard
permitted `fetch()` to any HTTPS origin — the entropy-exfiltration channel the
threat model names — and made the computed coordinator origin beside it
decorative.

Narrowing to the coordinator origin alone would have broken the ceremony:
`apps/ceremony/src/lib/api.ts:1711` `validateCoordinatorArtifactUrl` checks
only for HTTPS and absent credentials, not origin, and artifact bytes stream
directly between the browser and the object store.

Implemented instead: an explicit `ARTIFACT_ORIGINS` allowlist
(comma-separated), validated with the same rules as `COORDINATOR_BASE_URL` —
HTTPS or loopback HTTP, no credentials, no path/query/fragment, origins only.
`connect-src` is now `'self'` plus the coordinator origin plus that allowlist.
Unset means artifacts are coordinator-served, already covered.

Rendered output verified:

```
no env           connect-src 'self'
coordinator      connect-src 'self' https://coordinator.example
coord + storage  connect-src 'self' https://coordinator.example https://bucket.s3… https://mirror.example
rejects          https://host/path  →  "must be origins, not paths"
rejects          http://host        →  "must use HTTPS or loopback HTTP"
```

**Follow-up, not yet done:** `validateCoordinatorArtifactUrl` should enforce
the same allowlist client-side, so a compromised coordinator cannot steer an
artifact fetch — or the upload carrying a contribution — to an attacker origin.
CSP blocks the request, but the client should reject it before issuing it. This
needs the allowlist plumbed to the browser through the bootstrap payload.

Also add `ARTIFACT_ORIGINS` to `apps/ceremony/.env.example`.

### 2.2 Cross-origin isolation — BLOCKED on 9 (storage adapter)

`Cross-Origin-Opener-Policy: same-origin` plus
`Cross-Origin-Embedder-Policy: require-corp` gate `SharedArrayBuffer`, which
gates ffjavascript's worker threading; without them contributions run
single-threaded.

Do not add these blind. `require-corp` blocks every cross-origin subresource
lacking `Cross-Origin-Resource-Policy` or matching CORS — which now includes
artifact fetches from the object store. The CORP/CORS story cannot be settled
until the provider is chosen, so this depends on launch blocker 9 and must be
validated while the browser path is actually exercised, in 2.8.

### 2.3 Transport compression — needs a delivery decision first

Measured on the production genesis: 567,402,188 → 288,014,000 bytes, 1.97x
under `zstd -3`. The gain is almost entirely the coefficients section
(compresses to 15%); curve-point sections compress to 87%.

This is *not* a one-line header change under the direct-to-object-store
architecture. Storing objects with `Content-Encoding` metadata would mean the
archive no longer holds canonical bytes, breaking the property that the
SHA-256 in the transcript is the SHA-256 of the stored object. Options:

1. CDN performing on-the-fly compression in front of the archive — canonical
   bytes at rest, compressed on the wire. Preferred.
2. Coordinator proxies artifact reads and compresses — gives up direct-to-store
   transfer.
3. Store a second, compressed copy alongside the canonical object — doubles
   storage, needs both hashes pinned.

Note the gain is entirely in sections contributors do not need under section-
level transfer (§6). If §6 is adopted, this becomes nearly worthless; decide
§6 first.

Does **not** reduce the OPFS footprint in any variant.

### 2.4 Screen wake lock

`navigator.wakeLock.request("screen")` held for the duration of a contribution,
released on completion or failure. Prevents display sleep from stalling the
heartbeat. Chrome Android and Safari 16.4+.

### 2.5 Lease tuning for long contributions

Current policy: `heartbeatSeconds: 15`, `suspectAfterSeconds: 90`,
`absoluteSeconds: 5400`. Confirm the worker heartbeats independently of the
compute loop (`apps/verifier-worker/src/job-heartbeat.ts`, OPFS worker message
cadence). If heartbeats can be starved by sustained computation, either widen
`suspectAfterSeconds` or move the heartbeat off the compute thread.

### 2.6 Capability-probe UX — DONE 2026-09-18

Found a defect while doing this. `useContributionFlow` called
`getBrowserContributionCapabilities()` with no arguments, and the probe only
runs its quota check when given `inputSizeBytes`. The quota check therefore
never ran there; the only one that did is inside the worker
(`opfs-job.ts:206`), reached after the contributor has queued, waited and
claimed a lease. An under-provisioned browser burned a contribution slot and
stalled the ceremony for the lease duration before discovering it had nowhere
to put the key — 1.202 GB at this relation's size, which a mobile browser can
easily miss.

Fixed by sizing the probe against the current head. `StatusResponse` now
carries `headByteLength`, taken from the signed checkpoint `getStatus` already
cross-checks, so the deciding value is signature-backed rather than a
coordinator claim.

Reason codes now map to contributor-facing sentences in
`apps/ceremony/src/lib/capability-messages.ts`; quota shortfalls report actual
figures, and every path names the signed CLI as the fallback.

### 2.7 Design and accessibility pass — MOSTLY DONE 2026-09-18

- Colour converted to OKLCH. Every value round-trips exactly to the sRGB
  literal it replaced, so the interface is visually unchanged. Accent and error
  are split into lightness/chroma/hue components so tints derive from one
  definition.
- Component styles are free of colour literals; the 24 `rgba()` values became
  accent, error, shadow and overlay tokens.
- `prefers-reduced-motion` block added. The spinner and pulse indicators ran
  infinitely; stopping them costs no information because progress is also a
  numeric percentage and a status label. It selects elements rather than class
  names, so CSS-module styles are covered.
- Focus rings widened from a 1px box-shadow at 0.2 alpha — close to invisible —
  to a 2px solid outline, on the shared input and both VerifyScreen textareas.
- The 150ms border-colour focus transition was dropped; it delayed the one cue
  a keyboard user depends on.

**Still outstanding:** ARIA coverage beyond the present Verify and Entropy
usage, and a full audit against WCAG 2.2 AA including the 24x24 minimum target
size. Complete before the release freeze, since the bundle hash is pinned in
the manifest.

### 2.8 Benchmark matrix, then enable

Required OPFS quota, from `packages/crypto/src/browserContribution.ts:44`:

```
requiredBytes = inputSizeBytes * (alreadyInOpfs ? 1 : 2) + 64 MB
              = 567,402,188 * 2 + 67,108,864
              = 1,202,013,240 bytes  (1.202 GB)
```

Measure `storage.estimate()`, wall-clock, and peak memory on desktop
Chrome/Firefox/Safari and on both mobile platforms. Android Chrome should pass
(quota is a large fraction of free disk). iOS Safari is expected to fail on
quota — verify rather than assume.

Only after the matrix passes: set
`NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED=true` and remove the throw at
`useContributionFlow.ts:456`.

## 3. CLI — hardening

### 3.1 Reproducible pinned release — RESOLVED 2026-09-19

Not a signing key. Releases are hash-pinned: `ReleaseRef` is sha256, byteLength,
urls and sourceCommit, listed in `manifest.cliReleases[]`, and the manifest root
key signs the manifest. There is no separate code-signing key anywhere in the
design.

The mechanism as built could not work. `build.mjs` injected
`MOSS_CLI_RELEASE_SHA256` through an esbuild `define`, but that value is the
hash of the artifact the build produces, so embedding it changed the artifact
and therefore the hash. It never converges: pin the pre-injection hash and you
distribute a file that hashes to something else; pin the post-injection hash
and the embedded value disagrees with it.

Fixed by removing the injection and having `src/release.ts` read the running
bundle back at run time through `import.meta.url`. No self-reference, and the
value now describes the file actually executing rather than one someone passed
in. Verified: esbuild preserves `import.meta.url` in the bundle, the computed
hash matches `shasum -a 256 dist/index.js`, and the build reproduces the same
hash across rebuilds.

This remains allowlisting, not attestation — a modified CLI can report anything,
exactly as `README.md` says — but an honest build now answers truthfully and the
coordinator records which release each contributor used.

**Residual gap:** only the entry bundle is pinned. `dist/contribution-worker.js`
is forked as a sibling (`src/contribution.ts:10`) and nothing pins it, so a
tampered worker passes. `ReleaseRef` describes one downloadable file, so
covering both needs either a second pinned artifact with clear semantics about
which files belong to which release, or folding the worker into the entry bundle
so there is one artifact. Worth settling before releases are published.

Operator flow: build, hash `dist/index.js`, publish it at an immutable URL, and
list sha256/byteLength/urls/sourceCommit in `manifest.cliReleases[]` before
signing the manifest.

### 3.2 Journal resume at production size

`journal.ts` and `files.ts` implement restart recovery; `journal.test.ts`
covers fixture scale. Exercise against a 567 MB zkey with a kill mid-upload and
mid-contribution.

### 3.3 Seeded-host warning — DONE 2026-09-18

Upstream Caburé PR #65. The CLI now warns before any secret is generated, at
the top of `contributeCommand`, covering snapshots, cloned images and golden
templates, and instructing the contributor to destroy the working directory
after the receipt is saved.

Paired with the detection in section 5A.2, so a duplicate that slips through
anyway is rejected rather than silently accepted. Still outstanding: the same
warning in contributor-facing documentation, and in the browser UI.

### 3.4 Disk-capacity probing on real targets

p0tion issue #129 reports `df` probing failing on some filesystems. Verify the
CLI's pre-contribution capacity check on each contributor operating system.

## 4. Cross-client validation

`packages/crypto/tests/opfs.test.ts` with `vitest.config.ts` already gives the
OPFS graph an isolated snarkjs source tree while stock snarkjs stays intact.
That is the correct shape. Two extensions:

1. Run the differential test at production size — OPFS output compared
   byte-for-byte against stock snarkjs on the real genesis.
2. During the dress rehearsal, land contributions from both clients in the same
   chain, verified under the same two-operator unanimity policy.

## 5. Independent Rust contributor client (optional)

### 5.1 Why the obvious candidate does not fit

`kobigurk/phase2-bn254` is Sean Bowe's `phase2` v0.2.2 adapted to BN254 through
`bellman_ce`. It operates on its own `params` binary format, not snarkjs
`.zkey`, and its surrounding tooling targets the circom legacy JSON era
(`input.json`, `copy_json.rs`). Dependencies include `rand` 0.4 and `blake2`
0.8; last push 2024-03.

Adopting it requires a bidirectional `.zkey` ↔ `params` converter.

A defect in that converter is **fail-closed**: a malformed candidate is
rejected by verifier unanimity and the predecessor-plus-one framing checks
before any head CAS, so it costs a contributor slot and wall-clock, not the
integrity of the chain. The cost of the converter is therefore wasted slots and
maintenance surface, not ceremony corruption. See section 5.4 for the failure
mode that is *not* fail-closed.

`gnark` (Go) has Groth16 BN254 and MPC setup but likewise does not read
snarkjs `.zkey`.

### 5.2 What a fresh client would have to do

Against `ark-bn254` / `ark-ec`, operating directly on the `.zkey` format:

1. Parse the section table. Ten sections; layout confirmed on the production
   genesis:

   | id | name | bytes | changes per contribution |
   |---:|---|---:|---|
   | 1 | header | 4 | no |
   | 2 | groth16Header | 660 | yes |
   | 3 | IC | 1,344 | no |
   | 4 | coeffs | 198,961,580 | no |
   | 5 | A | 60,266,176 | no |
   | 6 | B1 | 60,266,176 | no |
   | 7 | B2 | 120,532,352 | no |
   | 8 | C (L) | 60,264,832 | yes |
   | 9 | H | 67,108,864 | yes |
   | 10 | contributions | 68 | yes |

2. Multiply every point in sections 8 and 9 by delta⁻¹
   (941,638 + 1,048,576 ≈ 2.0M G1 scalar multiplications).
3. Update delta in section 2.
4. Append a contribution record to section 10 with a Blake2b transcript hash
   and proof of knowledge byte-identical to snarkjs's.

The arithmetic is a few hundred lines. The cost is in byte-exact framing
compatibility and making `verifyFromInit` accept the output.

Estimate: **1–3 weeks**, including differential testing against snarkjs on the
real 567 MB artifact, plus review of `packages/zkey-inspect`'s
predecessor-plus-one checks against a second writer.

### 5.3 Recommendation

Not on the critical path for a ceremony of 20–30 known contributors. Option
1.2(b) — an independent Rust verifier — buys most of the same assurance for
days rather than weeks, with no write-framing risk. Revisit 5.2 only for a
large public ceremony.

### 5.4 The failure mode verification cannot catch

Every structural defect is fail-closed. The one that is not is a contribution
that is **structurally valid but carries weak or known randomness**. It passes
`verifyFromInit`, passes the framing checks, passes verifier unanimity, and
contributes nothing.

Verification tests the structure of a contribution, never the quality of the
secret. This is client-agnostic — it applies equally to the CLI, the browser,
and any future implementation — and it is why soundness rests on at least one
contributor having generated, kept private, and destroyed a real secret.

The terminal drand beacon does not help here: it prevents the coordinator from
choosing an ending after seeing randomness, but it is public and is not secret
toxic-waste entropy.

## 5A. Duplicate-secret detection

### 5A.1 The risk

Upstream Caburé PR #65 warns that a cloned VM snapshot duplicates CSPRNG state.
Two contributors running from the same image could generate identical secrets,
so the second contribution adds no entropy while appearing entirely valid — an
instance of 5.4.

### 5A.2 Free detection from data already published

`packages/zkey-inspect/src/parser.ts` already extracts per contribution:

```
deltaAfter  fixed[0:64]      g1s   fixed[64:128]
g1sx        fixed[128:192]   g2spx fixed[192:320]
transcript  fixed[320:384]
```

`g1s` and `g1sx` derive from the contributor's own proof-of-knowledge
randomness and secret multiplier, not from the predecessor. Two contributors
sharing CSPRNG state therefore produce **identical `g1s` and `g1sx`**,
regardless of their position in the chain.

Action: enforce uniqueness of `g1s` and `g1sx` across all accepted
contributions, at verification time and again during transcript replay. No new
protocol, no new data, no secret held longer. Reject on collision and
investigate.

**DONE 2026-09-18** at verification time. `verifyExactlyOneAppend` rejects a
candidate whose newest contribution reuses either point from any earlier
contribution in the same zkey. Two tests cover it: a forced collision is
rejected, and distinct points across four contributions are accepted.

The zkey-inspect fixture had zeroed every point region, so all records shared
`g1s` and the check could not have been exercised at all; point bytes now
derive from the record marker, with an override so a test can emit two records
sharing proof-of-knowledge randomness while differing elsewhere.

**Still outstanding:** the same uniqueness check during transcript replay at
the release gate, so an operator re-verifying from archived bytes reaches the
same conclusion independently.

### 5A.3 Scalar precommitment (evaluated, not recommended)

Proposal: each contributor publishes a commitment before contributing.

What blocks the strong version: snarkjs does not expose the delta scalar.
`packages/cli/src/contribution-worker.ts` notes that snarkjs mixes its own
CSPRNG bytes with the supplied entropy, so the effective scalar is
`f(contributor entropy, snarkjs internal randomness)`. A contributor cannot
commit to a value they do not control.

The achievable version commits to the *entropy input*, which gives:

- binding before exposure — the input is fixed before the predecessor is seen,
  preventing adaptive choice as a function of ceremony state;
- collision detection — already obtained free via 5A.2.

What it cannot give: the commitment can never be opened, because opening
reveals toxic waste. An unopened commitment does not prove the committed value
was the one used. Closing that gap needs a zero-knowledge proof of consistency
between the commitment and the contribution's proof-of-knowledge.

Costs: the secret must exist before the contribution begins and be retained
across it, which works against destroying it promptly; plus a new protocol
surface and a new manifest field.

Adaptive choice at intermediate positions is a weak attack — every subsequent
contribution re-randomizes on top — and adaptive choice at the terminal
position is already addressed by the precommitted drand round.

Conclusion: implement 5A.2. Revisit precommitment only if a concrete attack is
identified that 5A.2 does not cover.

## 6. Conditional: section-level transfer

Only required if mobile participation is a goal.

Contributors need sections 2, 8, 9 and 10 — 127.4 MB of the 567.4 MB file.
Sections 3, 4, 5, 6 and 7 are byte-identical to the genesis for the entire
ceremony and never need to move.

```
                    transfer      OPFS required
full zkey            567.4 MB        1.202 GB    iOS fails
sections 2/8/9/10    127.4 MB        ~319 MB     iOS fits
```

Requires a custom transfer protocol, coordinator-side reassembly, rework of
`packages/zkey-inspect`'s framing checks, and a new argument for why a
contributor who never received 440 MB of the key can still know they are
building on the canonical head. That argument is constructible — the invariant
sections are provably identical to the manifest-pinned genesis, and verifiers
still run full `verifyFromInit` on the reassembly — but it needs review.

Decide before the dress rehearsal so it can be exercised there, or defer
explicitly.

## 6A. Audit findings, 2026-09-18

Two reviews: the contribution acceptance path, and the CSP and
duplicate-randomness changes made that day.

The acceptance path's core properties were confirmed sound — a single
head-mutation site with no bypass, unanimity that cannot be forged, correct
report replay and attempt binding, no client claim load-bearing, no TOCTOU
across four independent hashing boundaries, and expired leases unable to
submit. The defects were elsewhere.

### Fixed

| Severity | Finding |
|---|---|
| HIGH | `promoteImmutable` copied into the content-addressed canonical path, so an interrupted copy wedged promotion permanently; unguarded `recoverVerifiedSubmission` made that halt the whole ceremony |
| HIGH | `artifactConnectSources` accepted wildcard hosts, reinstating the `https:` wildcard it replaced |
| HIGH | Point comparison was byte-wise, evadable by re-encoding a coordinate as `x + q` |
| MEDIUM | CSP baked at build time while every other consumer reads per request |
| MEDIUM | CSP delimiters in an origin truncated the policy |
| MEDIUM | Lost acceptance race threw at a verifier whose report had committed |
| MEDIUM | Claim response cast rather than parsed, skipping artifact-URL and name validation |
| LOW-MED | Multipart `parts` cast without validation |
| LOW | Reuse rejection thrown before the inspection existed, mislabelling it a prefix fault |
| MEDIUM | State machine was dead code and already violated by `PREPARED -> SEALED`; now enforced in `syncSchedule` |
| LOW | `expireVerifierJobsAndRejectImpossible` spanned every ceremony in the database |
| LOW | `ingestLocalUpload` lacked the `state='INITIATED'` guard, streaming a full artifact before failing |
| LOW | A blank database silently reseeded the ceremony from genesis; production now requires `ALLOW_CEREMONY_INITIALIZATION` |
| LOW | `errorStatus` returned 401 and 400 for internal invariant failures |

### Outstanding

**HIGH — the sealing instant is adjudicated by an unattested clock.** Narrowed,
not closed. `ceremonies.observed_time_high_water` now records the furthest
instant the ceremony has ever seen, advanced on every schedule synchronisation
and never moved backwards, and the head compare-and-swap requires the clock to
read at or after it. Once the coordinator has observed any instant at or past
`sealsAt` — which it must, in order to seal — an acceptance requiring the clock
to be before `sealsAt` can no longer be satisfied, so a rollback stops the
ceremony rather than reopening it.

Still open: the high-water mark is not externally attested, so an operator who
rolls the clock back *before* ever observing `sealsAt` is unconstrained; and
sealing remains lazy, so a coordinator that stops serving traffic at `sealsAt`
never signs a `SEALED` checkpoint. The independent transcript witness (launch
blocker 10) is the real fix. `RUNBOOK.md` §7 still says transitions "are
enforced from the signed times", which is true of the value and not of the
clock, and should be reworded.

**MEDIUM — `script-src 'unsafe-inline'`** with no nonce or hash. Tightening
`connect-src` raises the cost of using an XSS, not of getting one. Next 15's App
Router supports nonce-based CSP through middleware; if inline styles are the
real constraint, the exemption belongs in `style-src` only.

**LOW — signatures and receipts round-trip through PostgreSQL `jsonb`.**
Correct today because `assertVerificationReport` forces safe integers, but any
future non-integer, large integer or lone-surrogate field would make a genuine
report fail re-verification and block the head, and would hand a contributor a
receipt that fails against the pinned key. Signing over stored bytes removes
the class.

**LOW — quarantine blobs are never collected.** Each generation retains a full
copy in quarantine and another in canonical, and nothing removes the former.
This is what made the ENOSPC path in the promotion defect reachable; that
defect is fixed, but the disk growth is not.

**LOW — the signed receipt and transcript omit `clientKind` and
`clientReleaseSha256`.** Client provenance lives only in the private
`submissions` row, so the release allowlist is not independently auditable from
the published transcript.

**LOW — client provenance is absent from the published transcript.** Needs a
decision, not just an implementation. `clientKind` and `clientReleaseSha256`
live only in the private `submissions` row, so the release allowlist cannot be
audited from the published transcript. Adding them to the signed receipt and
transcript event is the fix, and it is far easier before the manifest is frozen
than after, because both are cryptographically committed and contributors
verify receipts against the pinned coordinator key.

It is also a disclosure decision: the receipt is public, so recording which
client each contributor used reveals that alongside their pseudonym. For a
ceremony of named contributors that is probably wanted, but it is a deliberate
choice rather than a defect fix, which is why it was left rather than applied.

### Unverified assumption — CLOSED 2026-09-18

`verifyExactlyOneAppend` compares only section 2's leading header fields and
section 10. It never byte-compares sections 3 through 9 — the IC, the
coefficients, and the A/B1/B2/C/H point vectors — against the predecessor, so
acceptance is sound only if `verifyFromInit` covers those cryptographically.
That had been reasoned about but never tested.

`apps/verifier-worker/tests/verify-from-init-coverage.test.ts` now asserts both
halves of the division of labour: `verifyFromInit` accepts an unmodified
append, rejects a single flipped bit in **each** of sections 3 through 9, and a
section-5 mutation passes `verifyExactlyOneAppend` while `verifyFromInit`
rejects it. Neither check can be dropped without opening a hole the other does
not cover.

snarkjs runs in a child process there, as it does in production, because it
leaves file handles open that Node now treats as fatal when collected.

## 7. Sequencing

```
2.1  2.2  2.3          small, independent, start now
1.2                    decide diversity story; unblocks docs and README
3.1                    critical path — launch blocker 6
2.4 2.5 2.6 2.7        browser hardening
3.2 3.3 3.4            CLI hardening
4                      cross-client validation
2.8                    needs all above; gates the browser flag
5, 6                   optional, scope separately
```

The ceremony can open CLI-only. The single critical-path item here is **3.1**.
