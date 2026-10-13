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
- [x] Host-local implementation, exact proof/runtime identity, final receipt outbox and protected policy pin; Linux exact-head acceptance remains open.
- [ ] Actual Linux Host outbound transport/Session hook, original operation recovery and restart validation (synthetic UI and local hooks are accepted).
- [ ] Actual CI/main/remote delivery, approved roles/Host opt-in and serial release/acceptance.

## Completed

User architecture approval, source/owner read-only audit and minimal polling contract prepared. Start/task-init gate passed on canonical main b421b759; independent registry branch not used as a new task base. Worktree isolated, existing dependencies reused after lockfile/package byte comparison.

## Verification

Integrated local verification: service89 passed/2 manual ignored; headless137/137; codec11/11; closed core5/5 and Node parity7/7. Host unit22 passed/2 Linux-only skipped; actual worker/private regression and bounded child stop6/6 integration. Typecheck/full lint, both all-targets clippy and format checks, Host+Session bundle smoke pass. UI fixture tests are synthetic and do not prove Linux Host effects. Original registry production acceptance belongs to BOTS-CLOUD-ADMIN-001; no paid model invocation.

## Blockers and unknowns

Host foundation PR24 is accepted in remote main fb92ce9c; synchronize that owner result while preserving finite Bot hooks and locking repairs. Platform administrator role was explicitly approved and registry release accepted separately. Specific Bot/Host protected opt-in and grant activation still require concrete permission. Actual model inference/fees, full runtime or multi-Bot parallelism are not claimed. Token/cost unknown.

## Next step

Finish exact-head Linux gates after merging accepted PR24 main; pin CI artifacts, obtain the non-secret account binding through the protected owner, and prepare the single-Bot release/rollback. Get exact protected opt-in only after the source/artifact/rollback is reviewable. Native/Node hooks are disabled by default; preserve deployed management/credential state and profile during the coordinated release.

## Preserved Host baseline and repair evidence

Draft PR23 holds the default-off implementation. Fixed9149753 Linux Host modules (matching deployed b98294c7) and native management dependencies were integrated without Desktop/Keychain/installer changes or modifications to the other owner's checkout. Native137/137 and codec11/11 pass locally. Host mixed integration40 passed/10 Linux-only skipped; Node focused22/2 skipped, typecheck and independent UI gates pass. Full lint is rerun with the versioned UI runner.

Initial PR23 Linux gate found metadata-core format errors and two test precondition errors: secure creation requires an existing private relative-path parent, and the tombstone proof must first fit policy expiry. These were repaired without relaxing source gates; latest-head Linux validation is still required. Concurrency review found actual lock inversion and whole-config replacement; both were repaired and covered by bounded completion and projection preservation tests. Missing optional policy now leaves legacy Host off/usable; existing authority still gets full path/hash validation.

No execution release or real Host effect is claimed. Specific finite opt-in, artifact provenance/rollback and primary production acceptance remain open. No model calls or external workers; requested native roles used Luna/medium for implementation/UI and Sol/high for cross-language/native authority. Actual runtime model/effort/tokens/cost are unavailable.

## Current integration gate

PR24 passed seven exact-head checks and merged to main fb92ce9c. The integration retains its accepted Host/native/installer/client base; finite execution hooks and Reg→supervisor/config projection fixes remain layered on top. Real cloud and Host read-only scope preflight confirms the declared Host is ready, no execution opt-in exists, and no Bot ledger or model reference was present. Single-Bot 24-hour lifecycle-only proposal is prepared privately; no production state was changed. Non-secret encrypted account-binding projection is needed to pin the operator policy without exposing credentials.

Linux fixture repair rounds: private intermediate path and grant expiry preconditions; controlled expired-read clock; and the immutable receipt ACK expected schema now checks the policy fingerprint. These are test corrections, not relaxations of production authority. All exact-head release gates remain required.

Post-PR24 integration local verification: typecheck, full lint, actual Host controller/private worker6/6 and focused Bot unit22 pass/2 Linux-only skipped. Extended build-script run247 passed/14 skipped/2 failed: Media Worker startup timeout passed on focused rerun; existing Darwin xattr fixture still expects permission denial where current OS returned success. That unchanged macOS-only test remains recorded as a local failure; required Linux CI is not waived or substituted.

## Protected binding pin and Linux recovery repair

The native run-only private account-context projection is implemented;140 tests/clippy/fmt passed. It emits only eight closed non-secret fields to a fixed, precreated600 file under the existing native0700 state directory, and preserves sealed account state. The operator matches actual PID/UID/source/freshness before using its account-binding UUID; this aid never enables execution. Actual running Node SupplementaryGroups already include the existing network IPC group; no group expansion is needed.

A stopped administrator registry candidate was created through real authorized OIDC/API to make the single-Bot opt-in reviewable. Its real IDs and receipt stay private; no Host grant/policy/effect or model invocation occurred. The large Linux lifecycle fixture is repaired around explicit current observations and CAS after restart recovery; fake adapter inspection now tracks unknown/stopped outcomes. The focused Linux policy/receipt gate runs before broad JS validation. Final Linux execution and production acceptance remain open.

The new early Linux gate exposed a production expiry-recovery defect at the final lifecycle stage: an exact confirmed stop cleared active_run but retained runtime_entry when the preceding inspect was running, failing strict ledger validation. The repair must remove the entry only on exact confirmed closure and preserve unknown identity/outcomes. No validation/schema relaxation or execution release is permitted to bypass this failure.
