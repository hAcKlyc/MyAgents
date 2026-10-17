<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/upstream-channels-20261017 -->
<!-- git-project-sync-task:base=4d3b666c170367a05a8871bee8a9b6032b7ef379 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-UPSTREAM-INTEGRATION-20261017 — channels

## Objective and scope

Port upstream 20d1bcc9 (relocated OpenClaw contracts) and ed28af72 (WeCom opaque QR handles) into MoXBots. Primary integration agent owns main/PR/CI and combined Rust validation. This branch owns plugin bridge contracts, Rust QR transport, QR helper and setup surfaces. Preserve MoXBots branding/navigation, credentials, Rust final admission and existing configuration owners. No production, account, real QR network or installed-client changes.

## To Do and acceptance

- [x] Verify configured/fetch/push repository https://github.com/heavenzhang/MoXBots.git and base4d3b666c; clean isolated branch observed before applying patches.
- [x] Port both repairs cleanly, retain legacy package exports and shared implementations; synchronize all three shim freshness identities.
- [x] Serialize async runtime snapshot mutations; reject conflicting host/legacy writes and unsupported file transactions without overwriting newer state.
- [x] Preserve opaque underscore and reserved-character session codes; reject empty, over2048-byte and control-character handles; encode exactly one scode query field and omit handles from poll errors/logs.
- [x] Render both existing setup surfaces in DOM tests, exercise start/poll/after-refresh failures, preserve credentials and suppress raw errors.
- [x] Commit focused regression coverage and documentation.
- [ ] Primary: review/integrate latest main, run combined Rust tests/CI and browser UI acceptance; verify remote main contains result.
- [ ] Existing sole release owner: release/native/user-path acceptance if applicable; no release performed on this branch.

## Validation evidence

Node v24 via /opt/homebrew/opt/node@24/bin. Reused existing unchanged node_modules through read-only symlink; no package installation or dependency modifications.

Focused run1: SDK public contracts17, legacy shim8, QR runner9, rendered QR UI6 =40 passed. Run2 after adding host CAS and unsupported-file regression: SDK contracts22, OpenClaw config7, compat runtime10 =39 passed. Across unique files62 tests pass (SDK contracts final22 +8 +9 +6 +7 +10). Scoped ESLint passed (only existing baseline-browser-mapping age notice). Test classification and diff whitespace checks passed.

Rendered behavior evidence: credentialQrFailures.test.tsx renders ChannelWizard and ChannelDetailView, clicks existing detail credential/re-scan buttons, and asserts each of start/poll/expired-refresh-then-poll paths displays the correct Chinese operation message, never an unrelated expiry/raw session error; persistence remains untouched and existing botId/secret unchanged. This is jsdom behavior verification, not a native screenshot/provider scan.

Added/ported Rust tests: commands::wecom_qr_tests (4) and im::credential_provisioning::tests::qr_session_keys_are_opaque_provider_values (1). Execution deferred to primary combined Rust gate. rustfmt --check reports preexisting unrelated commands.rs formatting outside this patch; no unrelated formatting applied.

## Runtime assumptions, boundaries and next step

Mutation support remains the Bridge normalized in-process snapshot only. afterWrite is accepted compatibility metadata without disk write/restart. Host writes must replace the snapshot through the existing setter (current implementation does); async mutation CAS detects that identity change and fails. Legacy sync mutations remain synchronous. Existing Rust BIND/allowlist/group admission is unchanged.

No real provider smoke or native client acceptance performed. Observe gate PASS; task-init was invoked after staged patch application and correctly blocked on dirty worktree, so this equivalent task record was authored manually. Next: primary cherry-picks reviewed branch commit and carries integration gates.
