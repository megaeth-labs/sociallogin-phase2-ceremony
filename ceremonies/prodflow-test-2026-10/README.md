# Production-flow test, 2026-10-26

A throwaway ceremony signed with `purpose: "production"` on the mainnet stack
(`moss-phase2-mainnet`), to exercise the production rules (one contribution
per GitHub account, signed heartbeat) before mainnet. Root key
`prodflow-test-root-2026-10`, SPKI SHA-256
`4b7e7a1f58608386d8bc9b31239a008f71e6b40189d68a46894b258d04ce18bf`; it is not
the mainnet root.

| | |
| --- | --- |
| Ceremony ID | `bd40e300-5034-4139-9576-ce162da9aca3` |
| Slug | `moss-phase2-prodflow-test-2026-10` |
| Window | 2026-10-26 15:30–16:30 UTC, cap 2 |
| Beacon | Ethereum block 26278142 (no earlier than 16:45:11 UTC), exponent 10 |
| Manifest SHA-256 | `1d0372caa754d78da75d439bab0a84db53d6b3c349512d976e20c21d345d2a92` |
| Database | `ceremony_prodflow` (the default `ceremony` database stays empty for mainnet) |
| Object Lock | compliance, until 2026-11-03 |
| Site | `dpl_9tkBvAk2xBJVaD4eBkxk2bJi9DJ7` from 4d867e1, 45 assets reproduced |
| Collectible | MegaETH mainnet `0x6E83C1577B486cB748f3768fb48BacafdaB047De` |

[inputs.json](inputs.json) and [manifest.json](manifest.json) build the signed
[manifest.signed.json](manifest.signed.json);
[published-releases.json](published-releases.json) lists the archived release
files.
