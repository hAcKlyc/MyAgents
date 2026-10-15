<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/host-capabilities-compat-20261016 -->
<!-- git-project-sync-task:base=c225acd830513eb50736f75718f559a9ebda17bc -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-HOST-INSTALL-82-20261016: bounded Host capability compatibility

## Objective and scope

The user requested installation, browser-authorized owned-network enrollment, and then reuse of the current desktop main Agent's model on their new Linux Host so it can execute tasks. This branch fixes a discovered blocker: the Host advertises 13 methods while deployed v1 codecs accept at most 12. The desktop therefore falls back to the legacy Kimi form.

Retain the existing v1 codec, permissions, private IPC and all callable operations. Omit only the redundant baseline host.snapshot advertisement; extension clients use host.inspect, and legacy clients can still call host.snapshot. Preserve remote-session support and modern generic provider operations within the existing bound. No desktop restart, client replacement, cloud-service deployment, protocol widening or secret values in Git.

## Acceptance criteria

- [x] Identify 13-versus-12 regression in actual Host capabilities and codec.
- [x] Keep advertisement within deployed v1 bound and retain callable baseline.
- [x] Actual bundled Host/Unix IPC regression verifies modern capabilities, bound and legacy snapshot; relevant controller regression passes.
- [ ] Source review, CI, PR merge, remote main inclusion.
- [ ] Build source-pinned Host package; back up target state and encrypted credentials consistently, preserve identity/units; controlled target update and rollback path.
- [ ] Desktop generic configuration reads actual target; current source provider/model reused through encrypted credential owner.
- [ ] Explicit execution permission and bounded Agent workspace; real minimal model/tool task and restart persistence.

## Verification and evidence

Private installation and execution records remain under MoxBot/work/host-install-82-20261016/. They must contain no raw credentials or authorization URLs. Current desktop source is default-workspace Mino, RC-Codex-Official / gpt-6.1-sol; no assumptions about unrelated Agent settings. Installation, network ready, desktop configuration, model execution and main delivery are separate gates.

## Next step

Node24 integration checks passed 16/16, including the actual bundled Host response and legacy call; focused ESLint and diff whitespace checks passed. Commit/push the fix and open a PR while preparing the target Host update. Do not touch other worktrees or the ongoing desktop release owner.
