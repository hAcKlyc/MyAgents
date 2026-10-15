/**
 * Plan-mode hard gate (issue #295) — pure decision core.
 *
 * WHY THIS EXISTS
 * ---------------
 * MyAgents launches the Claude Agent SDK subprocess with
 * `allowDangerouslySkipPermissions: true` (so a mid-session switch to
 * fullAgency / `bypassPermissions` is honored without a restart — see the
 * comment at the `query()` options in agent-session.ts). At spawn time the SDK
 * translates that flag into the CLI arg `--allow-dangerously-skip-permissions`,
 * which sets the native CLI's `toolPermissionContext.isBypassPermissionsModeAvailable = true`.
 *
 * The native permission resolver then short-circuits:
 *
 *     // (decompiled from the bundled `claude` binary)
 *     function resolve(mode, isBypassAvailable) {
 *       if (mode === "auto") return "classify";
 *       if (mode === "bypassPermissions" || (mode === "plan" && isBypassAvailable)) return "allow";
 *       if (mode === "dontAsk") return "deny";
 *       return "ask"; // <- only "ask" sends a can_use_tool control_request to our canUseTool
 *     }
 *
 * So whenever bypass mode is "available", **plan mode resolves every ordinary
 * tool to "allow"** — the CLI never emits a `can_use_tool` control request, our
 * `canUseTool` callback (where MyAgents enforces the plan-mode read-only rules)
 * is NEVER invoked, and `result.permission_denials` stays empty. A well-behaved
 * Claude model honors the plan-mode system reminder ("you MUST NOT run any
 * non-readonly tools") and only calls ExitPlanMode, so the missing enforcement
 * is invisible. A weaker third-party model ignores the reminder and calls
 * `Bash rm -rf …` / `Edit` directly — and they execute unchecked (#295).
 *
 * SDK 0.3.269 fixed the native plan+bypass short-circuit. We retain this
 * product-owned gate for the stricter read-only catalog and the live/native
 * mode transition fence below; the old native behavior explains its origin.
 *
 * THE FIX
 * -------
 * PreToolUse hooks run BEFORE the native permission resolver, and a hook
 * `permissionDecision: 'deny'` is honored regardless of the bypass-availability
 * short-circuit (`PreToolUse hook denies bypass canUseTool` per the SDK docs).
 * So a PreToolUse hook is the one place that can restore plan mode's read-only
 * guarantee WITHOUT giving up the always-on flag that fullAgency needs. Because
 * the hook reads the live permission mode on every tool call, it covers EVERY
 * way plan mode can be entered: agent config, the UI toggle, AND the AI's own
 * `EnterPlanMode` mid-turn (none of which a spawn-time flag could retro-fix on
 * the already-running subprocess).
 *
 * This module is the pure decision function (no I/O) so it can be unit-tested in
 * the fast pool; the imperative shell (the registered hook, logging) lives in
 * agent-session.ts. The allowlist is the single source of truth shared with
 * `getPermissionRules('plan')` so the canUseTool path and this hook can never
 * drift apart.
 */

import type { PermissionMode } from '../../shared/config-types';

/**
 * The live permission-mode union the sidecar mirror uses. agent-session.ts
 * carries a legacy `'custom'` member in its own `PermissionMode` union; include
 * it here so this leaf module accepts the sidecar's value WITHOUT importing
 * agent-session.ts (that would be a circular dependency). Structurally identical
 * to agent-session.ts's type, so the two are mutually assignable. Only the
 * `'plan'` literal is load-bearing for the transitions below.
 */
export type PlanCapablePermissionMode = PermissionMode | 'custom';

/**
 * Tools auto-allowed in plan mode: read-only file/codebase inspection only.
 * Mirrors `getPermissionRules('plan').allowedTools` (agent-session.ts consumes
 * this same constant so the two stay in lockstep).
 */
export const PLAN_MODE_READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'LS'] as const;

/**
 * Control-transfer tools that MUST reach the host (never auto-denied): the user
 * approves the plan / answers questions through these. The SDK always routes
 * `requiresUserInteraction` tools to the host even under the bypass shortcut, so
 * leaving them un-blocked here lets canUseTool's interactive handlers run.
 * Mirrors the `USER_INTERACTION_TOOLS` set in agent-session.ts's canUseTool.
 */
export const PLAN_MODE_HOST_INTERACTION_TOOLS = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'] as const;

/**
 * Fail-closed resolution of whether plan mode is in effect for a PreToolUse hook.
 *
 * The hook sees TWO sources of truth and they can desync mid-turn:
 *   - `hookMode` — the SDK's own per-call `PreToolUseHookInput.permission_mode`
 *     (BaseHookInput.permission_mode, sdk.d.ts), authoritative for the exact tool
 *     call about to run.
 *   - `localMode` — the sidecar's module-global mirror (`currentPermissionMode`),
 *     updated ASYNCHRONOUSLY from the status-message stream.
 *
 * They diverge in two windows, both fail-OPEN if we trust only `localMode`:
 *   1. The AI calls `EnterPlanMode` mid-turn; the SDK fires the next PreToolUse
 *      with `permission_mode: 'plan'` before the stream loop has updated the
 *      mirror (still `'auto'`) → a write tool slips through. This is the exact
 *      `plan + bypassAvailable ⇒ allow` hole #295 exists to close.
 *   2. `setSessionPermissionMode()` flips the mirror to `'auto'` OPTIMISTICALLY
 *      before `querySession.setPermissionMode()` is acked, while the CLI is still
 *      internally in plan.
 *
 * Treating plan as in effect when EITHER source says `'plan'` keeps the gate
 * fail-closed across both windows (worst case: one extra deny that the model
 * retries after ExitPlanMode — never an unchecked write).
 */
export function isPlanModeInEffect(localMode: string, hookMode: string | undefined): boolean {
  return localMode === 'plan' || hookMode === 'plan';
}

/**
 * Decide whether a PreToolUse hook should DENY a tool because the session is in
 * plan mode.
 *
 * Returns `true` (block) for any tool that is neither a plan-mode read-only tool
 * nor a control-transfer tool — i.e. every write / side-effecting tool (Bash,
 * Edit, Write, MultiEdit, NotebookEdit, Task, WebFetch, WebSearch, Skill, all
 * `mcp__*` tools, the `myagents` CLI, …). Returns `false` (allow normal flow)
 * when not in plan mode, for the read-only allowlist, and for control-transfer
 * tools.
 *
 * `mode` is typed as `string` so this leaf module carries no dependency on
 * agent-session.ts's `PermissionMode` union; only the `'plan'` literal matters.
 */
export function shouldBlockToolInPlanMode(toolName: string, mode: string): boolean {
  if (mode !== 'plan') return false;
  if ((PLAN_MODE_HOST_INTERACTION_TOOLS as readonly string[]).includes(toolName)) return false;
  if ((PLAN_MODE_READONLY_TOOLS as readonly string[]).includes(toolName)) return false;
  return true;
}

/** Human-facing denial message routed back to the model via the hook's deny reason. */
export function planModeDenyMessage(toolName: string, plansDir?: string): string {
  return (
    `当前处于 Plan（规划）模式，禁止执行写操作或有副作用的工具（本次被拦截：${toolName}）。` +
    `请先完成调研与规划，再用 ExitPlanMode 工具提交方案供用户审批；获批退出 Plan 模式后才能执行写操作。` +
    (plansDir ? `方案正文请用 Write/Edit 保存到当前会话专用目录 ${plansDir} 下的 Markdown 文件；不要写入项目 .agent-sync/plan.md 或其他源文件。` : '')
  );
}

// ---------------------------------------------------------------------------
// Plan-mode entry/exit mirror transitions (pure core).
//
// The sidecar keeps two module globals (agent-session.ts): `currentPermissionMode`
// (the live mode the hard gate above reads) and `prePlanPermissionMode` (the mode
// to RESTORE when plan exits). Keeping the second consistent across every way plan
// can be entered/exited is the bug this section fixes — see computePlanExitState.
// ---------------------------------------------------------------------------

/**
 * Non-plan mode the session falls back to when exiting plan with no captured
 * prior mode. 'auto' (acceptEdits) is the safe middle ground — writes auto-accept
 * but it never silently grants fullAgency.
 */
export const PLAN_EXIT_FALLBACK_MODE: PlanCapablePermissionMode = 'auto';

/**
 * Result of a plan-mode mirror transition: the new live mode plus the mode to
 * restore when plan next exits (`null` when the session is not parked in plan).
 */
export type PlanModeMirror = {
  permissionMode: PlanCapablePermissionMode;
  prePlanPermissionMode: PlanCapablePermissionMode | null;
};

/**
 * Compute the (currentPermissionMode, prePlanPermissionMode) pair after an
 * EXPLICIT mode selection — the UI toggle (`setSessionPermissionMode`), an
 * EnterPlanMode approval, or the SDK auto-entering plan.
 *
 * Invariant this centralizes (it was previously open-coded at each site and
 * drifted): whenever the live mode is 'plan', `prePlanPermissionMode` holds the
 * mode to restore on exit. Therefore:
 *   - Entering plan FROM a non-plan mode captures that mode. (The UI-toggle path
 *     forgot to do this, so ExitPlanMode approval had nothing to restore → the
 *     deadlock in the bug report.)
 *   - Re-entering plan while ALREADY in plan keeps the existing capture — it must
 *     NOT overwrite it with 'plan'. (The deadlock got WORSE when the model
 *     re-entered plan to "fix the state anomaly": that captured 'plan' as the
 *     restore target, so even a later ExitPlanMode would have restored to 'plan'.)
 *   - Selecting any non-plan mode is an explicit user choice → clears the capture.
 */
export function applyPermissionModeSelection(
  current: PlanCapablePermissionMode,
  savedPre: PlanCapablePermissionMode | null,
  next: PlanCapablePermissionMode,
): PlanModeMirror {
  if (next === 'plan') {
    return {
      permissionMode: 'plan',
      prePlanPermissionMode: current === 'plan' ? savedPre : current,
    };
  }
  return { permissionMode: next, prePlanPermissionMode: null };
}

/**
 * Compute the mirror state when EXITING plan (ExitPlanMode approval, or the SDK
 * reporting it left plan). Restores the captured prior mode, falling back to
 * PLAN_EXIT_FALLBACK_MODE when nothing valid was captured.
 *
 * Why the fallback is load-bearing — the root cause of this bug: plan mode can be
 * entered via paths that never captured a prior mode (the UI toggle before this
 * fix; a session restored from disk already in plan). With the old
 * `if (prePlanPermissionMode)` guard, ExitPlanMode approval was then a NO-OP — the
 * live mirror stayed 'plan', the fail-closed hard gate kept denying every write,
 * and the model was stuck (its Bash-heredoc / re-enter-plan workarounds all hit
 * the same gate) until the user hand-switched to fullAgency. Falling back to a
 * concrete non-plan mode guarantees exiting plan ALWAYS leaves plan. 'plan' is
 * also rejected as a restore target (belt-and-suspenders against a poisoned
 * capture) so the mirror can never resolve back into plan.
 */
export function computePlanExitState(savedPre: PlanCapablePermissionMode | null): PlanModeMirror {
  const restored = savedPre && savedPre !== 'plan' ? savedPre : PLAN_EXIT_FALLBACK_MODE;
  return { permissionMode: restored, prePlanPermissionMode: null };
}

/**
 * Compute the mirror state when RESTORING a session's saved permission mode —
 * disk self-resolve at init, or `switchToSession`. The restored mode is the new
 * session's authoritative live mode, and `prePlanPermissionMode` MUST be dropped:
 * it is bookkeeping that belonged to the PRIOR session/context.
 *
 * Why (codex review catch): without clearing it, a stale `prePlanPermissionMode`
 * from the previous session survives the switch. If the restored session is in
 * plan, ExitPlanMode would restore the prior session's mode instead of the 'auto'
 * fallback; if it's non-plan, the SDK-status exit branch (gated on a truthy
 * `prePlanPermissionMode`) could later "restore" the wrong mode and silently
 * change permissions. A restored plan session has no captured prior, so
 * computePlanExitState falls back to PLAN_EXIT_FALLBACK_MODE on exit.
 */
export function computeRestoredPlanState(resolvedMode: PlanCapablePermissionMode): PlanModeMirror {
  return { permissionMode: resolvedMode, prePlanPermissionMode: null };
}
