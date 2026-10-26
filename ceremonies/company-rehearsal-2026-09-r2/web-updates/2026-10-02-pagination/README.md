# Homepage contribution history pagination

Source: `a6426457097b77b9b8dc63c7733b5ee5d9a0929c`.
Deployment: `dpl_4jDrBM9AfvEMC9mts2DoF9tV8V6R`.
[Immutable web deployment](https://zklogin-phase2-ceremony-4s94h3rmh-mega-eth.vercel.app).

The homepage displays five accepted contributions per page, newest first, with
the total accepted count, page/range indicator and Previous/Next controls.
Receipt signature and full chain validation remain unchanged: pagination limits
rendered entries, not verification coverage. The coordinator, five-minute
rehearsal heartbeat grace, signed manifest and acceptance policy are unchanged.

Build, typecheck, full tests, e2e and whitespace checks passed before release.
Interaction tests cover newest-first initial display, next/previous navigation,
page boundaries, count changes, empty history and fail-closed signature errors.
All 37 browser assets matched the independent Linux AMD64 build; the release
and root-signed authorization are archived with immutable version references.

Rollout completed on October 2. Aggregate queue/lease/submission counts were
zero before and after coordinator drain. The same coordinator image restarted
with only the supplemental browser authorization changed. Its signed manifest
and generation-7 accepted head were confirmed unchanged; ECS reported one
running coordinator and no pending tasks.

The release is promoted to the stable site. A live Chrome check using the actual
public history verified seven total entries, five entries on the first page,
two on the second, Previous/Next navigation and the page indicator. Desktop and
390px mobile screenshots were inspected; mobile has no horizontal overflow.
No full-artifact contribution, wallet transaction or Safari/Firefox test was
performed for this presentation-only change.
