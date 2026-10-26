# Public ceremony UI

Implemented locally on `moss/production-hardening`, 2026-09-24. The owner's
requested direction is expressive and community-focused: warm paper, MOSS green,
forest ink, an abstract shared-chain illustration, and approachable typography.

## Review it locally

- Dashboard: `http://localhost:3000/`
- Interactive preview: `http://localhost:3000/preview`

The preview exists only in development. Its persistent banner labels all counts,
deadlines, participant entries and outcomes as simulated. It never authenticates,
creates a queue ticket, claims a lease, runs contribution arithmetic, uploads a
file, or manufactures a signed receipt. The screen picker exercises readiness,
waiting, slot offer/expiry, download, compute, upload, verification, acceptance,
error/retry, sealing and finalization.

## Connected behavior

The real dashboard uses verified checkpoint state, counts, the signed deadline,
and the existing signed receipt history. Sealing, capacity exhaustion and
finalization are separate states. It does not treat a countdown or contribution
cap as evidence of finalization, nor show the old heuristic wait estimate.

When browser participation is enabled for a reviewed release, the flow performs
browser/storage checks before joining, retains the existing entropy setup, joins
the coordinator queue, and waits for an explicit user claim of an unexpired
offer. Claiming is guarded against duplicate clicks and expired offers; the
coordinator still authoritatively validates the lease. Merely receiving an offer
no longer starts computation. Polling does not begin before a ticket is created.
The active slot deadline is shown, and closing/reloading the tab during compute
or upload triggers the browser's standard unload warning.

Progress uses worker measurements for download/compute. Upload and verification
remain indeterminate because those APIs do not provide measured percentages.
Receipt acceptance is distinct from independent witness publication and final
ceremony inclusion. A failed status or eligibility lookup does not enable joining.

The current browser-release flag remains disabled. No production manifest,
ceremony state, feature flag, or private configuration was modified. Existing
CLI instructions and artifact links remain available under advanced options.
The follow-up [Bellman integration](BELLMAN_INTEGRATION.md) selects either the
legacy zkey engine or direct Bellman engine from the signed manifest. Existing
epochs remain zkey-based. Size/storage checks use the signed current head.
Browser multipart uploads and retained-output recovery are implemented locally;
actual provider and authenticated browser acceptance remain launch gates.

## Remaining integration

- Full-size acceptance of the integrated Bellman engine and final import path.
- Provider testing of browser S3 multipart uploads and interrupted-upload recovery.
- Durable public readiness groups, admission/eligibility policy, requeue/cooldown
  rules and efficient large-lobby scheduling/polling. The new readiness screen is
  a client preflight; it does not implement server readiness groups.
- Multi-day queue recovery/notifications and capacity-backed ETA ranges.
- Deploy/provider-test the implemented witness/mirror service and show its distinct publication status in the
  participant view; final artifact inventory and verified final download links.
- Desktop browser/hardware acceptance, long-history performance, hosted OAuth,
  multiple independent verifier operators, and finalization rehearsal.

## Checks

UI unit tests cover lifecycle boundaries, deadline/cap versus finalization,
expired offers, queued versus computing rendering, acceptance copy, and
indeterminate upload/verification progress.

The isolated browser regression uses an externally installed
`playwright-core@1.56.1` and local Google Chrome on macOS:

```sh
node experiments/public-ui/smoke.mjs http://127.0.0.1:3000 \
  /absolute/path/to/playwright-core/index.mjs
```

It exercises the preview flow, expiry, retry, completion, widths 1440/768/390,
keyboard focus and reduced-motion mode, and asserts no ceremony API requests or
page errors. This is UI validation, not real-artifact browser acceptance.

Completed validation: repository build, typecheck, unit tests and scaffolder E2E
suite; 68 web tests; Chrome preview regression and visual inspection; production
server check (`node experiments/public-ui/production-preview-check.mjs`) confirming
that `/` responds and `/preview` returns 404. The final web build/typecheck were
repeated after the final copy/accessibility adjustments. The existing detailed
schedule/beacon preview is retained under a disclosure on the real dashboard.

Skipped: real GitHub sign-in, claiming an actual ceremony slot, full-size browser
computation, AWS uploads, multi-operator/witness integration, and the supported
hardware/browser acceptance matrix. None is established by the simulated UI run.
