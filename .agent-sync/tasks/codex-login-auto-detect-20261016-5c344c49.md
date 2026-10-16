<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/login-auto-detect-20261016 -->
<!-- git-project-sync-task:base=c0f7649d8ca08e017001e24492d46952c23b0159 -->
<!-- git-project-sync-task:status=ready-for-review -->
<!-- git-project-sync-task:scaffold=false -->

# Task: Automatic desktop browser-login completion

## Objective

LOGIN-AUTO-DETECT-20261016. Human requests: start browser automatically, automatically detect successful login and close dialog, retain manual status check as fallback, move the authorization URL into collapsed advanced information, and deliver with the designated unified desktop release chat.

## Acceptance criteria

- [x] Code: JoinNetworkDialog reuses existing Rust start/open/poll/cancel APIs; no new auth authority, server, deep-link protocol or credential storage.
- [x] Deterministic UI tests: automatic polling/close, focus/manual fallback, single flight, cancellation/expiry/unmount fences, identity reauthorization and existing parent account paths.
- [x] Rendered interaction/visual checks and independent screenshot review pass. Synthetic checks are separate from real authentication/native acceptance.
- [ ] Commit/push, required CI, latest-main integration and remote-SHA verification.
- [ ] Unified owner receives final SHA and includes it in the next unfrozen release. Actual signed package, installed-client and real-login acceptance remain separate gates.

## Completed

- Canonical repository https://github.com/heavenzhang/MoXBots.git verified; isolated worktree `/Users/zhangshaohua/Documents/Codex/2026-10-16/moxbots-login-auto-detect`, base main c0f7649d8ca08e017001e24492d46952c23b0159. Existing changes/worktrees preserved. Start/task-init gates PASS.
- `useOwnedLoginFlow` owns only presentation lifecycle: browser launch after explicit start, serial 2s checks with bounded failure backoff, immediate focus check, success close, expiry stop and explicit restart. Dialog leaves successful native persistence/registry decisions to existing parent/Rust owners.
- Shared flight blocks concurrent automatic/manual/focus calls; cancellation remains available during poll, fences generation before await and stops checking after an unconfirmed cancellation. Unmount clears timers/listeners and drops stale UI results; existing parent owners perform pending cancellation to avoid cancelling an authenticated result during registry-driven unmount.
- Existing identity reauthorization updates the same owner-supplied attempt and opens a changed authorization once. Full authorization URL is in collapsed advanced information; manual check/browser reopen are secondary fallbacks, with accurate zh/en feedback.
- Generic NetworkSelector join now has pending-attempt/generation fences, including cancellation and unmount. Other owners only invalidate the matching pending attempt, so stale cleanup cannot invalidate a newer login.

## Verification

- 60 related DOM tests PASS: flow 14, dialog 2, NetworkSelector 24, OwnedAccountEntry 20. TypeScript and scoped ESLint PASS. Initial tests caught timer integer overflow in far-future fixtures; timer is now capped/rearmed and regression covers it. The extra flow case covers StrictMode setup/cleanup replay without duplicate open/poll. No native/backend change requires a new local native build; required CI remains applicable.
- Primary implements/accepts overall. Existing bounded reviewer `/root/community_auth_review`, requested Sol/medium for auth lifecycle complexity, reviewed source/tests read-only and reports no remaining definite defects. Exact runtime model/effort, tokens and cost are unverified; no external model calls. Primary not switchable in this thread; no claimed model switch.
- UI baseline: existing dialog/theme/controls; desktop 1120x850 and compact 760x620. Required journeys include automatic completion without manual check, advanced-link visibility, browser fallback, in-flight cancellation, and expired state. Evidence: `/Users/zhangshaohua/Documents/WPS Cloud/【项目】目录/MoxBot/output/login-auto-detect-20261016/`; ignored local driver/fixture `output/login-qa/` and `playground/login-qa/`.

- Rendered product dialog with synthetic callbacks: 8 checks PASS, no page errors; 1120x850 and 760x620. Default advanced link hidden, automatic periodic success closes without manual/focus, browser failure/reopen and manual fallback, in-flight cancel/late result, expiry. Primary rejected the initial unstyled fixture, added explicit source styles plus computed-style/bounds assertions, then re-ran/inspected corrected renders. Independent reviewer inspected all five final screenshots and reports no blocking visual defect. Native/real browser login and narrow advanced/error states are not claimed tested.

## Blockers and unknowns

- Real browser/OIDC/OS credential-store flow and installed native package remain unverified here. Do not operate daily App, reuse unrelated account state or assert production completion from synthetic callbacks.
- Required remote CI/main remain pending until final delivery receipt. Server/Host deployment is not part of this source fix.

## Deployment request

- Human explicitly instructs delivery to unified packaging chat `01a12bc2-907a-7702-b6dd-788225c5dfe4`, “MoxBots桌面端统一打包负责人”. Owner confirms 0.5.8 is not frozen or formally building, and will wait for this repair before freezing the same candidate batch. Frozen 055/056/057 remain unchanged.
- Status: preparing. This chat owns source, tests, CI and main; designated owner owns packaging/signing/publishing/client actions under its existing idle/unlock/backup/test-identity gates.
- Native acceptance: start login -> system browser opens -> valid browser login -> dialog detects and closes without manual check -> current account shown/usable. Then verify fallback/open failure, cancellation, expiry and original-identity reauthorization. No credentials or real authorization URLs in Git/evidence.

## Next step

Commit/push, required CI, merge and live remote-main verification; send exact accepted head/main SHA and limits to the designated publisher. Preserve release/native/real-login states separately.
