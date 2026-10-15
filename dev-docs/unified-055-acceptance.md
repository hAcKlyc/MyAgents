# MOXBOTS-055-UNIFIED-ACCEPTANCE

Scope: unify explicit human-authorized NEXT-PROMPT-002, FEEDBACK/TITLE, remote Host and brand/community delivery into one immutable 0.5.5. Preserve daily running work. Root owns integration, signing and update publication; existing feature owners retain their source and runtime scopes.

## Model QA environment

A fourth closed build profile `moxbot-modelqa` owns `com.moxbot.modelqa`, `.moxbot-modelqa`, CLI/scheme/sidecar marker and port range 34415–34914. The existing updater QA profile still refuses models and credentials; no runtime switch relaxes it. Model QA has no updater endpoint or production credential Reader. It suppresses shell startup discovery, ambient provider environment, autostart grants/global shortcut registration and upstream Space. The launcher requires a private physical temporary HOME, supplies only a closed environment, and refuses an already live modelqa lock.

HOME/state isolation is not an OS sandbox. Local normal turns/restore/prewarm and legacy external-title sessions are refused. The audited builtin utility owner alone admits an SDK child in an asynchronous scoped admission, requires an explicit non-subscription Provider/model and credentials, forces no tools/MCP/project settings/persistence. Next-prompt owner supplies separately constrained native Codex/Claude Code/DSH utility paths; its native acceptance page uses clearly synthetic completed context with real generation, never a business mock or ordinary turn.

Owned-cloud/AgentNet is required by the authorized dedicated Linux Host test. Model QA account secrets use the existing helper-supported OS service inside a physically private user Keychain, plus a data-root-dependent key. Device-key physical OS scopes are domain-separated; wire/TLS scopes remain exactly issuer-owned. Load/save/delete and explicit authorization/recovery all map through the same wrapper, without daily-slot fallback. A new normal same-subject login is required; no daily login token/session is copied.

Build: `npm run tauri:build:moxbot-modelqa -- --qa-workspace /private/tmp/<new-snapshot> --qa-version 0.5.5 --qa-home /private/tmp/moxbots-modelqa-<private-home> -- --target aarch64-apple-darwin --bundles app`. Run only after independent boundary checks and explicit GUI handoff, using `scripts/run-moxbot-modelqa.mjs`. This profile is test-only and never published as the formal updater target.

## Ownership and serial acceptance

- Root: profile source, wiring, independent acceptance coordination, mainline/source freeze, formal signed/notarized 0.5.5, production updater and idle-only client update.
- NEXT-PROMPT owner 01a13586: runtime utility implementation, synthetic-anchor native test surface and real Codex/Claude/DSH minimum calls; does not alter profile or install client.
- FEEDBACK/TITLE owner 01a1361b: real account/menu/feedback entry and separate title utility page. Native 0.5.4 feedback entry, same-subject normal logout/relogin, assistant and notification control passed; notification online service is not inferred.
- Remote owner 01a134fe: session.remote capability compatibility fix, paired Linux artifact upgrade and dedicated Agent/Kimi/approval acceptance. Host calls are paused during coordinated community maintenance, never terminate active tasks.
- Brand/community owner 01a13caf: PR50 and exclusive existing cloud-service deployment; no desktop install. It must prove no ongoing RPC/relay/model and safe ingress/drain/backup before service replacement; SIGTERM5s is not acceptance.

Window authority: shared private `output/remote-session-20261015/OWNER-WINDOW-HANDOFF.json` with FileLock/token. Queue/registration is not a claim. No concurrent UI operators. Root has not claimed the daily app.

## Checkable delivery gates

- [x] Verified canonical Git, clean base c7bab285 and separate task worktree.
- [x] Four-profile build identity, closed arguments and poisoned-environment tests: 7/7.
- [x] Utility admission/no-fallback/tool-free and existing updater/SDK regressions: 43/43 initially, final modelqa/SDK 22/22 plus selector117 and profile integration7 passed.
- [x] TypeScript and scoped lint passed after initial implementation.
- [x] Scoped independent code review: P1 authorization path and two launch/admission P2 issues repaired, independently retested (7 build +22 unit). See `modelqa-independent-review.md`.
- [x] Model QA release Rust backend/namespace tests: 3/3. Debug Swift dependency linker failed locally; retained release-cache path compiled and ran these tests. This does not prove native UI/Host/model acceptance.
- [ ] All actual model/Host/UI acceptance; synthetic context, helper proof and real business proof remain separate.
- [ ] All related source reviewed/CI/main, exact final source frozen with version 0.5.5.
- [ ] Formal App/DMG signed, Apple Accepted/stapled/Gatekeeper and full archive inventory verified.
- [ ] Real 0.5.4→0.5.5 update, idle/edit protection, confirmation/restart and persisted state verified.
- [ ] Production signed endpoint/bytes/rollback and actual client installation verified, without interrupting running tasks.

Current state: implementation and independent review in progress; formal 0.5.5 not built/published/installed. Large outputs and secret-bearing evidence remain outside Git. Public 0.5.4/source e5a05f76 is immutable.

## Integration candidate and remaining runtime boundary (2026-10-15)

PR54 is the single final mainline integration queue. It preserves actual feature ancestry: NEXT 58c819b4, TITLE 9ff0ba28 (wire repair a3e51fd7), FEEDBACK record bc5ebb71, profile d97449c2, and brand production record ad3b0bb3. Brand code is already main b5b9c9c4 with publisher-reported production PKCE/readonly/account/DB acceptance; its exclusive cloud hold was released before the dedicated Host CLI preparation resumed. No second publisher changes that service. Feature PRs retain scoped review/CI evidence; their branches alone are not main delivery.

All package/lock/Cargo/Tauri release versions are aligned to 0.5.5; license and locked Cargo metadata checks passed. The final isolated native candidate also has compile-time-only navigation across QA Home/NEXT/TITLE/App; production has neither these pages nor utility endpoints. A1 native release/bundle passed with task-local SwiftPM overlay; A2 includes wire repair and coherent version. Neither is final UI evidence. A3 added navigation; A4 also awaits the actual Global owner before fixture metadata mounts. A4 is now running only in the private Model QA HOME, with exclusive independent-reviewer NEXT/TITLE GUI ownership. The first invocation lacked Cargo PATH after assets passed; the corrected explicit Cargo path built A1 without a stub or system-toolchain mutation.

Source/wire checks passed: Root integrated typecheck/scoped lint/classification, 178 initial route/composition/Title tests and 18 NEXT tests; final real Hono cancellation 29 plus Root routes3. Independent review separately ran actual Hono/composition/routes/handler with synthetic generator/config, rejecting unauthenticated callers and nonempty DELETE, accepting empty DELETE cancellation, and preventing late receipt writes. See unified-055-integration-review.md for exact scope. This does not replace native Rust IPC/SDK/model proof.

The TITLE page validates a real builtin utility and its separate modelqa receipt, not ordinary Session automatic-title persistence. The real remote Host source currently has no automatic-title hook and its remote DTO/UI does not expose durationMs. Those extra observations are outside this release acceptance scope, and no existing title or timestamp difference will be reported as either feature passing. No extra model rounds or product changes are authorized by those observations.

Final native, dedicated Host business, formal distribution, production updater and idle-only actual install gates remain open. The user's running tasks and daily client have not been stopped by this unified task.


## Current checkpoint — A4 and board integration

Main `205939249c057363d01163c6b0e4b6df717d5064` includes board PR56, now merged into integration `9f94335478c50a2699b5c87883374e1a57259141`. Board overlap was merged without dropping Model QA execution refusal. Focused board projection/activity/tab/data-hook tests passed 25/25; native final board behavior remains pending on the formal installed source.

A4 utility candidate source is `2b2f12cdd87aa18bd02451be068ffc0fbf41dd64`, before board PR56. External closure matches 3378 tracked runtime files, with the deliberate snapshot-only `beforeBuildCommand:null` after explicit asset build. Binary SHA256 `b984c1a8076cefa808c0a115db264442c327edb6b1ee0afc0ebe7ceb24507c8c`; Developer ID deep/strict verification passed, production CredentialReader absent. Embedded build SHA is null, so provenance relies on the frozen external source and artifact receipts, not an invented embedded SHA. A4 is a private utility acceptance artifact, never the formal update target.

The human confirmed creating `test` manually in the QA window. The ordinary task was refused with `MODEL_QA_UTILITY_ONLY`; its record is preserved. This was not evidence of an unauthorized GUI operator. Root transferred the sole QA GUI lease to `/root/updater_qa_review`, with all feature owners stopped. Native paid-model results remain pending the independent report.

Owned-account login failed on a native `owned-account` GET send timeout after 5002 ms. A later curl of the exact public instance route succeeded over direct and explicit loopback-proxy paths with TLS verification; that is not proof the native request or PKCE succeeded. No daily token, trust override or keychain fallback is used. Dedicated Host real model/approval remains pending the normal same-principal login.

HRM history now has identified child/root terminal events, but logs are not live owner authority. Installation remains blocked until the existing exact-generation update admission/quiesce owner confirms all active work/children/queues/interactions are safely idle, followed by backup. No extra external CLI permission is enabled for this check. Formal 0.5.5 remains unbuilt, unpublished and uninstalled.


## Native A5 and isolated OS credential store

A5 source `daf46d48b63dd48aa803a19e00434a70dd820345` built and Developer ID strict verification passed. Its 3381 tracked runtime files match the frozen source, except the documented snapshot-only build hook override. A5 includes the DSH handler repair (`plan` was rejected by the actual DSH configuration compiler; `approval-required` preserves its supported restrictive policy) and bounded owned-start error diagnostics using the existing closed `diagnostic_code`, without logging error details, URLs or credentials. Root independently passed the 17 affected tests; real DSH remains pending.

A4 independent native acceptance is recorded in `unified-055-native-acceptance.md`: Codex/Claude Code real utility suggestions and editable adoption passed; two Title fixtures, actual SDK cancellation/exit, unchanged old receipt and reload passed. DSH failed before starting its model; native Chinese IME and Escape remain open. QA-only send-attempt counting and explicit reuse/reset of a single genuine result make those keyboard checks observable without repeated inference; these controls do not execute ordinary tasks or modify production composer behavior.

Normal A5 owned login returned the exact closed code `NETWORK_CREDENTIAL_STORE_UNAVAILABLE`. Read-only `security default-keychain -d user` returned a real default under the daily HOME and none under the private QA HOME. After verifying the App is not sandboxed and all private HOME/Library/Preferences/Keychains paths are physical, current-user owned and0700, a short-lived fixed-private-HOME helper created a new user-domain Keychain using the Security framework, without UI prompts, sudo, real login-keychain copying or common/system/dynamic changes. Its generated local password stays only in a0600 private file outside Git, as does the private Keychain. Actual daily default/search-list and security preference bytes were identical before/after. Apple emits cross-process Keychain cache notifications, so HOME isolation is not a claim of zero OS notifications or an OS sandbox.

A new normal native PKCE attempt then succeeded through a temporary Codex in-app browser tab using existing authorized QA credentials; the native check restored exactly the expected principal and one owned connection. The temporary tab was closed. No daily session/token or trust exception was copied. Private bootstrap/login/source receipts remain in pointer `work/unified-055-20261015/`; screenshot evidence is in the private HOME. The old5s timeout is retained as an earlier event, not the explanation for every later failure.

The remote owner returned the A5 lease after diagnosing NETWORK_CREDENTIAL_KEY_MISSING: the existing env-cleared same-executable reader lacked the private HOME, and the former QA service was outside its existing closed allowlist. PKCE completion did not prove relay readiness. Zero Host model/remote-session rounds or Host credential writes occurred. A5 HOME and the human-created test are preserved.

A6 binds one explicit build-time --qa-home to both the signed artifact and its existing helper. Only the exact env-cleared reader invocation can restore this compiled HOME; startup and every QA credential I/O validate the actual user-default Keychain metadata inside that private HOME. Shared crypto, protocol, Reader and pins remain unchanged. A fresh private HOME/Keychain/device and normal PKCE are required; no A5 owned state is migrated. A6 also adds QA-only attempt counts/reset/layout for bounded DSH/keyboard/Escape/IME acceptance. Node build guards 9/9, synthetic Rust metadata guards 3/3 and fixture DOM 5/5 passed; independent source review found no reproducible P1/P2 under this fixed-Mac scope. Native helper cold-read and relay/Host acceptance remain pending.

At 09:21 local time Root independently projected the exact daily HRM owner: sessionState=running, isBusy=true, queue=0. Children and pending interactions were not observed and must not be assumed zero. Installation is blocked while this task is running. Final main/source freeze, formal App/notary/distribution and actual idle-only installation remain open; daily work is preserved.


## A6 candidate and system authorization gate

Fresh A6 native release built from `d0ab7087c936a4660a777d5c7e8abbe57af9b5f7`. Developer ID strict/deep verification passed; 3382 tracked runtime files match the freeze, with only the documented snapshot asset-hook override and compiled QA HOME Info.plist addition. Binary SHA-256 `f335dbf879e364b9afc87275aa326e4ee6a1a037ca885f0c7cc6eafdc5c1267e`. The production Reader is absent; this is not a formal distribution. New private-HOME startup passed and the real-user default QA directory was not created. Kimi credential presence and runtime/title allowlists were checked by boolean projection only.

The first normal login did not reach PKCE. A native stack sample located the wait inside Security `SecKeychainAddGenericPassword/updateSSGroup/encodeKey` IPC. Explicit unlock of the existing private QA Keychain succeeded without UI, but the request remained pending. Root normally quit the no-model QA App, gracefully retired its verified childless orphan Global, and retried once after unlock. `SecurityAgent` was present. The computer-use tool explicitly prohibits access to that system app; the human was asked to inspect the exact prompt, without sharing passwords or approving access to the daily login Keychain. The exact prompt is not yet observed, so its presence alone does not prove the cause. No system service restart, daily Keychain mutation, credential fallback, Host model/write or production installation was performed. Fresh PKCE, helper cold-read/restart, relay and Host acceptance remain open.


## Latest update publication authorization

The human explicitly requested publishing the latest update to the existing server after this formal package completes. Publish formal0.5.5 only after the preceding acceptance/main/signing/notarization gates, using the existing own signing key and stable darwin-aarch64 endpoint. Verify public manifest version, exact downloaded archive hash/signature and rollback availability so clients can fetch it. This conditional authorization does not publish the QA application or authorize interrupting busy clients; restart remains user-confirmed and actual installation still requires idle/backup checks.
