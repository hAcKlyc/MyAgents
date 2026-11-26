import { describe, expect, it } from 'vitest';
import {
  canonicalPermissionModeForTier,
  permissionTierForMode,
  resolveSessionStartPermissionMode,
  type PermissionCeilingTier,
} from './sessionPermissionCeiling';
import {
  getRuntimePermissionModes,
  isRuntimePermissionMode,
  type RuntimeType,
} from './types/runtime';

const ALL_RUNTIMES: readonly RuntimeType[] = [
  'builtin',
  'dsh',
  'claude-code',
  'codex',
  'antigravity',
];

const UNRESTRICTED_BY_RUNTIME: Readonly<Record<RuntimeType, string>> = {
  builtin: 'fullAgency',
  dsh: 'full-autonomous',
  'claude-code': 'bypassPermissions',
  codex: 'no-restrictions',
  antigravity: 'dangerously-skip-permissions',
};

describe('sessionPermissionCeiling', () => {
  it('assigns a known tier to every runtime permission mode declared in runtime.ts', () => {
    for (const runtime of ALL_RUNTIMES) {
      for (const mode of getRuntimePermissionModes(runtime)) {
        const tier = permissionTierForMode(runtime, mode.value);
        expect(tier, `${runtime}:${mode.value}`).not.toBeNull();
      }
      if (runtime === 'codex') {
        expect(permissionTierForMode('codex', 'suggest')).toBe(0);
      }
    }
  });

  it('produces valid runtime modes for every non-null canonical tier mapping', () => {
    for (const runtime of ALL_RUNTIMES) {
      for (const tier of [0, 1, 2, 3] as const) {
        const mode = canonicalPermissionModeForTier(runtime, tier);
        if (mode !== null) {
          expect(isRuntimePermissionMode(mode, runtime)).toBe(true);
          expect(permissionTierForMode(runtime, mode)).toBe(tier);
        }
      }
    }
  });

  it('aligns Tier 3 unrestricted 1-to-1 across every 5x5 runtime pair', () => {
    for (const targetRuntime of ALL_RUNTIMES) {
      for (const requestedRuntime of ALL_RUNTIMES) {
        const result = resolveSessionStartPermissionMode({
          targetRuntime,
          targetEffectivePermissionMode: UNRESTRICTED_BY_RUNTIME[targetRuntime],
          requestedRuntime,
        });
        expect(result).toEqual({
          ok: true,
          permissionMode: UNRESTRICTED_BY_RUNTIME[requestedRuntime],
          ceilingTier: 3,
          effectiveTier: 3,
        });
      }
    }
  });

  it('never silently escalates across any 5x5 runtime pair at any tier', () => {
    for (const targetRuntime of ALL_RUNTIMES) {
      for (const mode of getRuntimePermissionModes(targetRuntime)) {
        const ceilingTier = permissionTierForMode(targetRuntime, mode.value)!;
        for (const requestedRuntime of ALL_RUNTIMES) {
          const result = resolveSessionStartPermissionMode({
            targetRuntime,
            targetEffectivePermissionMode: mode.value,
            requestedRuntime,
          });
          if (ceilingTier === 0 && requestedRuntime === 'dsh') {
            expect(result).toMatchObject({
              ok: false,
              code: 'PERMISSION_CEILING_UNSATISFIABLE',
              ceilingTier: 0,
            });
          } else {
            expect(result.ok, `${targetRuntime}:${mode.value} -> ${requestedRuntime}`).toBe(true);
            if (result.ok) {
              expect(result.effectiveTier).toBeLessThanOrEqual(ceilingTier);
              expect(isRuntimePermissionMode(result.permissionMode, requestedRuntime)).toBe(true);
            }
          }
        }
      }
    }
  });

  it('preserves the exact target mode when staying on the same runtime without explicit override', () => {
    expect(
      resolveSessionStartPermissionMode({
        targetRuntime: 'builtin',
        targetEffectivePermissionMode: 'custom',
        requestedRuntime: 'builtin',
      }),
    ).toEqual({
      ok: true,
      permissionMode: 'custom',
      ceilingTier: 1,
      effectiveTier: 1,
    });
    expect(
      resolveSessionStartPermissionMode({
        targetRuntime: 'claude-code',
        targetEffectivePermissionMode: 'dontAsk',
        requestedRuntime: 'claude-code',
      }),
    ).toEqual({
      ok: true,
      permissionMode: 'dontAsk',
      ceilingTier: 1,
      effectiveTier: 1,
    });
  });

  it('allows explicit downgrade and fails closed on explicit escalation', () => {
    // High-autonomy Antigravity -> explicit read-only Codex suggest
    expect(
      resolveSessionStartPermissionMode({
        targetRuntime: 'antigravity',
        targetEffectivePermissionMode: 'dangerously-skip-permissions',
        requestedRuntime: 'codex',
        requestedPermissionMode: 'suggest',
      }),
    ).toEqual({
      ok: true,
      permissionMode: 'suggest',
      ceilingTier: 3,
      effectiveTier: 0,
    });

    // Read-only builtin plan -> explicit codex full-auto must be rejected
    expect(
      resolveSessionStartPermissionMode({
        targetRuntime: 'builtin',
        targetEffectivePermissionMode: 'plan',
        requestedRuntime: 'codex',
        requestedPermissionMode: 'full-auto',
      }),
    ).toMatchObject({
      ok: false,
      code: 'PERMISSION_ESCALATION_FORBIDDEN',
      ceilingTier: 0,
    });

    // Approval-gated builtin auto -> explicit dsh full-autonomous must be rejected
    expect(
      resolveSessionStartPermissionMode({
        targetRuntime: 'builtin',
        targetEffectivePermissionMode: 'auto',
        requestedRuntime: 'dsh',
        requestedPermissionMode: 'full-autonomous',
      }),
    ).toMatchObject({
      ok: false,
      code: 'PERMISSION_ESCALATION_FORBIDDEN',
      ceilingTier: 1,
    });

    // Invalid mode name for target runtime must fail closed
    expect(
      resolveSessionStartPermissionMode({
        targetRuntime: 'builtin',
        targetEffectivePermissionMode: 'fullAgency',
        requestedRuntime: 'codex',
        requestedPermissionMode: 'fullAgency',
      }),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_PERMISSION_MODE',
      ceilingTier: 3,
    });
  });

  it('downgrades Tier 2 targets safely to builtin auto when switching to builtin', () => {
    for (const [targetRuntime, mode] of [
      ['dsh', 'workspace-autonomous'],
      ['codex', 'full-auto'],
      ['claude-code', 'auto'],
      ['antigravity', 'auto'],
    ] as const) {
      const result = resolveSessionStartPermissionMode({
        targetRuntime,
        targetEffectivePermissionMode: mode,
        requestedRuntime: 'builtin',
      });
      expect(result).toEqual({
        ok: true,
        permissionMode: 'auto',
        ceilingTier: 2 as PermissionCeilingTier,
        effectiveTier: 1 as PermissionCeilingTier,
      });
    }
  });

  it('enforces Managed Codex (codex/managed-provider) permission rules excluding full-auto', () => {
    expect(canonicalPermissionModeForTier('codex', 1, 'managed-provider')).toBeNull();
    expect(canonicalPermissionModeForTier('codex', 2, 'managed-provider')).toBe('auto-edit');
    expect(
      resolveSessionStartPermissionMode({
        targetRuntime: 'codex',
        targetRuntimeSource: 'system-cli',
        targetEffectivePermissionMode: 'full-auto',
        requestedRuntime: 'codex',
        requestedRuntimeSource: 'managed-provider',
      }),
    ).toEqual({
      ok: true,
      permissionMode: 'auto-edit',
      ceilingTier: 2,
      effectiveTier: 2,
    });
    // Tier 3 unrestricted still aligns 1-to-1 to no-restrictions
    expect(
      resolveSessionStartPermissionMode({
        targetRuntime: 'antigravity',
        targetRuntimeSource: 'system-cli',
        targetEffectivePermissionMode: 'dangerously-skip-permissions',
        requestedRuntime: 'codex',
        requestedRuntimeSource: 'managed-provider',
      }),
    ).toEqual({
      ok: true,
      permissionMode: 'no-restrictions',
      ceilingTier: 3,
      effectiveTier: 3,
    });
    // Explicit full-auto on Managed Codex fails closed
    expect(
      resolveSessionStartPermissionMode({
        targetRuntime: 'builtin',
        targetEffectivePermissionMode: 'fullAgency',
        requestedRuntime: 'codex',
        requestedRuntimeSource: 'managed-provider',
        requestedPermissionMode: 'full-auto',
      }),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_PERMISSION_MODE',
      ceilingTier: 3,
    });
  });
  it('keeps automatic review and auto-approved edits above a human approval ceiling', () => {
    const source = {
      targetRuntime: 'codex',
      targetRuntimeSource: 'system-cli',
      targetEffectivePermissionMode: 'auto-edit',
    } as const;
    const managed = { requestedRuntime: 'codex', requestedRuntimeSource: 'managed-provider' } as const;
    expect(resolveSessionStartPermissionMode({ ...source, ...managed })).toMatchObject({
      ok: true,
      permissionMode: 'suggest',
      effectiveTier: 0,
    });
    expect(resolveSessionStartPermissionMode({
      ...source, ...managed, requestedPermissionMode: 'auto-edit',
    })).toMatchObject({ ok: false, code: 'PERMISSION_ESCALATION_FORBIDDEN' });
    expect(resolveSessionStartPermissionMode({ ...source, requestedRuntime: 'claude-code' })).toMatchObject({
      ok: true,
      permissionMode: 'manual',
      effectiveTier: 1,
    });
    expect(resolveSessionStartPermissionMode({
      ...source, requestedRuntime: 'claude-code', requestedPermissionMode: 'acceptEdits',
    })).toMatchObject({ ok: false, code: 'PERMISSION_ESCALATION_FORBIDDEN' });
  });
});
