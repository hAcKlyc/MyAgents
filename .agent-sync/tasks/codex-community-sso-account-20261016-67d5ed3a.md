<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/community-sso-account-20261016 -->
<!-- git-project-sync-task:base=16c2d8251fa52f8adc6e43d27116dd6dd77f0622 -->
<!-- git-project-sync-task:status=ready-for-review -->
<!-- git-project-sync-task:scaffold=false -->

# Task: Reuse desktop account for community and add account-menu entry

## Objective

Task ID: COMMUNITY-SSO-ACCOUNT-20261016. Open the owned community inside the desktop using its existing signed-in account; add a bottom-left personal-menu entry and retain More/settings/legacy-home entry paths. Preserve existing backend data, account authority and non-MoXBots Cloud Space.

## Acceptance criteria and state

- [x] Code: personal menu and More/settings/home paths converge on the native community Tab, with browse/filter/detail/create/reply and zh/en text. No external community login, token export or additional authentication authority.
- [x] Account boundaries: exact configured issuer/principal/login binding/current actor, explicit selection for ambiguous accounts, existing account-management action for unavailable login. Relay ready/joined is not required. Scope changes discard old content/drafts/results.
- [x] Simulated acceptance: focused unit/DOM and rendered-browser journeys pass, including uncertain writes retaining the same body and mutation ID. Independent auth and screenshot review pass.
- [x] Native-source compile and deterministic tests; separate from an installed/signed client. Standalone headless regression passes after shared-module compatibility updates.
- [ ] Real authenticated community integration and installed native-client acceptance. No daily App lease or matching current-account test authorization was claimed; synthetic IPC is not cloud acceptance.
- [ ] Git: push branch, required CI, merge latest main, verify remote main contains the exact code. Do not mark a PR as final main delivery.
- [ ] Release: designated owner packages next unfrozen candidate, publishes and coordinates real installed-client acceptance. No frozen 0.5.7 artifacts are changed.

## Completed

- Base observation/start/task-init gates passed on canonical `https://github.com/heavenzhang/MoXBots.git`, main `16c2d8251fa52f8adc6e43d27116dd6dd77f0622`, dedicated worktree `/Users/zhangshaohua/Documents/Codex/2026-10-16/moxbots-community-sso`.
- Existing external `/community` web app owns an independent OIDC session. Existing `/api/community` already accepts native owned-account bearer, so this fix uses the established invoke -> Rust account owner -> pinned-discovery/fixed HTTPS pattern. No cloud code/deployment or new SSO-ticket contract is needed.
- `community.rs` has closed `list/detail/create/reply` requests, strict UUID/text validation and only business response fields. The existing private login binding is projected as a non-secret fence; credentials stay Rust-owned. Identity HTTP budgets remain unchanged; community alone allows bounded 64 KiB requests/16 MiB responses for legal Unicode text and server list limits.
- Account owner validates before discovery and before/after HTTP; registry verifies stored binding/issuer and actor identity after await. Shared headless users copy their existing binding and compile the same module without exposing a new command.
- POST errors that may occur after commit, including owner/binding replacement, remain uncertain. Exact request/id are retained and editing is paused until explicit retry confirms the original mutation.

## Verification and evidence

Local output: `/Users/zhangshaohua/Documents/WPS Cloud/【项目】目录/MoxBot/output/community-sso-20261016/`. Browser driver/temporary fixture retained under ignored worktree `output/community-qa/` and `playground/community-qa/`; local server stopped.

- DOM: 39/39 across CommunityPage (15), CommunityContainer (4), OwnedAccountEntry (20).
- Unit: 14/14 for owned navigation and account selection (multiple same-issuer accounts, selected peer/official, removal, disconnection).
- Full TypeScript check, scoped ESLint, dependency graph, test classification, protocol hash verification, theme CSS and license checks: PASS. Protocol artifact unchanged.
- MoXBots Vite production web build: PASS (`web-build.log`); existing large-chunk warning remains.
- Native focused community tests: 6/6 PASS (`rust-community.log`), including legal large responses, extra fields/routes, issuer normalization and post-commit actor replacement/rebinding/logout. Initial strict-field test caught serde's unit-variant extra-field behavior; `List {}` now rejects it.
- Native AgentNet regression: 199 PASS, 1 ignored private child-process test entry (its parent owns the isolated fixture), 0 FAIL (`rust-account-regression.log`).
- Headless library: 163/163 PASS (`headless-unit.log`). This is local source compatibility, not a Host rollout.
- Native source compilation used the previously reviewed task-local SwiftPM overlay because CLT private Swift interfaces mismatch its libraries; no system/Xcode files were changed. Unit runner supplies the installed CLT Swift compatibility library; dyld reports an existing duplicate Swift class warning. Reused signed CLIProxy/resource build inputs remain verified by the original build gates. This does not assert a fresh signed package or installed-runtime acceptance.
- Rendered Chromium, actual product components + synthetic IPC: personal menu opens community, disconnected signed-in account loads list, create -> uncertain owner boundary -> exact same-request retry, reply, 760px layout; all 5 checks PASS, no page errors (`browser-qa.json` and five PNGs). No real login, external page, network write or credential access.
- Primary reviewed whole diff and personally inspected renders. Independent auth reviewer found the post-commit owner-error retry risk; fixed and re-review passed. Independent review of five rendered screenshots found no blocking readability/overflow issue. Narrow uncertain-state and native/screen-reader behavior are not claimed covered.

## Execution record

Primary owns integration and delivery. Two bounded native workers were requested as gpt-6.1-sol/medium: `community_ui` implemented only four new UI/test/locale files; `community_auth_review` reviewed source/auth and rendered screenshots without edits. Selected because scope-bound async state, idempotent writes and issuer/principal boundaries justify independent work. No external model calls; exact runtime model/effort, token totals and cost are unverified. No daily GUI, Host, cloud deployment or account mutation performed.

## Blockers and unknowns

- Required remote CI and main delivery are pending.
- Real authenticated and installed-client acceptance need the designated release owner's current account/GUI/idle/backup gates. No cloud server change is required.

## Deployment request

- Status: preparing; code verified locally, not deployed.
- Designated desktop owner: `01a12bc2-907a-7702-b6dd-788225c5dfe4`, title “MoxBots桌面端统一打包负责人”. Human authorization permits this coordination. Owner confirmed current 0.5.7 is frozen/published, next candidate may be 0.5.8, not yet frozen. Preserve parallel administrator short-login compatibility work.
- Target: the next unfrozen macOS arm64 desktop candidate. This task changes no cloud services and requests no Host/cloud deployment.
- Smoke after package install: current valid account -> personal menu community -> no second OIDC/password -> read existing cloud list/detail -> authorized controlled topic/reply persisted -> switch account/binding/logout -> no stale content/write authority. Record account, exact source/package version and rollback/idle gates in the release owner's private evidence; never copy credentials here.

## Next step

Commit/push this task, run required CI and merge/verify current remote main; send the exact reviewed head/main SHA and acceptance limits to the designated desktop owner. Real account and installed-client acceptance remain explicit open gates until that owner coordinates them.
