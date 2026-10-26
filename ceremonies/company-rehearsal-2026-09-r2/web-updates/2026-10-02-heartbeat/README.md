# Five-minute rehearsal heartbeat grace

Source: `b6ebbdec91601e5c4c67d037da559b24be479915`.
Deployment: `dpl_Bry55Zh4RbMMa5rxWcVhu1es4fcA`.
[Immutable web deployment](https://zklogin-phase2-ceremony-gp998ukxd-mega-eth.vercel.app).

The coordinator now gives active rehearsal slots at least 300 seconds without a
heartbeat before expiry. This is an explicit operator-authorized rehearsal-only
relaxation of the original signed 15-second policy, gated by both rehearsal mode
and signed rehearsal purpose. The original manifest and accepted chain remain
unchanged. It does not revive expired slots, extend the 90-minute absolute slot
deadline or closing time, or change artifact verification and acceptance.
Production still uses its signed policy exactly. New manifests generated with
`infra/build-manifest.mjs` default to a signed 300-second heartbeat allowance.
Existing rehearsal clients continue sending heartbeats every five seconds.

The site explains background-tab interruptions before and during contribution.
Expired-slot errors explain possible causes and link back to the ceremony to
check pending/accepted work before obtaining a fresh slot. The stale-slot retry
button is removed. Keeping the tab foregrounded is still advised: a five-minute
grace cannot prevent browser suspension or eviction.

Build, typecheck, full tests, e2e and whitespace checks passed. Regression tests
cover both rehearsal gates, unchanged production policy, preservation of longer
signed allowances and the original manifest, and expiry error rendering.
The built Linux coordinator image also passed the rehearsal/production policy
gate check without network access. All 37 browser assets match the independent Linux AMD64 build. Release evidence
is stored in version-pinned, locked archive objects.

Rollout completed on October 2. Aggregate queue, lease and submission counts
were zero both before and after coordinator drain. CloudFormation reached
UPDATE_COMPLETE with the pinned coordinator image; the verifier was not
restarted. The new release authorization is served, and the original signed
manifest and generation-6 accepted head were confirmed unchanged.

The staged web release was promoted to the stable rehearsal URL. Live Chrome
checks passed with simulated participant/wallet responses, including wallet
approval, confirmed claim UI, reload recovery, route-scoped CSP and desktop/mobile
layouts. No full-artifact background-tab contribution or real wallet mint was
performed for this release.
