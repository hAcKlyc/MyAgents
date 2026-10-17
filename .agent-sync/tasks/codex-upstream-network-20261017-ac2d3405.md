<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/upstream-network-20261017 -->
<!-- git-project-sync-task:base=4d3b666c170367a05a8871bee8a9b6032b7ef379 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-UPSTREAM-INTEGRATION-20261017 — AgentNet terminal recovery

## Objective and scope

Port upstream `78d85eb51aa0cfe96d68566f03250af5777b177e` onto the MoXBots-owned connector. Preserve accepted execution semantics, existing Host management, credentials/CA/Owned enrollment, continuous watch ownership and safe legacy negotiation. Protocol artifact authority: `hAcKlyc/MyAgents-Agenthub` source `eb6e2954b1b556766a616c67bb271335ae0d75e0`, package 1.2.0 SHA-256 `240dc3b654ab221db2904ba41dcf68d61d04492d6b3a10c370c59609c926720a`.

## To Do and acceptance

- [x] Verify canonical Git URL, branch, clean base and project coordination records (`observe`/`task-init` passed).
- [x] Import fixed protocol package and Rust wire projection; update only protocol package versions in consumer lockfiles.
- [x] Move bounded terminal-return associations and Inbox settlements into original Rust App identity owner; require fresh route resume/rebind before sending retained terminal event.
- [x] Preserve original op/event correlation, lost-ACK dedupe, watch registration lifetime and no accepted start/send replay; no durable outbox or permission expansion.
- [x] Resolve actor conflicts preserving MoXBots identity stores, credential cache, public CA, Owned enroll, management-only behavior, catalog ACK and diagnostic backoff.
- [x] Review owned relay compatibility and retain fail-closed capability negotiation and unsupported route resume regression.
- [x] Node terminal-return and Inbox event tests: 15 passed; fixed-artifact verifier and tamper tests: 4 passed.
- [x] Rust protocol: 13 tests passed; owned relay: 10 tests passed; actual headless crate: 162 tests passed.
- [x] Direct TypeScript `tsc --noEmit --pretty false` and server test-classification passed.
- [x] Original `returns.rs`/`memory.rs` state-only temporary harness: 27 tests passed (App/transport shell stubbed; not an App/native/relay integration gate).
- [ ] Full App Rust/native code gate: macOS dependency Swift linker environment blocks before this task's App modules compile; root must require Linux/Windows CI and review actor integration.
- [x] Commit local task branch for parent integration; no subagent push or main/production mutation.
- [ ] Root integration owner reviews combined diff and runs combined checks, merges/pushes main under task authorization.

## Server compatibility and limitations

`services/agentnet/relay-core` has device/channel relay only. Existing metadata advertises `capabilities: []`; `op.prepare` is already explicitly `UNSUPPORTED`. It has no permit or return-route authority, so implementing route.resume alone cannot enable recovery. This change does not advertise `return-resume-v1` or invent authorization. The regression confirms newly schema-valid `route.resume` also returns exactly one `UNSUPPORTED` error.

The desktop client negotiates resume only when `/v1/me/network` explicitly advertises `return-resume-v1`. MoXBots management-only actor keeps only `tls13-mtls` and skips the recovery metadata request. Headless `probe.rs` only adds exhaustive diagnostic mappings for the two new enum variants. Headless `connector.rs` uses its existing `management_hello`, `ManagementMessage`, explicit management IPC/admission and optional owned execution gateway; no terminal-return owner was added there. Remote Session traffic remains on its established device channel and Session owner.

No real-account writes, daily installed client actions, model calls, cloud deployment or production acceptance were performed. Owned-relay terminal recovery is unavailable pending a full compatible permit/route service owner. Synthetic state tests do not constitute native client or real two-end network acceptance; a real recovery service is required before such acceptance.

## Verification commands

- `npm ci --ignore-scripts --no-audit --no-fund` in this isolated worktree (978 packages; no shared node_modules mutation).
- `npm exec vitest -- run --project unit src/server/agent-network/return.unit.test.ts src/server/inbox/session-event.unit.test.ts` — 2 files, 15 tests passed.
- `node scripts/verify-agent-network-protocol.mjs` — protocol 1.2.0 and expected SHA verified.
- `node --test scripts/verify-agent-network-protocol.test.mjs` — 4 passed.
- `cargo test --manifest-path src-tauri/agent-network-protocol/Cargo.toml` — 8 unit + 5 parity passed; build/test command 2m23s.
- `cargo test --manifest-path services/agentnet/relay-core/Cargo.toml` — 10 passed, test execution 4.55s, first compile 2m16s.
- `cargo test --locked --manifest-path src-tauri/headless-network/Cargo.toml --lib` — 162 passed in 2.59s after a 1m58s first compile; includes actual cryptographic channel, exact scope and no replay regression.
- `npm exec tsc -- --noEmit --pretty false` — passed; `node scripts/check-test-classification.mjs` — passed (391 server tests).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib agent_network:: --no-default-features` — BLOCKED/FAILED before App module compilation: `apple-cf 0.9.3` and `apple-metal 0.8.8` Swift bridge manifest links fail with missing arm64 `PackageDescription.Package.__allocating_init`; command exits 101. No system/toolchain changes or dependency suppressions applied. Full App compile remains a required CI gate.
- Temporary `/tmp/moxbots-return-state-harness-20261017` directly references original `returns.rs` and `memory.rs`, uses actual protocol crate plus inert App/watch/transport shells; 27 state tests passed in 0.02s. This verifies lost ACK/same event dedupe, admission settlement across epochs, expiry, peer scope, watch cancellation and identity loss, but does not compile actor.rs or exercise actual socket recovery/App lifecycle. It is not equivalent to full App verification.
- Rust toolchain 1.92.0; targets `/tmp/moxbots-network-cargo`, `/tmp/moxbots-network-relay-cargo`, `/tmp/moxbots-network-app-cargo` are inactive after verification; integration owner may reuse. Isolated `node_modules` in this worktree contains protocol 1.2.0 and normal local CodeMirror/Virtuoso patches; root may consume read-only.

## Next step

Root reviews the local task commit, combines the other upstream changes, requires full App CI, and integrates to canonical main. No remote handoff synchronization is claimed until the integration owner publishes it. Token usage/cost unavailable from tool outputs; npm install duration was measured at 13 seconds, other durations are recorded by test output.
