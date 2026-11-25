import type { AgentConfig } from '../../shared/types/agent';
import {
  buildRuntimeChangePatch,
  coerceModelForRuntime,
  getMaxPermissionForRuntime,
  resolveEffectiveRuntime,
  projectPermissionModeForRuntime,
  type RuntimeSource,
  type RuntimeType,
} from '../../shared/types/runtime';
import { coerceReasoningEffortSettingForRuntime } from '../../shared/reasoningEffort';
import type { SessionMetadata } from '../types/session';
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import { createConcreteProviderRoute, type ProviderRoute } from '../../shared/providerRoute';
import {
  agentUsesManagedCodexProvider,
  createRuntimeBackedProviderIdentity,
  managedCodexProviderPermissionToRuntimePermission,
} from '../../shared/providerExecution';
import { createDshBinding, resolveDshPlatformTarget } from '../../shared/integrated-runtimes/identity';
import type { SessionBirthOverrides } from '../../shared/sessionPermissionCeiling';

/** Complete Product Session execution snapshots. Desktop, Task and IM share
 * the owned snapshot compiler; IM changes only its birth permission policy.
 * Registered cloud Agents retain their independent live-follow lifecycle.
 * configSnapshotAt is stamped by the Session writer, never by Rust templates.
 */
export type OwnedSessionSnapshot = Pick<
  SessionMetadata,
  | 'runtime'
  | 'runtimeSource'
  | 'runtimeBinding'
  | 'runtimeBindingCompatibility'
  | 'model'
  | 'reasoningEffort'
  | 'permissionMode'
  | 'mcpEnabledServers'
  | 'enabledPluginIds'
  | 'enabledOfficialToolIds'
  | 'providerId'
  | 'providerRoute'
  | 'providerExecutionIdentity'
  | 'providerEnvJson'
>;

/** Clone the frozen execution identity owned by an existing Session branch source. */
export function snapshotForForkedSession(
  source: SessionMetadata,
  legacyFallback?: OwnedSessionSnapshot & Pick<SessionMetadata, 'configSnapshotAt'>,
): OwnedSessionSnapshot & Pick<SessionMetadata, 'configSnapshotAt'> {
  const fallback = source.configSnapshotAt ? undefined : legacyFallback;
  const runtimeIdentity = source.runtimeBinding
    ? { runtimeBinding: source.runtimeBinding }
    : source.runtimeBindingCompatibility
      ? { runtimeBindingCompatibility: source.runtimeBindingCompatibility }
      : fallback?.runtimeBinding
        ? { runtimeBinding: fallback.runtimeBinding }
        : fallback?.runtimeBindingCompatibility
          ? { runtimeBindingCompatibility: fallback.runtimeBindingCompatibility }
          : {};
  return {
    runtime: source.runtime ?? fallback?.runtime ?? 'builtin',
    runtimeSource: source.runtimeSource ?? fallback?.runtimeSource,
    ...runtimeIdentity,
    model: source.model ?? fallback?.model,
    reasoningEffort: source.reasoningEffort ?? fallback?.reasoningEffort,
    permissionMode: source.permissionMode ?? fallback?.permissionMode,
    mcpEnabledServers: source.mcpEnabledServers
      ? [...source.mcpEnabledServers]
      : fallback?.mcpEnabledServers ? [...fallback.mcpEnabledServers] : undefined,
    enabledPluginIds: source.enabledPluginIds
      ? [...source.enabledPluginIds]
      : fallback?.enabledPluginIds ? [...fallback.enabledPluginIds] : undefined,
    enabledOfficialToolIds: source.enabledOfficialToolIds
      ? [...source.enabledOfficialToolIds]
      : fallback?.enabledOfficialToolIds ? [...fallback.enabledOfficialToolIds] : undefined,
    providerId: source.providerId ?? fallback?.providerId,
    providerRoute: source.providerRoute ?? fallback?.providerRoute,
    providerExecutionIdentity: source.providerExecutionIdentity ?? fallback?.providerExecutionIdentity,
    providerEnvJson: source.providerEnvJson ?? fallback?.providerEnvJson,
    // A fork is always an owned Session. Legacy sources followed Agent config,
    // so their caller supplies the effective owned snapshot at the fork boundary.
    configSnapshotAt: source.configSnapshotAt ?? fallback?.configSnapshotAt ?? new Date().toISOString(),
  };
}
/** Caller-resolved execution identity and Agent-template birth policy. */
interface SessionSnapshotRuntimeOptions {
  /** Agent-template births need the same distribution/gate policy as desktop. */
  runtimePolicy?: { defaultIntegratedRuntime?: unknown };
  /**
   * Runtime the session is being materialized for. Used when a caller creates a
   * session as part of a runtime switch before the AgentConfig patch is written.
   */
  runtimeOverride?: RuntimeType;
  /**
   * Source half of the runtime identity. `codex/system-cli` and
   * `codex/managed-provider` are different owners.
   */
  runtimeSourceOverride?: RuntimeSource;
  /**
   * Caller-owned readiness decision for provider-backed Managed Codex. Snapshot
   * helpers stay pure and do not read config.json themselves.
   */
  managedCodexProviderReady?: boolean;
  /**
   * One-shot birth overrides (e.g. local `myagents session start --runtime ...`).
   * Written solely to this Session's birth snapshot without mutating AgentConfig.
   */
  birthOverrides?: SessionBirthOverrides;
}

export function snapshotRuntimeIdentity(
  runtime: RuntimeType,
  runtimeSource?: RuntimeSource,
): Pick<SessionMetadata, 'runtime' | 'runtimeSource' | 'runtimeBinding'> {
  if (runtime === 'dsh') {
    return {
      runtime,
      runtimeSource: 'integrated',
      runtimeBinding: createDshBinding(resolveDshPlatformTarget(process.platform, process.arch)),
    };
  }
  return {
    runtime,
    runtimeSource: runtime === 'builtin'
      ? undefined
      : (runtimeSource ?? 'system-cli'),
  };
}

function agentForSnapshotRuntime(
  agent: AgentConfig,
  options?: SessionSnapshotRuntimeOptions,
): AgentConfig {
  const currentRuntime = agent.runtime ?? 'builtin';
  const targetRuntime = options?.runtimeOverride ?? currentRuntime;
  if (targetRuntime === currentRuntime) return agent;

  const runtimePatch = buildRuntimeChangePatch(agent.runtimeConfig, targetRuntime);
  return {
    ...agent,
    runtime: runtimePatch.runtime,
    runtimeConfig: runtimePatch.runtimeConfig,
  };
}

function shouldSnapshotManagedCodexProvider(
  agent: AgentConfig,
  options?: SessionSnapshotRuntimeOptions,
): agent is AgentConfig & {
  providerId: typeof CODEX_SUBSCRIPTION_PROVIDER_ID;
  model: string;
} {
  // runtimeOverride alone is an explicit runtime operation (runtime switch,
  // prepared runtime birth, etc.). Do not let a stale Agent.providerId=codex-sub
  // turn that operation back into a provider-owned managed Codex session. When
  // runtimeSourceOverride is also managed-provider, the caller supplied the full
  // runtime identity and the provider-backed owner should be preserved.
  const isImplicitAgentRuntime = options?.runtimeOverride === undefined;
  const isExplicitManagedCodexRuntime =
    options?.runtimeOverride === 'codex'
    && options?.runtimeSourceOverride === 'managed-provider';
  const managedProviderSelected = isExplicitManagedCodexRuntime
    || agentUsesManagedCodexProvider(agent);
  return (isImplicitAgentRuntime || isExplicitManagedCodexRuntime)
    && managedProviderSelected
    && options?.managedCodexProviderReady === true
    && agent.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID
    && typeof agent.model === 'string'
    && agent.model.trim().length > 0;
}

/** Cloud registered Agents retain Runtime-only identity and their own live-follow policy. */
export function snapshotForRegisteredAgentSession(
  agent: AgentConfig,
  options?: SessionSnapshotRuntimeOptions,
): Partial<SessionMetadata> {
  if (shouldSnapshotManagedCodexProvider(agent, options)) {
    return {
      runtime: 'codex',
      runtimeSource: 'managed-provider',
    };
  }
  const snapshotAgent = agentForSnapshotRuntime(agent, options);
  const runtime = snapshotAgent.runtime ?? 'builtin';
  return {
    ...snapshotRuntimeIdentity(
      runtime,
      options?.runtimeSourceOverride ?? snapshotAgent.runtimeConfig?.source,
    ),
  };
}

/** IM uses the same complete snapshot as desktop, with unattended birth permissions. */
export function snapshotForImSession(
  agent: AgentConfig,
  options?: SessionSnapshotRuntimeOptions,
): OwnedSessionSnapshot & Pick<SessionMetadata, 'configSnapshotAt'> {
  let birthOptions = options;
  if (options?.runtimePolicy && options.runtimeOverride === undefined) {
    const preferred = resolveEffectiveRuntime(agent.runtime, agent.runtimePreference, agent.runtimeConfig?.source, agent.providerId, undefined,
      options.runtimePolicy.defaultIntegratedRuntime);
    const managed = preferred === 'builtin' && agentUsesManagedCodexProvider(agent);
    if (managed && options.managedCodexProviderReady !== true) {
      throw new Error('Managed Codex is not ready for IM Session birth');
    }
    birthOptions = { ...options, runtimeOverride: managed ? 'codex' : preferred,
      runtimeSourceOverride: managed ? 'managed-provider' : undefined };
  }
  const snapshot = snapshotForOwnedSession(agent, birthOptions);
  return {
    ...snapshot,
    permissionMode: getMaxPermissionForRuntime(snapshot.runtime ?? 'builtin'),
  };
}

/** A Team AI peer config switching Runtime starts from its saved choices.
 * CLI model/source/effort remain runtime-owned and are scrubbed by the same
 * compiler used by ordinary Runtime changes; integrated Provider choices carry.
 */
export function snapshotForImRuntimeSwitch(
  source: Pick<SessionMetadata, 'runtime' | 'runtimeSource' | 'permissionMode' | 'providerId' | 'model' | 'reasoningEffort' | 'providerEnvJson' | 'mcpEnabledServers' | 'enabledPluginIds' | 'enabledOfficialToolIds'>,
  runtime: RuntimeType,
): OwnedSessionSnapshot {
  const integrated = source.runtime === 'builtin' || source.runtime === 'dsh';
  const agent: AgentConfig = {
    id: 'runtime-switch', name: 'Runtime switch', enabled: true, channels: [],
    runtime: source.runtime as RuntimeType | undefined,
    permissionMode: source.permissionMode ?? 'auto',
    providerId: integrated ? source.providerId : undefined,
    model: integrated ? source.model : undefined,
    reasoningEffort: integrated ? source.reasoningEffort : undefined,
    providerEnvJson: integrated ? source.providerEnvJson : undefined,
    runtimeConfig: integrated || source.runtimeSource === 'managed-provider' ? undefined : { source: source.runtimeSource, model: source.model, reasoningEffort: source.reasoningEffort },
    mcpEnabledServers: source.mcpEnabledServers ?? [],
    enabledPluginIds: source.enabledPluginIds ?? [],
    enabledOfficialToolIds: source.enabledOfficialToolIds ?? [],
  };
  return snapshotForImSession(agent, { runtimeOverride: runtime,
    runtimeSourceOverride: runtime === 'codex' || runtime === 'claude-code' || runtime === 'antigravity' ? 'system-cli' : undefined });
}

/**
 * Desktop Tab / Cron owner — full-snapshot policy (D2, D3, D9).
 *
 * Desktop sessions own their config: once created, the session is self-contained
 * and is not affected by later changes to AgentConfig (D1). Cron `new_task`
 * tick creates a fresh snapshot each run (every tick reads current Agent);
 * Cron `current_session` freezes at first creation and reuses forever.
 *
 * Return shape = `OwnedSessionSnapshot` payload + the writer-stamped
 * `configSnapshotAt` marker. For the desktop-creation path, "writer" =
 * this function (we stamp `now` here). For the runtime-change freeze path,
 * the writers (`/api/session/freeze` endpoint and Rust file-lock fallback)
 * stamp `configSnapshotAt` themselves so the marker reflects when the
 * write actually committed — those callers should pass `OwnedSessionSnapshot`
 * by itself, not the return of this function.
 *
 * **Runtime-aware model/permission capture (issue #224).** `SessionMetadata.model`
 * is overloaded — for builtin runtime it holds the SDK / provider model
 * (`agent.model`), for external runtimes it holds the CLI's model id
 * (`agent.runtimeConfig.model`). The interactive write path in
 * `renderer/api/persistInputOption.ts::buildSnapshotPatch` already encodes
 * this dispatch. Snapshot creation must match: previously this helper
 * blindly captured `agent.model` even for external runtimes, leaking a
 * Claude/builtin model name into a Codex session snapshot. The cron
 * `followAgent` resolution path then promoted that into
 * `runtimeConfig.model`, which Codex CLI rejects (issue #224).
 */
export function snapshotForOwnedSession(
  agent: AgentConfig,
  options?: SessionSnapshotRuntimeOptions,
): OwnedSessionSnapshot & Pick<SessionMetadata, 'configSnapshotAt'> {
  const birthOverrides = options?.birthOverrides;
  const effectiveOptions: SessionSnapshotRuntimeOptions | undefined = birthOverrides
    ? {
        ...options,
        runtimeOverride: options?.runtimeOverride ?? birthOverrides.runtime,
        runtimeSourceOverride: options?.runtimeSourceOverride ?? birthOverrides.runtimeSource,
      }
    : options;
  const managedCodexAgent: AgentConfig = birthOverrides
    ? {
        ...agent,
        ...(birthOverrides.providerId !== undefined ? { providerId: birthOverrides.providerId } : {}),
        ...(birthOverrides.model !== undefined ? { model: birthOverrides.model } : {}),
      }
    : agent;
  const agentEffectiveRuntime: RuntimeType = agentUsesManagedCodexProvider(agent)
    ? 'codex'
    : (agent.runtime ?? 'builtin');
  const agentEffectiveSource: RuntimeSource | undefined = agentUsesManagedCodexProvider(agent)
    ? 'managed-provider'
    : (agentEffectiveRuntime === 'builtin'
      ? undefined
      : agentEffectiveRuntime === 'dsh'
        ? 'integrated'
        : (agent.runtimeConfig?.source ?? 'system-cli'));
  const birthSwitchedRuntime = Boolean(
    birthOverrides?.runtime !== undefined
    && (birthOverrides.runtime !== agentEffectiveRuntime
      || (birthOverrides.runtimeSource !== undefined
        && birthOverrides.runtimeSource !== agentEffectiveSource)),
  );
  if (shouldSnapshotManagedCodexProvider(managedCodexAgent, effectiveOptions)) {
    const providerExecutionIdentity = createRuntimeBackedProviderIdentity({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: managedCodexAgent.model,
    });
    const rawEffort = birthOverrides
      ? (birthOverrides.reasoningEffort ?? (birthSwitchedRuntime ? undefined : agent.runtimeConfig?.reasoningEffort))
      : agent.runtimeConfig?.reasoningEffort;
    const effectivePermissionMode = birthOverrides?.permissionMode
      ?? managedCodexProviderPermissionToRuntimePermission(agent.permissionMode)
      ?? 'auto-edit';
    return {
      runtime: providerExecutionIdentity.runtime,
      runtimeSource: providerExecutionIdentity.runtimeSource,
      model: providerExecutionIdentity.model,
      reasoningEffort: coerceReasoningEffortSettingForRuntime(
        rawEffort,
        providerExecutionIdentity.runtime,
      ),
      permissionMode: effectivePermissionMode,
      mcpEnabledServers: agent.mcpEnabledServers ? [...agent.mcpEnabledServers] : undefined,
      enabledPluginIds: agent.enabledPluginIds ? [...agent.enabledPluginIds] : undefined,
      enabledOfficialToolIds: agent.enabledOfficialToolIds ? [...agent.enabledOfficialToolIds] : undefined,
      providerId: providerExecutionIdentity.providerId,
      providerRoute: undefined,
      providerExecutionIdentity,
      providerEnvJson: undefined,
      configSnapshotAt: new Date().toISOString(),
    };
  }
  const snapshotAgent = agentForSnapshotRuntime(agent, effectiveOptions);
  const runtime = snapshotAgent.runtime ?? 'builtin';
  const isDsh = runtime === 'dsh';
  const isExternal = runtime !== 'builtin' && !isDsh;
  const rawProviderId = !isExternal
    ? (birthOverrides?.providerId ?? (birthSwitchedRuntime && agentEffectiveRuntime !== 'builtin' && agentEffectiveRuntime !== 'dsh' ? undefined : snapshotAgent.providerId))
    : undefined;
  const hasStaleManagedProviderId = rawProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID;
  const builtinProviderId = !isExternal && !hasStaleManagedProviderId
    ? rawProviderId
    : undefined;
  const switchedProviderOrRuntime = Boolean(
    birthOverrides?.providerId !== undefined
    || birthSwitchedRuntime,
  );
  const model = isExternal
    ? coerceModelForRuntime(
        birthOverrides
          ? (birthOverrides.model ?? (birthSwitchedRuntime ? undefined : snapshotAgent.runtimeConfig?.model))
          : snapshotAgent.runtimeConfig?.model,
        runtime,
      )
    : (birthOverrides?.model
      ?? (hasStaleManagedProviderId
        || (birthOverrides?.providerId !== undefined && birthOverrides.providerId !== snapshotAgent.providerId)
        || (birthSwitchedRuntime && agentEffectiveRuntime !== 'builtin' && agentEffectiveRuntime !== 'dsh')
        ? undefined
        : snapshotAgent.model));
  const providerRoute: ProviderRoute | undefined = builtinProviderId && model
    ? createConcreteProviderRoute(builtinProviderId, model)
    : undefined;
  const resolvedPermissionMode = birthOverrides?.permissionMode
    ?? (isExternal
      ? projectPermissionModeForRuntime(snapshotAgent.runtimeConfig?.permissionMode, runtime)
      : snapshotAgent.permissionMode);
  const rawReasoningEffort = birthOverrides
    ? (birthOverrides.reasoningEffort !== undefined
      ? birthOverrides.reasoningEffort
      : birthSwitchedRuntime
        ? undefined
        : isExternal
          ? snapshotAgent.runtimeConfig?.reasoningEffort
          : snapshotAgent.reasoningEffort)
    : isExternal
      ? snapshotAgent.runtimeConfig?.reasoningEffort
      : snapshotAgent.reasoningEffort;
  return {
    ...snapshotRuntimeIdentity(
      runtime,
      effectiveOptions?.runtimeSourceOverride ?? snapshotAgent.runtimeConfig?.source,
    ),
    model,
    // #324 — same runtime-aware dispatch as model (issue #224 rationale).
    reasoningEffort: isExternal
      ? coerceReasoningEffortSettingForRuntime(rawReasoningEffort, runtime)
      : rawReasoningEffort,
    permissionMode: resolvedPermissionMode,
    mcpEnabledServers: snapshotAgent.mcpEnabledServers ? [...snapshotAgent.mcpEnabledServers] : undefined,
    enabledPluginIds: snapshotAgent.enabledPluginIds ? [...snapshotAgent.enabledPluginIds] : undefined,
    enabledOfficialToolIds: snapshotAgent.enabledOfficialToolIds ? [...snapshotAgent.enabledOfficialToolIds] : undefined,
    providerId: builtinProviderId,
    providerRoute,
    providerExecutionIdentity: undefined,
    providerEnvJson: isExternal || providerRoute || hasStaleManagedProviderId || switchedProviderOrRuntime
      ? undefined
      : snapshotAgent.providerEnvJson,
    configSnapshotAt: new Date().toISOString(),
  };
}
