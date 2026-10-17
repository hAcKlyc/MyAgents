import { describe, it, expect } from 'vitest';
import {
  shouldBlockToolInPlanMode,
  planModeDenyMessage,
  isPlanModeInEffect,
  PLAN_MODE_READONLY_TOOLS,
  PLAN_MODE_HOST_INTERACTION_TOOLS,
  applyPermissionModeSelection,
  computePlanExitState,
  computeRestoredPlanState,
  PLAN_EXIT_FALLBACK_MODE,
} from './plan-mode-gate';
import type { PlanModeMirror } from './plan-mode-gate';

describe('shouldBlockToolInPlanMode (#295 plan-mode hard gate)', () => {
  it('never blocks outside plan mode', () => {
    for (const mode of ['auto', 'fullAgency', 'custom', 'default', 'acceptEdits', 'bypassPermissions']) {
      expect(shouldBlockToolInPlanMode('Bash', mode)).toBe(false);
      expect(shouldBlockToolInPlanMode('Edit', mode)).toBe(false);
      expect(shouldBlockToolInPlanMode('mcp__whatever__do', mode)).toBe(false);
    }
  });

  it('blocks write / side-effecting tools in plan mode (the #295 regression)', () => {
    // The exact tools from the bug report plus the common write/exec surface.
    for (const tool of [
      'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
      'Task', 'WebFetch', 'WebSearch', 'Skill',
      'mcp__gemini-image__generate', 'mcp__playwright__click',
    ]) {
      expect(shouldBlockToolInPlanMode(tool, 'plan')).toBe(true);
    }
  });

  it('allows the read-only inspection tools in plan mode', () => {
    for (const tool of PLAN_MODE_READONLY_TOOLS) {
      expect(shouldBlockToolInPlanMode(tool, 'plan')).toBe(false);
    }
  });

  it('never blocks control-transfer tools — they must reach the host for approval', () => {
    for (const tool of PLAN_MODE_HOST_INTERACTION_TOOLS) {
      expect(shouldBlockToolInPlanMode(tool, 'plan')).toBe(false);
    }
  });

  it('is case-sensitive / exact-match (an unknown tool is blocked, fail-closed)', () => {
    expect(shouldBlockToolInPlanMode('read', 'plan')).toBe(true); // not 'Read'
    expect(shouldBlockToolInPlanMode('SomeFutureTool', 'plan')).toBe(true);
  });

  it('readonly and control-transfer sets do not overlap with each other', () => {
    const overlap = (PLAN_MODE_READONLY_TOOLS as readonly string[]).filter(t =>
      (PLAN_MODE_HOST_INTERACTION_TOOLS as readonly string[]).includes(t)
    );
    expect(overlap).toEqual([]);
  });
});

describe('isPlanModeInEffect (#295 fail-closed desync window)', () => {
  it('is in effect when the local mirror says plan (UI toggle / agent config path)', () => {
    expect(isPlanModeInEffect('plan', undefined)).toBe(true);
    expect(isPlanModeInEffect('plan', 'auto')).toBe(true);
  });

  it('is in effect when the SDK hook says plan even if the async mirror lags (the critical fix)', () => {
    // AI EnterPlanMode mid-turn: SDK fires PreToolUse with permission_mode 'plan'
    // before the sidecar stream loop updates currentPermissionMode (still 'auto').
    expect(isPlanModeInEffect('auto', 'plan')).toBe(true);
    // And the gate must then BLOCK a write tool against this fail-closed mode —
    // the exact bypass that trusting only the local mirror would let through.
    const effective = isPlanModeInEffect('auto', 'plan') ? 'plan' : 'auto';
    expect(shouldBlockToolInPlanMode('Bash', effective)).toBe(true);
    expect(shouldBlockToolInPlanMode('Edit', effective)).toBe(true);
  });

  it('is NOT in effect when neither source says plan', () => {
    expect(isPlanModeInEffect('auto', undefined)).toBe(false);
    expect(isPlanModeInEffect('auto', 'auto')).toBe(false);
    expect(isPlanModeInEffect('fullAgency', 'acceptEdits')).toBe(false);
    // and a read-only allowlist tool still flows normally in that case
    const effective = isPlanModeInEffect('auto', 'auto') ? 'plan' : 'auto';
    expect(shouldBlockToolInPlanMode('Bash', effective)).toBe(false);
  });
});

describe('planModeDenyMessage', () => {
  it('names the blocked tool and points the model at ExitPlanMode', () => {
    const msg = planModeDenyMessage('Bash');
    expect(msg).toContain('Bash');
    expect(msg).toContain('ExitPlanMode');
    expect(msg).toContain('Plan');
    const scoped = planModeDenyMessage('Write', '/workspace/.claude/plans/myagents/session-1');
    expect(scoped).toContain('/workspace/.claude/plans/myagents/session-1');
    expect(scoped).toContain('沿用 SDK 指定文件名');
  });
});

describe('plan-mode capture/restore invariant (UI-toggle ExitPlanMode deadlock)', () => {
  describe('applyPermissionModeSelection', () => {
    it('captures the prior mode when entering plan from a non-plan mode (the missing UI-toggle capture)', () => {
      expect(applyPermissionModeSelection('auto', null, 'plan')).toEqual({
        permissionMode: 'plan',
        prePlanPermissionMode: 'auto',
      });
      expect(applyPermissionModeSelection('fullAgency', null, 'plan')).toEqual({
        permissionMode: 'plan',
        prePlanPermissionMode: 'fullAgency',
      });
    });

    it('does NOT overwrite the capture when re-entering plan while already in plan (anti-poison)', () => {
      // The model re-entered plan to "fix" the stuck state. This must keep the
      // original restore target and never set it to 'plan' (which previously made
      // the deadlock permanent — exiting would have restored back to 'plan').
      expect(applyPermissionModeSelection('plan', 'auto', 'plan')).toEqual({
        permissionMode: 'plan',
        prePlanPermissionMode: 'auto',
      });
      // even with no prior capture, re-entering plan must not invent 'plan' as the target
      expect(applyPermissionModeSelection('plan', null, 'plan')).toEqual({
        permissionMode: 'plan',
        prePlanPermissionMode: null,
      });
    });

    it('clears the capture when selecting a concrete non-plan mode (explicit user choice)', () => {
      expect(applyPermissionModeSelection('plan', 'auto', 'fullAgency')).toEqual({
        permissionMode: 'fullAgency',
        prePlanPermissionMode: null,
      });
      expect(applyPermissionModeSelection('auto', null, 'fullAgency')).toEqual({
        permissionMode: 'fullAgency',
        prePlanPermissionMode: null,
      });
    });
  });

  describe('computePlanExitState', () => {
    it('restores the captured prior mode', () => {
      expect(computePlanExitState('auto')).toEqual({ permissionMode: 'auto', prePlanPermissionMode: null });
      expect(computePlanExitState('fullAgency')).toEqual({ permissionMode: 'fullAgency', prePlanPermissionMode: null });
    });

    it('falls back to a non-plan mode when nothing was captured — the core fix for the no-op exit deadlock', () => {
      // The exact UI-toggle / disk-restore case: plan entered without a captured
      // prior mode. Exit must STILL leave plan (previously a no-op → stuck).
      expect(computePlanExitState(null)).toEqual({
        permissionMode: PLAN_EXIT_FALLBACK_MODE,
        prePlanPermissionMode: null,
      });
      expect(PLAN_EXIT_FALLBACK_MODE).not.toBe('plan');
    });

    it('never restores back into plan even if the capture was poisoned to plan', () => {
      expect(computePlanExitState('plan')).toEqual({
        permissionMode: PLAN_EXIT_FALLBACK_MODE,
        prePlanPermissionMode: null,
      });
    });
  });

  it('end-to-end: UI-toggle into plan, then ExitPlanMode approval, leaves plan and unblocks writes', () => {
    // 1. user toggles auto -> plan via the bottom selector (setSessionPermissionMode)
    let mirror = applyPermissionModeSelection('auto', null, 'plan');
    expect(mirror).toEqual({ permissionMode: 'plan', prePlanPermissionMode: 'auto' });
    // hard gate blocks writes while parked in plan
    expect(shouldBlockToolInPlanMode('Write', mirror.permissionMode)).toBe(true);
    // 2. AI calls ExitPlanMode, user approves -> must exit plan (previously a no-op)
    mirror = computePlanExitState(mirror.prePlanPermissionMode);
    expect(mirror.permissionMode).toBe('auto');
    expect(mirror.prePlanPermissionMode).toBeNull();
    // 3. the hard gate now sees a non-plan mirror -> writes flow
    expect(shouldBlockToolInPlanMode('Write', mirror.permissionMode)).toBe(false);
  });

  describe('computeRestoredPlanState (session switch / disk restore must not leak prior prePlan)', () => {
    it('adopts the restored mode and ALWAYS clears prePlanPermissionMode', () => {
      expect(computeRestoredPlanState('plan')).toEqual({ permissionMode: 'plan', prePlanPermissionMode: null });
      expect(computeRestoredPlanState('auto')).toEqual({ permissionMode: 'auto', prePlanPermissionMode: null });
      expect(computeRestoredPlanState('fullAgency')).toEqual({ permissionMode: 'fullAgency', prePlanPermissionMode: null });
    });

    it('regression: stale prePlan from a prior session does NOT survive a restore (codex catch)', () => {
      // Session A left a capture; switching to Session B (saved in plan) must NOT
      // carry A's mode as B's restore target — B exits plan to the 'auto' fallback.
      const restored = computeRestoredPlanState('plan'); // B saved in plan, prior prePlan was e.g. 'fullAgency'
      expect(restored.prePlanPermissionMode).toBeNull();
      const exited = computePlanExitState(restored.prePlanPermissionMode);
      expect(exited.permissionMode).toBe(PLAN_EXIT_FALLBACK_MODE); // 'auto', NOT the prior session's mode
    });
  });

  it('end-to-end: re-entering plan to "fix it" no longer permanently locks the session', () => {
    // Reproduce the screenshot: parked in plan with no capture (e.g. disk restore),
    // then the model re-enters plan, then exits.
    let mirror: PlanModeMirror = { permissionMode: 'plan', prePlanPermissionMode: null };
    // model re-enters plan (this used to poison prePlan to 'plan')
    mirror = applyPermissionModeSelection(mirror.permissionMode, mirror.prePlanPermissionMode, 'plan');
    expect(mirror.prePlanPermissionMode).not.toBe('plan');
    // exit still escapes plan
    mirror = computePlanExitState(mirror.prePlanPermissionMode);
    expect(mirror.permissionMode).not.toBe('plan');
    expect(shouldBlockToolInPlanMode('Bash', mirror.permissionMode)).toBe(false);
  });
});
