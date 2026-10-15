# MOXBOTS-PROJECT-BOARD-004 validation

Run `node dev-docs/project-board-validation/state/serve.mjs` under Node24 and open http://127.0.0.1:8879/__board_state. This mounts the actual React ProjectBoard with isolated synthetic APIs. It never executes a model or mutates real records. Do not use this fixture as native/business acceptance.

Automated checks: projection/activity/SessionEngine/session-observation unit plus hook/page DOM suites:161 passed. Includes exact-current-query children, root errors, owner transition failures, archive-only history, done restore/persistence boundary, visible polling, stale generations, four-reader concurrency and slow50-session sweep. Typecheck, lint, web/server builds and Rust tests are tracked in the branch task record.

Rust resource preparation follows the existing CI non-executed resource-path fixture; signed CLIProxy bytes remain verified. A temporary ManifestAPI shadow interface fixes the local CLT6.3.2 stale private interface only for that command. These test inputs are not a production package. Native packaging/installation remains owned by the existing unified0.5.5 release task.

The daily HRM log proves root-idle while current-query children were stillactive earlier on2026-10-15. The latest bounded record inspected ended07:17:37; no claim that the original screenshot's exact instant is proven, or that HRM is currently running. Private IDs, business bodies and credential material are excluded.

Archive performs a passive owner recheck, not an atomic admission lock. Any subsequent known active/last-known active unknown record remains visible in the work board even if metadata says archived. Existing Task/Session archive semantics remain in force.

Independent UI review is in review.md and screenshots/independent. Task82/82 and activity-dispatch2/2 Rust tests passed. Typecheck/full lint and web/server builds passed. The final UI review additionally fixed history counts and execution-error precedence over stale Task executionState.
