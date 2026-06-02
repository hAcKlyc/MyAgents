---
issue: 294
url: https://github.com/hAcKlyc/MyAgents/issues/294
reporter: "@olinfox"
created: 2026-06-02
processed: 2026-06-02 16:19 Asia/Shanghai
type: bug
status: fixed
---

# 对话记录选择与跳转卡顿、无反应、跳转错误

## Issue 概述

Reporter is on v0.2.26 / Windows 10 and describes rapid history switching causing slow response, no response, or wrong-session jumps. Reported logs include old sidecar kill/release, stale config reads, callback-id failures, tab server URL retry exhaustion, and load-session skip messages.

## Root Cause

Session switching had no per-tab latest-request guard. `App.handleSwitchSession()` performs several async Rust/sidecar operations before it finally commits `setTabs`. When a user clicks sessions A → B → C quickly, older async work can finish after the newer request and still mutate visible tab state or focus.

`TabProvider.loadSession()` had a matching stale-response gap: a slower `/sessions/:id` or `/sessions/switch` response could continue after a newer load had started, then replace message history for the wrong target. The sharpest failure mode is stale `loadSession(A)` running after `currentSessionIdRef` has already moved to B, because tab-scoped HTTP helpers resolve their base URL through that mutable ref.

## Fix

- Added `shouldCommitSessionSwitch(...)` as a pure latest-wins guard with unit coverage.
- `App.handleSwitchSession()` now stamps each per-tab switch request with a token and checks it before visible commits, tab focus changes, new-tab commits, and background-completion cancellation.
- `TabProvider.loadSession()` now uses a generation guard and, for prop-driven switches, rejects loads whose target no longer matches `currentSessionIdRef`.
- Stale loads no longer clear the loading flag for the newer load.

## Verification

- `npm run test:unit -- src/server/utils/tool-result-attachments.unit.test.ts src/renderer/utils/optionResolve.test.ts`
- `npm run test:unit`
- `npm run typecheck`
- `npm run lint`

`npm run lint` passed with the existing dependency-cruiser warning for `src/renderer/constants/chatSuggestions.ts`.

## GitHub Handling

Label `bug`; comment with root cause/fix/verification; close as completed after commit/push.
