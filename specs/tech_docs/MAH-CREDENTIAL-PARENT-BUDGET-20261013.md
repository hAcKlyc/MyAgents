# MAH-CREDENTIAL-PARENT-BUDGET-20261013

Goal: complete MoXBots credential migration, cold start and update recovery, then accept remote Linux Host configuration with the existing test identity. Keep MyAgents, original credentials, device identity and immutable reader v1 intact. No model key or paid model call is needed for this acceptance.

## Current evidence

- [x] Exact 6ac923a6 package installed after human approval; normal App startup verified.
- [x] Human completed OS authorization; application logged validated legacy session and device key.
- [ ] New credential routing commit: migration returned credential-store unavailable after validated key. A missing routing ledger does not prove absence of a partially written OS entry. Do not delete either entry or retry authorization automatically.
- [x] Exact a8a60f1c joint package approved, installed and cold-started; signed executable matches its package. Original 6ac and b116 App backups remain available.
- [x] Independent native sidebar acceptance: reversible chat and Agent moves, section creation/rename, keyboard section ordering and restart persistence; temporary sections removed. Native pointer section ordering and multiple-Agent/multiple-chat ordering remain unproven; do not claim them passed.
- [ ] Diagnose the migration failure using a synthetic missing-record request and equivalent App resources. Five-second background operations include parent and child signature verification; this is a hypothesis, not a confirmed root cause.
- [ ] If confirmed, isolate a parent-only budget adjustment and closed diagnostic stages without modifying the original reader v1 source closure, bytes, signature, protocol or authentication checks.
- [ ] Appropriate default/MoX/Linux compilation, source and packaging provenance, protocol/cancellation tests and independent review.
- [ ] Signed candidate, personally authorized installation, actual migration and prompt-free cold start/update acceptance.
- [ ] Actual Host model settings and disabled Agent create/readback after the server deployment owner completes its maintenance. No paid inference.
- [ ] Credential PR14 native gate, remote main delivery and exact installed-source verification.

## Ownership and limits

Primary agent owns integration, packaging, installation and overall acceptance. The sidebar owner has returned the native UI window. The cloud owner controls server maintenance; do not overlap Host writes with it. The synthetic probe worker may only query a wholly synthetic nonexistent scope through the unchanged reader, without authorization mode or real credential reads/writes. OS permission windows remain human-only.

Private artifact, runtime and diagnostic receipts are under `combined-desktop-rebuild` in the task's private QA directory; do not commit raw logs, credentials, identity-bearing URLs or account data. This worktree starts at frozen a8a60f1c and preserves its sidebar code. It does not include subsequent main or pending Host configuration changes until explicitly integrated and checked.
