<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/mah-auth-host-acceptance-20261014 -->
<!-- git-project-sync-task:base=644434fa685ee7e2ccc0d6421c95b5431aea1b0c -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# MOXBOTS-AUTH-HOST-20261014

Repository: https://github.com/heavenzhang/MoXBots.git
Branch: codex/mah-auth-host-acceptance-20261014
Base: 644434fa685ee7e2ccc0d6421c95b5431aea1b0c
Status: in-progress
Owner: root, integration and all real desktop/server operations. Workers: host_packaging owns account/sidebar login UI; host_plan_review independently reviews UI source; headless_runtime_review owns explicit same-account management renewal in native CLI/operator. Only root controls production, credentials, packaging and native integration. Exact worker model/effort/usage are not exposed; no model switch claimed. Native-only ai-yaoren-local was explicitly selected; no AIRouter calls.

## Objective

Finish real credential recovery and Host remote model configuration/disabled Agent creation, connect the MoX bottom-left account entry to the existing owned backend, then reviewed CI/main delivery and exact client/server acceptance. Preserve original MyAgents, credentials, local conversations and Host data. No paid inference, new model secrets, widened grants or unrelated public endpoints. Minimize keychain prompts: background stays noninteractive; explicit authorized migration once, stop on typed failure. OS passwords and browser security interstitials require human handling.

## Acceptance criteria

- [x] Verify main/remote, installed5f and prior failure evidence; isolate codex branch and task record.
- [x] Merge previous credential repair without changing frozen reader, coordinate account UI against existing Rust owner.
- [x] Diagnose invalid session; normal existing-account login and credential route persistence on installed5f. Both durable slots now developer-id-v2; no new OS authorization prompt in this normal login.
- [x] Implement MoX sidebar owned-account entry, read-only Rust account metadata, reauthentication and cancellation fences. Default MyAgents retains official account entry. Code/tests pass; real new-bundle UI remains open.
- [ ] Meaningful focused tests, independent source/UI review, signed package and source/CI verification.
- [ ] Real native login, prompt behavior on cold start/update, Host visible and remote model/Agent persist/readback.
- [ ] Review/sync latest main, pass CI, merge/push verify remote main and exact deployed runtime.

UI baseline: existing global sidebar and AgentNet dialogs; primary owns actual native/IAB journeys, read-only reviewer owns source/criteria and independent review. Required states signed-out, authenticated, authorization-required, invalid-session, offline, cancel and late response; account boundaries must never reuse official Space tokens. Runtime evidence stays in authorized external output, no credentials/session URLs in Git.

## Blockers and unknowns

Current installed candidate is114e2ac5; the public download remains the older5f1a8feb. Human explicitly approved updating/opening114; root installed it with app/data backup and exact resource/hash verification. A normal existing-test-account sign-in repaired its expired owned session and saved both fixed-family slots, without new keychain prompts. Cross-update startup restored the owned account and both devices without an OS authorization prompt; controlled114 cold restart remains open. Prior explicit a838 migration failed at destination save, never repeat it. Two candidates built but only5f installed;84fd unrun. Exact source tests/CI from prior phase remain evidence of their own source only. Goal tool retains historical blocked status and exposes no resume mutation; user explicitly resumed work, no inference of pause or completion.

## Completed

- Desktop account UI reuses the existing AgentNet registry/login owner, fixed configured issuer and actual principal/expiry projection. No extra credential store or official Space token reuse. Session validity uses the existing noninteractive account guard plus expiry validation.
- UI review repaired stale issuer/account generations, unmount cancellation, and cancel-failure retry. Two source-review repair rounds; final independent review found no new deterministic blocker. Real visual/interaction/responsive acceptance awaits the exact new signed app.
- Root independently passed 111 DOM cases (owned/official account, network selector, sidebar), typecheck, 7 grant-renewal cases, 2 CLI cases and 6 operator cases. Native registry 14-case verification passed after final expiry-owner reuse; final result recorded outside Git.
- Linux101 Node service/data remain intact. Its same-account normal login was renewed through real IAB authorization and existing operator wait. Connector then correctly rejected the changed account binding with HOST_MANAGEMENT_REBIND_REQUIRED. No encrypted grant was deleted or overwritten.
- Added explicit owned-management-renew / renew-management: existing exact scope/principal only, profile run lock, server-validated session, CAS of old bytes, fail-closed unknown writes/readback, no join/start/policy expansion. Worker tests/clippy passed; root code review and focused rerun passed. Exact-tree Linux artifact was verified and deployed; explicit renewal returned renewed, second renewal unchanged, existing unit/dropins unchanged, same NodePID74632, new connectorPID516580 ready. Real desktop remote mutation acceptance remains pending.
- Native window lease returned to root. After explicit human approval, root normally quit old5f, verified and gracefully stopped two orphan MoX sidecars, backed up application/data, installed114 and verified actual PID10690/source/resource hashes. New bottom-left account shows the owned cloud trial; Linux-Host and local Mac both online. No keychain prompt during this update/startup.

## Verification

Signed new macOS candidate source114e2ac50794d7c1f245ba2efa06dbe844f60d22 was built clean, Developer ID signed, 19 resource groups and extracted ZIP verified; frozen reader bytes preserved. ZIP346339034 bytes, SHA256 ae652ec5f2d91a4f7752617847e7af19d6b8ac7cdbfef0bf2951137e1370f169. Not notarized; installed and actually opened after concrete approval. Published5f download remains unchanged until new real acceptance.

Linux CI run38537585674/artifact11880996895 commit9dc0a7ef104f2e6995d1c48dca2e045967ab7569 has the exact114e2ac5 source tree0f256faafd5e6d05042b686bec289ac19bbd2cde. Archive digest acaad15839634d8d2274d119b6fa8b03138903cf9708b54dd1664193c9457634; native b9497dd310e41711fa1f6b867f922afc8ff270fc0872e2604bc835772ec046c0. Existing root-private backup/rollback /root/moxbot-auth-renew-114e2ac5. No original namespace or finite-policy renewal.

Evidence (private/local, no tokens committed): workspace pointer output/auth-host-20261014 has credential-recovery-progress.json, frontend-tests.log, typecheck.log, native-check.log/native-registry-tests.log. Headless focused logs /tmp/moxbot-renew-*.log. Login URLs/receipts are only in mode0600 private output, never in Git. Frozen publisher reader remains unchanged.

## Current real-integration finding

- Human explicitly approved114e2ac5 update/open. Root installed and opened it with exact inventory/hash checks, app/data backup and normal old-process exit; actual native PID10690. New bottom-left account restored the owned cloud and both devices online without an OS prompt. Root then verified normal quit and native process exit, cold-start PID43585, automatic account/two-device recovery without login/recovery clicks or keychain prompt. Original MyAgents stayed running.
- Real management reads exposed a strict contract mismatch: Node forwarded the full ready diagnostic to Rust AgentNetStatus (only available/reason). Narrow projection preserves full local doctor diagnostics and strict schema. Root19 focused Node tests/typecheck passed, independent Rust20 codec/validator tests and Clippy passed; source review confirmed. Exact clean Node bundle df10990f deployed with state/unit/link backups at /root/moxbot-ready-fix-df10990f, unit/dropin bytes unchanged.
- Linux upgrade exposed missing management IPC ESTAB despite ready status. Paired ordered restart (native572655 then Node573254) restored ESTAB; no grant/policy expansion. Independent review identified a Node connect-to-attach close-listener gap capable of accepting an already-closed socket; deterministic regression/repair in progress.
- With IPC restored, real114 desktop now reports HOST_MANAGEMENT_RESPONSE_INVALID (not transport timeout). Second deterministic mismatch: strict frontend ExtendedSnapshot omitted capabilities/agentNet/runtime present in Rust DTO. API/interface repaired, actual complete DTO acceptance/unknown-field rejection regression8 passed. Existing16 DOM fixtures corrected to full protocol DTO,21 DOM tests passed. This is still simulated UI evidence until a corrected package runs.
- Actual account click exposed CSS contract mismatch: footer pointer-events:none only re-enables data-global-account-trigger, while new button lacked it. Minimal marker repair and13 DOM cases pass. Root independently reviewed both client changes.
- Frozen intermediate16ea5243 built clean with fresh assets; not installed/published. Main5315ac69 website-branding changes were subsequently merged, to include the user's latest main improvements in the final candidate. Current114 remains installed. Final candidate build, signature/resources/ZIP validation and concrete update approval precede real config save/Agent creation acceptance.
- Seven checks passed ed91; newer exact source CI and final combined tests remain gates. Public5f download is unchanged; PR14 remains draft and unmerged. Goal tool still reports historical blocked and has no resume mutation; user explicitly resumed, work continues without claiming completion.

Evidence remains external output/auth-host-20261014: cold-start-114-receipt.json and cold-start-114-network.png; package/ installed/start/approval receipts; linux-ready-fix/ archive and deployment helper; package-16ea5243/ clean intermediate build provenance. Do not commit credentials, auth links or backup contents.

## Next step

Finish Node IPC close-race regression/repair, commit coherent checkpoint, freeze one final candidate after main5315 integration. Run combined tests/CI and signed package/resource/extraction validation; update Linux through existing isolated services with exact-source rollback. Then concrete new-package approval, real model save preserving the existing test credential, disabled Agent creation and directory/readback/restart persistence. Only after those gates merge PR14, verify remote-main/runtime, and refresh public trial download. No paid inference, credential widening or finite execution-policy renewal.
