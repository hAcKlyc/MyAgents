import {
  isPermissionModeForRuntimeIdentity,
} from './providerExecution';
import {
  type RuntimeSource,
  type RuntimeType,
} from './types/runtime';

/**
 * One-shot execution overrides for a newly minted Session created via
 * `myagents session start`. Written exclusively to the Session's birth snapshot
 * (`SessionMetadata`) and never back to the target Agent's persisted defaults.
 */
export interface SessionBirthOverrides {
  runtime?: RuntimeType;
  runtimeSource?: RuntimeSource;
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
}

/**
 * Unified 4-tier security ceiling across all five MyAgents Runtimes:
 * - 0: Read-only / planning (cannot execute arbitrary mutations)
 * - 1: Approval-gated / interactive confirmation
 * - 2: Workspace-autonomous / auto-approved
 * - 3: Unrestricted / full access (aligns 1-to-1 across all runtimes so
 *      unattended agent-to-agent calls never stall on human approval)
 */
export type PermissionCeilingTier = 0 | 1 | 2 | 3;

export const PERMISSION_TIER_LABELS: Readonly<Record<PermissionCeilingTier, string>> = {
  0: 'read-only (tier 0)',
  1: 'approval-gated (tier 1)',
  2: 'workspace-autonomous (tier 2)',
  3: 'unrestricted (tier 3)',
};

const RUNTIME_MODE_TIERS: Readonly<Record<RuntimeType, Readonly<Record<string, PermissionCeilingTier>>>> = {
  builtin: {
    plan: 0,
    auto: 1,
    custom: 1,
    fullAgency: 3,
  },
  dsh: {
    'approval-required': 1,
    'workspace-autonomous': 2,
    'full-autonomous': 3,
  },
  'claude-code': {
    plan: 0,
    manual: 1,
    acceptEdits: 2,
    dontAsk: 1,
    auto: 2,
    bypassPermissions: 3,
  },
  codex: {
    suggest: 0,
    'auto-edit': 1,
    'full-auto': 2,
    'no-restrictions': 3,
  },
  antigravity: {
    plan: 0,
    default: 1,
    'accept-edits': 1,
    auto: 2,
    'dangerously-skip-permissions': 3,
  },
};

const CANONICAL_MODE_BY_TIER: Readonly<Record<RuntimeType, Readonly<Record<PermissionCeilingTier, string | null>>>> = {
  builtin: {
    0: 'plan',
    1: 'auto',
    2: null,
    3: 'fullAgency',
  },
  dsh: {
    0: null,
    1: 'approval-required',
    2: 'workspace-autonomous',
    3: 'full-autonomous',
  },
  'claude-code': {
    0: 'plan',
    1: 'manual',
    2: 'auto',
    3: 'bypassPermissions',
  },
  codex: {
    0: 'suggest',
    1: 'auto-edit',
    2: 'full-auto',
    3: 'no-restrictions',
  },
  antigravity: {
    0: 'plan',
    1: 'accept-edits',
    2: 'auto',
    3: 'dangerously-skip-permissions',
  },
};

export function permissionTierForMode(
  runtime: RuntimeType,
  mode: string | null | undefined,
  runtimeSource?: RuntimeSource,
): PermissionCeilingTier | null {
  const trimmed = typeof mode === 'string' ? mode.trim() : '';
  if (runtime === 'codex' && runtimeSource === 'managed-provider') {
    // Managed auto-edit uses the automatic reviewer, like system full-auto.
    if (trimmed === 'auto-edit') return 2;
    if (trimmed === 'full-auto') return null;
  }
  const modes = RUNTIME_MODE_TIERS[runtime];
  return Object.hasOwn(modes, trimmed) ? modes[trimmed] ?? null : null;
}

export function canonicalPermissionModeForTier(
  runtime: RuntimeType,
  tier: PermissionCeilingTier,
  runtimeSource?: RuntimeSource,
): string | null {
  if (runtime === 'codex' && runtimeSource === 'managed-provider') {
    if (tier === 1) return null;
    if (tier === 2) return 'auto-edit';
  }
  return CANONICAL_MODE_BY_TIER[runtime]?.[tier] ?? null;
}

export type SessionStartPermissionResolution =
  | {
      ok: true;
      permissionMode: string;
      ceilingTier: PermissionCeilingTier;
      effectiveTier: PermissionCeilingTier;
    }
  | {
      ok: false;
      code:
        | 'INVALID_PERMISSION_MODE'
        | 'PERMISSION_CEILING_UNSATISFIABLE'
        | 'PERMISSION_ESCALATION_FORBIDDEN';
      message: string;
      ceilingTier?: PermissionCeilingTier;
    };

/**
 * Resolve the effective birth `permissionMode` for `myagents session start`
 * under the target Agent's permission ceiling:
 * - Same runtime & source without explicit `--permissionMode`: keeps target mode verbatim.
 * - Cross-runtime (or system-cli -> managed-provider) without explicit `--permissionMode`:
 *   aligns to the highest canonical mode in `(requestedRuntime, requestedRuntimeSource)`
 *   with `tier <= ceilingTier` (so Tier 3 unrestricted aligns 1-to-1 across all runtimes,
 *   while lower tiers never silently escalate; fails closed when no mode satisfies Tier 0, e.g. DSH).
 * - Explicit `--permissionMode`: must be valid for `(requestedRuntime, requestedRuntimeSource)`
 *   and have `tier <= ceilingTier` (allows deliberate downgrade, rejects escalation).
 */
export function resolveSessionStartPermissionMode(params: {
  targetRuntime: RuntimeType;
  targetRuntimeSource?: RuntimeSource;
  targetEffectivePermissionMode: string;
  requestedRuntime: RuntimeType;
  requestedRuntimeSource?: RuntimeSource;
  requestedPermissionMode?: string;
}): SessionStartPermissionResolution {
  const targetMode = params.targetEffectivePermissionMode.trim();
  const ceilingTier = permissionTierForMode(params.targetRuntime, targetMode, params.targetRuntimeSource);
  if (ceilingTier === null) {
    return {
      ok: false,
      code: 'PERMISSION_CEILING_UNSATISFIABLE',
      message: `Cannot determine permission ceiling from target Agent mode '${targetMode || '(empty)'}' on runtime '${params.targetRuntime}'.`,
    };
  }

  const explicit = params.requestedPermissionMode?.trim();
  if (explicit) {
    if (
      !isPermissionModeForRuntimeIdentity(
        explicit,
        params.requestedRuntime,
        params.requestedRuntimeSource,
      )
    ) {
      return {
        ok: false,
        code: 'INVALID_PERMISSION_MODE',
        message: `Invalid permissionMode '${explicit}' for runtime '${params.requestedRuntime}'${params.requestedRuntimeSource === 'managed-provider' ? ' (managed-provider)' : ''}.`,
        ceilingTier,
      };
    }
    const requestedTier = permissionTierForMode(params.requestedRuntime, explicit, params.requestedRuntimeSource);
    if (requestedTier === null) {
      return {
        ok: false,
        code: 'INVALID_PERMISSION_MODE',
        message: `Unsupported permissionMode '${explicit}' for runtime '${params.requestedRuntime}'.`,
        ceilingTier,
      };
    }
    if (requestedTier > ceilingTier) {
      return {
        ok: false,
        code: 'PERMISSION_ESCALATION_FORBIDDEN',
        message:
          `Requested permissionMode '${explicit}' (${PERMISSION_TIER_LABELS[requestedTier]}) exceeds target Agent ceiling ` +
          `'${targetMode}' on '${params.targetRuntime}' (${PERMISSION_TIER_LABELS[ceilingTier]}). ` +
          `session start only allows equal or more restrictive permission modes.`,
        ceilingTier,
      };
    }
    return {
      ok: true,
      permissionMode: explicit,
      ceilingTier,
      effectiveTier: requestedTier,
    };
  }

  const sameIdentity =
    params.requestedRuntime === params.targetRuntime
    && (params.requestedRuntimeSource === undefined
      || params.targetRuntimeSource === undefined
      || params.requestedRuntimeSource === params.targetRuntimeSource);
  if (
    sameIdentity
    && permissionTierForMode(params.requestedRuntime, targetMode, params.requestedRuntimeSource) === ceilingTier
    && isPermissionModeForRuntimeIdentity(
      targetMode,
      params.requestedRuntime,
      params.requestedRuntimeSource,
    )
  ) {
    return {
      ok: true,
      permissionMode: targetMode,
      ceilingTier,
      effectiveTier: ceilingTier,
    };
  }

  for (let tier = ceilingTier; tier >= 0; tier -= 1) {
    const candidate = canonicalPermissionModeForTier(
      params.requestedRuntime,
      tier as PermissionCeilingTier,
      params.requestedRuntimeSource,
    );
    if (candidate !== null) {
      return {
        ok: true,
        permissionMode: candidate,
        ceilingTier,
        effectiveTier: tier as PermissionCeilingTier,
      };
    }
  }

  return {
    ok: false,
    code: 'PERMISSION_CEILING_UNSATISFIABLE',
    message:
      `Runtime '${params.requestedRuntime}' has no permission mode within target Agent ceiling ` +
      `'${targetMode}' on '${params.targetRuntime}' (${PERMISSION_TIER_LABELS[ceilingTier]}). ` +
      `Choose a runtime that supports read-only mode or adjust the target Agent defaults explicitly.`,
    ceilingTier,
  };
}
