# Goal grouping regression — MOXBOTS-PROJECT-BOARD-006

Root cause: the board read Task status and current Session turn state, but never read Rust-owned Goal state. A done Task with an idle turn and active Goal could appear completed.

The existing `getSessionGoal(sessionId, workspacePath, true)` read now accompanies bounded Session observations. An active Goal keeps work running between turns; waiting for human input remains actionable. Paused, blocked, canceled and unreadable/expired Goal state cannot appear done. Terminal Goal alone does not complete a linked Task. The same read protects archive actions. Goal events trigger an active visible board refresh; associated Session IDs are observed even when metadata is absent.

Validation: 44 unit/DOM tests; full typecheck/lint (16 existing dependency warnings, 0 errors); production web build; seven actual React browser checks in `ui-results.json` at 1440 and 540 pixels. Screenshots use only explicitly synthetic data. Primary agent checked layout and Escape/detail behavior; no independent reviewer was used for this bounded state change.

Reproduce locally: run `node dev-docs/project-board-validation/goal/serve.mjs`, then `node dev-docs/project-board-validation/goal/verify.mjs`. If Playwright's expected Chromium is not installed, set `BOARD_BROWSER_EXECUTABLE` to an existing isolated test-browser executable. No real browser profile, model turn or business mutation is used.

Native acceptance remains open: the installed client is not replaced by this task. Existing unified release source/owner and busy application must be respected; a follow-up package must include the patch and be checked against the real Task/Session/Goal once an installation window is available.
