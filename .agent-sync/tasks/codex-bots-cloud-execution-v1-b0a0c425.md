<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/bots-cloud-execution-v1 -->
<!-- git-project-sync-task:base=b421b759180fb36432186dbbbda42b11eb0d3a1c -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: BOTS-CLOUD-EXEC-001 finite Host-delegated Bot execution

## Objective

BOTS-CLOUD-EXEC-001 implements the finite Bot delegation approved by the user. Use Host outbound authenticated polling and scoped short execution leases, preserving existing same-principal pair/relay authority. Team contract: services/agentnet/planning/BOTS-CLOUD-EXECUTION-CONTRACT.md. First-stage registry PR20 is tracked separately.

## Acceptance criteria

- [x] Closed schema/canonical hash/cross-language fixtures and typed signer domain checks.
- [x] Actual authority/ledger implementation and cryptographic service fixture gates; production remains separate.
- [x] Host-local implementation, exact proof/runtime identity, final receipt outbox and protected policy pin; Linux-specific tests still pending.
- [ ] Real outbound transport/Host hook, actual UI flows, original operation recovery and restart validation.
- [ ] Actual CI/main/remote delivery, approved roles/Host opt-in and serial release/acceptance.

## Completed

User architecture approval, source/owner read-only audit and minimal polling contract prepared. Start/task-init gate passed on canonical main b421b759; independent registry branch not used as a new task base. Worktree isolated, existing dependencies reused after lockfile/package byte comparison.

## Verification

Integrated local verification: service89 passed/2 manual ignored; headless99/99; closed core5/5 and Node parity7/7. Host unit22 passed/2 Linux-only skipped; actual worker/private regression and bounded child stop6/6 integration. Typecheck/full lint, both all-targets clippy and format checks, Host+Session bundle smoke pass. UI fixture tests are synthetic and do not prove Linux Host effects. Original registry production acceptance belongs to BOTS-CLOUD-ADMIN-001; no paid model invocation.

## Blockers and unknowns

PR14 connector/IPC/main APIs actively owned by separate Host task; coordinate thin hook integration against fixed SHA. Platform administrator role was explicitly approved and registry release accepted separately. Specific Bot/Host protected opt-in and grant activation still require concrete permission. Actual model inference/fees, full runtime or multi-Bot parallelism are not claimed. Token/cost unknown.

## Next step

Finish independent UI gates, commit/push implementation and synchronize latest main; await the verified existing Linux Host management baseline (PR14) before integrating/releasing Node/connector hooks. Get exact protected opt-in only after the source/artifact/rollback is reviewable. Native/Node hooks are disabled by default; do not deploy a main-based Host artifact over deployed PR14 management/credential hooks.
