---
issue: 292
url: https://github.com/hAcKlyc/MyAgents/issues/292
reporter: "@olinfox"
created: 2026-06-02
processed: 2026-06-02 16:19 Asia/Shanghai
type: feat
status: reviewed-notified
---

# 支持将用户数据目录迁移至自定义路径

## Issue 概述

Reporter wants to move the default `~/.myagents` data directory to a custom path, mainly to reduce pressure on the Windows system drive. Suggested shapes include a setting in the UI, an environment-variable override, and a migration tool that moves existing data safely.

## 架构判断

This is a valid feature request, but it is not a narrow renderer setting. `~/.myagents` is currently a cross-process authority boundary used by Rust, Node sidecars, plugin bridge, CLI, bundled skills, logs, sessions, generated attachments, cron/task state, search index, and helper-agent assets.

There is already a good Rust entry point:

- `src-tauri/src/app_dirs.rs::myagents_data_dir()`

That helper is intended to centralize the data root. The gap is that many Node/CLI/system-skill paths still hardcode `~/.myagents` or derive it independently. A correct implementation needs a single authority and explicit propagation into every subprocess.

## Recommended Plan

1. Define the authority:
   - Rust owns the resolved data dir.
   - Sidecar / plugin bridge / CLI receive it via a stable env var such as `MYAGENTS_DATA_DIR`.
   - Node gets a central helper and no longer hardcodes `homedir()/.myagents` outside that helper.

2. Add migration only after centralization:
   - app must stop active sidecars / plugin bridge first;
   - acquire config/session locks;
   - copy or move all state atomically enough to survive interruption;
   - validate sessions, attachments, cron/task stores, logs/search index paths;
   - preserve rollback path if migration fails.

3. Update path safety:
   - attachment/read allow-lists and credential blacklists must account for the custom root;
   - Rust and Node path-safety rules must remain synchronized.

4. UI should be conservative:
   - show current data root;
   - allow selecting a new root only when no sessions are running;
   - clearly state restart/migration requirements.

## Risk

High for accidental data loss if implemented as a direct setting toggle. The feature crosses storage, process spawning, path safety, and bundled helper/system-skill assumptions. It should be designed as a migration project, not a quick preference.

## GitHub Handling

Label as `enhancement` + `needs-review`; leave open for product/architecture decision.
