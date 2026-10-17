<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/upstream-dsh-20261017 -->
<!-- git-project-sync-task:base=4d3b666c170367a05a8871bee8a9b6032b7ef379 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-UPSTREAM-INTEGRATION-20261017 — DSH/build

## Objective and scope

Port upstream DSH diagnostics (9c8ee6cf), macOS host staging restoration (6ef57a68), native handshake test alignment (786504dd), failed-session storage deletion/protocol 6.2 (706f00cb), and only DSH release selection 0.1.18 from d735c847. Preserve MoXBots branding, configuration, context recovery, owned cloud and Host behavior. Root integration owner alone merges/pushes and accepts final product.

## Acceptance criteria / To Do

- [x] Verify MoXBots canonical Git URL, clean isolated branch and base; read map/plan and applicable architecture.
- [x] Port four repair commits without unrelated application version/changelog changes.
- [x] Select paired published DSH 0.1.18 for formal builds.
- [x] Run matching deterministic unit, storage transaction/integration and build script tests; type/lint checks.
- [x] Prepare/verify isolated DSH 0.1.18 artifact and run native handshake, interrupted recovery and failed-history deletion tests.
- [ ] Full native acceptance: retain the two child-prompt failures until the Runtime publisher provides a compatible fix; no immutable artifact edits or removed assertions.
- [x] Review complete worker diff and commit evidence; root has integrated the initial seven commits and separately owns final delivery.
- [ ] Root: integrate into latest main, validate combined behavior, push and verify remote main.

## Evidence and boundaries

Base: 4d3b666c170367a05a8871bee8a9b6032b7ef379. `project-sync observe/start/task-init` passed for https://github.com/heavenzhang/MoXBots.git. No dependency manifests changed; matching package-lock permits read-only shared node_modules symlink. No install mutates shared dependencies. Tests must use scratch HOME and loopback fake providers; installed clients, Hosts, histories, credentials and production are out of scope for this worker. Build resource staging in this worktree is ignored and is not a published artifact.

## Verification completed

- Node 24.21.0 tool runtime; source bundled Node requirement remains exact 24.20.0/npm 11.19.0. Read-only matching sibling bundled Node reports 24.20.0; copied binary only into this worktree ignored resources, never altered the source resource.
- `vitest run --project unit src/server/integrated-runtimes/dsh src/server/utils/im-terminal-payload.unit.test.ts src/shared/integrated-runtimes`: **37 files / 288 tests passed**.
- Integration selection for `external-session-mock`, `runtime-diagnostics`, `dsh-delete`: **3 files / 203 tests passed**. An initial filter named nonexistent mutation-store/recovery paths; those did not execute in this command and are not counted here.
- Corrected `src/server/__tests__/dsh-mutation-store.integration.test.ts`: **1 file / 22 tests passed**, including purged receipt physical-collection replay.
- `session-transcript/dsh`, `runtime-browser`, `runtime-steer`: **3 files / 20 tests passed**.
- `node --test scripts/build-assets.test.mjs scripts/build-resource-staging.test.mjs scripts/integrated-runtimes/dsh-handoff-policy.test.mjs scripts/integrated-runtimes/prepare-dsh-runtime.test.mjs`: **50 tests passed**. Initial 49/50 result exposed a pre-existing fixture assumption: on clean macOS files `xattr -crs` has nothing to clear and returns 0. Explicit scratch attribute seeding reproduces the intended permission refusal and preserves all source/staged byte/mode assertions.
- Total focused deterministic checks: **583 passed** (288 unit + 245 integration + 50 build).
- `npm run typecheck`: **passed** including AgentNet/CodeMirror/Virtuoso prechecks.
- Scoped ESLint covering all changed server code/tests, DSH directory and native Vitest config: **passed**.
- `npm run test:classification`: **passed**, 393 server tests (100 integration, 6 credentialed).
- `git diff --check`: passed.
- Test summaries/logs remain local at `/tmp/moxbots-upstream-dsh-{build-tests,mutation-tests,runtime-tests,typecheck,eslint,classification}.log`; unit and initial integration results are in this task tool transcript.

## Artifact admission status

The exact 0.1.18 public manifest was fetched from the release selection URL. It names source `8f5a36fa3ef7544b5dfeda432f0446531d476707` and verified claims for darwin-arm64, darwin-x64, linux-x64 and win32-x64. The selected darwin-arm64 archive has size 46,916,412 and SHA256 `4d59a3a6e21e932aa6c894b873099b4103768420e5dddd4bdde13e62348061b1`. This is publisher metadata until archive admission completes. The committed source snapshot is protocol 6.2.0/runtime 0.1.17 from native commit bfb9a6e5; formal builds use effective contracts derived from the selected verified handoff, not that source-mode snapshot.

The full darwin-arm64 archive was acquired through bounded parallel HTTP Range reads and verified to the exact published size and SHA-256 before entering the official content-addressed cache. `prepare-dsh-runtime.mjs --source release --target darwin-arm64` and `verify-dsh-resources.mjs` both passed, including the public full handoff verifier. Effective identity: runtime **0.1.18**, protocol **6.2.0**, schema SHA256 `341c84d8885b8a5be48f6c3fe02c4e27224219d9eaf374b139b961e970b7e539`, profile digest `8a9b3120b6cf7b3932803aa184575bfc322189a8ae6ed4eddcc8bbdd2afeba7b`, **48 host / 7 reverse / 4 notification** methods. Handoff SHA256 `aaaa8f2638383b8d8891530f84c126a65325d6764783061f885e931115d4c199`; Runtime manifest SHA256 `fcbe4dcfd89c93af231914753fcb44b02415a40d870d3ed28e65006714d51344`; compatibility SHA256 `e6f58bdc267f4911a5ecd4268d963976b5dbbb5f62d5bc6a6665d96367e07cd9`.

The ordinary Node downloader and two ordinary whole-archive attempts were stopped after bounded slow transport behavior; one 60-second curl attempt received 2,321,189 / 46,916,412 bytes and was rejected as partial. A temporary environment-proxy retry did not change product network configuration. Exact bundled Node 24.20.0 was copied read-only from the named sibling development resource; no source or installed application was changed. Public verifier logs are `/tmp/moxbots-upstream-dsh-{prepare-cached,verifier}.log`. Native smoke uses selected effective contracts and scratch HOME/loopback providers; exact final results and the remaining artifact gate are below. No real Provider, installed desktop, Linux/Windows native, package signing, production or user-history acceptance is claimed.

## Native results and remaining artifact gate

Exact command (run from this or the root integration worktree):

```sh
MYAGENTS_DSH_NATIVE_SMOKE=1 \
MYAGENTS_DSH_NATIVE_SMOKE_RESOURCE_ROOT=/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-upstream-dsh/src-tauri/resources \
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
npm exec vitest run -- --config vitest.dsh-native.config.ts
```

Final full native run: **15 passed / 2 failed / 2 skipped (19)**, `/tmp/moxbots-upstream-dsh-native-final.log`. The eight Anthropic/DeepSeek × interrupt/kill × resend/prewarm history recovery and unreadable-state deletion combinations pass, as do exact handshake, configured resume, MCP/attachment/realtime/TLS checks. Chromium is skipped without an explicitly supplied browser executable; the separate native soak is disabled. Root independently reran and passed the eight recovery/deletion combinations against integrated source.

Both failures are the small/large approval-review fixtures, after correcting a stale model-facing tool contract. Verified 0.1.18 advertises native `subagent` / `fork_agent`; their shared Product approval surface remains canonical `Agent` / `agent.spawn`. The fixture now checks that actual model schema, exact six permission approvals, inherited directory grant without redundant approval, foreground-child native lineage (id, parent, depth, one-shot mode), `process.execute` Session-tree approval, exact CLI capability route, inherited model, and native history recovery. These all pass before the retained final prompt assertion fails. `npm run build:cli` prepared only this worktree's ignored CLI resource; scoped ESLint for the fixture passed.

The failing assertion at `process-host.native.integration.test.ts:1099` rejects the actual child prompt sentence `operations that require approval are rejected automatically`. Native DSH `@deepseek-ai/dsh-subagent/lib/index.js:489,514–517` inserts the paragraph unconditionally. Its generic delegation policy pins approval to never, while MyAgents Runtime composition `composition.js:860–885` overrides child approval with the parent's policy; the controlled foreground child indeed requests and receives Host approval. This is an advisory text contradiction, not an observed approval denial or bypass. Do not claim full native acceptance.

It is **pre-existing**: both the named sibling's selected 0.1.17 / protocol 6.1 artifact and this selected 0.1.18 / protocol 6.2 artifact have identical `dsh-subagent/lib/index.js` SHA256 `343d1f45aa3122f02219804b3e86f306109e40349e1c0d616b64b1df432069ad`, package `0.2.0-rc.2.myagents.639ed0153972.56bce4eb7e07`. `gh release list --repo hAcKlyc/MyAgents-dsh --limit 10` reports latest published stable **0.1.18**, published `2026-10-13T17:52:40Z`; no newer compatible fixed artifact is available in that listing. Downgrading to the known 0.1.17 / protocol 6.1 would not satisfy maintenance-delete protocol 6.2. The local artifacts remain unmodified and no caller masks the failing assertion.

## Independent integrated-source review requested by root

Read-only review of root c678/MCP/history integration against base 4d3b666c found duplicate Rust `#[cfg(test)] mod tests` in `src-tauri/src/session_goal/scheduler.rs` (original 326 and appended 372), which would cause test-build E0428; reported to root for correction. No additional actionable regression found in broad recovery/model-switch activity guards versus nonambient Goal snapshots, claim-before-final-validation, or SSE asynchronous reserve/epoch/queue ordering. Actual installed SDK defines replace-level live tasks and excludes ambient tasks from activity; the narrower Goal facade respects that contract while broad safety guards retain task-edge observation. Root-owned diff reviewed did not change existing navigation.

## Next step

Root should integrate the final native-fixture/evidence commits, retain the full native artifact gate, and deliver only the agreed mainline scope with the advisory prompt limitation explicit. A future verified protocol-6.2-compatible Runtime release must correct child prompt policy and pass both approval scenarios before full native acceptance. Worker did not push or publish; remote handoff remains owned by root.
