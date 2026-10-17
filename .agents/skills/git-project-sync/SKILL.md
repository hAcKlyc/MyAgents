---
name: git-project-sync
description: Require an explicitly supplied Git repository URL as the durable record and save target for continuous development across agents, threads, machines, or worktrees. Establish a committed project map, shared plan, and branch-specific handoff records so another agent can find the latest code, decisions, tests, and next step. Use when binding a project, starting work, resuming, handing off, or integrating branches. Do not use it as deployment authorization or as a substitute for runtime data, secrets, or artifact storage.
---

# Git Project Sync

Coordinate continuous development through remote refs, immutable commit SHAs, and a task record committed with the code. Chat history may explain work, but another agent must be able to continue from Git alone.

## Required Git destination

Before using this skill for a project, obtain the Git repository address explicitly supplied by the user. Reuse that address during the task, including every `project-sync.mjs` command via `--remote <git-url>`. If no address has been supplied, ask for it before binding, starting, resuming, or handing off. Do not select a destination from `origin`, `.agent-sync.json`, the current directory, or a handoff note on the user's behalf.

The tool checks that the supplied address matches the committed `.agent-sync.json` and the checkout's fetch and push URLs. The address names the repository where code and task records must be committed and pushed; a local commit alone is not a saved remote handoff.

## What this skill guarantees

When its gates pass, another agent can fetch the named branch and obtain the same committed project artifacts. It does not provide real-time locking, merge correctness, deployment approval, secret distribution, database replication, or synchronization of ignored/generated files.

The durable synchronization unit is:

```text
canonical Git URL + canonical branch + base SHA + task branch + head SHA + committed task record
```

## Project structure and reading order

Keep these paths in the same Git repository as the project code:

```text
AGENTS.md                              agent instructions and constraints
.agent-sync.json                       Git destination and branch policy
.agent-sync/project-map.md             authoritative navigation map
.agent-sync/plan.md                    shared development plan and milestones
.agent-sync/tasks/<branch-record>.md   one handoff record per task branch
.agents/skills/git-project-sync/       vendored skill and gate script
```

The map names the actual source, test, specification, architecture/decision, operations, release, and asset locations. Existing projects retain their own directory layout; do not move code or create empty directories merely to match examples. If a category does not apply, say so in the map. The plan records scope, milestones, priorities, dependencies, acceptance evidence, and unresolved decisions. Task records hold branch-specific progress and next actions; they do not replace the shared plan. Avoid duplicating a full design or test log across all three files: link to the committed authoritative file and SHA where useful.

For a fresh or resumed task, read the map, plan, and current branch's task record, in that order. Then inspect the named code, tests, and evidence and verify the recorded base/head against the supplied Git destination. If the map, plan, or task record is stale or incomplete, update it in the appropriate branch before claiming a complete handoff.

## Bind a project

Use the Git URL supplied by the user. Never invent a repository or silently substitute a fork.

For an existing checkout, verify that its configured remote identifies the same repository. For a new checkout, clone the supplied URL using the user's existing Git credentials; do not embed credentials in a URL.

Bind from a clean branch or worktree whose `HEAD` equals the current canonical remote head:

```bash
node <skill-root>/scripts/project-sync.mjs bind \
  --repo <project-path> \
  --remote <git-url> \
  --canonical-branch main \
  --branch-prefix codex/
```

Binding adds these versioned project resources:

- `.agent-sync.json`: repository identity and branch policy.
- `.agent-sync/project-map.md`: where each category of project knowledge and code lives.
- `.agent-sync/plan.md`: project-wide outcome, milestones, priorities, and acceptance gates.
- `.agents/skills/git-project-sync/`: a vendored copy of this skill so a fresh clone carries the protocol.
- A managed block in `AGENTS.md` telling compatible agents to load the vendored skill.
- `.agent-sync/tasks/`: branch-specific task continuity records created as work begins.

`bind` creates the map and plan as scaffolds without overwriting existing files. Fill their real project locations, goals, and gates, remove both `scaffold=true` markers, and review the result. The gate checks that completed versions are in `HEAD`; it cannot judge the semantic quality of the text, so the integration owner must review it. Commit and push the setup branch, then integrate it into the canonical branch. They do not become the project's shared protocol until merged. `bind` never commits, pushes, opens a pull request, merges, or deploys.

Use `--update` only to change an existing config deliberately. To adopt this structure in a previously bound project, first verify a clean setup branch at the canonical remote head, then run `bind --update --refresh-skill --remote <git-url>`. This preserves existing custom map/plan contents and non-managed `AGENTS.md` content; review and commit the generated changes. Legacy bindings without `structureVersion` continue with a warning until adopted. Use `--refresh-skill` only to replace the managed vendored skill with this installed version.

## Categorize and save project work

GitHub is the remote view of the named Git repository, not a second source of truth. Use the map to classify each file and put it in the project's existing appropriate location:

| Category | Save and update |
| --- | --- |
| Source and tests | Product code, test cases, fixtures, and build configuration in mapped source/test paths |
| Requirements and decisions | Specifications, architecture, and decision records in mapped documentation paths |
| Shared plan | `.agent-sync/plan.md`, updated by the integration owner when milestones, priorities, or acceptance gates change |
| Task handoff | `.agent-sync/tasks/`, updated with the task branch's code and verification |
| Operations and release | Non-secret runbooks, release notes, migration plans, and validation evidence in mapped paths |
| Assets and large outputs | Version only suitable source assets; put large/generated outputs in an approved external store and link their non-secret location and digest |

Do not commit credentials, tokens, cookies, private keys, local databases, caches, build outputs, or machine-only state. Project records can name how authorized agents obtain required access, but must not contain the access material. If a file belongs in another repository, record its explicit URL and revision in the map; do not imply it was saved to this Git destination.

Before pushing a task branch, stage only the intended paths (including its task record and any changed plan/map), review `git diff --cached --name-status` and `git diff --cached --check`, commit, and push to the configured remote. Avoid blanket `git add .` when unrelated user changes may be present. Run the handoff gate against that remote after pushing. The integration owner reviews each category and updates shared map/plan entries when integrating; a pull request or GitHub upload alone does not prove the project is current or deployable.

## Start an agent task

Read `.agent-sync.json` and the committed map and plan, then run the read-only observation gate:

```bash
node .agents/skills/git-project-sync/scripts/project-sync.mjs observe \
  --repo <project-path> --remote <git-url>
```

Fetch the configured remote and canonical branch. Create a unique task branch and isolated worktree from the verified remote SHA; never let two writing agents share a worktree.

```bash
git fetch --prune <remote-name> <canonical-branch>
git worktree add -b <branch-prefix><task-id> <isolated-path> <remote-name>/<canonical-branch>
node .agents/skills/git-project-sync/scripts/project-sync.mjs start \
  --repo <isolated-path> \
  --remote <git-url> \
  --base <full-canonical-sha>
```

After the start gate passes, create the branch-specific continuity record:

```bash
node .agents/skills/git-project-sync/scripts/project-sync.mjs task-init \
  --repo <isolated-path> \
  --remote <git-url> \
  --base <full-canonical-sha> \
  --title "<task outcome>"
```

Replace the scaffold with the real objective, acceptance criteria, completed work, verification, blockers, and one concrete next step. Remove `scaffold=true`, then commit the record with the task changes. The record path is derived from the branch, so parallel branches do not overwrite one another.

The coordinator assigns branch ownership, write scope, dependencies, and the integration owner before parallel edits. Treat dirty or unpushed work from another worktree as belonging to another task unless the user explicitly reassigns it. Do not copy, stash, reset, overwrite, or commit it.

## Work and handoff

- Commit coherent project artifacts and tests on the task branch.
- Keep secrets, credentials, cookies, private keys, local databases, caches, build output, and machine-only state out of Git.
- Keep the committed task continuity record current. It carries the objective, acceptance criteria, completed scope, verification evidence, blockers, unknowns, and next action across agents.
- Record the resulting head SHA and remote branch in the task report or pull request; do not place the head SHA inside the task file because committing it would change the SHA again.
- Do not claim a handoff is synchronized until the task branch exists on the configured remote at the same head SHA.
- After handoff, do not rewrite published history or force-push. Add commits or create a new branch.

Verify handoff:

```bash
node .agents/skills/git-project-sync/scripts/project-sync.mjs handoff \
  --repo <task-worktree> \
  --remote <git-url> \
  --base <full-base-sha>
```

The handoff gate verifies both the remote branch SHA and the committed task record. If pushing is not authorized, stop after the local commit and report `local only — not synchronized to the remote`. Request authority for the exact branch; do not describe the remote handoff as complete.

## Resume another agent's task

Fetch the exact remote task branch into a new clean worktree. Read its project map, shared plan, and `.agent-sync/tasks/` record, then run:

```bash
node .agents/skills/git-project-sync/scripts/project-sync.mjs resume \
  --repo <new-worktree> \
  --remote <git-url> \
  --base <recorded-base-sha>
```

Continue from the recorded next step unless the user gives a newer instruction. Review the entire `base..HEAD` diff and rerun risk-relevant tests. A clean synchronization check proves identity and transport, not implementation quality.

## Integrate

Only the designated integration owner integrates task branches. Verify the reviewed remote head SHA immediately before integration, incorporate the current canonical branch deliberately, resolve conflicts through source review, and rerun affected tests. Never force-push the canonical branch.

Merging, releasing, deploying, migrating data, and changing production are separate actions with separate authorization and acceptance evidence.

## Stop conditions

Stop and report the exact mismatch when:

- The checkout fetch or push URL differs from the supplied Git destination or project config.
- The user has not supplied a Git URL for this project, or a command omits `--remote`.
- The canonical remote head cannot be verified.
- A canonical/shared worktree is dirty or does not match the remote head.
- A task branch has the wrong prefix, base SHA, or ancestry.
- The committed project map or plan is missing or still a scaffold in a structure-enabled project.
- A remote task branch is missing or resolves to a different head SHA.
- Ownership of existing local changes is unclear.

Do not repair these conditions with destructive cleanup, `reset --hard`, checkout-overwrite, or force-push.
