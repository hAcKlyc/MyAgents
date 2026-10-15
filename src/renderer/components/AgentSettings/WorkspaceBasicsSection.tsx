import { APP_DISPLAY_NAME } from '../../../shared/appProfile';
import type { AgentConfigMutation } from '../../../shared/agentConfigMutation';
// WorkspaceBasicsSection — workspace name, icon, model, permission, MCP tools
// AI config (model/provider/permission/mcp) reads from AgentConfig (source of truth).
// Metadata (name/icon) writes to both Project and AgentConfig.

import { isImeComposingEvent } from '@/utils/imeKeyboard';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ChevronRightIcon } from '@/components/icons';
import { useConfig } from '@/hooks/useConfig';
import { useAvailableProviders } from '@/hooks/useAvailableProviders';
import { getAllMcpServers, getEnabledMcpServerIds } from '@/config/configService';
import { patchAgentConfig, patchAgentProjectConfig } from '@/config/services/agentConfigService';
import { isProviderAvailable } from '@/config/services/providerService';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import { applyBuiltinBrowserExecutionToolToggle } from '@/../shared/browserTools';
import { PERMISSION_MODES, type Project, type McpServerDefinition } from '@/config/types';
import type { AgentConfig } from '../../../shared/types/agent';
import { reasoningEffortChoices, reasoningEffortAfterModelChange, REASONING_EFFORT_DESCRIPTIONS } from '@/../shared/reasoningEffort';
import { DEFAULT_WORKSPACE_ICON } from '@/assets/workspace-icons';
import WorkspaceIconGrid, { WORKSPACE_ICON_GRID_PANEL_CLASS } from '../launcher/WorkspaceIconGrid';
import WorkspaceIcon from '../launcher/WorkspaceIcon';
import RuntimeSelector from '../RuntimeSelector';
import { PermissionModeIcon, PermissionModeMenuContent, type PermissionModeMenuItem } from '../PermissionModeMenu';
import { Popover } from '../ui/Popover';
import type { RuntimeType, RuntimeDetections, RuntimeConfig } from '../../../shared/types/runtime';
import { getRuntimePermissionModes, isAgentRuntimeSelectorAvailable, resolveEffectiveRuntime } from '../../../shared/types/runtime';
import { agentUsesManagedCodexProvider, toProviderExecutionIntent } from '../../../shared/providerExecution';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '@/components/Toast';
import { useBrowserResourceReady } from '@/hooks/useBrowserResourceReady';
import { MANAGED_BROWSER_MCP_ID } from '@/../shared/browserTools';
import {
  isProviderModelCompatibleWithRuntime,
  projectProvidersForRuntime,
} from '@/utils/runtimeProviderProjection';

interface WorkspaceBasicsSectionProps {
  project: Project | undefined;
  agent: AgentConfig | undefined;
  agentDir: string;
}

function permissionText(mode: string | null | undefined, t: TFunction<'settings'>): PermissionModeMenuItem {
  const value = mode === 'fullAgency' || mode === 'auto' || mode === 'plan' ? mode : 'plan';
  const icon = PERMISSION_MODES.find(item => item.value === value)?.icon;
  return {
    value,
    icon,
    label: t(`agentSettings.permission.${value}`),
    description: t(`agentSettings.permission.${value}Description`),
  };
}

export default function WorkspaceBasicsSection({ project, agent, agentDir }: WorkspaceBasicsSectionProps) {
  const { t } = useTranslation('settings');
  const { t: tChat } = useTranslation('chat');
  const { config, providers, apiKeys, providerVerifyStatus, patchProject, refreshConfig } = useConfig();
  // Only credentialed providers — the picker must not expose a provider
  // the user can't actually use, and must match the Chat model switcher's
  // "available" set (see useAvailableProviders for rationale).
  const credentialedProviders = useAvailableProviders();
  const toast = useToast();
  const managedBrowserReady = useBrowserResourceReady();
  // Derive canonical name from project — use as initializer key to reset input
  const canonicalName = useMemo(
    () => project?.displayName || project?.name || '',
    [project?.displayName, project?.name],
  );
  const [name, setName] = useState(canonicalName);
  const [openPopup, setOpenPopup] = useState<'icon' | 'model' | 'effort' | 'permission' | 'mcp' | 'plugins' | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [globalEnabledMcp, setGlobalEnabledMcp] = useState<string[]>([]);
  const isMountedRef = useRef(true);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const permissionButtonRef = useRef<HTMLButtonElement>(null);
  const effortButtonRef = useRef<HTMLButtonElement>(null);
  const toolsButtonRef = useRef<HTMLButtonElement>(null);

  // Runtime detection (v0.1.59)
  const [runtimeDetections, setRuntimeDetections] = useState<RuntimeDetections>({
    'builtin': { installed: true },
    'dsh': { installed: false },
    'claude-code': { installed: false },
    'codex': { installed: false },
  });
  // Unset Agents follow the root default; explicit choices remain authoritative.
  const agentRuntimeConfig = agent?.runtimeConfig as RuntimeConfig | undefined;
  const currentRuntime: RuntimeType = resolveEffectiveRuntime(
    agent?.runtime,
    agent?.runtimePreference,
    agent?.runtimeConfig?.source,
    agent?.providerId,
    undefined,
    config.defaultIntegratedRuntime,
  );
  const runtimeSelectorAvailable = isAgentRuntimeSelectorAvailable();
  const usesManagedCodexProvider = currentRuntime === 'builtin'
    && agentUsesManagedCodexProvider(agent);
  const usesExternalCliConfiguration = currentRuntime !== 'builtin' && currentRuntime !== 'dsh';
  const usesProductConfiguration = !usesExternalCliConfiguration;
  const availableProviders = useMemo(
    () => projectProvidersForRuntime(credentialedProviders, currentRuntime),
    [credentialedProviders, currentRuntime],
  );

  // Sync name when canonical name changes externally
  useEffect(() => {
    setName(canonicalName);
  }, [canonicalName]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Detect installed runtimes (v0.1.59)
  useEffect(() => {
    void (async () => {
      try {
        const detections = await invoke<Record<string, { installed: boolean; version?: string; path?: string }>>('cmd_detect_runtimes');
        if (isMountedRef.current) {
          setRuntimeDetections(detections as RuntimeDetections);
        }
      } catch (err) {
        console.warn('[runtime] Failed to detect runtimes:', err);
      }
    })();
  }, []);

  const handleRuntimeChange = useCallback(async (runtime: RuntimeType) => {
    if (!agent) return;
    try {
      // buildRuntimeChangePatch scrubs cross-runtime non-portable fields
      // (model / permissionMode / additionalArgs) — see its doc in
      // shared/types/runtime.ts. Keep all 4 runtime-change callsites
      // funneling through this single helper.
      await patchAgentConfig(agent.id, { runtime });
      refreshConfig();
      const label = runtime === 'claude-code' ? 'Claude Code'
        : runtime === 'dsh' ? 'DSH'
        : runtime === 'codex' ? 'Codex'
        : APP_DISPLAY_NAME;
      toast.success(t('agentSettings.basics.runtimeChanged', { label }));
    } catch (err) {
      console.error('[runtime] Failed to save runtime:', err);
    }
  }, [agent, refreshConfig, t, toast]);

  // Load globally available MCP servers
  useEffect(() => {
    void (async () => {
      const [servers, enabled] = await Promise.all([
        getAllMcpServers(),
        getEnabledMcpServerIds(),
      ]);
      if (isMountedRef.current) {
        setMcpServers(servers);
        setGlobalEnabledMcp(enabled);
      }
    })();
  }, []);

  const availableMcpServers = mcpServers.filter(s => globalEnabledMcp.includes(s.id));

  // Save workspace metadata (name, icon) to Project + AgentConfig
  const saveProjectMeta = useCallback(async (updates: Partial<Pick<Project, 'displayName' | 'icon'>>) => {
    if (!project) return;
    const agentPatch: Partial<Omit<AgentConfig, 'id'>> = {};
    if (updates.displayName !== undefined) agentPatch.name = updates.displayName || project.name;
    if (updates.icon !== undefined) agentPatch.icon = updates.icon;
    if (agent && Object.keys(agentPatch).length > 0) {
      await patchAgentProjectConfig(agent.id, agentPatch, project.id, updates);
    } else {
      await patchProject(project.id, updates);
    }
    await refreshConfig();
  }, [project, agent, patchProject, refreshConfig]);

  // Save AI config (model, provider, permission, mcp, plugins).
  // AgentConfig is the single source of truth when available; fallback to Project for non-agent workspaces.
  const saveAgentConfig = useCallback(async (updates: AgentConfigMutation) => {
    const projectSync: Partial<Omit<Project, 'id'>> = {};
    if (updates.providerId !== undefined) projectSync.providerId = updates.providerId;
    if (updates.model !== undefined) projectSync.model = updates.model;
    if (updates.permissionMode !== undefined) {
      projectSync.permissionMode = updates.permissionMode as Project['permissionMode'];
    }
    if (updates.mcpEnabledServers !== undefined) projectSync.mcpEnabledServers = updates.mcpEnabledServers;
    if (updates.enabledPluginIds !== undefined) projectSync.enabledPluginIds = updates.enabledPluginIds;
    if (agent && project && Object.keys(projectSync).length > 0) {
      await patchAgentProjectConfig(agent.id, updates, project.id, projectSync);
    } else {
      if (agent) await patchAgentConfig(agent.id, updates);
      if (project && Object.keys(projectSync).length > 0) await patchProject(project.id, projectSync);
    }
    await refreshConfig();
  }, [agent, project, patchProject, refreshConfig]);

  const handleNameBlur = useCallback(() => {
    const trimmed = name.trim();
    const currentName = project?.displayName || project?.name || '';
    if (trimmed && trimmed !== currentName) {
      void saveProjectMeta({ displayName: trimmed });
    }
  }, [name, project, saveProjectMeta]);

  const handleIconSelect = useCallback((iconId: string) => {
    void saveProjectMeta({ icon: iconId || undefined });
    setOpenPopup(null);
  }, [saveProjectMeta]);

  const handleModelSelect = useCallback((providerId: string, model: string) => {
    const provider = availableProviders.find(p => p.id === providerId) ?? providers.find(p => p.id === providerId);
    if (!provider) return;
    const intent = toProviderExecutionIntent(provider, model);
    if (intent.kind === 'runtime-backed-provider') {
      const effort = reasoningEffortAfterModelChange(agent?.runtimeConfig?.reasoningEffort as string | undefined, provider.models?.find(item => item.model === model));
      if (effort === 'default' && agent?.runtimeConfig?.reasoningEffort && agent.runtimeConfig.reasoningEffort !== 'default') toast.info(tChat('input.reasoningModelReset'));
      void saveAgentConfig({ runtimeBackedProviderSelection: intent, reasoningEffort: effort });
    } else {
      void saveAgentConfig({ providerId, model });
    }
    setOpenPopup(null);
  }, [agent?.runtimeConfig, availableProviders, providers, saveAgentConfig, toast, tChat]);

  const handlePermissionSelect = useCallback((mode: string) => {
    void saveAgentConfig({ permissionMode: mode as AgentConfig['permissionMode'] });
    setOpenPopup(null);
  }, [saveAgentConfig]);

  // #324 — Product-configured runtimes persist effort on AgentConfig.
  const handleEffortSelect = useCallback((effort: string) => {
    void saveAgentConfig(usesManagedCodexProvider
      ? { runtimeConfigPatch: { reasoningEffort: effort } }
      : { reasoningEffort: effort });
    setOpenPopup(null);
  }, [saveAgentConfig, usesManagedCodexProvider]);

  const handleMcpToggle = useCallback((serverId: string) => {
    const current = agent?.mcpEnabledServers || [];
    const enabled = !current.includes(serverId);
    if (serverId === MANAGED_BROWSER_MCP_ID && enabled && !managedBrowserReady) {
      toast.warning(t('toolbox.browserResource.installFirst'));
      return;
    }
    const newEnabled = applyBuiltinBrowserExecutionToolToggle(
      current,
      serverId,
      enabled,
      managedBrowserReady,
    );
    void saveAgentConfig({ mcpEnabledServers: newEnabled });
  }, [agent?.mcpEnabledServers, managedBrowserReady, saveAgentConfig, t, toast]);

  // PRD 0.2.17 — Claude plugin enable list. Same two-layer model as MCP:
  // candidate pool = AppConfig.plugins ∩ enabledPlugins (Layer 1 visibility
  // gate from Settings); per-Agent enable list is the subset chosen here.
  const visiblePlugins = useMemo(
    () => (config.plugins ?? []).filter(p => config.enabledPlugins?.[p.id] === true),
    [config.plugins, config.enabledPlugins],
  );
  const effectiveEnabledPlugins = agent?.enabledPluginIds ?? project?.enabledPluginIds;
  const enabledPluginNames = visiblePlugins
    .filter(p => effectiveEnabledPlugins?.includes(p.id))
    .map(p => p.name);
  const pluginSummary = enabledPluginNames.length === 0
    ? t('agentSettings.basics.noPluginsSummary')
    : enabledPluginNames.length <= 2
      ? enabledPluginNames.join(' / ')
      : `${enabledPluginNames.slice(0, 2).join(' / ')} +${enabledPluginNames.length - 2}`;

  const handlePluginToggle = useCallback((pluginId: string) => {
    const current = agent?.enabledPluginIds ?? project?.enabledPluginIds ?? [];
    const newEnabled = current.includes(pluginId)
      ? current.filter(id => id !== pluginId)
      : [...current, pluginId];
    void saveAgentConfig({ enabledPluginIds: newEnabled });
  }, [agent?.enabledPluginIds, project?.enabledPluginIds, saveAgentConfig]);

  // Derived display values — read from AgentConfig (source of truth), fallback to Project.
  //
  // The summary label shows the PERSISTED provider, not an availability-
  // resolved fallback: if a saved providerId no longer has credentials
  // (e.g. user removed the API key), we still display that name so the
  // closed button matches what's on disk. The picker popup below surfaces
  // only available providers — so the user can see "oh, this is stale"
  // and pick something valid — and we annotate the summary with a small
  // "⚠ 暂不可用" hint when the saved provider fails `isProviderAvailable`.
  // This is cheaper than an automatic rewrite and keeps persistence as
  // the single source of truth for what was actually saved.
  const effectiveProviderId = agent?.providerId ?? project?.providerId;
  const effectiveModel = agent?.model ?? project?.model;
  const selectedProvider = providers.find(p => p.id === effectiveProviderId);
  const isSelectedProviderAvailable = selectedProvider
    ? isProviderAvailable(selectedProvider, apiKeys, providerVerifyStatus)
      && isProviderModelCompatibleWithRuntime(
        currentRuntime,
        selectedProvider,
        effectiveModel ?? selectedProvider.primaryModel,
      )
    : true;
  const modelName = effectiveModel
    ? (selectedProvider?.models?.find(m => m.model === effectiveModel)?.modelName || effectiveModel)
    : (selectedProvider?.primaryModel || t('agentSettings.basics.notSet'));
  const providerName = selectedProvider?.name || t('agentSettings.basics.defaultProvider');

  const openProviderSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
      detail: { section: 'providers' },
    }));
    setOpenPopup(null);
  }, []);

  const effectivePermissionMode = agent?.permissionMode ?? project?.permissionMode;
  const permissionModeChoices = currentRuntime === 'dsh'
    ? getRuntimePermissionModes('dsh').map(mode => ({
        ...mode,
        label: tChat(`input.permissionModes.${mode.value}.label`, { defaultValue: mode.label }),
        description: tChat(`input.permissionModes.${mode.value}.description`, { defaultValue: mode.description }),
      }))
    : PERMISSION_MODES.map(mode => permissionText(mode.value, t));
  const permissionMode = permissionModeChoices.find(mode => mode.value === effectivePermissionMode)
    ?? permissionModeChoices[0]!;

  // #324 — agent-level 推理强度 default (builtin; no project fallback — the
  // agent is the only storage for this field).
  const effectiveReasoningEffort = (usesManagedCodexProvider ? agentRuntimeConfig?.reasoningEffort : agent?.reasoningEffort) ?? 'default';
  const effortModel = selectedProvider?.models?.find(model => model.model === (effectiveModel ?? selectedProvider.primaryModel));
  const defaultEffortLabel = usesManagedCodexProvider && effortModel?.defaultReasoningEffort
    ? `${t('agentSettings.basics.defaultValue')} (${effortModel.defaultReasoningEffort})`
    : t('agentSettings.basics.defaultValue');
  const effectiveReasoningEffortChoices = usesManagedCodexProvider
    ? effortModel?.supportedReasoningEfforts?.map(option => option.reasoningEffort) ?? []
    : reasoningEffortChoices(
    currentRuntime,
    selectedProvider?.apiProtocol,
    selectedProvider?.id,
    effectiveModel ?? undefined,
    selectedProvider?.config.baseUrl,
  );
  const visibleReasoningEffortChoices = currentRuntime === 'dsh'
    ? (effectiveReasoningEffortChoices ?? [])
    : effectiveReasoningEffortChoices;

  const effectiveMcpServers = agent?.mcpEnabledServers ?? project?.mcpEnabledServers;
  const enabledMcpNames = availableMcpServers
    .filter(s => effectiveMcpServers?.includes(s.id))
    .map(s => s.name);
  const mcpSummary = enabledMcpNames.length === 0
    ? t('agentSettings.basics.noToolsSummary')
    : enabledMcpNames.length <= 2
      ? enabledMcpNames.join(' / ')
      : `${enabledMcpNames.slice(0, 2).join(' / ')} +${enabledMcpNames.length - 2}`;

  if (!project) {
    return <p className="text-sm text-[var(--ink-subtle)]">{t('agentSettings.general.missingWorkspace')}</p>;
  }

  return (
    <div className="space-y-3">
      {/* Name + Icon — single row: [label] [icon] [input] */}
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.name')}</label>
        <button
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
            openPopup === 'icon'
              ? 'border-[var(--accent)] bg-[var(--accent-warm-muted)]'
              : 'border-[var(--line)] hover:border-[var(--line-strong)]'
          }`}
          onClick={() => setOpenPopup(openPopup === 'icon' ? null : 'icon')}
          title={t('agentSettings.basics.chooseIcon')}
        >
          <WorkspaceIcon icon={project.icon || DEFAULT_WORKSPACE_ICON} size={22} />
        </button>
        <input
          className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent)] focus:outline-none"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={e => { if (isImeComposingEvent(e)) return; if (e.key === 'Enter') e.currentTarget.blur(); }}
          placeholder={t('agentSettings.basics.workspaceNamePlaceholder')}
        />

        {openPopup === 'icon' && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpenPopup(null); }} />
            <div className={`absolute left-20 top-10 z-50 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-lg ${WORKSPACE_ICON_GRID_PANEL_CLASS}`}>
              <WorkspaceIconGrid value={project.icon} onSelect={handleIconSelect} />
            </div>
          </>
        )}
      </div>

      {/* Workspace path — read-only */}
      <div className="flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.workspace')}</label>
        <span className="flex-1 truncate rounded-lg px-3 py-1.5 text-sm text-[var(--ink-subtle)]" title={agentDir}>
          {agentDir}
        </span>
      </div>

      {/* Runtime (v0.1.59) — only visible when multi-agent runtime is enabled in developer settings */}
      {runtimeSelectorAvailable && (
        <>
          <div className="flex items-center gap-3">
            <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.runtime')}</label>
            <div className="min-w-0 flex-1">
              <RuntimeSelector
                value={currentRuntime}
                detections={runtimeDetections}
                onChange={handleRuntimeChange}
                variant="panel"
              />
            </div>
          </div>

          {/* External CLI runtime notice */}
          {usesExternalCliConfiguration && (() => {
            const runtimeLabel = currentRuntime === 'claude-code' ? 'Claude Code'
              : currentRuntime === 'codex' ? 'Codex'
              : currentRuntime;
            return (
              <p className="rounded-lg bg-[var(--accent-warm-subtle)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--ink-muted)]">
                {t('agentSettings.basics.externalRuntimeNotice', { runtime: runtimeLabel })}
              </p>
            );
          })()}

          {/* Issue #194 — proxy policy for external runtime subprocess.
              Only relevant when the agent runs an external CLI (Codex / CC),
              so hidden for builtin. */}
          {usesExternalCliConfiguration && agent && (() => {
            // Read current policy; default to 'myagents' for backwards compat.
            // runtimeConfig is on AgentConfig as a free-form record — keep the
            // narrow `as` cast so we don't expand its public schema unnecessarily.
            // Legacy disk values (the removed `'direct'` from 0.2.16 dev) fall
            // through the literal narrowing and read as default `'myagents'`,
            // matching the server-side `resolveAgentEnvPolicy` validator.
            const rc = (agent.runtimeConfig as Record<string, unknown> | undefined) ?? {};
            const rawPolicy = (rc.envPolicy as { proxy?: unknown } | undefined)?.proxy;
            const proxyMode: 'myagents' | 'terminal' =
              rawPolicy === 'terminal' ? 'terminal' : 'myagents';

            const onSelect = (next: 'myagents' | 'terminal') => {
              void patchAgentConfig(agent.id, { runtimeConfigPatch: { envPolicy: { proxy: next } } });
            };

            const radio = (
              value: 'myagents' | 'terminal',
              label: string,
              hint: string,
            ) => (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed transition-colors ${
                  proxyMode === value
                    ? 'border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]'
                    : 'border-[var(--line)] hover:border-[var(--line-strong)]'
                }`}
              >
                <input
                  type="radio"
                  name={`proxy-policy-${agent.id}`}
                  value={value}
                  checked={proxyMode === value}
                  onChange={() => onSelect(value)}
                  className="mt-0.5 shrink-0"
                />
                <div className="min-w-0">
                  <div className="font-medium text-[var(--ink)]">{label}</div>
                  <div className="text-[var(--ink-muted)]">{hint}</div>
                </div>
              </label>
            );

            return (
              <div className="flex items-start gap-3">
                <label className="w-16 shrink-0 pt-2 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.networkProxy')}</label>
                <div className="flex-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {radio('myagents', t('agentSettings.basics.proxyMyAgents'), t('agentSettings.basics.proxyMyAgentsHint'))}
                  {radio('terminal', t('agentSettings.basics.proxyTerminal'), t('agentSettings.basics.proxyTerminalHint'))}
                </div>
              </div>
            );
          })()}
        </>
      )}

      {/* Product provider/model configuration is shared by Builtin and DSH. */}
      {usesProductConfiguration && (
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.model')}</label>
        <button
          ref={modelButtonRef}
          aria-expanded={openPopup === 'model'}
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'model' ? null : 'model')}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{providerName} / {modelName}</span>
            {!isSelectedProviderAvailable && selectedProvider && (
              // Saved provider lost credentials — warn the user inline so
              // they don't hit a runtime error when a message fires.
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-[var(--warning)]"
                title={t('agentSettings.basics.providerUnavailableTitle')}
              >
                ⚠ {t('agentSettings.basics.unavailable')}
              </span>
            )}
          </span>
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        <Popover
          open={openPopup === 'model'}
          onClose={() => setOpenPopup(null)}
          anchorRef={modelButtonRef}
          placement="bottom-start"
          className="max-h-[300px] w-[320px] overflow-y-auto overscroll-contain rounded-xl p-2"
        >
          {availableProviders.length === 0 ? (
            <div className="px-3 py-3">
              <p className="mb-2 text-xs leading-relaxed text-[var(--ink-muted)]">
                {t('agentSettings.basics.noProviders')}
              </p>
              <button
                type="button"
                onClick={openProviderSettings}
                className="text-xs font-medium text-[var(--accent-warm)] hover:underline"
              >
                {t('agentSettings.basics.openProviderSettings')}
              </button>
            </div>
          ) : (
            availableProviders.map(provider => (
              <div key={provider.id} className="mb-1">
                <div className="px-2 py-1 text-xs font-medium text-[var(--ink-muted)]">{provider.name}</div>
                {provider.models?.map(model => (
                  <button
                    key={`${provider.id}:${model.model}`}
                    className={`flex w-full items-center rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                      effectiveProviderId === provider.id && effectiveModel === model.model
                        ? 'bg-[var(--accent-warm-muted)] text-[var(--accent-warm)]'
                        : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                    }`}
                    onClick={() => handleModelSelect(provider.id, model.model)}
                  >
                    {model.modelName}
                  </button>
                ))}
              </div>
            ))
          )}
        </Popover>
      </div>
      )}

      {/* Product permission configuration is shared by Builtin and DSH. */}
      {usesProductConfiguration && (
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.permission')}</label>
        <button
          ref={permissionButtonRef}
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'permission' ? null : 'permission')}
        >
          <span className="flex items-center gap-1.5">
            <PermissionModeIcon
              value={permissionMode.value}
              fallback={permissionMode.icon}
              className="h-4 w-4 shrink-0"
            />
            {permissionMode.label}
          </span>
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        <Popover
          open={openPopup === 'permission'}
          onClose={() => setOpenPopup(null)}
          anchorRef={permissionButtonRef}
          placement="bottom-start"
          className="composer-toolbar-menu-enter w-72 py-1"
        >
          <PermissionModeMenuContent
            items={permissionModeChoices}
            selectedValue={permissionMode.value}
            header={tChat('input.permissionModeHeader')}
            onSelect={handlePermissionSelect}
          />
        </Popover>
      </div>
      )}

      {/* #324 推理强度 — hidden only for external CLI runtimes. */}
      {usesProductConfiguration && visibleReasoningEffortChoices !== null && (
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.reasoningEffort')}</label>
        <button
          ref={effortButtonRef}
          aria-expanded={openPopup === 'effort'}
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'effort' ? null : 'effort')}
        >
          <span>{effectiveReasoningEffort === 'default' ? defaultEffortLabel : effectiveReasoningEffort}</span>
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        <Popover
          open={openPopup === 'effort'}
          onClose={() => setOpenPopup(null)}
          anchorRef={effortButtonRef}
          placement="bottom-start"
          className="max-h-[300px] w-[280px] overflow-y-auto overscroll-contain rounded-xl p-2"
        >
          {['default', ...(visibleReasoningEffortChoices ?? [])].map(level => (
            <button
              key={level}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${
                effectiveReasoningEffort === level
                  ? 'bg-[var(--accent-warm-muted)] text-[var(--accent-warm)]'
                  : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
              }`}
              onClick={() => handleEffortSelect(level)}
            >
              <span className="shrink-0 text-sm font-medium">{level === 'default' ? defaultEffortLabel : level}</span>
              <span title={usesManagedCodexProvider ? effortModel?.supportedReasoningEfforts?.find(option => option.reasoningEffort === level)?.description : undefined} className="ml-3 min-w-0 truncate text-xs text-[var(--ink-muted)]">
                {usesManagedCodexProvider ? effortModel?.supportedReasoningEfforts?.find(option => option.reasoningEffort === level)?.description ?? '' : t(`agentSettings.reasoning.descriptions.${level}`, {
                  defaultValue: REASONING_EFFORT_DESCRIPTIONS[level] ?? '',
                })}
              </span>
            </button>
          ))}
          <div className="mt-1 whitespace-nowrap border-t border-[var(--line)] px-3 pb-1 pt-2 text-xs text-[var(--ink-muted)]/60">
            {t('agentSettings.basics.reasoningSupportHint')}
          </div>
        </Popover>
      </div>
      )}

      {/* Product MCP selection is shared by Builtin and DSH. */}
      {usesProductConfiguration && (
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.tools')}</label>
        <button
          ref={toolsButtonRef}
          aria-expanded={openPopup === 'mcp'}
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'mcp' ? null : 'mcp')}
        >
          <span className="truncate">{mcpSummary}</span>
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        <Popover
          open={openPopup === 'mcp'}
          onClose={() => setOpenPopup(null)}
          anchorRef={toolsButtonRef}
          placement="bottom-start"
          className="max-h-[300px] w-[320px] overflow-y-auto overscroll-contain rounded-xl p-2"
        >
          {availableMcpServers.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[var(--ink-subtle)]">
              {t('agentSettings.basics.noGlobalTools')}
            </p>
          ) : (
            availableMcpServers.map(server => {
              const checked = effectiveMcpServers?.includes(server.id) ?? false;
              return (
                <label
                  key={server.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[var(--hover-bg)]"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => handleMcpToggle(server.id)}
                    className="h-4 w-4 rounded border-[var(--line)]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-[var(--ink)]">{server.name}</p>
                    {server.description && (
                      <p className="truncate text-xs text-[var(--ink-muted)]">{server.description}</p>
                    )}
                  </div>
                </label>
              );
            })
          )}
        </Popover>
      </div>
      )}

      {/* Plugins (PRD 0.2.17) — same shape as MCP row above. Hidden for
       *  external CLI runtimes (CC/Codex manage their own plugins).
       *  Renders nothing when no plugin is globally visible — avoids an
       *  empty "未启用插件" row for users who haven't installed any. */}
      {usesProductConfiguration && visiblePlugins.length > 0 && (
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.plugins')}</label>
        <button
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'plugins' ? null : 'plugins')}
        >
          <span className="truncate">{pluginSummary}</span>
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        {openPopup === 'plugins' && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpenPopup(null); }} />
            <div className="absolute left-20 top-0 z-50 max-h-[300px] w-[320px] overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-lg">
              {visiblePlugins.map(plugin => {
                const checked = effectiveEnabledPlugins?.includes(plugin.id) ?? false;
                return (
                  <label
                    key={plugin.id}
                    className="flex cursor-pointer items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[var(--hover-bg)]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handlePluginToggle(plugin.id)}
                      className="h-4 w-4 rounded border-[var(--line)]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-[var(--ink)]">{plugin.name}</p>
                      {plugin.description && (
                        <p className="truncate text-xs text-[var(--ink-muted)]">{plugin.description}</p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}
