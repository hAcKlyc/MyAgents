<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/context-recovery-20261017 -->
<!-- git-project-sync-task:base=85b1d2bea8f71a4ccbc9ee7a0a6badb072bab2bf -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-CONTEXT-RECOVERY-20261017

## Objective and authorization

User requested durable fixes for effective context budgeting, native compaction failure classification, automatic recovery and the original Goal continuation without repeating business operations, followed by CI/main and release under project workflow. Existing single deployment owner remains 01a12bc2-907a-7702-b6dd-788225c5dfe4; no concurrent release or interruption of daily tasks.

## Acceptance criteria

- [x] Identify incident: provider-declared1,024,000 vs explicit upstream context overflow at341,052; failed native compact incorrectly marked successful; Goal blindly retries10 then blocked.
- [x] Verify remote/source/base and create isolated worktree; preserve other worktrees.
- [x] Establish route-scoped effective budgeting for SDK compaction and UI without claiming configured capacity was verified.
- [x] Treat compact_result failed as failure even with SDK outer success.
- [x] Recover using existing lifecycle authority, preserve native tool results and original Product Session/Goal, bounded operation with backup/rollback.
- [x] Verify exact tool/input completed/uncertain replay gates, including cancel/restart/write-ahead reservation. Semantic changed-input duplicates require downstream idempotency; see contract.
- [x] Focused JS/DOM tests and actual SDK manual/auto compact + same-Session Query restart + counter=1 acceptance. Rust same-Goal tests implemented; native compilation awaits CI.
- [ ] Independent review, source/affected checks and CI; integrate latest main and verify remote contains final code.
- [ ] Existing deployment owner serial release, signed artifact/runtime/version/user-path evidence; never equate main/CI with published.

## Execution

Primary owns implementation, integration and acceptance. Read-only scoped reviewers recovery_architecture and goal_recovery_review requested gpt-6.1-sol/high for native replay and cross-process lifecycle risk. Pure native mode; no external model requests. No models/effort upgrades. Usage not measured.

## Evidence and next action

Private incident/restoration evidence under local output/session-recovery-20261017 (outside Git); never commit user session, credentials or business data. Implement shared policies and scoped regressions, then verify live SDK behavior before release.

## Verification

Contract `specs/tech_docs/context_recovery.md`; acceptance `dev-docs/context-recovery-20261017/acceptance.md`. Focused130 tests passed, real SDK manual/auto compact and durable ledger restart passed. CI/main/release pending. Workers follow-up usage-limited; primary accepted and repaired assembled implementation. Next: commit, merge latest main, run CI and main ancestry verification; release remains sole-owner serial.

PR https://github.com/heavenzhang/MoXBots/pull/96; main148c51bc integrated without conflicts. Additional hardening: same-history armed tombstone blocks missing-ledger restart, and explicit route override/official isolation integration test. Six CI gates running; no release yet.

## Completed

Implemented and committed recovery/budget/failure classification, same-Goal pause/resume plumbing, immutable request archives and restart-safe write-ahead action protection. Synced current main without conflicts, pushed reviewed branch and opened PR96. Real SDK manual/automatic compact, native failure regression, durable restart and exact-action duplicate counters passed. Existing original recovered payroll Goal store currently reports complete/0 consecutive failures; this is runtime state, not business acceptance.

## Blockers and unknowns

Six exact-head CI checks are required before main merge. Local Rust is blocked by pre-existing Swift PackageDescription linkage; no native compilation pass claimed. Real commercial capacity, signed next release, installation/Reader and original business-path acceptance remain separate gates. Sole deployment chat owns the next unfrozen release. Cross-session messaging requires explicit human authorization to that specific chat; no new message sent yet. Independent follow-up reviewer workers are usage-limited; primary owns assembled-source review. Tokens/cost unavailable.

## Next step

Wait for PR96 exact-head six checks; repair any real failures, merge normally, verify fresh remote main contains the accepted commits. Then hand the concrete release record to the existing publisher with explicit messaging authorization and retain all active-session/install gates.

Integration repair: incoming main continuous-watch lint/legacy-route/receipt regressions fixed without disabling checks; real loopback route tests replace fixed-port placeholders. Related73+48 tests, merged full lint/typecheck passed. Recovery finalization cleanup now rechecks paused control revision under lifecycle lock; SDK thrown-error path retains the structured recovery code. Exact-head CI rerun required.
