#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const CONFIG_NAME = '.agent-sync.json';
const SUPPORTED_VERSION = 1;
const STRUCTURE_VERSION = 1;
const DEFAULT_TASK_STATE_DIR = '.agent-sync/tasks';
const PROJECT_MAP_PATH = '.agent-sync/project-map.md';
const PROJECT_PLAN_PATH = '.agent-sync/plan.md';
const COMMANDS = new Set(['bind', 'observe', 'start', 'task-init', 'resume', 'handoff']);
const TASK_STATUSES = new Set(['in-progress', 'blocked', 'ready-for-review', 'complete']);
const MANAGED_START = '<!-- git-project-sync:start -->';
const MANAGED_END = '<!-- git-project-sync:end -->';

function usage(message) {
  if (message) console.error(message);
  console.error(
    'Usage:\n' +
      '  project-sync.mjs bind --repo PATH --remote URL [--remote-name origin] ' +
      '[--canonical-branch main] [--branch-prefix codex/] [--update] [--refresh-skill] [--json]\n' +
      '  project-sync.mjs observe|start|resume|handoff --repo PATH --remote URL [--base SHA] ' +
      '[--remote-name NAME] [--canonical-branch NAME] ' +
      '[--branch-prefix PREFIX] [--json]\n' +
      '  project-sync.mjs task-init --repo PATH --remote URL --base SHA [--title TEXT] [--json]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) usage(`Unsupported or missing command: ${command ?? '(none)'}`);
  const options = {
    command,
    repo: process.cwd(),
    remote: null,
    remoteName: null,
    canonicalBranch: null,
    branchPrefix: null,
    base: null,
    title: null,
    update: false,
    refreshSkill: false,
    json: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--update') options.update = true;
    else if (arg === '--refresh-skill') options.refreshSkill = true;
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) usage(`Missing value for ${arg}`);
      if (arg === '--repo') options.repo = value;
      else if (arg === '--remote') options.remote = value;
      else if (arg === '--remote-name') options.remoteName = value;
      else if (arg === '--canonical-branch') options.canonicalBranch = value;
      else if (arg === '--branch-prefix') options.branchPrefix = value;
      else if (arg === '--base') options.base = value;
      else if (arg === '--title') options.title = value;
      else usage(`Unknown argument: ${arg}`);
      index += 1;
    }
  }
  if (command !== 'bind' && (options.update || options.refreshSkill)) {
    usage('--update and --refresh-skill are valid only with bind.');
  }
  if (!options.remote) usage('A Git destination is required: pass --remote URL for every command.');
  validateSafeRemote(options.remote);
  return options;
}

function git(repo, args, timeout = 20_000) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

function hasEmbeddedCredential(value) {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
  } catch {
    return /^(?:https?|git):\/\/[^/]*:[^/@]+@/i.test(value) || /[?#]/.test(value);
  }
}

function stripGitSuffix(value) {
  return value.replace(/\.git\/?$/i, '').replace(/\/$/, '');
}

function normalizeRemote(value, repoRoot = process.cwd()) {
  const remote = value.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote)) {
    const parsed = new URL(remote);
    if (parsed.protocol === 'file:') return stripGitSuffix(fileURLToPath(parsed));
    const path = stripGitSuffix(parsed.pathname.replace(/^\/+/, ''));
    return `${parsed.host.toLowerCase()}/${path}`;
  }
  const scp = remote.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
  if (scp && !/^[A-Za-z]:[\\/]/.test(remote)) {
    return `${scp[1].toLowerCase()}/${stripGitSuffix(scp[2])}`;
  }
  const absolute = isAbsolute(remote) ? remote : resolve(repoRoot, remote);
  return stripGitSuffix(absolute);
}

function validateSafeRemote(value) {
  if (!value?.trim()) throw new Error('A Git remote URL is required.');
  if (hasEmbeddedCredential(value)) {
    throw new Error('Git URLs with embedded credentials, query strings, or fragments are not allowed.');
  }
}

function validBranchName(repo, branch) {
  return Boolean(branch) && git(repo, ['check-ref-format', '--branch', branch]).ok;
}

function resolveCommit(repo, revision) {
  if (!revision) return null;
  const result = git(repo, ['rev-parse', '--verify', `${revision}^{commit}`]);
  return result.ok ? result.stdout : null;
}

function isAncestor(repo, ancestor, descendant) {
  return git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]).ok;
}

function remoteBranchSha(repo, remoteName, branch) {
  const result = git(repo, ['ls-remote', remoteName, `refs/heads/${branch}`]);
  if (!result.ok) return { ok: false, sha: null, timedOut: result.timedOut };
  const line = result.stdout.split(/\r?\n/).find(Boolean);
  const sha = line?.split(/\s+/)[0] ?? null;
  return { ok: Boolean(sha), sha, timedOut: false };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validateConfig(config) {
  if (!config || config.version !== SUPPORTED_VERSION) {
    throw new Error(`Unsupported ${CONFIG_NAME} version.`);
  }
  for (const field of ['remote', 'remoteName', 'canonicalBranch', 'branchPrefix']) {
    if (typeof config[field] !== 'string' || !config[field]) {
      throw new Error(`Invalid ${CONFIG_NAME}: ${field} is required.`);
    }
  }
  validateSafeRemote(config.remote);
  if (config.structureVersion !== undefined && config.structureVersion !== STRUCTURE_VERSION) {
    throw new Error(`Unsupported project structure version in ${CONFIG_NAME}.`);
  }
  const taskStateDir = config.taskStateDir ?? DEFAULT_TASK_STATE_DIR;
  return { ...config, taskStateDir };
}

function validatePolicy(root, settings) {
  if (!/^[A-Za-z0-9._-]+$/.test(settings.remoteName) || settings.remoteName.startsWith('-')) {
    throw new Error('remoteName must be a simple Git remote name.');
  }
  if (!validBranchName(root, settings.canonicalBranch)) {
    throw new Error('canonicalBranch is not a valid Git branch name.');
  }
  if (!settings.branchPrefix || /\s/.test(settings.branchPrefix) ||
      !validBranchName(root, `${settings.branchPrefix}sync-probe`)) {
    throw new Error('branchPrefix cannot form a valid Git task branch.');
  }
  const taskSegments = settings.taskStateDir.replace(/\\/g, '/').split('/');
  if (isAbsolute(settings.taskStateDir) || taskSegments.some((segment) => !segment || segment === '..')) {
    throw new Error('taskStateDir must be a safe repository-relative directory.');
  }
  return settings;
}

function gitRoot(repo) {
  const root = git(repo, ['rev-parse', '--show-toplevel']);
  if (!root.ok) throw new Error('The selected path is not inside a Git repository.');
  return root.stdout;
}

function settingsFor(root, options) {
  const configPath = join(root, CONFIG_NAME);
  const existing = existsSync(configPath) ? validateConfig(readJson(configPath)) : null;
  if (!options.remote) throw new Error('An explicitly supplied Git destination is required.');
  validateSafeRemote(options.remote);
  if (existing) {
    const overrides = {
      remote: options.remote,
      remoteName: options.remoteName,
      canonicalBranch: options.canonicalBranch,
      branchPrefix: options.branchPrefix,
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) continue;
      const same = key === 'remote'
        ? normalizeRemote(value, root) === normalizeRemote(existing.remote, root)
        : value === existing[key];
      if (!same) throw new Error(`${key} conflicts with the committed ${CONFIG_NAME}.`);
    }
    return validatePolicy(root, { ...existing, configPresent: true });
  }
  return validatePolicy(root, {
    version: SUPPORTED_VERSION,
    remote: options.remote,
    remoteName: options.remoteName ?? 'origin',
    canonicalBranch: options.canonicalBranch ?? 'main',
    branchPrefix: options.branchPrefix ?? 'codex/',
    taskStateDir: DEFAULT_TASK_STATE_DIR,
    structureVersion: STRUCTURE_VERSION,
    configPresent: false,
  });
}

function addIssue(report, code, message) {
  report.issues.push({ code, message });
}

function addWarning(report, code, message) {
  report.warnings.push({ code, message });
}

function taskStatePath(settings, branch) {
  const readable = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
  const digest = createHash('sha256').update(branch).digest('hex').slice(0, 8);
  return `${settings.taskStateDir.replace(/\\/g, '/')}/${readable}-${digest}.md`;
}

function taskStateTemplate(branch, base, title) {
  const safeTitle = title?.trim() || branch;
  if (/[\r\n]/.test(safeTitle)) throw new Error('Task title must be a single line.');
  return [
    '<!-- git-project-sync-task:version=1 -->',
    `<!-- git-project-sync-task:branch=${branch} -->`,
    `<!-- git-project-sync-task:base=${base} -->`,
    '<!-- git-project-sync-task:status=in-progress -->',
    '<!-- git-project-sync-task:scaffold=true -->',
    '',
    `# Task: ${safeTitle}`,
    '',
    '## Objective',
    '',
    'Describe the user-visible outcome and scope.',
    '',
    '## Acceptance criteria',
    '',
    '- State observable completion conditions.',
    '',
    '## Completed',
    '',
    '- Record committed results, not intentions.',
    '',
    '## Verification',
    '',
    '- Record commands and outcomes tied to the current branch.',
    '',
    '## Blockers and unknowns',
    '',
    '- Record unresolved ownership, environment, authorization, or validation gaps.',
    '',
    '## Next step',
    '',
    '- Give the next agent one concrete starting action.',
    '',
  ].join('\n');
}

function taskMetadata(content) {
  const entries = [...content.matchAll(/<!-- git-project-sync-task:([a-z-]+)=([^>\r\n]+) -->/g)]
    .map((match) => [match[1], match[2].trim()]);
  return Object.fromEntries(entries);
}

function projectMapTemplate() {
  return [
    '# Project Map',
    '',
    '<!-- git-project-sync:structure:scaffold=true -->',
    '',
    '## Project identity',
    '',
    '- Purpose and users: describe the project in one or two sentences.',
    '- Repository and canonical branch: see `.agent-sync.json`.',
    '- Main entry point: add the actual path or explain why there is none.',
    '',
    '## Locations',
    '',
    '| Category | Repository path | What belongs there |',
    '| --- | --- | --- |',
    '| Working rules | `AGENTS.md` | Agent instructions and project constraints |',
    '| Git binding | `.agent-sync.json` | Remote, branch, and structure policy |',
    '| Project plan | `.agent-sync/plan.md` | Shared milestones and current priorities |',
    '| Task handoffs | `.agent-sync/tasks/` | One committed record per task branch |',
    '| Product source | Replace with actual path | Code owned by this repository |',
    '| Tests | Replace with actual path | Test suites and fixtures |',
    '| Specifications and decisions | Replace with actual path | Requirements, architecture, and decisions |',
    '| Operations and releases | Replace with actual path | Deployment instructions and release evidence, if applicable |',
    '',
    '## Validation and environments',
    '',
    '- Add build/test commands and identify which environment each checks.',
    '- Link any separate repositories or external artifact stores by non-secret reference.',
    '',
    '## Handoff reading order',
    '',
    '1. Read this map and `.agent-sync/plan.md`.',
    '2. Read the current branch record in `.agent-sync/tasks/`.',
    '3. Verify the Git base/head and inspect the relevant source, tests, and evidence.',
    '',
  ].join('\n');
}

function projectPlanTemplate() {
  return [
    '# Development Plan',
    '',
    '<!-- git-project-sync:structure:scaffold=true -->',
    '',
    '## Outcome and scope',
    '',
    'Describe the intended project outcome and current scope.',
    '',
    '## Milestones',
    '',
    '| Milestone | Status | Acceptance evidence |',
    '| --- | --- | --- |',
    '| Add a real milestone | planned | Add a verifiable result |',
    '',
    '## Current priorities',
    '',
    '- Link active task branches or their records and identify dependencies.',
    '',
    '## Acceptance and release gates',
    '',
    '- State project-specific checks and distinguish code completion from deployment.',
    '',
    '## Decisions and open questions',
    '',
    '- Link the authoritative decision or record the unresolved choice.',
    '',
  ].join('\n');
}

function verifyCommittedProjectStructure(root, settings, report) {
  if (!settings.configPresent) return;
  if (settings.structureVersion !== STRUCTURE_VERSION) {
    addWarning(report, 'legacy_project_structure',
      'This binding predates the project map and plan; adopt them with bind --update.');
    return;
  }
  for (const [path, label, heading, placeholders] of [
    [PROJECT_MAP_PATH, 'project map', '# Project Map',
      ['Replace with actual path', 'describe the project in one or two sentences',
        'add the actual path or explain why there is none']],
    [PROJECT_PLAN_PATH, 'development plan', '# Development Plan',
      ['Describe the intended project outcome and current scope', 'Add a real milestone',
        'Add a verifiable result']],
  ]) {
    const committed = git(root, ['show', `HEAD:${path}`]);
    if (!committed.ok) {
      addIssue(report, 'structure_missing', `Commit the ${label} at ${path}.`);
    } else if (!committed.stdout.includes(heading) ||
        committed.stdout.includes('git-project-sync:structure:scaffold=true') ||
        placeholders.some((placeholder) => committed.stdout.includes(placeholder))) {
      addIssue(report, 'structure_incomplete', `Complete the ${label} at ${path} before continuing.`);
    }
  }
  report.projectMap = PROJECT_MAP_PATH;
  report.projectPlan = PROJECT_PLAN_PATH;
}

function verifyCommittedTaskState(root, settings, report) {
  if (!report.localBranch || report.localBranch === '(detached)' || !report.base) return;
  const relativePath = taskStatePath(settings, report.localBranch);
  report.taskStateFile = relativePath;
  const committed = git(root, ['show', `HEAD:${relativePath}`]);
  if (!committed.ok) {
    addIssue(report, 'task_state_missing', `Commit the task continuity record at ${relativePath}.`);
    return;
  }
  const metadata = taskMetadata(committed.stdout);
  report.taskStatus = metadata.status ?? null;
  if (metadata.version !== '1') addIssue(report, 'task_state_version', 'Task continuity record version is missing or unsupported.');
  if (metadata.branch !== report.localBranch) addIssue(report, 'task_state_branch', 'Task continuity record branch does not match the current branch.');
  if (metadata.base !== report.base) addIssue(report, 'task_state_base', 'Task continuity record base does not match --base.');
  if (!TASK_STATUSES.has(metadata.status)) addIssue(report, 'task_state_status', 'Task continuity record has an invalid status.');
  if (metadata.scaffold === 'true') {
    addIssue(report, 'task_state_scaffold', 'Replace the task record scaffold text and remove scaffold=true before handoff.');
  }
  for (const heading of [
    '## Objective',
    '## Acceptance criteria',
    '## Completed',
    '## Verification',
    '## Blockers and unknowns',
    '## Next step',
  ]) {
    if (!committed.stdout.includes(heading)) {
      addIssue(report, 'task_state_incomplete', `Task continuity record is missing ${heading}.`);
    }
  }
}

function inspect(root, settings, command, baseInput) {
  const report = {
    ok: false,
    command,
    repository: root,
    configPresent: settings.configPresent,
    expectedRemote: normalizeRemote(settings.remote, root),
    normalizedCheckoutRemote: null,
    normalizedPushRemote: null,
    remoteName: settings.remoteName,
    canonicalBranch: settings.canonicalBranch,
    branchPrefix: settings.branchPrefix,
    remoteHead: null,
    localBranch: null,
    head: null,
    upstream: null,
    worktreeClean: null,
    changedEntryCount: null,
    relationToRemoteHead: 'unknown',
    base: null,
    remoteTaskHead: null,
    taskStateFile: null,
    taskStatus: null,
    projectMap: null,
    projectPlan: null,
    issues: [],
    warnings: [],
  };

  const checkoutRemote = git(root, ['remote', 'get-url', settings.remoteName]);
  if (!checkoutRemote.ok) {
    addIssue(report, 'remote_missing', `Git remote ${settings.remoteName} does not exist.`);
  } else if (hasEmbeddedCredential(checkoutRemote.stdout)) {
    addIssue(report, 'embedded_remote_credential', 'The checkout remote URL contains embedded credentials or parameters.');
  } else {
    report.normalizedCheckoutRemote = normalizeRemote(checkoutRemote.stdout, root);
    if (report.normalizedCheckoutRemote !== report.expectedRemote) {
      addIssue(report, 'remote_mismatch', 'The checkout remote does not match the configured Git repository.');
    }
  }
  const pushRemote = git(root, ['remote', 'get-url', '--push', settings.remoteName]);
  if (!pushRemote.ok) {
    addIssue(report, 'push_remote_missing', `Git push URL for ${settings.remoteName} could not be resolved.`);
  } else if (hasEmbeddedCredential(pushRemote.stdout)) {
    addIssue(report, 'embedded_push_credential', 'The checkout push URL contains embedded credentials or parameters.');
  } else {
    report.normalizedPushRemote = normalizeRemote(pushRemote.stdout, root);
    if (report.normalizedPushRemote !== report.expectedRemote) {
      addIssue(report, 'push_remote_mismatch', 'The checkout push URL does not match the configured Git destination.');
    }
  }

  const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  report.localBranch = branch.ok && branch.stdout ? branch.stdout : '(detached)';
  report.head = resolveCommit(root, 'HEAD');
  if (!report.head) addIssue(report, 'head_missing', 'HEAD does not resolve to a commit.');

  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  report.upstream = upstream.ok ? upstream.stdout : null;

  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!status.ok) addIssue(report, 'status_failed', 'Git worktree status could not be read.');
  else {
    const entries = status.stdout ? status.stdout.split(/\r?\n/).filter(Boolean) : [];
    report.changedEntryCount = entries.length;
    report.worktreeClean = entries.length === 0;
  }

  const canonical = remoteBranchSha(root, settings.remoteName, settings.canonicalBranch);
  if (!canonical.ok) {
    addIssue(
      report,
      'canonical_remote_unverified',
      canonical.timedOut ? 'Canonical remote verification timed out.' : 'Canonical remote branch could not be resolved.',
    );
  } else report.remoteHead = canonical.sha;

  if (report.head && report.remoteHead) {
    if (report.head === report.remoteHead) report.relationToRemoteHead = 'equal';
    else if (!resolveCommit(root, report.remoteHead)) {
      report.relationToRemoteHead = 'remote-object-not-local';
      addWarning(report, 'fetch_required', 'Fetch the canonical branch before ancestry checks.');
    } else if (isAncestor(root, report.remoteHead, report.head)) report.relationToRemoteHead = 'local-ahead';
    else if (isAncestor(root, report.head, report.remoteHead)) report.relationToRemoteHead = 'local-behind';
    else {
      report.relationToRemoteHead = 'diverged';
      addWarning(report, 'history_diverged', 'Local HEAD and the canonical remote branch have diverged.');
    }
  }

  if (!settings.configPresent) {
    if (command === 'observe') {
      addWarning(report, 'project_unbound', `The project has no committed ${CONFIG_NAME}.`);
    } else {
      addIssue(report, 'project_unbound', `Bind and commit ${CONFIG_NAME} before cross-agent work.`);
    }
  }
  verifyCommittedProjectStructure(root, settings, report);

  if (command === 'observe' && report.localBranch === settings.canonicalBranch) {
    if (report.worktreeClean !== true) {
      addIssue(report, 'shared_canonical_dirty', 'The canonical branch has local changes of unresolved ownership.');
    }
    if (report.head && report.remoteHead && report.head !== report.remoteHead) {
      addIssue(report, 'canonical_head_mismatch', 'Local canonical HEAD does not equal the remote canonical head.');
    }
  }

  if (command !== 'observe') {
    if (report.worktreeClean !== true) addIssue(report, 'worktree_dirty', 'This gate requires a clean worktree.');
    if (report.localBranch === '(detached)') addIssue(report, 'detached_head', 'Use a named task branch.');
    else if (report.localBranch === settings.canonicalBranch) {
      addIssue(report, 'canonical_branch_in_use', 'Do not develop or hand off directly on the canonical branch.');
    } else if (!report.localBranch.startsWith(settings.branchPrefix)) {
      addIssue(report, 'task_branch_prefix', `Task branches must start with ${settings.branchPrefix}.`);
    }

    report.base = resolveCommit(root, baseInput);
    if (!baseInput) addIssue(report, 'base_required', `--base is required for ${command}.`);
    else if (!report.base) addIssue(report, 'base_missing', 'The base revision is not a local commit.');
    else if (report.head && !isAncestor(root, report.base, report.head)) {
      addIssue(report, 'base_not_ancestor', 'The base commit is not an ancestor of HEAD.');
    }
  }

  if ((command === 'start' || command === 'task-init') && report.base && report.remoteHead) {
    if (report.base !== report.remoteHead) {
      addIssue(report, 'stale_start_base', 'A new task must start from the current canonical remote head.');
    }
    if (report.head !== report.base) {
      addIssue(report, 'start_head_mismatch', 'Before editing, task HEAD must equal the base commit.');
    }
  }

  if (command === 'resume' || command === 'handoff') {
    if (!validBranchName(root, report.localBranch)) {
      addIssue(report, 'invalid_task_branch', 'The current task branch is not a valid Git branch name.');
    } else {
      const task = remoteBranchSha(root, settings.remoteName, report.localBranch);
      report.remoteTaskHead = task.sha;
      if (!task.ok) addIssue(report, 'task_branch_not_remote', 'The task branch does not exist on the configured remote.');
      else if (report.head !== task.sha) {
        addIssue(report, 'task_branch_out_of_sync', 'Local HEAD and the remote task branch differ.');
      }
    }
    verifyCommittedTaskState(root, settings, report);
  }

  if (command === 'handoff' && report.base && report.head === report.base) {
    addWarning(report, 'no_commits_after_base', 'The handoff contains no commit after the base.');
  }

  report.ok = report.issues.length === 0;
  return report;
}

function configContent(settings) {
  const config = {
    version: SUPPORTED_VERSION,
    remote: settings.remote,
    remoteName: settings.remoteName,
    canonicalBranch: settings.canonicalBranch,
    branchPrefix: settings.branchPrefix,
    taskStateDir: settings.taskStateDir,
  };
  if (settings.structureVersion !== undefined) config.structureVersion = settings.structureVersion;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function managedAgentsBlock() {
  return [
    MANAGED_START,
    'For any task that changes this repository or resumes another agent\'s work, first read',
    '`.agents/skills/git-project-sync/SKILL.md` and use `.agent-sync.json` as the',
    'repository coordination config. Remote refs and commit SHAs define code state;',
    'handoff prose and generated artifacts are supporting evidence only.',
    'Require a user-supplied Git URL via `--remote` for every project-sync command;',
    'verify it matches the config and checkout fetch/push URLs before saving work.',
    'Read `.agent-sync/project-map.md`, `.agent-sync/plan.md`, and the current',
    'branch record in `.agent-sync/tasks/` before continuing another agent\'s work.',
    MANAGED_END,
  ].join('\n');
}

function updateAgentsContent(existing) {
  const block = managedAgentsBlock();
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new Error('AGENTS.md contains an incomplete git-project-sync managed block.');
  }
  if (start >= 0) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + MANAGED_END.length)}`;
  }
  const prefix = existing.trimEnd();
  return `${prefix ? `${prefix}\n\n` : ''}${block}\n`;
}

function writeIfChanged(path, content, changed) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  changed.push(path);
}

function writeIfMissing(path, content, changed) {
  if (existsSync(path)) return;
  writeIfChanged(path, content, changed);
}

function bindProject(root, options) {
  if (!options.remote) throw new Error('bind requires --remote.');
  validateSafeRemote(options.remote);
  const configPath = join(root, CONFIG_NAME);
  const currentConfig = existsSync(configPath) ? validateConfig(readJson(configPath)) : null;
  const settings = validatePolicy(root, {
    version: SUPPORTED_VERSION,
    remote: options.remote,
    remoteName: options.remoteName ?? currentConfig?.remoteName ?? 'origin',
    canonicalBranch: options.canonicalBranch ?? currentConfig?.canonicalBranch ?? 'main',
    branchPrefix: options.branchPrefix ?? currentConfig?.branchPrefix ?? 'codex/',
    taskStateDir: currentConfig?.taskStateDir ?? DEFAULT_TASK_STATE_DIR,
    structureVersion: STRUCTURE_VERSION,
    configPresent: false,
  });

  if (currentConfig && configContent(currentConfig) !== configContent(settings) && !options.update) {
    throw new Error(`Existing ${CONFIG_NAME} differs; use --update only after reviewing the change.`);
  }

  const preflight = inspect(root, settings, 'observe', null);
  preflight.issues = preflight.issues.filter((issue) => issue.code !== 'shared_canonical_dirty');
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!status.ok || status.stdout) addIssue(preflight, 'bind_requires_clean_tree', 'Bind requires a clean worktree.');
  if (preflight.head && preflight.remoteHead && preflight.head !== preflight.remoteHead) {
    addIssue(preflight, 'bind_head_mismatch', 'Bind must start at the current canonical remote head.');
  }
  preflight.ok = preflight.issues.length === 0;
  if (!preflight.ok) return { report: preflight, changed: [] };

  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const targetRoot = join(root, '.agents', 'skills', 'git-project-sync');
  const managedFiles = [
    ['SKILL.md', join(sourceRoot, 'SKILL.md'), join(targetRoot, 'SKILL.md')],
    ['project-sync.mjs', join(sourceRoot, 'scripts', 'project-sync.mjs'), join(targetRoot, 'scripts', 'project-sync.mjs')],
  ];
  for (const [label, source, target] of managedFiles) {
    if (!existsSync(source)) throw new Error(`Installed skill is missing ${label}.`);
    if (resolve(source) === resolve(target)) continue;
    if (existsSync(target) && readFileSync(target, 'utf8') !== readFileSync(source, 'utf8') && !options.refreshSkill) {
      throw new Error(`Vendored ${label} differs; use --refresh-skill only after review.`);
    }
  }

  const changed = [];
  writeIfChanged(configPath, configContent(settings), changed);
  writeIfMissing(join(root, PROJECT_MAP_PATH), projectMapTemplate(), changed);
  writeIfMissing(join(root, PROJECT_PLAN_PATH), projectPlanTemplate(), changed);
  for (const [, source, target] of managedFiles) {
    if (resolve(source) === resolve(target)) continue;
    writeIfChanged(target, readFileSync(source, 'utf8'), changed);
  }
  const targetScript = join(targetRoot, 'scripts', 'project-sync.mjs');
  if (existsSync(targetScript)) chmodSync(targetScript, 0o755);

  const agentsPath = join(root, 'AGENTS.md');
  const agentsExisting = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  writeIfChanged(agentsPath, updateAgentsContent(agentsExisting), changed);

  return {
    report: {
      ...preflight,
      ok: true,
      command: 'bind',
      configPresent: true,
      issues: [],
      warnings: [],
    },
    changed,
  };
}

function initializeTask(root, settings, options) {
  const report = inspect(root, settings, 'task-init', options.base);
  if (!report.ok) return { report, changed: [] };
  const relativePath = taskStatePath(settings, report.localBranch);
  const absolutePath = join(root, ...relativePath.split('/'));
  if (existsSync(absolutePath)) {
    throw new Error(`Task continuity record already exists: ${relativePath}`);
  }
  const changed = [];
  writeIfChanged(absolutePath, taskStateTemplate(report.localBranch, report.base, options.title), changed);
  report.taskStateFile = relativePath;
  report.taskStatus = 'in-progress';
  return { report, changed };
}

function printReport(report, json, changed = []) {
  const relativeChanged = changed.map((path) => path.startsWith(`${report.repository}/`)
    ? path.slice(report.repository.length + 1)
    : path);
  if (json) {
    console.log(JSON.stringify({ ...report, changedFiles: relativeChanged }, null, 2));
  } else {
    console.log(`Git project sync: ${report.ok ? 'PASS' : 'BLOCKED'} (${report.command})`);
    console.log(`repository: ${report.repository}`);
    console.log(`configured remote: ${report.expectedRemote}`);
    console.log(`checkout remote: ${report.normalizedCheckoutRemote ?? 'unknown'}`);
    console.log(`push remote: ${report.normalizedPushRemote ?? 'unknown'}`);
    console.log(`branch: ${report.localBranch ?? 'unknown'}`);
    console.log(`head: ${report.head ?? 'unknown'}`);
    console.log(`canonical ${report.canonicalBranch}: ${report.remoteHead ?? 'unverified'}`);
    console.log(`relation: ${report.relationToRemoteHead}`);
    console.log(`worktree: ${report.worktreeClean === true ? 'clean' : report.worktreeClean === false ? 'dirty' : 'unknown'}`);
    if (report.base) console.log(`base: ${report.base}`);
    if (report.remoteTaskHead) console.log(`remote task head: ${report.remoteTaskHead}`);
    if (report.taskStateFile) console.log(`task state: ${report.taskStateFile}`);
    if (report.taskStatus) console.log(`task status: ${report.taskStatus}`);
    if (report.projectMap) console.log(`project map: ${report.projectMap}`);
    if (report.projectPlan) console.log(`project plan: ${report.projectPlan}`);
    for (const path of relativeChanged) console.log(`CHANGED ${path}`);
    for (const warning of report.warnings) console.log(`WARNING ${warning.code}: ${warning.message}`);
    for (const issue of report.issues) console.log(`BLOCKER ${issue.code}: ${issue.message}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const root = gitRoot(options.repo);
    if (options.command === 'bind') {
      const result = bindProject(root, options);
      printReport(result.report, options.json, result.changed);
      return;
    }
    const settings = settingsFor(root, options);
    if (options.command === 'task-init') {
      const result = initializeTask(root, settings, options);
      printReport(result.report, options.json, result.changed);
      return;
    }
    const report = inspect(root, settings, options.command, options.base);
    printReport(report, options.json);
  } catch (error) {
    console.error(`Git project sync: ERROR\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

main();
