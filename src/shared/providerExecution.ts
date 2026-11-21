import { resolveAgentRuntimePreference } from './integrated-runtimes/identity';
import type { PermissionMode, Provider, ProviderExecution } from './config-types';
import { CODEX_SUBSCRIPTION_PROVIDER_ID, SUBSCRIPTION_PROVIDER_ID } from './config-types';
import {
  canResumeAcrossProviderBoundary,
  getProviderHistoryIdentity,
  type ProviderHistoryEnv,
  type ProviderHistoryPolicy,
} from './providerHistory';
import {
  createConcreteProviderRoute,
  type ProviderRoute,
} from './providerRoute';
import {
  isRuntimePermissionMode,
  RUNTIME_CONFIG_PER_RUNTIME_FIELDS,
  type RuntimeConfig,
  type RuntimeSource,
  type RuntimeType,
} from './types/runtime';

export { getProviderExecutionConstraint } from './integrated-runtimes/provider-constraints';
export type {
  ApiFamily,
  DshApiFamily,
  ProviderExecutionConstraint,
} from './integrated-runtimes/provider-constraints';

export type RuntimeBackedProviderIdentity = {
  kind: 'runtime-backed-provider';
  providerId: typeof CODEX_SUBSCRIPTION_PROVIDER_ID;
  runtime: 'codex';
  runtimeSource: 'managed-provider';
  model: string;
};

export type ProviderExecutionIntent =
  | { kind: 'builtin-provider'; route: ProviderRoute }
  | RuntimeBackedProviderIdentity;

export type ProviderExecutionHistoryFamily =
  | 'builtin:anthropic'
  | 'builtin:third-party'
  | `builtin:isolated:${string}`
  | `runtime-backed:${typeof CODEX_SUBSCRIPTION_PROVIDER_ID}`;

type ProviderExecutionShape = Pick<Provider, 'id' | 'execution'>;

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const MANAGED_CODEX_PROVIDER_PERMISSION_TO_RUNTIME: Partial<Record<PermissionMode, string>> = {
  auto: 'auto-edit',
  plan: 'suggest',
  fullAgency: 'no-restrictions',
};

const MANAGED_CODEX_RUNTIME_PERMISSION_TO_PROVIDER: Record<string, PermissionMode> = {
  suggest: 'plan',
  'auto-edit': 'auto',
  'no-restrictions': 'fullAgency',
};

type ManagedCodexAgentIdentity = {
  providerId?: string | null;
  runtime?: string | null;
  runtimePreference?: unknown;
  runtimeConfig?: { source?: string | null } | null;
};

/**
 * Current Agent defaults keep managed Codex in the builtin/provider shape;
 * the former codex + managed-provider shape remains readable. Any other
 * explicit external runtime wins over a dormant providerId/source.
 */
export function agentUsesManagedCodexProvider(
  agent: ManagedCodexAgentIdentity | null | undefined,
): boolean {
  if (agent?.providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID) return false;
  return resolveAgentRuntimePreference({
    runtimePreference: agent.runtimePreference,
    runtime: agent.runtime,
    runtimeSource: agent.runtimeConfig?.source,
    providerId: agent.providerId,
  })?.family === 'integrated';
}

export function isRuntimeBackedProvider(
  provider: ProviderExecutionShape | null | undefined,
): boolean {
  return provider?.execution?.kind === 'runtime-backed'
    || provider?.id === CODEX_SUBSCRIPTION_PROVIDER_ID;
}

export function isRuntimeBackedProviderId(
  providerId: string | null | undefined,
): providerId is typeof CODEX_SUBSCRIPTION_PROVIDER_ID {
  return providerId === CODEX_SUBSCRIPTION_PROVIDER_ID;
}

export function isBuiltinExecutionProvider(
  provider: ProviderExecutionShape | null | undefined,
): boolean {
  return Boolean(provider) && !isRuntimeBackedProvider(provider);
}

export function assertBuiltinExecutionProvider(
  provider: ProviderExecutionShape,
): void {
  if (!isBuiltinExecutionProvider(provider)) {
    throw new Error(`Provider ${provider.id} is runtime-backed and cannot be materialized as ProviderEnv`);
  }
}

function assertManagedCodexExecution(provider: ProviderExecutionShape): asserts provider is ProviderExecutionShape & {
  execution: Extract<ProviderExecution, { kind: 'runtime-backed' }>;
} {
  if (
    provider.id !== CODEX_SUBSCRIPTION_PROVIDER_ID
    || provider.execution?.kind !== 'runtime-backed'
    || provider.execution.runtime !== 'codex'
    || provider.execution.source !== 'managed-provider'
  ) {
    throw new Error(`Unsupported runtime-backed provider: ${provider.id}`);
  }
}

export function createRuntimeBackedProviderIdentity(args: {
  providerId: typeof CODEX_SUBSCRIPTION_PROVIDER_ID;
  model: string;
}): RuntimeBackedProviderIdentity {
  const model = nonEmpty(args.model);
  if (!model) {
    throw new Error('Runtime-backed provider identity requires a model');
  }
  return {
    kind: 'runtime-backed-provider',
    providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
    runtime: 'codex',
    runtimeSource: 'managed-provider',
    model,
  };
}

export function managedCodexProviderPermissionToRuntimePermission(
  permissionMode: string | null | undefined,
): string | undefined {
  const mode = nonEmpty(permissionMode);
  if (!mode) return undefined;
  return MANAGED_CODEX_PROVIDER_PERMISSION_TO_RUNTIME[mode as PermissionMode];
}

/** Read-time projection for historical/session values. Never accepts the
 * system-Codex-only `full-auto` value. */
export function projectManagedCodexPermissionToRuntime(
  permissionMode: string | null | undefined,
): string | undefined {
  const mode = nonEmpty(permissionMode);
  if (!mode) return undefined;
  return managedCodexProviderPermissionToRuntimePermission(mode)
    ?? (mode === 'suggest' || mode === 'auto-edit' || mode === 'no-restrictions'
      ? mode
      : undefined);
}

export function isManagedCodexRuntimePermissionMode(
  permissionMode: string | null | undefined,
): boolean {
  const mode = nonEmpty(permissionMode);
  return mode === 'suggest' || mode === 'auto-edit' || mode === 'no-restrictions';
}

/** Exact new-input validator for the complete execution identity. */
export function isPermissionModeForRuntimeIdentity(
  permissionMode: string | null | undefined,
  runtime: RuntimeType,
  runtimeSource?: RuntimeSource,
): boolean {
  return runtime === 'codex' && runtimeSource === 'managed-provider'
    ? isManagedCodexRuntimePermissionMode(permissionMode)
    : isRuntimePermissionMode(permissionMode, runtime);
}

export function managedCodexRuntimePermissionToProviderPermission(
  permissionMode: string | null | undefined,
): PermissionMode | undefined {
  const mode = nonEmpty(permissionMode);
  if (!mode) return undefined;
  if (mode === 'auto' || mode === 'plan' || mode === 'fullAgency') return mode;
  return MANAGED_CODEX_RUNTIME_PERMISSION_TO_PROVIDER[mode];
}

export function runtimeBackedProviderPermissionMode(
  identity: RuntimeBackedProviderIdentity,
  permissionMode: string | null | undefined,
): string | undefined {
  if (identity.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
    return managedCodexProviderPermissionToRuntimePermission(permissionMode);
  }
  return nonEmpty(permissionMode);
}

/**
 * Runtime snapshots are execution-level payloads (session/task birth). They
 * intentionally include source/model so the sidecar can spawn managed Codex.
 */
export function runtimeConfigForRuntimeBackedProvider(
  identity: RuntimeBackedProviderIdentity,
  current?: RuntimeConfig,
): RuntimeConfig {
  const next: RuntimeConfig = { ...(current ?? {}) };
  for (const key of RUNTIME_CONFIG_PER_RUNTIME_FIELDS) {
    delete next[key];
  }
  return {
    ...next,
    source: identity.runtimeSource,
    model: identity.model,
  };
}

/**
 * Agent/Channel defaults store the user's Provider choice. They must not store
 * the managed runtime/source projection, otherwise Codex subscription becomes
 * indistinguishable from the legacy user-managed Codex CLI runtime.
 */
export function runtimeConfigForRuntimeBackedProviderDefault(
  current?: RuntimeConfig,
  overrides?: Pick<RuntimeConfig, 'reasoningEffort'>,
): RuntimeConfig | undefined {
  const next: RuntimeConfig = { ...(current ?? {}) };
  delete next.source;
  delete next.model;
  delete next.permissionMode;
  delete next.additionalArgs;
  if (overrides?.reasoningEffort !== undefined) {
    next.reasoningEffort = overrides.reasoningEffort;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function agentDefaultsForRuntimeBackedProvider(
  identity: RuntimeBackedProviderIdentity,
  current?: RuntimeConfig,
  overrides?: Pick<RuntimeConfig, 'permissionMode' | 'reasoningEffort'>,
): {
  providerId: RuntimeBackedProviderIdentity['providerId'];
  model: string;
  runtime: 'builtin';
  permissionMode?: PermissionMode;
  runtimeConfig: RuntimeConfig | undefined;
} {
  const permissionMode = overrides?.permissionMode === undefined
    ? undefined
    : (managedCodexRuntimePermissionToProviderPermission(overrides.permissionMode) ?? 'auto');
  return {
    providerId: identity.providerId,
    model: identity.model,
    runtime: 'builtin',
    ...(permissionMode ? { permissionMode } : {}),
    runtimeConfig: runtimeConfigForRuntimeBackedProviderDefault(current, {
      ...(overrides?.reasoningEffort !== undefined ? { reasoningEffort: overrides.reasoningEffort } : {}),
    }),
  };
}

export function toProviderExecutionIntent(
  provider: Pick<Provider, 'id' | 'execution'>,
  model: string,
): ProviderExecutionIntent {
  if (isRuntimeBackedProvider(provider)) {
    assertManagedCodexExecution(provider);
    return createRuntimeBackedProviderIdentity({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model,
    });
  }

  assertBuiltinExecutionProvider(provider);
  return {
    kind: 'builtin-provider',
    route: createConcreteProviderRoute(provider.id, model),
  };
}

export function providerExecutionIntentProviderId(
  intent: ProviderExecutionIntent | null | undefined,
): string | undefined {
  if (!intent) return undefined;
  if (intent.kind === 'runtime-backed-provider') return intent.providerId;
  return intent.route.kind === 'provider' || intent.route.kind === 'subscription'
    ? intent.route.providerId
    : undefined;
}

function builtinFamilyFromHistory(
  providerEnv: ProviderHistoryEnv | undefined,
  policy: ProviderHistoryPolicy | undefined,
): ProviderExecutionHistoryFamily {
  const identity = getProviderHistoryIdentity(providerEnv, policy);
  if (identity === 'anthropic') return 'builtin:anthropic';
  if (identity === 'third-party') return 'builtin:third-party';
  if (identity.startsWith('isolated:')) {
    return `builtin:${identity}` as `builtin:isolated:${string}`;
  }
  return `builtin:isolated:${identity}`;
}

export function getProviderExecutionHistoryFamily(args: {
  intent?: ProviderExecutionIntent;
  providerHistoryEnv?: ProviderHistoryEnv;
  policy?: ProviderHistoryPolicy;
}): ProviderExecutionHistoryFamily {
  if (args.intent?.kind === 'runtime-backed-provider') {
    return `runtime-backed:${args.intent.providerId}`;
  }
  return builtinFamilyFromHistory(args.providerHistoryEnv, args.policy);
}

export function canReuseSessionAcrossProviderExecutionBoundary(args: {
  currentIntent?: ProviderExecutionIntent;
  nextIntent?: ProviderExecutionIntent;
  currentProviderEnv?: ProviderHistoryEnv;
  nextProviderEnv?: ProviderHistoryEnv;
  legacyCurrentProviderUnknown?: boolean;
  policy?: ProviderHistoryPolicy;
}): boolean {
  const currentIntent = args.currentIntent;
  const nextIntent = args.nextIntent;
  const currentIsRuntimeBacked = currentIntent?.kind === 'runtime-backed-provider';
  const nextIsRuntimeBacked = nextIntent?.kind === 'runtime-backed-provider';

  if (currentIsRuntimeBacked || nextIsRuntimeBacked) {
    if (!currentIsRuntimeBacked || !nextIsRuntimeBacked) return false;
    return currentIntent.providerId === nextIntent.providerId
      && currentIntent.runtime === nextIntent.runtime
      && currentIntent.runtimeSource === nextIntent.runtimeSource;
  }

  if (args.legacyCurrentProviderUnknown && !args.currentProviderEnv) {
    return true;
  }

  return canResumeAcrossProviderBoundary(
    args.currentProviderEnv,
    args.nextProviderEnv,
    args.policy,
  );
}

export function isAnthropicSubscriptionProviderIntent(
  intent: ProviderExecutionIntent | null | undefined,
): boolean {
  return intent?.kind === 'builtin-provider'
    && intent.route.kind === 'subscription'
    && intent.route.providerId === SUBSCRIPTION_PROVIDER_ID;
}
