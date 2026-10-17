# MOXBOTS-CONTEXT-RECOVERY-20261017 acceptance

## Implemented

Operational API compaction budgets; explicit native compaction failure overrides misleading outer SDK success; bounded inference-only context reduction; private immutable archives; durable write-ahead action ledger; new-ID duplicate protection; original Rust Goal pause/resume with structured codes. See [contract](../../specs/tech_docs/context_recovery.md).

## Verified locally

- Focused recovery/budget/turn lifecycle/Goal JS/SessionStore/indicator: 130 tests across8 files passed. Persistence subset34 passed. Typecheck and focused ESLint passed. Dependency check:0 errors,17 existing orphan warnings.
- Real SDK0.3.296 manual compact:147937-byte history reduced to11072, authentic manual compact_boundary, new Query resumed same native Session, duplicate denied1, counter1,3 archives,8 loopback requests.
- Real SDK automatic compact:147568-byte history reduced to10703; SDK emitted trigger=auto, pre_tokens225002/post_tokens547 with synthetic usage. Restart resumed same Session, duplicate denied1, counter1,4 archives,8 loopback requests. These are synthetic upstream usage numbers, not measured commercial capacity or billing.
- Native scripts use isolated temporary HOME and actual MCP tools; no paid provider requests or production writes. Full private JSONL/logs/receipts retained outside Git. Request/archive checksums and ledgers are private.
- Server bundle and web build passed, including existing theme tests. Minor UI label is covered by real component DOM hover assertion; no page redesign.

Additional final checks: 24 SDK environment tests include an explicit512K operational override while retaining1M declared aliases and official-route isolation. Same-history missing-ledger tombstone regression is covered. PR: https://github.com/heavenzhang/MoXBots/pull/96.

## Open gates

Full CI Rust/OS checks and final main ancestry; signed next-version release via the existing sole deployment owner; installation only when daily tasks are idle and required local unlock/backup gates hold; fresh installed-version/provider/real business-path validation. An SDK loopback fixture does not prove completion of the original payroll Goal.

Local debug cargo tests could not reach test compilation: the installed Command Line Tools Swift PackageDescription link fails in existing native dependencies. No stub, global toolchain change or lowered test gate was used. Rust CI is required before integration.

## Execution

Primary owns integration/acceptance. Bounded native workers implemented bridge, pure budget policy and Rust Goal handling; requested models: gpt-6.1-sol/high for replay/cross-process risk and gpt-6-luna/medium for pure policy. Follow-up independent review workers became unavailable due account usage limits; primary reviewed the assembled diff and repaired persistence/restart and real-SDK internal-system compatibility. No external model dispatch. Token/currency totals unavailable. Native fixture needed two substantive repairs (SDK internal system messages; fixture's native evidence summarization), and was rerun successfully. Safety depends on exact action identities/real tool outcomes; changed-argument semantic duplicates require downstream business idempotency.

Final assembled-source review added the post-recovery-new-action case: a new action commits successfully, a new-ID duplicate is denied, and inference continues rather than misclassifying that denied call as an uncertain business failure. All34 controller tests passed; real SDK manual/auto/failed compact fixtures rerun after the change.
