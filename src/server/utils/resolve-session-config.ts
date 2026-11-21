import type { AgentConfig, ChannelConfig } from '../../shared/types/agent';
import { resolveEffectiveConfig } from '../../shared/types/agent';
import type { SessionMetadata } from '../types/session';
import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import {
  coerceModelForRuntime,
  getDefaultRuntimePermissionMode,
  getMaxPermissionForRuntime,
  projectPermissionModeForRuntime,
} from '../../shared/types/runtime';
import type { ProviderRoute } from '../../shared/providerRoute';
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import {
  agentUsesManagedCodexProvider,
  projectManagedCodexPermissionToRuntime,
} from '../../shared/providerExecution';
import {
  runtimeSourceForBinding,
  runtimeTypeForBinding,
} from '../../shared/integrated-runtimes/identity';

/**
 * Effective runtime config for a single query (v0.1.69).
 *
 * Only the fields we actually snapshot. `systemPrompt` / tool registry /
 * provider definitions are deliberately NOT here — those stay live (shared
 * by all sessions, upgraded together).
 */
export interface ResolvedSessionConfig {
  runtime: RuntimeType;
  runtimeSource: RuntimeSource | undefined;
  model: string | undefined;
  permissionMode: string | undefined;
  mcpEnabledServers: string[] | undefined;
  providerId: string | undefined;
  providerRoute: ProviderRoute | undefined;
  providerEnvJson: string | undefined;
}

/** Owned snapshots are authoritative for desktop, task and IM alike.
 * `im` only selects the unattended Agent-template birth/legacy resolver when
 * no complete snapshot exists; Cloud registered Agents use a separate lifecycle.
 */
export type SessionOwnerKind = 'im' | 'owned';

export interface ResolveSessionConfigOptions {
  managedCodexProviderReady?: boolean;
}

/**
 * Resolve the effective config for one query (D2, D4, D7, Option C).
 *
 * - IM with a complete snapshot uses the same owned policy. Without metadata,
 *   the compatibility/birth resolver reads only Agent defaults; Channels own
 *   transport and restrictions, never a second execution template.
 *
 * - Owned (`'owned'`): if `configSnapshotAt` is present, the session snapshot
 *   owns the field set and missing fields resolve only to runtime/provider
 *   product defaults. Agent fallback is reserved for legacy sessions that have
 *   no snapshot marker yet.
 *
 * The lazy fallback is **only a read-path concern** — it does NOT write back
 * into SessionMetadata. Backfill happens only on active writes (user sends a
 * message / changes a setting); see PRD §6.4.
 */
export function resolveSessionConfig(
  meta: SessionMetadata | null | undefined,
  agent: AgentConfig | undefined,
  channel: ChannelConfig | undefined,
  ownerKind: SessionOwnerKind,
  options: ResolveSessionConfigOptions = {},
): ResolvedSessionConfig {
  const managedCodexProviderReady = options.managedCodexProviderReady === true;
  if (ownerKind === 'im' && !meta?.configSnapshotAt) {
    if (!agent) throw new Error('IM session config requires an Agent.');
    // A missing channel is only a startup/health fallback; use the same identity
    // projection instead of maintaining a second permission path.
    const eff = channel ? resolveEffectiveConfig(agent, channel) : { ...agent, permissionMode: getMaxPermissionForRuntime(agent.runtime ?? 'builtin') };
    const effectiveRuntime = eff.runtime ?? 'builtin';
    const managedCodexSelected = agentUsesManagedCodexProvider({
      runtimePreference: agent.runtimePreference,
      providerId: eff.providerId,
      runtime: agent.runtime,
      runtimeConfig: agent.runtimeConfig,
    });
    if (managedCodexProviderReady && managedCodexSelected
        && eff.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID && eff.model) {
      return {
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        model: eff.model,
        permissionMode: projectManagedCodexPermissionToRuntime(eff.permissionMode)
          ?? 'auto-edit',
        mcpEnabledServers: eff.mcpEnabledServers,
        providerId: undefined,
        providerRoute: undefined,
        providerEnvJson: undefined,
      };
    }
    const permissionMode = effectiveRuntime === 'builtin'
      ? eff.permissionMode
      : effectiveRuntime === 'dsh'
        ? (projectPermissionModeForRuntime(eff.permissionMode, effectiveRuntime)
          ?? getDefaultRuntimePermissionMode(effectiveRuntime))
      : (projectPermissionModeForRuntime(eff.permissionMode, effectiveRuntime)
        ?? getMaxPermissionForRuntime(effectiveRuntime));
    return {
      runtime: effectiveRuntime,
      runtimeSource: effectiveRuntime === 'dsh'
        ? 'integrated'
        : effectiveRuntime !== 'builtin' ? 'system-cli' : undefined,
      model: eff.model,
      permissionMode,
      mcpEnabledServers: eff.mcpEnabledServers,
      providerId: eff.providerId,
      providerRoute: undefined,
      providerEnvJson: eff.providerEnvJson,
    };
  }

  // owned (Desktop + Cron): complete snapshots are session-owned. Legacy
  // sessions without configSnapshotAt may still fall back to Agent for
  // compatibility; snapshotted-but-partial sessions must not silently inherit
  // Agent defaults (#395/#396), because that makes old conversations drift when
  // the Agent template changes.
  const snapshotOwnsConfig = Boolean(meta?.configSnapshotAt);
  const agentUsesManagedProvider = Boolean(agent && agentUsesManagedCodexProvider(agent))
    && managedCodexProviderReady
    && typeof agent?.model === 'string'
    && agent.model.trim().length > 0;
  const runtime = meta?.runtimeBinding
    ? runtimeTypeForBinding(meta.runtimeBinding)
    : meta?.runtime ?? (agentUsesManagedProvider ? 'codex' : agent?.runtime) ?? 'builtin';
  const runtimeSource = meta?.runtimeBinding
    ? runtimeSourceForBinding(meta.runtimeBinding)
    : runtime === 'builtin'
      ? undefined
      : runtime === 'dsh'
        ? 'integrated'
        : (meta?.runtime !== undefined
      ? (meta.runtimeSource
        ?? meta.providerExecutionIdentity?.runtimeSource
        ?? 'system-cli')
      : (agentUsesManagedProvider ? 'managed-provider' : agent?.runtimeConfig?.source ?? 'system-cli'));
  const managedCodexSession = runtime === 'codex' && runtimeSource === 'managed-provider';
  // Snapshot vs agent-fallback for model. For external runtimes the snapshot
  // and agent fallback target different fields — snapshot holds the runtime
  // model (set by interactive writes + the runtime-aware snapshot helper),
  // agent fallback should read `runtimeConfig.model` not `agent.model`
  // (which is the builtin/provider field). Without this branch a fresh
  // unsnapshotted external session would read `agent.model` (Claude) and
  // hand it to Codex → 400 (issue #224).
  const usesIntegratedProvider = runtime === 'builtin' || runtime === 'dsh';
  const rawModel = usesIntegratedProvider
    ? (snapshotOwnsConfig ? meta?.model : (meta?.model ?? agent?.model))
    : (snapshotOwnsConfig
      ? meta?.model
      : (meta?.model ?? (agentUsesManagedProvider ? agent?.model : agent?.runtimeConfig?.model)));
  // Coerce obviously-foreign models out before they reach the runtime CLI.
  // Heals existing stale snapshots written by the pre-fix snapshot helper
  // (e.g. cron tasks created on App ≤ 0.2.19 with runtime=codex but
  // model=claude-opus-4-6). Uses the same conservative heuristic as the
  // agent-config migration — only drops values we're confident don't
  // belong, keeps unknown values intact.
  let model = rawModel;
  const coercedModel = coerceModelForRuntime(model, runtime);
  if (runtime !== 'builtin'
      && typeof model === 'string' && model.trim().length > 0
      && coercedModel === undefined) {
    console.warn(
      `[runtime-coerce] dropping stale session model='${model}' on runtime='${runtime}' (issue #224); falling back to runtime default. sessionId=${meta?.id ?? '<none>'} agentDir=${meta?.agentDir ?? '<unknown>'}`,
    );
    model = coercedModel;
  } else if (typeof model === 'string') {
    model = coercedModel;
  }

  const rawPermissionMode = usesIntegratedProvider
    ? (snapshotOwnsConfig ? meta?.permissionMode : (meta?.permissionMode ?? agent?.permissionMode))
    : (meta ? meta.permissionMode : (managedCodexSession
      ? agent?.permissionMode
      : agent?.runtimeConfig?.permissionMode));
  const projectedPermissionMode = managedCodexSession
    ? (projectManagedCodexPermissionToRuntime(rawPermissionMode) ?? 'auto-edit')
    : projectPermissionModeForRuntime(rawPermissionMode, runtime);
  const permissionMode = projectedPermissionMode
    ?? (runtime !== 'builtin' ? getDefaultRuntimePermissionMode(runtime) : undefined);
  if (typeof rawPermissionMode === 'string'
      && rawPermissionMode.trim().length > 0
      && projectedPermissionMode === undefined) {
    console.warn(
      `[runtime-coerce] dropping stale session permissionMode='${rawPermissionMode}' on runtime='${runtime}'; falling back to runtime default. sessionId=${meta?.id ?? '<none>'} agentDir=${meta?.agentDir ?? '<unknown>'}`,
    );
  }

  return {
    runtime,
    runtimeSource,
    model,
    permissionMode,
    mcpEnabledServers: snapshotOwnsConfig ? meta?.mcpEnabledServers : (meta?.mcpEnabledServers ?? agent?.mcpEnabledServers),
    providerId: usesIntegratedProvider
      ? (snapshotOwnsConfig ? meta?.providerId : (meta?.providerId ?? agent?.providerId))
      : undefined,
    providerRoute: usesIntegratedProvider && snapshotOwnsConfig ? meta?.providerRoute : undefined,
    providerEnvJson: usesIntegratedProvider
      ? (snapshotOwnsConfig ? meta?.providerEnvJson : (meta?.providerEnvJson ?? agent?.providerEnvJson))
      : undefined,
  };
}
