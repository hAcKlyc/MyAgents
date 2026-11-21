import type { AgentConfig } from '../../shared/types/agent';
import type { Provider } from '../../shared/config-types';
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import { resolveAgentConfigMutation, mutationForAgentModelSelection, type AgentModelSelection } from '../../shared/agentConfigMutation';
import { canReuseSessionAcrossProviderExecutionBoundary, createRuntimeBackedProviderIdentity, toProviderExecutionIntent } from '../../shared/providerExecution';
import { createConcreteProviderRoute } from '../../shared/providerRoute';
import { projectProvidersForRuntime, isProviderModelCompatibleWithRuntime, resolveProviderSwitchIntegratedRuntime, platformHiddenProviderIds } from '../../shared/runtimeProviderProjection';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { createHash } from 'node:crypto';
import { coerceReasoningEffortSettingForRuntime, reasoningEffortAfterModelChange, reasoningEffortChoices, type ModelReasoningCapabilities } from '../../shared/reasoningEffort';
import { getSessionEngine, queryRuntimeModels } from '../session-engine';
import { getSessionMetadata, updateSessionMetadata } from '../SessionStore';
import { findProjectAgentByWorkspacePath, getAllEffectiveProviders, getProviderSelectionError, loadConfig, loadProjects, resolveProviderEnv } from '../utils/admin-config';
import { snapshotForImSession } from '../utils/session-snapshot';
import { resolveWorkspaceConfig } from '../utils/admin-config';
import { isManagedCodexProviderReady } from '../utils/managed-codex-readiness';
import { buildSessionSnapshotPatchUpdates } from '../utils/session-snapshot-patch';
import { commitAgentModelSelection } from '../admin-api';
import { broadcast } from '../sse';
import type { SessionMetadata } from '../types/session';

export type ImModelSelection = AgentModelSelection;
export type ImModelOption = { selection: ImModelSelection; group: string; name: string; isCurrent: boolean; requiresNewSession: boolean; capabilities?: ModelReasoningCapabilities };
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
export function sameSelection(a: ImModelSelection, b: ImModelSelection) {
  return a.kind === b.kind && a.model === b.model && (a.kind === 'product-provider' && b.kind === 'product-provider' ? a.providerId === b.providerId : a.kind === 'external-cli' && b.kind === 'external-cli' && a.runtime === b.runtime && a.runtimeSource === b.runtimeSource);
}

/** The Agent, its workspace and config, without compiling any birth template. */
export function agentContext(agentId: string) {
  const config = loadConfig();
  const projects = loadProjects().filter(p => p.agentId === agentId);
  if (projects.length !== 1 || !projects[0].path) throw new Error('Agent workspace is unavailable or ambiguous');
  const workspacePath = projects[0].path;
  const agent = findProjectAgentByWorkspacePath(workspacePath) as AgentConfig | undefined;
  if (!agent || agent.id !== agentId) throw new Error('Agent is unavailable');
  return { config, workspacePath, agent };
}

/** Reads persisted authority without binding the Global Host to a Product Session.
 *  `base` lists options relative to a Team AI peer config instead of a Session. */
export async function modelContext(agentId: string, sessionId?: string, base?: Partial<SessionMetadata>) {
  const { config, workspacePath, agent } = agentContext(agentId);
  const metadata = sessionId ? getSessionMetadata(sessionId) : null;
  if (sessionId && (!metadata || !workspacePathsEqual(metadata.agentDir, workspacePath))) throw new Error('Session workspace does not match Agent');
  if (metadata && !metadata.configSnapshotAt) throw new Error('Legacy Session must be frozen before model selection');
  const current = metadata ?? base ?? snapshotForImSession(agent, { managedCodexProviderReady: isManagedCodexProviderReady(config), runtimePolicy: { defaultIntegratedRuntime: config.defaultIntegratedRuntime } });
  // Effort choices and Provider compatibility depend on the endpoint of this Session or peer config.
  const currentEnv = metadata ? resolveWorkspaceConfig(workspacePath, metadata, { includeMcp: false }).providerEnv
    : resolveProviderEnv(current.providerId ?? agent.providerId ?? 'anthropic-sub', config);
  const runtime = current.runtime ?? 'builtin';
  const nativeCli = (runtime === 'codex' || runtime === 'claude-code' || runtime === 'antigravity') && current.runtimeSource !== 'managed-provider';
  const options: ImModelOption[] = [];
  if (nativeCli) {
    const models = await queryRuntimeModels(runtime, { runtimeSource: current.runtimeSource ?? 'system-cli' });
    for (const model of models as import('../../shared/types/runtime').RuntimeModelInfo[]) options.push({ selection: { kind: 'external-cli', runtime, runtimeSource: current.runtimeSource ?? 'system-cli', model: model.value }, group: runtime === 'antigravity' ? 'Antigravity CLI' : runtime === 'codex' ? 'Codex CLI' : 'Claude Code', name: model.displayName, isCurrent: current.model === model.value || (runtime === 'antigravity' && !!model.isDefault), requiresNewSession: false, capabilities: model });
  } else {
    const managedModels = isManagedCodexProviderReady(config)
      ? await queryRuntimeModels('codex', { runtimeSource: 'managed-provider' }) : undefined;
    const providers = projectProvidersForRuntime(getAllEffectiveProviders(config, managedModels as import('../../shared/types/runtime').RuntimeModelInfo[] | undefined)
      .filter(provider => !platformHiddenProviderIds(process.platform).includes(provider.id)) as unknown as Provider[], runtime);
    const currentProvider = current.providerExecutionIdentity
      ?? (current.providerId && current.model ? { kind: 'builtin-provider' as const, route: createConcreteProviderRoute(current.providerId, current.model) } : undefined);
    // A runtime-backed identity (Managed Codex) carries the provider id instead of `providerId`.
    const currentProviderId = current.providerExecutionIdentity?.providerId ?? current.providerId;
    for (const provider of providers) {
      if (getProviderSelectionError(provider as unknown as ReturnType<typeof getAllEffectiveProviders>[number], config)) continue;
      for (const model of provider.models) {
        if (!isProviderModelCompatibleWithRuntime(runtime, provider, model.model)) continue;
        const nextIntent = toProviderExecutionIntent(provider, model.model);
        const nextEnv = provider.id === current.providerId ? currentEnv : provider.id === CODEX_SUBSCRIPTION_PROVIDER_ID ? undefined : resolveProviderEnv(provider.id, config);
        const requiresNewSession = !!metadata && !canReuseSessionAcrossProviderExecutionBoundary({ currentIntent: currentProvider, nextIntent, currentProviderEnv: currentEnv ? { ...currentEnv, model: current.model } : undefined, nextProviderEnv: nextEnv ? { ...nextEnv, model: model.model } : undefined, legacyCurrentProviderUnknown: !currentProvider && !currentEnv });
        options.push({ selection: { kind: 'product-provider', providerId: provider.id, model: model.model }, group: provider.name, name: model.modelName, isCurrent: currentProviderId === provider.id && current.model === model.model, requiresNewSession, capabilities: model });
      }
    }
  }
  return { config, workspacePath, agent, metadata, current, options, currentEnv: metadata || base ? currentEnv : undefined };
}

/** Observe desired execution fields, excluding transcript/activity and credentials. */
export function imSnapshotObservation(metadata: SessionMetadata): string {
  const fields = ['configSnapshotAt', 'runtime', 'runtimeSource', 'runtimeBinding', 'runtimeBindingCompatibility',
    'providerId', 'providerRoute', 'providerExecutionIdentity', 'providerEnvJson', 'model', 'reasoningEffort',
    'permissionMode', 'mcpEnabledServers', 'enabledPluginIds', 'enabledOfficialToolIds'];
  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
    return value;
  }
  const projection = Object.fromEntries(fields.map(key => [key, (metadata as unknown as Record<string, unknown>)[key]]));
  return createHash('sha256').update(JSON.stringify(stable(projection))).digest('hex');
}

export function sessionEffortChoices(context: Awaited<ReturnType<typeof modelContext>>): readonly string[] | null {
  const current = context.current;
  const capabilities = context.options.find(option => option.isCurrent)?.capabilities;
  if (current.runtimeSource === 'managed-provider' || current.runtime === 'antigravity') return capabilities?.supportedReasoningEfforts?.map(option => option.reasoningEffort) ?? [];
  return reasoningEffortChoices(current.runtime ?? 'builtin', context.currentEnv?.apiProtocol, current.providerId, current.model, context.currentEnv?.baseUrl);
}

export function birthForSelection(context: Awaited<ReturnType<typeof modelContext>>, selection: ImModelSelection) {
  const mutation = mutationForAgentModelSelection(context.agent, selection);
  const targetAgent = { ...context.agent, ...resolveAgentConfigMutation(context.agent, mutation) };
  // A model choice uses this Product Session's execution owner, not a later
  // default CLI Runtime. Reuse the desktop Provider-switch birth policy.
  const targetProvider = selection.kind === 'product-provider'
    ? getAllEffectiveProviders(context.config).find(provider => provider.id === selection.providerId) : undefined;
  if (selection.kind === 'product-provider' && !targetProvider) throw new Error('Selected provider is unavailable');
  const targetRuntime = selection.kind === 'product-provider' && selection.providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID && targetProvider
    ? resolveProviderSwitchIntegratedRuntime({ targetProvider: targetProvider as unknown as Provider,
      currentSessionRuntime: context.current.runtime ?? 'builtin', agentRuntimePreference: context.agent.runtimePreference,
      legacyAgentRuntime: context.agent.runtime, legacyAgentRuntimeSource: context.agent.runtimeConfig?.source, legacyAgentProviderId: context.agent.providerId })
    : selection.kind === 'product-provider' ? 'codex' : selection.runtime as import('../../shared/types/runtime').RuntimeType;
  const birth = snapshotForImSession(targetAgent, { runtimeOverride: targetRuntime,
    runtimeSourceOverride: selection.kind === 'product-provider' && selection.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID ? 'managed-provider' : undefined,
    managedCodexProviderReady: isManagedCodexProviderReady(context.config) });
  return { agentDir: context.workspacePath, runtime: birth.runtime, runtimeSource: birth.runtimeSource, seedMaxPermission: true, providerExecutionIdentity: birth.providerExecutionIdentity, providerId: birth.providerId, model: birth.model, reasoningEffort: birth.reasoningEffort, mcpEnabledServers: birth.mcpEnabledServers, enabledPluginIds: birth.enabledPluginIds, enabledOfficialToolIds: birth.enabledOfficialToolIds, origin: { kind: 'agent-channel', surface: 'channel_message' } };
}

export async function handleImModelRoute(path: string, request: Request): Promise<Response | null> {
  const sessionOnly = path === '/api/im/session-model-selection';
  if (sessionOnly) path = '/api/im/model-selection';
  if (path !== '/api/im/model-options' && path !== '/api/im/model-selection') return null;
  try {
    if (path === '/api/im/model-options' && request.method === 'GET') {
      const url = new URL(request.url);
      const context = await modelContext(url.searchParams.get('agentId') ?? '', url.searchParams.get('sessionId') ?? undefined);
      return json({ success: true, sessionId: context.metadata?.id ?? null, configSnapshotAt: context.metadata?.configSnapshotAt ?? null, snapshotObservation: context.metadata ? imSnapshotObservation(context.metadata) : null, currentModel: context.current.model ?? '(默认)', runtime: context.current.runtime, runtimeSource: context.current.runtimeSource, model: context.current.model, reasoningEffort: context.current.reasoningEffort, reasoningEffortChoices: sessionEffortChoices(context), mcpEnabledServers: context.current.mcpEnabledServers ?? [], enabledPluginIds: context.current.enabledPluginIds ?? [], enabledOfficialToolIds: context.current.enabledOfficialToolIds ?? [], options: context.options });
    }
    if (path === '/api/im/model-options' && request.method === 'POST') {
      const body = await request.json() as { agentId: string; selection: ImModelSelection };
      const context = await modelContext(body.agentId);
      const option = context.options.find(o => sameSelection(o.selection, body.selection));
      if (!option) return json({ success: false, error: 'Model is unavailable' }, 409);
      return json({ success: true, birth: birthForSelection(context, option.selection) });
    }
    if (path === '/api/im/model-selection' && request.method === 'POST') {
      const body = await request.json() as { agentId: string; sessionId: string; configSnapshotAt: string; snapshotObservation: string; selection: ImModelSelection; allowNewSession?: boolean };
      const engine = getSessionEngine();
      if (engine.getCurrentSessionContext().sessionId !== body.sessionId) return json({ success: false, error: 'Session binding changed' }, 409);
      const context = await modelContext(body.agentId, body.sessionId);
      const metadata = context.metadata!;
      if (imSnapshotObservation(metadata) !== body.snapshotObservation) return json({ success: false, error: '模型菜单已失效，请重新发送 /model' }, 409);
      const option = context.options.find(o => sameSelection(o.selection, body.selection));
      if (!option) return json({ success: false, error: '模型不可用，请重新发送 /model' }, 409);
      const selection = option.selection;
      if (option.requiresNewSession) {
        if (body.allowNewSession !== true) return json({ success: false, error: '模型兼容性已变化，请重新发送 /model 查看列表' }, 409);
        return json({ success: false, requiresNewSession: true, birth: { ...birthForSelection(context, selection), ...(sessionOnly ? {
          reasoningEffort: coerceReasoningEffortSettingForRuntime(reasoningEffortAfterModelChange(metadata.reasoningEffort, option.capabilities), selection.kind === 'external-cli' ? selection.runtime : selection.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID ? 'codex' : metadata.runtime ?? 'builtin'),
          mcpEnabledServers: metadata.mcpEnabledServers ?? [], enabledPluginIds: metadata.enabledPluginIds ?? [], enabledOfficialToolIds: metadata.enabledOfficialToolIds ?? [],
        } : {}) } }, 409);
      }
      const runtime = metadata.runtime ?? 'builtin';
      const effort = coerceReasoningEffortSettingForRuntime(reasoningEffortAfterModelChange(metadata.reasoningEffort, option.capabilities), runtime);
      const payload = selection.kind === 'external-cli' ? { model: selection.model, reasoningEffort: effort }
        : selection.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID
          ? { providerExecutionIdentity: createRuntimeBackedProviderIdentity({ providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, model: selection.model }), model: selection.model, reasoningEffort: effort }
          : { providerRoute: createConcreteProviderRoute(selection.providerId, selection.model), model: selection.model, reasoningEffort: effort, providerEnvJson: metadata.providerId === selection.providerId ? metadata.providerEnvJson : null };
      const updates = buildSessionSnapshotPatchUpdates({ existing: metadata, payload, nowIso: new Date().toISOString() });
      const updated = await updateSessionMetadata(metadata.id, updates, current => engine.getCurrentSessionContext().sessionId === body.sessionId && imSnapshotObservation(current) === body.snapshotObservation);
      if (!updated) return json({ success: false, error: 'Session configuration changed', sessionConfig: 'failed' }, 409);
      broadcast('chat:session-config-changed', { sessionId: updated.id });
      if (engine.getCurrentSessionContext().sessionId !== body.sessionId) return json({ success: false, sessionConfig: 'saved', runtimeApply: 'failed', error: '会话已切换，原会话模型已保存，请查看 /status' }, 409);
      let applied;
      try { applied = await engine.applyModelSelection({ model: selection.model, providerEnv: selection.kind === 'product-provider' && selection.providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID ? (metadata.providerId === selection.providerId ? context.currentEnv : resolveProviderEnv(selection.providerId, context.config)) : undefined, reasoningEffort: effort });
      } catch { return json({ success: false, sessionConfig: 'saved', runtimeApply: 'failed', error: '会话模型已保存，运行时应用失败；请查看 /status 后重试' }, 500); }
      if (!applied.success) return json({ success: false, sessionConfig: 'saved', runtimeApply: 'failed', error: applied.error }, 500);
      if (sessionOnly) return json({ success: true, sessionConfig: 'saved', runtimeApply: applied.status ?? 'applied' });
      let defaults;
      try { defaults = await commitAgentModelSelection(body.agentId, selection, effort); }
      catch { defaults = { success: false, error: '当前会话已修改，Agent 默认模型保存失败' }; }
      return json({ success: defaults.success, sessionConfig: 'saved', runtimeApply: applied.status ?? 'applied', agentDefault: defaults.success ? 'saved' : 'failed', error: defaults.error, reloadPatch: defaults.success ? (defaults.data as { reloadPatch?: unknown })?.reloadPatch : undefined });
    }
    return json({ success: false, error: 'Method not allowed' }, 405);
  } catch { return json({ success: false, error: '无法读取或更新模型配置，请检查 Agent 与会话状态' }, 409); }
}
