# MAH-CREDENTIAL-PARENT-BUDGET-20261013

Goal: complete MoXBots credential migration, cold start and update recovery, then accept remote Linux Host configuration with the existing test identity. Keep MyAgents, original credentials, device identity and immutable reader v1 intact. No model key or paid model call is needed for this acceptance.

## Current evidence

- [x] Exact 6ac923a6 package installed after human approval; normal App startup verified.
- [x] Human completed OS authorization; application logged validated legacy session and device key.
- [ ] New credential routing commit: migration returned credential-store unavailable after validated key. A missing routing ledger does not prove absence of a partially written OS entry. Do not delete either entry or retry authorization automatically.
- [x] Exact a8a60f1c joint package approved, installed and cold-started; signed executable matches its package. Original 6ac and b116 App backups remain available.
- [x] Independent native sidebar acceptance: reversible chat and Agent moves, section creation/rename, keyboard section ordering and restart persistence; temporary sections removed. Native pointer section ordering and multiple-Agent/multiple-chat ordering remain unproven; do not claim them passed.
- [x] Equivalent-resource synthetic missing-record read returned `CredentialMissing` in 2,235 ms through exact v1 reader; this did not reproduce a five-second timeout. The failure cause remains unknown.
- [x] Controlled synthetic save/readback and cold-read succeeded and own test records were cleaned. Actual production slot mapping/ledger also succeeded in an isolated profile. First slot runner lost its failed attempt stdout; its cause is unknown, not evidence of a product root cause.
- [x] Candidate parent-only policy: bounded 30-second background transport budget and closed diagnostic stages. Original v1 source closure, bytes, signature, protocol and authentication checks remain unchanged. This mitigates budget pressure but does not establish the original failure cause; synchronous signature preflight remains a soft timing boundary.
- [x] Parent tests 41 passed (two ignored OS/subprocess entries), strict parent Clippy, packaging gate tests 13 passed, default and MoX production cargo checks; root MoX AgentNet regression 148 passed (one subprocess entry ignored). Local root tests required installed Apple Swift archive/runtime search paths, with failed environment attempts preserved. Headless dependency graph retains original crypto, not parent.
- [x] Independent review fixed snapshot TOCTOU and a production-only diagnostic type error; input mutation regression covers verified bytes snapshots.
- [ ] Combined latest-main checks, full packaging provenance and native acceptance.
- [ ] Signed candidate, personally authorized installation, actual migration and prompt-free cold start/update acceptance.
- [ ] Actual Host model settings and disabled Agent create/readback after the server deployment owner completes its maintenance. No paid inference.
- [ ] Credential PR14 native gate, remote main delivery and exact installed-source verification.

## Ownership and limits

Primary agent owns integration, packaging, installation and overall acceptance. The sidebar owner has returned the native UI window. The cloud owner controls server maintenance; do not overlap Host writes with it. The synthetic probe worker may only query a wholly synthetic nonexistent scope through the unchanged reader, without authorization mode or real credential reads/writes. OS permission windows remain human-only.

Private artifact, runtime and diagnostic receipts are under `combined-desktop-rebuild` in the task's private QA directory; do not commit raw logs, credentials, identity-bearing URLs or account data. This worktree starts at frozen a8a60f1c and preserves its sidebar code. It does not include subsequent main or pending Host configuration changes until explicitly integrated and checked.

Current integration: accepted main 863f4b40 includes title generation and cf741f Host configuration. Windows CI caught a macOS-only parent dev dependency entering its build; both parent dependencies are now target-scoped to macOS. Raw source fingerprints remain enforced. macOS graph includes parent; Windows/Linux graphs exclude it. Installed a8 Shell identity was verified, but installed Node server currently stamps 506be6de/dirty; this invalidates any claim of unified source provenance for that installation. The new package gate must independently check server identity, all freshly built bundles, extraction and installed resources. Native migration still failed after old credential validation; no automatic retry.
