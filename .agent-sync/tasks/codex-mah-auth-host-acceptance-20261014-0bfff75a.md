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

## Objective and ownership

Restore owned desktop credentials, wire the bottom-left account entry to the existing owned backend, and accept real Linux Host model configuration and disabled Agent creation. Merge PR14 only after real acceptance and current CI. Preserve original MyAgents, conversations, credentials and Host permissions; no paid model call or cloud_models opt-in. Root owns integration, UI, signing and all server operations; bounded local workers own source/tests or independent read-only review. No external model calls or measured per-worker cost claims.

## Acceptance criteria

- [x] Source: owned account UI and registry expiry/cancellation guards; immutable Developer ID credential reader; explicit same-account management renewal; strict Node/Rust/frontend DTO parity; IPC close-listener handoff regression and repair.
- [x] Simulated: 83 focused cases/9 files, Rust protocol20 tests/Clippy; seven exact-head CI checks at 9dc214e9. New Agent-list tests separately pass; combined latest-main checks pending.
- [x] Package29: clean source29e0f05a7213347556ae38a8e87acff741c449da, same publisher/stable DR/frozen reader, 19 resource inventories, ZIP CRC/extraction/signature validation.
- [x] Human specifically approved29 update/open. Root backed up app/data and installed it; original MyAgents remains running. Exact executable SHA25628e996d73eeb69a0b10cf5653c109686e0dcfdab82720e3d08a17b7bf44b33fd.
- [x] Actual desktop: owned sidebar account auto-restored, menu click works and opens the owned network; Linux-Host online. No keychain prompt during114→29 update/start or controlled29 cold start; no login/recovery click required. This is evidence for these versions, not a guarantee for every future signature change.
- [x] Actual remote writes: saved Kimi Code/k3 and existing Host directory through the native UI; created remote-agent-qa-20261014 as disabled, browsed its server-created directory, saved it as configuration workspace; revision6 receipt and independent server readback agree.
- [x] Persistence: normal client quit/cold start plus both isolated101 Host services restarted. Model/directory/settings/Agent/project IDs and disabled state retained; real desktop read back k3/new directory. Node690386/native690383 ready, no active Session or inference.
- [x] Found and repaired a final UI gap: extended DTO resources were not rendered. Added only a read-only registered-Agent list; no enabling/sharing controls, network catalog stays separate. Three DOM regression cases, ESLint and typecheck pass. New native package acceptance is pending.
- [x] Synced main da4ed114 (PR38/39), resolved shared-plan conflict preserving both owners; 57 combined focused cases/10 files pass. Exact-head seven CI remains in progress.
- [x] Built/verified clean combined package27d6ed8c: same immutable reader, strict signing/19 resources/ZIP CRC and extraction pass. New native list/account recovery acceptance awaits concrete update answer.
- [ ] Review and merge PR14, verify remote main; publish accepted trial release and refresh the already-public download page.

## Completed

Actual29 UI writes and restart persistence are accepted as detailed below. Code/real core acceptance does not substitute for the final combined package read-only list check or remote-main delivery.

## Actual accepted state and boundaries

Host101 devicecc8fc885-529b-43e9-8a58-ee7c5f2a4c58, network7b4e69be-f3ef-439a-af6f-5d0acc2b9820. Settings revision6: provider profilemoonshot-coding-v-8264c463baeb293afb445991, modelk3, workspace/var/lib/moxbot-host-test/workspaces/default/remote-agent-qa-20261014, executionAuthorizedfalse. Agent8e53e453-dbb0-4e3e-8255-c10e98227cc3 / projectda2203f7-0472-40a0-b873-2115748ee5a3 persist, enabledfalse. No model API key configured or model call made; actual inference is outside this acceptance. A disabled, unshared Host Agent does not belong in the AgentNet collaboration catalog.

101 Node is exact29 source; native connector remains114e2ac5 binarySHA256b9497dd310e41711fa1f6b867f922afc8ff270fc0872e2604bc835772ec046c0. Existing unit/dropins, grants, keys and finite Bot policy preserved. Automatic real IPC recovery after native restart passed0.46s. Both-service controlled restart passed1.44s. No whole-machine reboot or original myagents-host namespace changes.

140 maintenance belongs to the authorized Bots 管理控制台 chat; peer reports PR38 model center deployed at0bb3f934, docs main da4ed114, no model calls. Root has not changed140 in this phase. Source may be incorporated without enabling cloud_models on101. Latest-main source compatibility independently reviewed; no overlapping target hunks or confirmed P1/P2, ordinary execution=false remains denied.

## Verification

Combined57 cases and independent main compatibility/UI reviews passed; list-only change preserves disabled/shared/authority state. Reviewer notes a nonblocking future display enhancement: archived resources currently show enabled/disabled without a separate archive label. Protocol/project owner remains unchanged. Exact source27 CI is still running; older green checks do not close it.

Combined ZIP346343830bytes, SHA256416bad4edaa83c210f7e5c63ef2e79481198d862a61b9e9a5a9ecd9dcc022d78, source27d6ed8cb405f2ccdc905798611df218d18b4caf. Source includes da4ed114 and the registered-Agent list. Package27 is signed but not notarized/installed/published at this checkpoint.

## Evidence and rollback

Private evidence stays outside Git under the project pointer output/auth-host-20261014: package-29e0f05a build/delivery/approval/install/start receipts; 29e-real-desktop-cold-restart.json; actual screenshots29e-final-config-saved.png and29e-after-cold-restart-config.png; final-ci-9dc214e9.json. No credentials, auth links, backups or machine databases committed.

App backup: /Applications/.MoXBots.previous-0efaae32-before-29e0f05a.app; private data backup in package29 folder. Linux rollback/state/unit backups and desktop readback receipts: /root/moxbot-ready-fix-29e0f05a. Earlier credential renewal backup remains /root/moxbot-auth-renew-114e2ac5. Do not run join/install again to regenerate existing permissions.

Public website currently serves old5f trial, not29; new source/package/runtime/main states must remain distinct. PR14 draft remains unmerged. Historical goal tool status is blocked with no resume mutation; user explicitly resumed, work continues without inventing a replacement goal or declaring completion.

## Blockers and unknowns

Awaiting the specific27 update answer and exact-head CI; continue independent artifact/source verification. No model key is configured, so inference is untested and out of scope. Historical goal API blocked status cannot be resumed by available mutations; user has explicitly resumed actual work. No password/key request or automatic migration is pending.

## Next step

Accept combined27 native list/cold recovery after the requested concrete update answer; obtain exact-head CI and Linux artifact provenance, preserve101 policy while aligning its Node source, then merge PR14 and verify remote main. Refresh the already-public trial download with a new immutable release; keep old downloads for rollback.
