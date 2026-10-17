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
- [ ] Prepare isolated DSH artifact and run native handshake, interrupted recovery and failed-history deletion tests where resources permit.
- [ ] Review complete diff and commit evidence for root integration.
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

Archive acquisition/native verification remains in progress. HEAD requests to both Node and DSH return HTTP 200, while full downloads are slow. A downloader retry enables the already configured environment proxy only in the isolated preparation process. No application network configuration was changed. No native smoke, real Provider, installed desktop, Linux/Windows native, package signing, production or user-history acceptance is claimed.

## Next step

Finish bounded release acquisition; if admission succeeds, verify handoff and run explicit native process tests using this worktree resources. Root must review/integrate commits into latest main and own combined acceptance/push. Remote handoff is not synchronized by this worker.

