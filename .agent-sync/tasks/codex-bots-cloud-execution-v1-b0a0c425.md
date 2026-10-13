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

## Preserved Host baseline and repair evidence

Draft PR23 holds the default-off implementation. Fixed9149753 Linux Host modules (matching deployed b98294c7) and native management dependencies were integrated without Desktop/Keychain/installer changes or modifications to the other owner's checkout. Native137/137 and codec11/11 pass locally. Host mixed integration40 passed/10 Linux-only skipped; Node focused22/2 skipped, typecheck and independent UI gates pass. Full lint is rerun with the versioned UI runner.

Initial PR23 Linux gate found metadata-core format errors and two test precondition errors: secure creation requires an existing private relative-path parent, and the tombstone proof must first fit policy expiry. These were repaired without relaxing source gates; latest-head Linux validation is still required. Concurrency review found actual lock inversion and whole-config replacement; both were repaired and covered by bounded completion and projection preservation tests. Missing optional policy now leaves legacy Host off/usable; existing authority still gets full path/hash validation.

No execution release or real Host effect is claimed. Specific finite opt-in, artifact provenance/rollback and primary production acceptance remain open. No model calls or external workers; requested native roles used Luna/medium for implementation/UI and Sol/high for cross-language/native authority. Actual runtime model/effort/tokens/cost are unavailable.
