# Rehearsal participant-history UI release

Source: `54198dec8925d822f392c35e8f5181d865b55793`.
Deployment: `dpl_2WDGA1eaqVSZv7v4Z7oxXYd7wkVJ`, now promoted to the
[stable ceremony site](https://zklogin-phase2-ceremony-mega-eth.vercel.app).

This release adds pending-submission recovery, reopening the verification view,
verified receipt history, and clearer accepted-contributor messaging. It also
adds the rehearsal-only root-signed supplemental web-release mechanism.

- [Root-signed authorization](web-release-authorization.signed.json)
- [Browser asset hashes](web-release.json)
- [Independent build reproduction](web-reproduction.json)
- [Immutable archive references](published-releases.json)

All 60 browser assets matched the independent Linux AMD64 build. Dependencies
were installed offline from the prior independent build's cache under the same
frozen lockfile; the source came from a clean Git archive. The standard online
reproduction procedure uses the same locked dependencies.

Verify the authorization with the original ceremony-root public key and the
`MOSS_PHASE2_REHEARSAL_WEB_RELEASE_V1` domain. Its manifest hash binds the original
ceremony manifest, which remains unchanged. Existing receipts and the original
browser release remain valid. This authorization does not alter the relation,
schedule, beacon, verifier policy, or canonical artifact chain. Production
ceremonies reject this rehearsal-only authorization mechanism.
