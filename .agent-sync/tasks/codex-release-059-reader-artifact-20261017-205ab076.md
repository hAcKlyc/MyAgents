<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/release-059-reader-artifact-20261017 -->
<!-- git-project-sync-task:base=343b37e6dec01a19ed131630542d9e1d3d4d66df -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-059 Developer ID credential reader pin repair

## Objective

Make the formal 0.5.9 macOS arm64 package build against the current merged main by refreshing the Developer ID credential-reader artifact/source pin and adding regression coverage. Then complete the already-authorized package and self-hosted updater publication through the release owner workflow.

## Acceptance criteria

- [x] The signed arm64 reader matches the current packaged source closure, release manifest, identity and CDHash; strict codesign verification passes.
- [x] The reader pin regression is part of the build-script suite and passes locally.
- [x] The complete build-script suite passes serially; typecheck, lint and Rust reader crate checks complete with evidence recorded accurately.
- [ ] Normal PR checks pass and the repair is merged into canonical main; verify exact remote-main SHA.
- [ ] Correct the unpublished `v0.5.9` source tag only after the repair is on main, preserving the audit record of the initial target.
- [ ] Rebuild and independently inspect the signed/notarized 0.5.9 app package; publish one immutable artifact to the existing updater and complete public verification/lock release.
- [ ] Report elapsed time from the original formal build attempt through successful public verification, including the failed attempt/remediation and per-stage durations.

## Completed

- Canonical repository is `https://github.com/heavenzhang/MoXBots.git`; this branch is based on merged main `343b37e6dec01a19ed131630542d9e1d3d4d66df` (PR #97). Its existing tree included the official AgentNet protocol v1.2 source, while the Developer ID reader release pin still described the older source closure.
- The initial timed app build failed closed during reader source-closure verification in 0.525 seconds. It produced no app compilation or package output, and no server changes occurred.
- Rebuilt the arm64 reader with locked Cargo dependencies for the current source closure. Artifact SHA-256 `e99409ad3e881b202d3adda27f8b98b580ae177df3563cbc73243ad448d87b04`; CDHash `63faf580a4ac68dd0604f97b7a61b5df6d24e7d5`; source closure SHA-256 `13adb414091cb5b6b2d17440c9535d904b5c50e45a4a49ada8236335d60927b9`. `codesign --verify --strict` and the fixed identity checks pass. Independent read-only artifact review passed.
- Added a regression requiring the Developer ID pin to match `computeSourceInputSha256()`, and included the reader test file in `test:build-scripts`.
- The complete build-script suite passed serially: 286 passed, 14 skipped, 0 failed. Two transient parallel-run failures passed individually and in the serial run. `npm run typecheck` and `npm run lint` passed; lint emitted 18 existing non-fatal no-orphan warnings. `cargo test --bin moxbots-credential-reader --features fixed-macos-reader` exited successfully but ran zero tests; it is not evidence of tested Rust behavior.
- Remote `main` and local `v0.5.9` tag still point to `343b37e6dec01a19ed131630542d9e1d3d4d66df`. No package has been published. The tag correction remains pending the repair merge.

## Boundaries

Do not install, quit, launch or restart the daily MoxBots app; do not interrupt active user work. Do not upload package binaries to GitHub or alter the existing update service routes. Keep the 0.5.8 rollback archive and stable record intact. A source merge, package build or HTTP response alone does not constitute successful updater publication.

## Verification

- `node --test scripts/prepare-moxbot-credential-reader.test.mjs`: 18/18 passed, including the new source-closure pin regression.
- Full build-script suite with test concurrency set to one: 286 passed, 14 skipped, 0 failed. In the earlier parallel execution, two timing-sensitive tests failed once, then passed individually and in the full serial rerun.
- `npm run typecheck`: passed.
- `npm run lint`: passed with 18 existing non-fatal no-orphan warnings.
- `cargo test --bin moxbots-credential-reader --features fixed-macos-reader`: exit 0, zero tests discovered; not treated as behavior coverage.
- Independent reader artifact review: passed SHA, CDHash, source closure, fixed signing identity, architecture, strict signature and release-manifest consistency.
- `git diff --check`: passed before commit. Git handoff gate will be rerun after pushing this exact record.

## Blockers and unknowns

- Follow-up PR checks and normal merge are pending.
- The `v0.5.9` tag currently points to the initial 0.5.9 main commit `343b37e6`; it was created in this release attempt, but must be corrected only after the reader fix reaches main. No 0.5.9 package or server publication exists.
- Final Tauri build, signing/notarization, external transfer, stable promotion and public checks have not completed. The original end-to-end timer remains active and must not be reset.
- The signed reader artifact is local to the release host at `/private/tmp/moxbots-059-reader-artifact-343b`; it is not part of the Git commit. Recompute the packaged source closure after merge before reuse.

## Next step

Run the final source checks, stage only the pin, regression test, package script and this task record, then commit and push this branch. Open a normal PR, wait for its exact-head checks, merge normally, and verify remote main before correcting the unpublished v0.5.9 tag and continuing the timed package build.
