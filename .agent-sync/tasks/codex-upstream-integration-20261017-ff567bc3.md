<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/upstream-integration-20261017 -->
<!-- git-project-sync-task:base=4d3b666c170367a05a8871bee8a9b6032b7ef379 -->
<!-- git-project-sync-task:status=ready-for-review -->

# Task: Integrate nine upstream repair groups while preserving MoXBots navigation

## Objective

MOXBOTS-UPSTREAM-INTEGRATION-20261017: user authorized all nine reviewed upstream repair groups and settings navigation state repair, preserving existing MoXBots navigation/brand and business-action recovery safeguards. Destination confirmed in this conversation: https://github.com/heavenzhang/MoXBots.git main. Upstream frozen36b5282c88275cd6e8851bd9eb0a37d6f9c48dd6. Do not copy upstream product version/changelog.

## Acceptance criteria / To Do

- [x] Verify source, remotes, clean isolated branch, base4d3b666c and current owner/CI triggers.
- [x] Integrate MCP normalization+overflow (db28d65c,8c6ea9e6).
- [x] Integrate Goal/MCP recovery (c6787a46,d05472b5) preserving context recovery.
- [x] Integrate history body preservation/ref transport (31e813a9).
- [x] Integrate DSH diagnostics/build/deletion+paired artifact (9c8ee6cf,6ef57a68,786504dd,706f00cb,required selector only).
- [x] Integrate AgentNet recoverable terminal returns/protocol (78d85eb5), validate owned service compatibility.
- [x] Integrate plugin SDK+WeCom QR fixes (20d1bcc9,ed28af72).
- [x] Port only settings/capabilities consumed-navigation state fix/tests from2fdc6448; sidebar/App menu design unchanged.
- [x] Review combined diff; focused tests, TS/lint, deterministic suites, JS bundles and relevant Rust/loopback/native tests.
- [x] Actual rendered settings/channels state interaction checks; preserve navigation baseline.
- [x] Independent review and repair loop, see acceptance record.
- [ ] Final-head CI pass, main integration and remote ancestry proof via PR98 merge receipt.
- [x] Save next-release dependency/acceptance record with no concurrent release.

## Ownership / execution

Root owns MCP/Goal/history/navigation and combined integration, acceptance/PR/main. Native workers: dsh_fixes (6.1-sol/high requested, native protocol/storage risk); network_fixes (6.1-sol/high requested, cross-device auth/dedupe risk); channel_fixes (6.1-sol/medium requested). Each owns isolated codex/upstream-{dsh,network,channels}-20261017 worktree under /Users/zhangshaohua/Documents/Codex/2026-10-17. No worker production changes. Usage/cost unknown unless runtime reports it. No external model calls in selected native mode.

## Completed

Read owning architecture and current canonical project map/plan. Observe/start gates pass. User scope explicitly includes main delivery. Existing deploy workflow disabled; test/service CI do not deploy.

## Verification

Evidence under dev-docs/upstream-integration-20261017/ (bounded source records), verbose logs outside Git under original MoxBot/output/upstream-integration-20261017/. No real user data/credentials in fixtures.

## Deployment request

Desktop signed release required after main delivery. Sole deployment chat remains01a12bc2-907a-7702-b6dd-788225c5dfe4; this task does not install/publish/restart daily clients, cloud or Hosts. Preserve frozen058/current release. Queue next unfrozen release with DSH/protocol resource requirements. Real provider scan/live transient disconnects and signed-client acceptance tracked separately from local tests; cannot mark them passed from CI. No permission to message another chat has been given in this task.

## Blockers and unknowns

All source groups integrated; DSH0.1.18/protocol6.2 artifact verified and8 scoped native recovery/delete cases pass; full native has2 pre-existing advisory-prompt assertion failures (old/new artifact source identical), gate retained; owned relay currently lacks permit/return-route authority and remains safely capability-gated. Mac full App Rust compile has a Swift dependency link environment failure; required Linux/Windows CI must pass. Product source/main delivery and production acceptance are separate gates.

## Next step

Require final-head PR98 CI green, merge through normal reviewed flow, verify remote main contains the final head and preserve merge receipt. No concurrent desktop/service release; native advisory gate stays open with the existing sole release owner.

## Final source evidence

All nine groups and state-only navigation integrated. Main da68eba3 synchronized without changing its navigation. Combined acceptance, browser provenance, known native advisory gate and execution report: `dev-docs/upstream-integration-20261017/{acceptance.md,execution.md}`. PR98 is the authority for final CI and merge status. Root confirms remote main ancestry after merging and saves the receipt outside Git (the receipt necessarily follows this commit).
