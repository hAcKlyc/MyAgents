import { APP_CLI_NAME } from '../../shared/appProfile';
// Pure scope-descriptor + Agent-facing note for workspace-scoped cron reads
// (`cron list` / `cron status`). Extracted as a Functional Core so the exact
// note text — which steers the MA helper Agent's behavior — is unit-pinned.
//
// Why this exists: `cron list/status` silently filter to the caller's
// workspace (a security boundary — a prompt-injected IM bot must not enumerate
// other workspaces' tasks). An empty / zero result is therefore trivially
// misread by the consumer (usually the Agent over `--json`) as "no cron tasks
// exist anywhere" when tasks live in another workspace (#320 secondary report).
// Echoing the scope + a note lets the consumer tell "empty within this
// workspace" apart from "empty everywhere".

export interface CronScope {
  workspacePath: string;
  /** 'explicit' = caller passed --workspace; 'default' = scoped silently. */
  source: 'explicit' | 'default';
  visibility: 'single-workspace';
}

export interface CronScopeContext {
  scope: CronScope;
  /** Human/LLM-readable note. Reused as the AdminResponse `hint`. */
  hint: string;
}

/**
 * Build the scope + note for a workspace-scoped cron read.
 *
 * Progressive disclosure: the note names the ONLY broadening command that
 * exists in this build — `cron list --workspace <path>`. There is intentionally
 * NO `--all` yet, so we never advertise a command an Agent would then fail to
 * run. The broadening nudge is added only when the scope was *defaulted*; an
 * explicit `--workspace` caller already knows what they asked for.
 */
export function buildCronScope(workspacePath: string, explicit: boolean): CronScopeContext {
  const source = explicit ? 'explicit' : 'default';
  const ws = workspacePath || '(无活动工作区)';
  const base = `本结果仅含工作区「${ws}」内的定时任务，其他工作区的任务未包含。`;
  const broaden = workspacePath
    ? `如需查看其他工作区，请用 ${APP_CLI_NAME} cron list --workspace <该工作区路径>。`
    : `请用 ${APP_CLI_NAME} cron list --workspace <路径> 指定工作区查看。`;
  return {
    scope: { workspacePath, source, visibility: 'single-workspace' },
    hint: source === 'default' ? base + broaden : base,
  };
}
