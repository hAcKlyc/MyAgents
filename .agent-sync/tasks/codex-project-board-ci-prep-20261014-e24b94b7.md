<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/project-board-ci-prep-20261014 -->
<!-- git-project-sync-task:base=644434fa685ee7e2ccc0d6421c95b5431aea1b0c -->
<!-- git-project-sync-task:status=in-progress -->

# Task: Repair native Windows NSIS CI provisioning

## Objective

Repair PR #35's Windows native NSIS prerequisite without bypassing compiler or actual install/upgrade/uninstall checks. User supplied https://github.com/heavenzhang/MoXBots.git and authorized repair plus main delivery; primary Agent owns review/integration. Worker owns only workflow, NSIS CI helper/tests and this task record. No desktop UI, release, installation or main changes.

## Acceptance criteria

- [x] Identify the failed prerequisite from run38532310804/job115746817730.
- [x] Replace floating Chocolatey provisioning with a fixed official portable asset and verify bytes before extraction.
- [x] Preserve existing native NSIS tests and fail explicitly for missing/wrong/non-executable compiler.
- [x] Verify deterministic failure cases and actual publisher archive download on macOS.
- [ ] Primary Agent review, Windows exact-head CI and main delivery (integration owner).

## Completed

- Failed Chocolatey V2 feed `Packages(Id='nsis',Version='3.13.0')` returned HTTP406 and installed0/0 packages. Its native exit check did not prevent a later missing-compiler failure. The following Rust loader diagnostic also failed because Rust tests had not run; that is secondary, not the root cause.
- Current GitHub Windows2025/2022 runner-image lists do not include NSIS; relying on preinstallation is not justified.
- `scripts/ci/download-nsis.mjs` reuses the existing bounded downloader (three attempts, five-minute body/header deadline, byte cap), pins the Tauri publisher's portable3.13 archive, verifies exact size/SHA256, and writes only validated bytes to a fresh CI-owned path. No separate cache, installer, account or admin privilege.
- Workflow extracts under RUNNER_TEMP, verifies compiler file and successful exact`v3.13` probe, then runs the original native tests unchanged. A network/verification failure exits before extraction/tests.
- Archive authority: https://github.com/tauri-apps/tauri/blob/94ffd77664759f38111bde3e85802841da80c3eb/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs#L32-L38. Publisher asset: https://github.com/tauri-apps/binary-releases/releases/tag/nsis-3.13 ; GitHub release API pins2363925 bytes and SHA256`ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8`. Actual downloaded SHA1`db14f8af2ea346b786c6ae19343f61aaf5e09b8e` also matches Tauri's source.

## Verification

- `node --test scripts/ci/download-nsis.test.mjs scripts/build-resource-download.test.mjs scripts/windows-node-runtime-install.test.mjs`:12 passed,0 failed,3 skipped (no macOS NSIS compiler; Windows native cases require CI). New tests cover truncated/same-size corruption, HTTP406 download failure, and retention of any previous archive on failed verification.
- `node scripts/ci/download-nsis.mjs /tmp/moxbots-ci-nsis-3.13.zip`: real network successful, exact2363925 bytes and expected SHA256. ZIP has`nsis-3.13/makensis.exe`, full Bin/Include/Plugins/Stubs toolchain; ZIP SHA1 matches source. This is archive evidence, not Windows execution evidence.
- `git diff --check` clean; start/task-init gates passed with canonical base644434fa685ee7e2ccc0d6421c95b5431aea1b0c. Original worker worktree fromd913 was left untouched after start gate rejected it; new assigned path/branch starts at canonical main.

## Blockers and unknowns

- Windows execution remains CI-only; local macOS checks must not be reported as actual Windows compiler/install verification. No existing test skips or expectations were changed.

## Next step

- Primary Agent reviews/cherry-picks this worker commit into PR #35, awaits all current-head CI including the unchanged real Windows NSIS lifecycle tests, then integrates the acceptance report into main.
