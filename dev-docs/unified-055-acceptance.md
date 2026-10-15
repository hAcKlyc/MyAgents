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


## Ordinary Session automatic title gate

A new direct human instruction in the TITLE owner chat explicitly requires ordinary Session automatic title acceptance before unified0.5.5. A4 utility receipts remain valid only for their narrower scope. The TITLE owner prepares a frozen-source, normal moxbot Session sidecar in a fresh private HOME/data/cwd, separate loopback port and closed environment, using only the already-authorized Kimi key. No daily window, modelqa guard relaxation, direct title-utility trigger or owned/Host bootstrap is permitted. Native GUI lease remains with Root pending human system-prompt inspection.

Before the bounded normal-turn plus automatic-title model calls, the installed SDK must independently prove project deny rules actually produce an empty tool catalog, with no MCP/hooks/extra agents or fallback. Official SDK permission documentation supports deny precedence and project settings, but installed runtime behavior is the gate. Backend acceptance must observe normal post-turn automatic triggering, real model completion, persisted title/source, SSE and reload. Sidebar/Tab/manual-title UI protection remain distinct native evidence. The backend subset subsequently passed as recorded below; the native UI subset remains open.


## Ordinary Session real backend result

Root reviewed the original successful `kSW6qJ` receipt, normal Session API readback/reload, actual index metadata and V2 transcript SHA. Exactly one normal `/chat/send` completed and the existing post-turn hook made the second real Kimi request. Both requests returned200 (9968ms/5547ms). The generated title is **费用包金额统一万元展示与毛利校验**, not an input prefix. `titleSource=auto`, `titleGenAttempts=1`, the real `chat:session-title-changed` event, persisted metadata/transcript and same-ID owner restart/reload all matched. Root independently verified both test process groups31500/31613 had no remaining members and the transcript contained zero tool-use records. Monetary cost/token accounting remains unknown.

This used the product-supported custom Provider `qa-kimi-title-055` with the authorized Kimi k3 key held only by a capped loopback proxy. The actual source SDK hash is `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937`; normal init and both outgoing requests had empty tools/MCP. macOS network restrictions allowed only the two harness loopback ports; Root separately reran the parent/child probe and verified allowed HTTP plus EPERM for another loopback port and external443. A strict adapter forwarded only the exact new Session/workspace Goal GET to the actual isolated A6 GoalStore. IM mirror POSTs received real local403 denials and were never forwarded. No fake goal/admission response, modelqa ordinary-turn relaxation, daily Session or cloud IM write was used. The temporary QA internal-capability projection was deleted after confirmed harness exit.

Earlier harness failures are retained: incorrect catalog parsing, no-input init timeout, config mode/schema/permissions, SSE envelope and listener/liveness checks. An earlier builtin-provider run ignored the intended base URL; real key use/proxy forwarding were zero but direct invalid-local-token attempts are **unknown**, so it is not accepted and is not relabeled as zero-network. The successful run used the real custom-provider authority and kernel network restrictions.

Accepted: normal Session backend automatic trigger, two real model results, terminal completion, event delivery, persistence and process restore. **Still unaccepted:** native sidebar/Tab display, manual-title race protection, normal desktop SDK circuit/lifecycle, DSH/IME/Escape, real Host, formal055 publication and actual idle-only update. Backend evidence is separate from package/production acceptance.

## A7 build-only freeze checkpoint

- [x] Synced actual main `8f7ebc21` (PR57 plan-review/SDK plan-file changes) into `6c48e25c`; only the shared plan record conflicted and both completed feature records were retained. Title service/generator/post-turn hook and production composer bytes match the accepted `01deb0b1` backend source.
- [x] Merged plan/title/composer regression: 243 tests across11 files and TypeScript noEmit passed. Node QA build/launcher combination10/10 passed; independent launcher review separately passed7/7.
- [x] QA launcher now gives only future new child processes umask077, restoring its own previous mask on successful or synchronous failed spawn. Existing A6/daily processes and OS settings are unchanged; this is not a sandbox or a fix for existing files.
- [x] Ordinary title owner harness/source records integrated as `3f90dca5`, `38f32ead`, `8f84dd9f`; real backend evidence remains scoped as above. No additional model calls were made for this merge.
- [ ] Build and sign a fresh A7 snapshot, with the existing compiled A6 private HOME; source closure must include newly added main files. Build only while the human system-prompt inspection is pending. No GUI launch, no SecurityAgent operation, no daily client update.
- [ ] Native DSH/Enter/Escape/actual IME, native ordinary title display/manual protection, cold helper/relay and dedicated Host gates remain open. At10:40 board owner again confirmed daily HRM running/isBusy, queue0; children/pending unknown. No installation or restart while busy.

Evidence: pointer `work/unified-055-20261015/merged-plan-title-composer-tests.log`, `merged-plan-title-tsc.log`, `qa-private-umask-tests.log`; independent scope in `dev-docs/unified-055-home-binding-review.md`. Formal0.5.5 remains unbuilt/unpublished/uninstalled; stable endpoint still0.5.4. The user's failed Mac-password attempt does not identify the system prompt or authorize guessing other passwords.

## A7 native checkpoint and current handoff

A7 source `f44fc7c3479fb4844793cd73889500b80a66557d` built successfully, Developer ID deep/strict passed, binary `9de1ca3723e4bf4fc320e069cae2656a593ff4a863bd4d1e4ea7569f51f2f12f`. External closure compared all4217 copied tracked inputs, including3383 runtime inputs, with no unexplained difference; the two declared snapshot build/Info changes remain. Full CI38672613455 on exact f44 passed all6 jobs. This artifact is a private Model QA candidate, not formal distribution.

- [x] A6 ordinary UI was actually waiting for an expired09:44 PKCE browser request; it was not continuously stuck before start returned. Cancel then waited in own `SecKeychainFindGenericPassword`. With only App/Global and no SDK/model children, normal CmdQ exited94448; exact childless orphan94462 exited via SIGINT. Data preserved and daily App untouched.
- [x] A7 App31990/Global32043 are running under the exact compiled private HOME; configuration remains0600. Ambiguous name/bundle lookup timed out; exact already-running path binding succeeded. During the two name lookups a real-HOME `.moxbot-modelqa` appeared with only empty records and two156B loading-log lines. Old artifact registration is suspected, not proven. Evidence preserved; do not claim zero real-HOME writes.
- [x] Independent native DSH/integrated/moonshot-coding/k3 generated once in6203ms, no tools/ordinary turn. Same-result replay passed heldReturn1300ms draft/count0, edit plus second distinct Return/count1 with draft retained, and Escape/empty/count0. Root reviewed original JSON and three PNGs; NEXT owner independently reviewed them too. No additional model requests for replay.
- [ ] Actual Chinese IME remains open. Existing shortcuts showed Latin only; system input-source menu lookup timed out. Root reset to the same result, empty focused draft/count0 and stopped all GUI for human candidate preparation. Latest human feedback mentions a password prompt, so it is not IME proof and no Enter was sent. NEXT chat collects exact user-provided prompt details; no duplicate password request.
- [ ] Dedicated private Keychain metadata is locked. One normal unlock using its existing generated credential failed; Root parent error handling did not preserve stderr, so exact OSStatus is unknown. No further password attempt/reset/ACL/search-list change. Independent source audit found no confirmed ctypes ABI error; original random binary password does not guarantee SDK canonical UTF8, a confirmed input-contract gap but not proven failure cause. Old Keychain/credential/data remain preserved; any future provisioning must use canonical credentials and verify create/lock/unlock before imported credentials, with stage/status-only diagnostics.
- [ ] Fresh owned PKCE/helper cold-read/restart/relay and dedicated Host remain open; no Host model or credential write is accepted. All QA and Keychain execution is paused during the human prompt handoff; source/CI/release preparation only.
- [ ] PR58 TODO/current-step/child-Agent board enhancement is pending intake at head34db21c0, not in A7/f44. Its owner completes CI/main delivery before final source freeze; do not republish an existing version.
- [ ] PR57 plan-review repair is in main8f7 and A7 inputs, including exact server artifact content independently checked by its owner. Real native SDK-file/full-card/scroll/revision/explicit synthetic approval acceptance remains open; Model QA ordinary-turn refusal is not relaxed. Never approve/reject the running HRM business plan to free an update window.

Main is still `8f7ebc21`; integration PR54 is open and not main delivery. Formal0.5.5 is not built/published/installed. At12:55 independent exact-owner frontend readback still had HRM running/isBusy, queue0, pending interactions0, children unknown; this is not future idle evidence. Stable endpoint normal TLS still0.5.4/no-store; rollback054 App/DMG/TAR hashes were independently reverified. Final installation requires fresh complete owner/generation admission and current consistent backup; no task is stopped for installation. Private originals and Root primary receipts are under pointer `work/unified-055-20261015/` and private HOME `native-independent-A7/`; raw auth or business logs never enter Git.

## TODO / child-Agent main intake

Fetched actual main `06baeb83` (PR58 merge `7346499b`, product source identical to CI head34db21c0) and merged into integration `19b8d731e785ba1865ba29f370c942ab9919e62e` without conflicts. Root independently reviewed read-only progress projection, exact-Query background registry, native-plan reset, cold-history interruption and unchanged Task authority. The merged board/shared progress/observation files match actual main byte-for-byte. No SDK admission, update transaction or ModelQA ordinary-turn guard was relaxed.

- [x] Merged regression: **372 tests /21 files**, including shared TODO/Agent progress, original Chat status panel, board projection/activity/data, SessionEngine/observation, external plan reset, plan approval, title and composer/IME synthetic cases. TypeScript noEmit passed. Private logs: `merged-board-todo-regression.log`, `merged-board-todo-tsc.log`.
- [x] Dedicated DSH utility entry/runtime, automatic title service/generator/post-turn hook and production SimpleChatInput are unchanged from the already tested6a/f44 runtime paths; no repeated paid inference for this source merge.
- [ ] Push final intake checkpoint and run CI on the actual combined head; PR54 remains the unified mainline queue, not a release itself.
- [ ] A7 does **not** contain TODO/child-Agent board enhancement. Next native candidate must include this merged source and independently compare card/detail TODO counts, current step, child status, stale/history labeling and route back to the original Session; synthetic screenshots/main CI do not substitute for that native check.
- [ ] All QA/Keychain execution remains paused during the human password-prompt handoff. The latest feedback is not IME proof. Existing QA resources are preserved; no new password attempt, system setting or daily client operation was made for this source intake. Host/native plan-review/formal055/production update gates remain open, with fresh idle/backup/admission required before installation.
