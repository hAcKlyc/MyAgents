<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/bots-cloud-execution-v1 -->
<!-- git-project-sync-task:base=b421b759180fb36432186dbbbda42b11eb0d3a1c -->
<!-- git-project-sync-task:status=complete -->
<!-- git-project-sync-task:scaffold=false -->

# Task: BOTS-CLOUD-EXEC-001 finite Host-delegated Bot execution

## Objective

BOTS-CLOUD-EXEC-001 implements the finite Bot delegation approved by the user. Use Host outbound authenticated polling and scoped short execution leases, preserving existing same-principal pair/relay authority. Team contract: services/agentnet/planning/BOTS-CLOUD-EXECUTION-CONTRACT.md. First-stage registry PR20 is tracked separately.

## Acceptance criteria

- [x] Closed schema/canonical hash/cross-language fixtures and typed signer domain checks.
- [x] Actual authority/ledger implementation and cryptographic service fixture gates; production remains separate.
- [x] Host-local implementation, exact proof/runtime identity, final receipt outbox and protected policy pin; Linux exact-head acceptance remains open.
- [x] Actual Linux Host outbound transport/Session hook, original operation replay/CAS, restart persistence and six lifecycle methods accepted.
- [x] CI/main/remote source delivery, approved role/single-Bot finite opt-in and actual serial release/acceptance.

## Completed

User architecture approval, source/owner read-only audit and minimal polling contract prepared. Start/task-init gate passed on canonical main b421b759; independent registry branch not used as a new task base. Worktree isolated, existing dependencies reused after lockfile/package byte comparison.

## Verification

Integrated local verification: service89 passed/2 manual ignored; headless137/137; codec11/11; closed core5/5 and Node parity7/7. Host unit22 passed/2 Linux-only skipped; actual worker/private regression and bounded child stop6/6 integration. Typecheck/full lint, both all-targets clippy and format checks, Host+Session bundle smoke pass. UI fixture tests are synthetic and do not prove Linux Host effects. Original registry production acceptance belongs to BOTS-CLOUD-ADMIN-001; no paid model invocation.

## Current outcome and limits

First finite builtin lifecycle scope is released and actually accepted. Main75 contains the implementation and its seven required checks passed; real IAB/Owner/admin and Node/native effects, exact worker exit, original replay/CAS, restart persistence, soft-delete/new-grant restore and effective revocation passed. Final Bot is restored, no worker/Session remains, both grant generations are revoked and all seven receipts ACKed. Detailed trace/source/artifact/rollback evidence: `services/agentnet/validation/BOTS-CLOUD-EXEC-001-LINUX-ACCEPTANCE.md`.

Shared use, paid inference, other Runtime, true second-user validation and extended IAM writes remain future scope, not a failed gate for the approved single-Bot lifecycle. Actual model/effort/token/cost metrics are unavailable. Later main Host/client improvements are preserved in Git but were not installed by this75 runtime release.

## Next step

Continue future account/role/Host/Bot capabilities only inside the single MoXBots cloud administrator console. Do not create additional login/account/Bot back offices. User-facing client login continues with the common auth service; Bots Net is the personal product surface. New specific Host authority or model invocation needs its applicable authorization; do not reuse the closed acceptance grant or silently extend expired policy.

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

Exact source c5f6c9bf passed all seven required checks, including the full Linux unit/DOM/integration/build pools, service/core validation and native/Windows/macOS gates. The fixed expiry scenario passed on Linux. PR23 is ready; concurrent accepted sidebar PR25 main c21e9f43 changed only renderer/docs and required preserving both append-only task records before merge. Host/service production source is unchanged by this integration; latest-head CI is still enforced. Local myagents-test Node24.20/SDK0.3.296 candidate is clean/source-pinned, but deployment and specific finite opt-in are not complete.

## 2026-10-14 — main delivery and approved finite activation

PR23 is merged at main75bb0269ff471973f1b7e594ab279f824b777e9e; the task source and all seven required checks are accepted. Main Test run38420752527 is successful after rerunning only the macOS queue-cancelled job; Owned run38420752530 is successful. Concurrent accepted renderer/resume/documentation main changes are preserved; this release deliberately uses the tested75 runtime baseline.

The default-off Linux upgrade is accepted: local clean Node sourcec5f6c9bf (Host critical tree matches75), Node24.20.0/SDK0.3.296, and authenticated CI native test-merge sourceb0235d7d (whole source tree equals75). Original management, credential namespace, service UID/groups and profile remain intact. Software directory permission preflight was strengthened after two failed default-off attempts; each restored the original services. Failed evidence and consistent root-private backups are retained. No unrelated desktop/Keychain/Mori/Dex deployment was performed.

The human explicitly authorized the concrete existing lifecycle acceptance Bot, for at most24h and only create/configure/enable/disable/delete/restore in its UUID path. The policy is installed with a shorter expiry capped by the existing Host account lifetime. Native socket/permissions and ready network are verified; no Bot grant or Session business effects are yet accepted. This fulfills the specific opt-in permission gate and must not be requested again.

Cloud75 main CI artifact archive/source/executable hashes are verified locally. Target transfer/ABI, cloud execution activation, actual owner UI grant, six lifecycle effects, exact child exit, persistence/replay/CAS and effective revocation remain open. Slow binary transfer is a transport issue; cloud remains at the registry release until artifact verification and serial switch. Private files contain actual identifiers, accounts and deployment evidence; public Git records only source, checks and evidence roles. Model invocation and future shared use remain outside this lifecycle-only slice.

## 2026-10-14 — actual release acceptance completed

Cloud main75 artifact and Node/native runtime source/hashes are verified on the real targets. Six methods produced six persisted success receipts; one deliberate stale-revision operation produced a conflict and unchanged snapshot. Original replay/mismatch409, exact child exit, actual restart and final effective revocation were independently verified. Current live/account details and original receipts remain private. Linux source/model-call boundary and truthful UI/pending states are not weakened.

The previous preparation/gate entries are historical; the completed current criteria and linked acceptance record supersede them. The latest user instruction requires one unified cloud console, including user/login administration as future modules of that same platform; no additional back office is planned.
