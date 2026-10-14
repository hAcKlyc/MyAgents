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

Current installed/released trial is5f1a8feb, not the unified candidate with this turn's account UI. A normal existing-test-account sign-in repaired its expired owned session and saved both fixed-family slots, without new keychain prompts. Root did not yet perform controlled cold restart/update acceptance. Prior explicit a838 migration failed at destination save, never repeat it. Two candidates built but only5f installed;84fd unrun. Exact source tests/CI from prior phase remain evidence of their own source only. Goal tool retains historical blocked status and exposes no resume mutation; user explicitly resumed work, no inference of pause or completion.

## Completed

- Desktop account UI reuses the existing AgentNet registry/login owner, fixed configured issuer and actual principal/expiry projection. No extra credential store or official Space token reuse. Session validity uses the existing noninteractive account guard plus expiry validation.
- UI review repaired stale issuer/account generations, unmount cancellation, and cancel-failure retry. Two source-review repair rounds; final independent review found no new deterministic blocker. Real visual/interaction/responsive acceptance awaits the exact new signed app.
- Root independently passed 111 DOM cases (owned/official account, network selector, sidebar), typecheck, 7 grant-renewal cases, 2 CLI cases and 6 operator cases. Native registry 14-case verification passed after final expiry-owner reuse; final result recorded outside Git.
- Linux101 Node service/data remain intact. Its same-account normal login was renewed through real IAB authorization and existing operator wait. Connector then correctly rejected the changed account binding with HOST_MANAGEMENT_REBIND_REQUIRED. No encrypted grant was deleted or overwritten.
- Added explicit owned-management-renew / renew-management: existing exact scope/principal only, profile run lock, server-validated session, CAS of old bytes, fail-closed unknown writes/readback, no join/start/policy expansion. Worker tests/clippy passed; root code review and focused rerun passed. Exact-tree Linux artifact was verified and deployed; explicit renewal returned renewed, second renewal unchanged, existing unit/dropins unchanged, same NodePID74632, new connectorPID516580 ready. Real desktop remote mutation acceptance remains pending.
- Installed5f native window is temporarily held by the project-board owner for already authorized remaining acceptance. Root does not concurrently operate/install/restart it; user has since unlocked; board owner temporarily holds the unchanged5f for controlled restart/readback. New114e2ac5 has not been installed. This does not block source verification.

## Verification

Signed new macOS candidate source114e2ac50794d7c1f245ba2efa06dbe844f60d22 was built clean, Developer ID signed, 19 resource groups and extracted ZIP verified; frozen reader bytes preserved. ZIP346339034 bytes, SHA256 ae652ec5f2d91a4f7752617847e7af19d6b8ac7cdbfef0bf2951137e1370f169. Not notarized or installed. Published5f download remains unchanged until new real acceptance.

Linux CI run38537585674/artifact11880996895 commit9dc0a7ef104f2e6995d1c48dca2e045967ab7569 has the exact114e2ac5 source tree0f256faafd5e6d05042b686bec289ac19bbd2cde. Archive digest acaad15839634d8d2274d119b6fa8b03138903cf9708b54dd1664193c9457634; native b9497dd310e41711fa1f6b867f922afc8ff270fc0872e2604bc835772ec046c0. Existing root-private backup/rollback /root/moxbot-auth-renew-114e2ac5. No original namespace or finite-policy renewal.

Evidence (private/local, no tokens committed): workspace pointer output/auth-host-20261014 has credential-recovery-progress.json, frontend-tests.log, typecheck.log, native-check.log/native-registry-tests.log. Headless focused logs /tmp/moxbot-renew-*.log. Login URLs/receipts are only in mode0600 private output, never in Git. Frozen publisher reader remains unchanged.

## Next step

Sync accepted main NSIS repair, preserve frozen package source114e2ac5 and record doc-only/CI changes separately. Install only after concrete package confirmation and exclusive native handback; perform cold restart/update, model config preserving existing test key and disabled Agent create/readback through actual desktop. Then sync main, CI/review/merge and verify remote main/runtime. No paid inference or finite execution-policy extension.
