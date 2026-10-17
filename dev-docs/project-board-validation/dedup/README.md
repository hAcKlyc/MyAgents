# MOXBOTS-BOARD-DEDUP-001 acceptance

Multiple Task records can retain the same execution Session. The board previously copied current Session timing, TODOs and Goal state into every record, making completed historical checks look like duplicate active work.

The renderer now selects one presentation representative per Session: concrete Task execution first, then recent dispatch evidence, creation time and stable id. Original Task lifecycle, timeout evidence and Session links remain intact. This is a display rule, not proof of Task/Query execution identity or a TaskStore mutation.

- 48 related unit/DOM checks, full typecheck and lint passed (16 pre-existing dependency warnings, zero errors).
- MoXBots production web build and theme verification passed.
- Actual React fixture: light/dark 1440px, list, original shared-Session navigation, 540px detail/Escape and paused-Goal refresh passed; `ui-results.json` records six journeys with zero page errors. Main agent inspected light/dark/narrow screenshots. No independent reviewer, model calls or business writes.
- Browser fixture repairs: selectors initially inspected only title buttons, then the isolated store mock needed a stable snapshot; both harness defects were fixed before the final clean run. They were not product defects.
- This is synthetic UI verification. Installed native client and real salary workflow remain unverified; the patch belongs to 0.5.6, never the frozen 0.5.5 release. No application restart/install occurred.

Run `node dev-docs/project-board-validation/dedup/serve.mjs`, then `node dev-docs/project-board-validation/dedup/verify.mjs`. Loopback only at `http://127.0.0.1:8889/__board_dedup`; APIs are synthetic. If needed, set `BOARD_BROWSER_EXECUTABLE` to an existing isolated test-browser binary. No user Chrome profile is used.
