# MOXBOTS-UPDATER-20261014 — confirmed-update composer checkpoint

Scope owner: `SimpleChatInput` owns its live text, images and `QueryMentionContext`. `App` owns confirmed update and exact persisted Tab restore. This patch adds a single-renderer MoxBots-only handoff; it does not start a process, send a message, mutate a Session, weaken Rust admission, or make normal quit an autosave path. `getConfigDir()` selects the existing build-profile root, including updater QA isolation.

## Status and acceptance

- [x] Code: exact Tab / Session / workspace / discussion scope wiring through Chat and Launcher; stable getter registration keeps keystrokes inside the composer rather than rerendering Chat.
- [x] Simulated: new unit19 + DOM6 checkpoint regressions; existing related DOM91 passed. Root added an owner-scope rerender/abort regression; readOnly capture now survives owner re-registration and restores editability. TypeScript and changed-file ESLint pass. No real directories, credentials or network are used by the new tests.
- [ ] Native: Root must rebuild A2 (0.5.3) and B2 (0.5.4), then verify the actual confirmed update and restore pill on the independent QA identity. Old A does not contain the new checkpoint writer.
- [ ] Mainline / release / production: Root owns commit, merge, CI, packages, publication and acceptance. This worker performs none of them.

## Behavior

Before any await, the update path rejects IME composition, a pending send/import/file-picker/FileReader, in-memory images (including prepared image attachment refs), screenshot context and staged workflow settings. Live content stays editable on rejection. It then freezes text, send and attachment entry points, submits existing Record/file saves, validates the complete composer snapshot, and awaits `safeWriteJson` (tmp + fsync + rename + directory fsync) to `update-composer-drafts.json` under the existing config root. Failure refuses installation, awaits cleanup only of this attempt's main/bak/tmp artifacts, and releases the live input. Cleanup failures are surfaced.

The file contains the existing whitelisted Chat/Record tab snapshot plus visible draft text and validated structured context. Workspaces and `@myagents_files/...` text references remain exact; Agent mention snapshots, primary context and the compiled product Skill requirement remain typed. Invalid or stale structured context rejects rather than becoming plain text. The handoff must map to a real restorable Chat Session. Nonempty Launcher and pending Chat drafts refuse installation with a Chinese message; an empty Launcher does not block.

A final check after tab persistence and immediately before the Rust install call verifies membership, draft equality and exact restorable scope. Backend execution admission is unchanged. Successful install keeps the input frozen until relaunch; abort releases it. Recovery takes the awaited handoff tab IDs over possibly stale WebView localStorage. It offers the existing restore pill even if an older clean-exit marker survives. The exact mounted composer receives text and context without calling `onSend`; other scopes and existing nonempty text cannot consume that draft. Unclaimed draft files remain until restored or explicitly dismissed. A further update is refused while valid loaded drafts remain unclaimed.

## Native evidence Root still needs

Use only independent updater-QA roots/bundle keys and synthetic fixtures, with all SDK/model paths disabled. Open a real persisted synthetic Chat Session in A2, leave a recognizable multiline draft (with a durable workspace file reference) and an edited Record note, click update confirmation, and confirm no model/send admission occurs. Observe B2 relaunch/version, click restore, and verify exact tab/session/workspace, exact text/reference, and Record note. Close/reopen or inspect synthetic disk state only to corroborate the UI; a JSON file alone does not prove restoration.

Separately leave a nonempty Launcher, active IME, image, or delayed attachment import and verify confirmation visibly refuses installation and preserves the draft/attachment while the app stays usable. Verify cancellation and blocked Rust install remove main/bak/tmp handoff files and unlock input. Structured-context reconstruction is covered by DOM; native structured-context evidence is required before claiming that business path accepted.

Known scope: no normal-quit persistence, no durable File/image serialization, no Launcher reconstruction, no model execution or production acceptance. Read/parse failure preserves the handoff file, blocks further updates and shows a recovery error; support must inspect only authorized evidence rather than delete a user's data to force acceptance.

## CI composition repair

The leaf checkpoint now takes the existing serializer/parser from App rather than importing the builtin UI composition at runtime. Root and independent 62/62 related cases passed; Node24 full lint (0 dependency errors; 16 existing orphan warnings), typecheck and diff check passed. The c46 compilation inputs are superseded; native candidates must be rebuilt from the repair commit.


### A3 guard coverage and boundaries

Mox-only local editor admission covers ThoughtCard, ThoughtInput and TaskCommentTimeline. Dirty/IME/in-flight states refuse installation without auto-save/send; remote-session tabs explicitly refuse until formal update attestation exists. Root 211 focused regressions plus composition139, independent154 and real isolated/authenticated Node route1 pass. DefaultMyAgents does not register these guards.

Native A2 exposed a separate ordinary TaskCenter tab-navigation loss of unsubmitted inline state. It was not an updater installation loss (installation never ran), and is not claimed repaired here. A3 updater guard must be tested with editor still mounted via titlebar update. Chat durable handoff restore and A3/B3 native upgrade remain pending. Daily installed0.5.3 requires one manual installation of corrected0.5.4; this task cannot operate daily App/data/Keychain.


### Final native restoration accepted

A3/B3 sourcee5a05f76 actual signed update passes. Mounted inline/new-thought drafts refuse exit, remain editable; own realPTY continues during refusal. Idle confirm installs B0.5.4, real Rust RESTART_EXIT_CODE cleanup removes old App and sidecars. Restore pill brings exactTab/Session/workspace/three-line draft and @file reference back without send; actual editable keystroke/revert and durable handoff consumption pass. OwnRecord hash unchanged. Root independently observed actualB AX/screenshot/latest204 and draft after tab navigation. See isolation review tenth round and WPS work/updater-20261014/qa-native-A3.log/QA-WINDOW-RELEASED.json. This proves QA-profile native update; production user/issuer/paidProvider/Host are not claimed.
