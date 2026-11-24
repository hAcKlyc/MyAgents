import { describe, expect, test } from 'vitest';

import {
  coerceModelForRuntime,
  coercePermissionModeForRuntime,
  getDefaultRuntimePermissionMode,
  getMaxPermissionForRuntime,
  isRuntimePermissionMode,
  projectPermissionModeForRuntime,
  modelLooksLikeRuntime,
  permissionModeLooksLikeRuntime,
  normalizeRuntime,
  resolveCronPermissionMode,
  resolveScheduledTurnPermissionMode,
  resolveEffectiveRuntime,
  resolveAgentRuntimeSelection,
  runtimeSourceForRuntimeType,
  runtimeSupportsPrewarm,
  VALID_RUNTIMES,
  type RuntimeType,
} from './runtime';
import { coerceReasoningEffortForRuntime } from '../reasoningEffort';
import type { AgentRuntimeDistributionPolicy } from '../integrated-runtimes/distribution-policy';

const DSH_ONLY_POLICY: AgentRuntimeDistributionPolicy = {
  schemaVersion: 1,
  allowedIntegratedRuntimes: ['dsh'],
  allowedExternalRuntimes: [],
  defaultIntegratedRuntime: 'dsh',
  selectorAvailability: 'hidden',
};

describe('normalizeRuntime', () => {
  test('passes through valid runtimes', () => {
    expect(normalizeRuntime('builtin')).toBe('builtin');
    expect(normalizeRuntime('dsh')).toBe('dsh');
    expect(normalizeRuntime('claude-code')).toBe('claude-code');
    expect(normalizeRuntime('codex')).toBe('codex');
  });

  test('falls back to builtin for missing / unknown values', () => {
    expect(normalizeRuntime(undefined)).toBe('builtin');
    expect(normalizeRuntime(null)).toBe('builtin');
    expect(normalizeRuntime('')).toBe('builtin');
    expect(normalizeRuntime('o3')).toBe('builtin');
    expect(normalizeRuntime('gemini')).toBe('builtin');
  });
});

describe('resolveEffectiveRuntime', () => {
  // Mirrors the Rust spawn-time policy in
  // src-tauri/src/sidecar/runtime_identity.rs — keep in sync.

  test('an Agent without a choice follows the configured Integrated default', () => {
    expect(resolveEffectiveRuntime(undefined)).toBe('builtin');
    expect(resolveEffectiveRuntime(undefined, undefined, undefined, undefined, undefined, 'dsh')).toBe('dsh');
    expect(resolveEffectiveRuntime(undefined, undefined, undefined, undefined, undefined, 'future-runtime')).toBe('builtin');
  });

  test('an explicit Integrated choice wins over the global default', () => {
    expect(resolveEffectiveRuntime('builtin', undefined, undefined, undefined, undefined, 'dsh')).toBe('builtin');
    expect(resolveEffectiveRuntime('dsh', undefined, undefined, undefined, undefined, 'claude-agent-sdk')).toBe('dsh');
  });

  test('honors the configured (normalized) runtime', () => {
    expect(resolveEffectiveRuntime('codex')).toBe('codex');
    expect(resolveEffectiveRuntime('dsh')).toBe('dsh');
    expect(resolveEffectiveRuntime('claude-code')).toBe('claude-code');
    expect(resolveEffectiveRuntime('builtin')).toBe('builtin');
  });

  test('gives authoritative runtimePreference precedence over the legacy projection', () => {
    expect(resolveEffectiveRuntime(
      'codex',
      { family: 'integrated', id: 'dsh' },
      'system-cli',
    )).toBe('dsh');
    expect(resolveEffectiveRuntime(
      'dsh',
      { family: 'external', id: 'claude-code' },
      'integrated',
    )).toBe('claude-code');
    expect(resolveEffectiveRuntime(
      'dsh',
      { family: 'integrated', id: 'future-runtime' },
      'integrated',
    )).toBe('builtin');
  });

  test('applies Product Provider constraints after explicit External preference precedence', () => {
    expect(resolveEffectiveRuntime(
      'dsh',
      { family: 'integrated', id: 'dsh' },
      'integrated',
      'anthropic-sub',
    )).toBe('builtin');
    expect(resolveEffectiveRuntime(
      'dsh',
      { family: 'integrated', id: 'dsh' },
      'integrated',
      'codex-sub',
    )).toBe('builtin');
    expect(resolveEffectiveRuntime(
      'builtin',
      { family: 'external', id: 'codex' },
      undefined,
      'codex-sub',
    )).toBe('codex');
  });

  test('selects the Agent base independently of the provider that owns a new Session', () => {
    const dsh = { runtime: 'dsh', runtimePreference: { family: 'integrated', id: 'dsh' } };
    for (const providerId of ['codex-sub', 'anthropic-sub', 'anthropic-api']) {
      expect(resolveAgentRuntimeSelection({ ...dsh, providerId })).toBe('dsh');
      expect(resolveEffectiveRuntime(dsh.runtime, dsh.runtimePreference, undefined, providerId)).toBe('builtin');
    }
    expect(resolveEffectiveRuntime(dsh.runtime, dsh.runtimePreference, undefined, 'xai-sub')).toBe('dsh');
    expect(resolveAgentRuntimeSelection({ providerId: 'codex-sub' }, 'dsh')).toBe('dsh');
    expect(resolveAgentRuntimeSelection({ runtime: 'codex', providerId: 'codex-sub', runtimeConfig: { source: 'managed-provider' } })).toBe('builtin');
    expect(resolveAgentRuntimeSelection({ runtime: 'codex', providerId: 'codex-sub' })).toBe('codex');
  });

  test('with no/unknown agent runtime is builtin', () => {
    expect(resolveEffectiveRuntime(undefined)).toBe('builtin');
    expect(resolveEffectiveRuntime(null)).toBe('builtin');
    expect(resolveEffectiveRuntime('nonsense')).toBe('builtin');
  });

  test('a DSH-only build uses DSH regardless of stored incompatible intent', () => {
    expect(resolveEffectiveRuntime('builtin', undefined, undefined, undefined, DSH_ONLY_POLICY)).toBe('dsh');
    expect(resolveEffectiveRuntime(
      'codex',
      { family: 'external', id: 'codex' },
      'system-cli',
      undefined,
      DSH_ONLY_POLICY,
    )).toBe('dsh');
    expect(resolveEffectiveRuntime(
      'builtin',
      { family: 'integrated', id: 'dsh' },
      undefined,
      'codex-sub',
      DSH_ONLY_POLICY,
    )).toBe('dsh');
  });

  test('SCOPE: resolves only the agent-CONFIG dimension, NOT the session-frozen runtime', () => {
    // Documents the deliberate limitation (cross-review C1/C2): this helper has
    // no sessionId input and therefore CANNOT reproduce the runtime a still-open
    // session was spawned with. Concretely — a session created under codex whose
    // agent was later reconfigured to Claude Code: the server-side ai_turn_complete
    // still reports the FROZEN 'codex', but this helper (given current config)
    // returns 'claude-code'. Session-scoped analytics must therefore prefer the frozen
    // `sessionRuntime` and use this only as the pre-session fallback.
    const currentAgentConfig = 'claude-code';
    expect(resolveEffectiveRuntime(currentAgentConfig)).toBe('claude-code'); // config view
    // The authoritative value for an existing session would be the frozen
    // 'codex' — which lives in session metadata, not derivable from this fn.
  });
});

describe('runtimeSourceForRuntimeType', () => {
  test('projects only legal source families for each Runtime type', () => {
    expect(runtimeSourceForRuntimeType('builtin', 'system-cli')).toBeUndefined();
    expect(runtimeSourceForRuntimeType('dsh')).toBe('integrated');
    expect(runtimeSourceForRuntimeType('dsh', 'system-cli')).toBe('integrated');
    expect(runtimeSourceForRuntimeType('claude-code', 'managed-provider')).toBe('system-cli');
    expect(runtimeSourceForRuntimeType('codex', 'managed-provider')).toBe('managed-provider');
    expect(runtimeSourceForRuntimeType('codex')).toBe('system-cli');
  });
});

describe('runtimeSupportsPrewarm', () => {
  test('keeps every persistent protocol runtime in the shared prewarm set', () => {
    expect(runtimeSupportsPrewarm('dsh')).toBe(true);
    expect(runtimeSupportsPrewarm('codex')).toBe(true);
    expect(runtimeSupportsPrewarm('claude-code')).toBe(false);
    expect(runtimeSupportsPrewarm('builtin')).toBe(false);
  });
});

describe('model runtime family coercion', () => {
  test('drops obvious Claude models for Codex and returns runtime default', () => {
    expect(modelLooksLikeRuntime('claude-opus-4-7', 'codex')).toBe(false);
    expect(coerceModelForRuntime('claude-opus-4-7', 'codex')).toBeUndefined();
    expect(coerceModelForRuntime('anthropic/claude-sonnet-4.6', 'codex')).toBeUndefined();
    expect(coerceModelForRuntime('us.anthropic.claude-opus-4-7', 'codex')).toBeUndefined();
  });

  test('keeps native and unknown model ids', () => {
    expect(coerceModelForRuntime('gpt-5.5', 'codex')).toBe('gpt-5.5');
    expect(coerceModelForRuntime('openai/gpt-5.5', 'codex')).toBe('openai/gpt-5.5');
    expect(coerceModelForRuntime('future-lab-model', 'codex')).toBe('future-lab-model');
  });

  test('drops namespaced foreign model families', () => {
    expect(coerceModelForRuntime('google/gemini-2.5-pro', 'claude-code')).toBeUndefined();
  });

  test('trims blank values to undefined', () => {
    expect(coerceModelForRuntime('  ', 'codex')).toBeUndefined();
    expect(coerceModelForRuntime(undefined, 'codex')).toBeUndefined();
  });
});

describe('permission mode runtime family coercion', () => {
  test('drops obvious builtin permission modes for Codex', () => {
    expect(permissionModeLooksLikeRuntime('fullAgency', 'codex')).toBe(false);
    expect(coercePermissionModeForRuntime('fullAgency', 'codex')).toBeUndefined();
  });

  test('keeps native and unknown permission modes', () => {
    expect(coercePermissionModeForRuntime('no-restrictions', 'codex')).toBe('no-restrictions');
    expect(coercePermissionModeForRuntime('future-mode', 'codex')).toBe('future-mode');
  });

  test('shared labels stay valid for runtimes that own them', () => {
    expect(coercePermissionModeForRuntime('plan', 'builtin')).toBe('plan');
    expect(coercePermissionModeForRuntime('manual', 'claude-code')).toBe('manual');
  });

  test('write validation and historical projection use the exact runtime vocabulary', () => {
    expect(isRuntimePermissionMode('full-auto', 'codex')).toBe(true);
    expect(isRuntimePermissionMode('future-mode', 'codex')).toBe(false);
    expect(isRuntimePermissionMode('dontAsk', 'claude-code')).toBe(true);
    expect(isRuntimePermissionMode('auto', 'claude-code')).toBe(true);
    expect(isRuntimePermissionMode('manual', 'claude-code')).toBe(true);
    expect(isRuntimePermissionMode('default', 'claude-code')).toBe(false);
    expect(projectPermissionModeForRuntime('no-restrictions', 'codex')).toBe('no-restrictions');
    expect(projectPermissionModeForRuntime('future-mode', 'codex')).toBeUndefined();
  });
});

describe('reasoning effort runtime coercion', () => {
  test('drops levels that the target runtime does not expose', () => {
    expect(coerceReasoningEffortForRuntime('max', 'codex')).toBe('max');
    expect(coerceReasoningEffortForRuntime('minimal', 'claude-code')).toBeUndefined();
  });

  test('keeps target-runtime levels and default sentinel', () => {
    expect(coerceReasoningEffortForRuntime('xhigh', 'codex')).toBe('xhigh');
    expect(coerceReasoningEffortForRuntime('max', 'claude-code')).toBe('max');
    expect(coerceReasoningEffortForRuntime('default', 'codex')).toBeUndefined();
  });
});

describe('getMaxPermissionForRuntime — unattended max-agency mode per runtime', () => {
  // The unattended memory-update / heartbeat turns inject system work (git commit,
  // file writes) and MUST run at each runtime's maximum agency so tool use never
  // blocks on an approval no human will answer. If any of these regress to a
  // non-bypass mode, /api/memory/update on that runtime would hang to its 60-min
  // timeout instead of completing. (memory-update external-routing fix.)
  test('maps each runtime to its bypass / full-access mode', () => {
    expect(getMaxPermissionForRuntime('antigravity')).toBe('dangerously-skip-permissions');
    expect(getDefaultRuntimePermissionMode('antigravity')).toBe('accept-edits');
    expect(getMaxPermissionForRuntime('dsh')).toBe('full-autonomous');
    expect(getMaxPermissionForRuntime('builtin')).toBe('fullAgency');
    expect(getMaxPermissionForRuntime('claude-code')).toBe('bypassPermissions');
    expect(getMaxPermissionForRuntime('codex')).toBe('no-restrictions');
  });

  test('returns a non-empty mode for every known runtime', () => {
    for (const rt of VALID_RUNTIMES as readonly RuntimeType[]) {
      const mode = getMaxPermissionForRuntime(rt);
      expect(typeof mode).toBe('string');
      expect(mode.length).toBeGreaterThan(0);
    }
  });

  test('falls back to builtin fullAgency for an unknown runtime', () => {
    expect(getMaxPermissionForRuntime('something-else' as RuntimeType)).toBe('fullAgency');
  });
});

describe('resolveCronPermissionMode', () => {
  test('uses runtime max when no mode is pinned', () => {
    expect(resolveCronPermissionMode(undefined, undefined, 'codex')).toBe('no-restrictions');
  });

  test('respects runtime-appropriate pinned modes', () => {
    expect(resolveCronPermissionMode('full-auto', undefined, 'codex')).toBe('full-auto');
  });

  test('treats obvious foreign stale modes as missing for unattended runs', () => {
    expect(resolveCronPermissionMode('fullAgency', undefined, 'codex')).toBe('no-restrictions');
  });

  test('skips stale payload mode before falling back to runtimeConfig mode', () => {
    expect(resolveCronPermissionMode('auto', 'full-auto', 'codex')).toBe('full-auto');
  });

  test('defaults unspecified Antigravity cron runs to dangerously-skip-permissions while honoring explicit overrides', () => {
    expect(resolveCronPermissionMode(undefined, undefined, 'antigravity')).toBe('dangerously-skip-permissions');
    expect(resolveCronPermissionMode('', '', 'antigravity')).toBe('dangerously-skip-permissions');
    expect(resolveCronPermissionMode('fullAgency', undefined, 'antigravity')).toBe('dangerously-skip-permissions');
    expect(resolveCronPermissionMode('auto', undefined, 'antigravity')).toBe('auto');
    expect(resolveCronPermissionMode('accept-edits', undefined, 'antigravity')).toBe('accept-edits');
  });
});

describe('resolveScheduledTurnPermissionMode', () => {
  test('elevates an unset CLI Goal to the builtin runtime maximum', () => {
    expect(resolveScheduledTurnPermissionMode('goal', '', 'auto', 'builtin')).toBe('fullAgency');
  });

  test('elevates an unset CLI Goal to the external runtime maximum', () => {
    expect(resolveScheduledTurnPermissionMode('goal', '', 'full-auto', 'codex')).toBe('no-restrictions');
    expect(resolveScheduledTurnPermissionMode('goal', '', 'accept-edits', 'antigravity')).toBe('dangerously-skip-permissions');
  });

  test('preserves the session snapshot fallback for ordinary Cron', () => {
    expect(resolveScheduledTurnPermissionMode('cron', '', 'auto', 'builtin')).toBe('auto');
  });
});
