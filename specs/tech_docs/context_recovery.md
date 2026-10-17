# Builtin API context recovery

Owner: existing builtin Query token, bridge, SessionStore and Rust SessionGoalManager. Task: MOXBOTS-CONTEXT-RECOVERY-20261017.

## Capacity and compaction

An API provider's model `contextLength` is declared capacity, not evidence that every upstream route accepts that size. Non-managed third-party API-key routes default to a 200,000-token operational compaction budget, capped by a smaller declared window. A model row's explicit `contextCompactionWindow` can raise/lower this budget; it never raises declared capacity. Native model aliases still derive `[1m]` from declared capability. The SDK compaction window and UI denominator share the operational policy. The UI identifies operational budgets separately. Official Anthropic, subscription/managed endpoint and cloud-scoped authority retain their existing policy.

## Inference-only repair

Only explicit context-overflow responses (400/413/422) trigger one reduced inference retry. Generic HTTP400 pauses the Goal as an invalid request. Before retry, SessionStore commits the complete request into a private, content-addressed, immutable archive. Reduction preserves every system instruction, user text, tool name/input/ID, paired result ID and latest two messages. Only older bulky assistant text/tool evidence is excerpted with archive references and hashes. Internal SDK system messages are preserved. Unknown block shapes, missing/uncertain tool pairs, inadequate reduction, background work, concurrent inference, stale tokens and cancellation stop automatic repair. Native histories are never rewritten and queue turns are never replayed.

SSE delivery remains admitted until message_stop. Partial streams seal the request against implicit replay. Native /compact success creates the SDK's own compact_boundary. Its explicit compact_result=failed overrides an outer SDK success result. Structured failure codes pass through the JS terminal outcome to Rust; Rust pauses the same Goal, preserving objective/progress and explicit resume, instead of ten identical retries ending in a terminal blocked Goal.

## Action protection and persistence

Once repair is armed, a Query-level ledger keys business actions by tool name plus canonical JSON input, independently of native tool IDs. Known successful actions are denied with prior evidence; Read/Grep/Glob remain repeatable. Every newly allowed business action first reserves an uncertain entry durably, then commits success from PostToolUse. A crash or failure between these commits leaves an uncertain action that must be checked read-only before further automatic execution. Ledger commits serialize within the controller and validate the current Product/native-history owner in SessionStore. A new Query restores the same-history ledger, including after native compaction has removed old tool pairs. Corruption, write failure and ledger capacity exhaustion fail closed. An immutable same-history armed marker also makes a missing ledger fail closed.

Private files: `<app-data>/context-recovery/<product-session>/`: SHA256 request JSON and `ledger-<native-session>.json`, directory0700/files0600. Ledger<=16MiB/2048 distinct actions; immutable archives<=128 and256MiB total, each<=64MiB. Limits stop automatic recovery without deleting evidence. Existing Product/native transcripts remain authoritative; archives are operational evidence, never source-controlled. Different native histories use distinct ledgers.

This is exact tool/input replay protection, not distributed exactly-once delivery: semantically equivalent operations with changed arguments require business-system idempotency keys and receipts. A tool must report its real success/failure; an ambiguous result is never proof of success. Downgrading to an older binary that lacks these gates requires pausing affected Goals and preserving/exporting their checkpoints first. Do not let the old version automatically continue recovered business work.

## Acceptance

Run the focused unit/integration/DOM tests and `node --import tsx/esm scripts/verify-context-recovery-loopback.ts`, plus `--auto`. The latter uses the real SDK with isolated HOME, synthetic loopback suppliers and an actual MCP counter; zero paid requests/business records. It asserts authentic native compaction, same native Session, restart from durable ledger, duplicate under a new tool ID denied and counter=1. Rust tests cover same Goal pause/resume/reload/finalization and dispatch fallbacks. Real provider capacities, production signed package/install and original payroll business completion require separate release/user-path evidence.
