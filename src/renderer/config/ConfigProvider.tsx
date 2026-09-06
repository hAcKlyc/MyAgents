// ConfigProvider — single source of truth for app config state
// Dual Context pattern: data (changes often) vs actions (stable references)
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    type AppConfig,
    DEFAULT_CONFIG,
    type ModelEntity,
    type Project,
    type WorkspaceTemplateAgentDefaults,
    type WorkspaceTemplateSource,
    type ModelAliases,
    type Provider,
    type ProviderVerifyStatus,
    type ManagedCodexAuthState,
    type ManagedCodexRuntimeInstallState,
    type ProxySettings,
    PRESET_PROVIDERS,
    PROXY_DEFAULTS,
    MANAGED_CODEX_REQUIRED_RUNTIME,
    applyManagedCodexProviderReadiness,
    applyProviderEnablementAndOrder,
    getManagedCodexProviderReadiness,
    shouldAutoUpdateManagedCodexRuntime,
    withManagedCodexProviderCatalog,
} from './types';
import type { RuntimeModelInfo } from '../../shared/types/runtime';
import type { TokenDanceAuthView } from '../../shared/tokendance';
import type { AgentConfig } from '../../shared/types/agent';
import { apiGetJson } from '@/api/apiFetch';
import {
    loadAppConfig,
    atomicModifyConfig,
    ensureBundledWorkspace,
    ensureManagedCodexProviderDevGateDefault,
    mergePresetCustomModels,
} from './services/appConfigService';
import {
    getAllProviders,
    saveApiKey as saveApiKeyService,
    deleteApiKey as deleteApiKeyService,
    saveProviderVerifyStatus as saveProviderVerifyStatusService,
    saveCustomProvider as saveCustomProviderService,
    atomicModifyCustomProvider,
    deleteCustomProvider as deleteCustomProviderService,
    rebuildAndPersistAvailableProviders,
} from './services/providerService';
import {
    enrichExistingModelsFromDiscovery,
    type DiscoveredModel,
} from './services/modelDiscoveryService';
import {
    loadProjects,
    saveProjects,
    addProject as addProjectService,
    updateProject as updateProjectService,
    patchProject as patchProjectService,
    removeOrHideProject as removeOrHideProjectService,
    touchProject as touchProjectService,
} from './services/projectService';
import {
    configureMemoryAutoUpdateTaskForAgent,
    configureMemoryEvolutionTasksForAgent,
    migrateImBotConfigsToAgents,
    persistAgents,
    reconcilePersistedAgentWorkspaceIdentities,
    reconcilePersistedAgentWorkspaceIdentitiesLocked,
} from './services/agentConfigService';
import { isLockBusyError, withAgentConfigIntentLock, withProjectsLock } from './services/configStore';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { resolveAgentWorkspaceProjections } from '../../shared/agentWorkspaceIdentity';
import { normalizeUiLanguage, type SupportedLocale, type UiLanguage } from '../../shared/i18n';
import {
    effectiveGeneralProxyScopeKey,
    removeProviderFromProxySettingsScope,
} from '../../shared/proxyScope';

interface ManagedCodexStatusResult {
    runtimeInstall: ManagedCodexRuntimeInstallState;
    auth: ManagedCodexAuthState;
}

interface ConfigDiskSnapshot {
    config: AppConfig;
    projects: Project[];
    providers: Provider[];
    apiKeys: Record<string, string>;
    verifyStatus: Record<string, ProviderVerifyStatus>;
}

async function loadConfigDiskSnapshot(): Promise<ConfigDiskSnapshot> {
    // config.json is the authority for provider gates, credentials, and
    // verification. Read it once, then derive every provider-facing state
    // slice from that same snapshot so a refresh cannot mix generations.
    const config = await loadAppConfig();
    const [projects, providers] = await Promise.all([
        loadProjects(),
        getAllProviders(config),
    ]);
    return {
        config,
        projects,
        providers,
        apiKeys: config.providerApiKeys ?? {},
        verifyStatus: config.providerVerifyStatus ?? {},
    };
}

const STARTUP_MAINTENANCE_RETRY_MS = 30_000;

// Main-window process scope: an App launch may make at most one background
// update attempt even if React remounts ConfigProvider. A real App relaunch
// reloads this module and re-arms the attempt. The in-flight request lives at
// the same scope so startup and Settings keep one download owner across remounts.
let managedCodexStartupUpdateEvaluated = false;
let managedCodexRuntimeUpdateRequest: Promise<ManagedCodexStatusResult> | null = null;

/**
 * Normalize agents loaded from disk: ensure every agent has a `channels` array.
 * External tools (e.g., AI bots editing config.json) may produce agents without
 * the `channels` field, which would crash downstream iteration.
 * Returns true if any agent was repaired (caller should persist).
 */
function normalizeAgents(config: AppConfig): boolean {
    if (!config.agents) return false;
    let repaired = false;
    for (const agent of config.agents) {
        if (!Array.isArray(agent.channels)) {
            agent.channels = [];
            repaired = true;
        }
    }
    return repaired;
}

/**
 * Migrate old hardcoded openclawEnabledToolGroups to the full set.
 * Before v0.1.56, ChannelWizard wrote a fixed subset ['doc','chat','wiki_drive','bitable']
 * which silently hid calendar/task/sheet/search/common/im tools.
 * Expand to all known groups so everything is enabled.
 */
const LEGACY_TOOL_GROUPS = new Set(['doc', 'chat', 'wiki_drive', 'bitable']);
// Exclude sensitive groups (im, perm) from auto-migration — keep them opt-in
const ALL_KNOWN_TOOL_GROUPS = ['doc', 'chat', 'wiki_drive', 'bitable', 'calendar', 'task', 'sheet', 'search', 'common'];
function migrateToolGroups(config: AppConfig): boolean {
    if (!config.agents) return false;
    let changed = false;
    for (const agent of config.agents) {
        for (const ch of (agent.channels ?? [])) {
            const groups = ch.openclawEnabledToolGroups;
            if (!groups || groups.length === 0) continue;
            // Only expand if it's the exact old default (user didn't customize)
            if (groups.length === LEGACY_TOOL_GROUPS.size && groups.every(g => LEGACY_TOOL_GROUPS.has(g))) {
                ch.openclawEnabledToolGroups = [...ALL_KNOWN_TOOL_GROUPS];
                changed = true;
            }
        }
    }
    if (changed) {
        console.log('[ConfigProvider] Migrated legacy openclawEnabledToolGroups → all groups enabled');
    }
    return changed;
}

async function reconcileMemoryEvolutionTasks(
    agents: readonly AgentConfig[] | undefined,
    projects: readonly Project[],
): Promise<void> {
    if (!isTauriEnvironment()) return;
    if (!agents?.length) return;

    const projections = resolveAgentWorkspaceProjections(projects, agents).agentProjections;
    for (const projection of projections) {
        const agent = projection.agent;
        if (!agent.memoryEvolution) continue;
        const project = projection.project;
        if (!project) continue;
        try {
            await configureMemoryEvolutionTasksForAgent(
                agent,
                project.id,
                projection.workspacePath,
                agent.memoryEvolution.enabled,
            );
        } catch (err) {
            console.warn(
                `[ConfigProvider] Memory evolution task reconcile failed for agent ${agent.id}:`,
                err,
            );
        }
    }
}

async function reconcileMemoryAutoUpdateTasks(
    agents: readonly AgentConfig[] | undefined,
    projects: readonly Project[],
): Promise<void> {
    if (!isTauriEnvironment()) return;
    if (!agents?.length) return;

    const projections = resolveAgentWorkspaceProjections(projects, agents).agentProjections;
    for (const projection of projections) {
        const agent = projection.agent;
        if (!agent.memoryAutoUpdate) continue;
        try {
            await configureMemoryAutoUpdateTaskForAgent(agent, projection.workspacePath);
        } catch (err) {
            console.warn(
                `[ConfigProvider] Memory auto-update task reconcile failed for agent ${agent.id}:`,
                err,
            );
        }
    }
}

// ============= Context Types =============

export interface ConfigDataValue {
    config: AppConfig;
    projects: Project[];
    providers: Provider[];
    apiKeys: Record<string, string>;
    providerVerifyStatus: Record<string, ProviderVerifyStatus>;
    isLoading: boolean;
    error: string | null;
    managedCodexRuntimeUpdateInFlight: boolean;
}

export interface ConfigActionsValue {
    updateConfig: (updates: Partial<AppConfig>) => Promise<void>;
    /** Merge-aware proxy update — see ConfigProvider for the lost-update rationale (#230). */
    patchProxySettings: (partial: Partial<ProxySettings>) => Promise<void>;
    refreshConfig: () => Promise<void>;
    reload: () => Promise<void>;
    refreshProviderData: () => Promise<void>;
    requestManagedCodexRuntimeUpdate: () => Promise<void>;
    // Projects
    addProject: (path: string, options?: AddProjectOptions) => Promise<Project>;
    updateProject: (project: Project) => Promise<void>;
    patchProject: (projectId: string, updates: Partial<Omit<Project, 'id'>>) => Promise<void>;
    removeProject: (projectId: string) => Promise<void>;
    touchProject: (projectId: string) => Promise<void>;
    // Providers
    addCustomProvider: (provider: Provider) => Promise<void>;
    updateCustomProvider: (provider: Provider, discoveredModels?: DiscoveredModel[]) => Promise<void>;
    deleteCustomProvider: (providerId: string) => Promise<void>;
    refreshProviders: () => Promise<void>;
    // Preset custom models
    savePresetCustomModels: (providerId: string, models: ModelEntity[]) => Promise<void>;
    removePresetCustomModel: (providerId: string, modelId: string) => Promise<void>;
    // Provider primary model override
    savePrimaryModel: (providerId: string, modelId: string) => Promise<void>;
    // Provider model aliases (SDK sub-agent model mapping)
    saveProviderModelAliases: (providerId: string, aliases: ModelAliases) => Promise<void>;
    // API Keys
    saveApiKey: (providerId: string, apiKey: string) => Promise<void>;
    deleteApiKey: (providerId: string) => Promise<void>;
    // Verify status
    saveProviderVerifyStatus: (
        providerId: string,
        status: 'valid' | 'invalid',
        accountEmail?: string,
        metadata?: Pick<ProviderVerifyStatus, 'invalidReason' | 'error'>,
    ) => Promise<void>;
}

export interface AddProjectOptions {
    icon?: string;
    displayName?: string;
    templateId?: string;
    templateSource?: WorkspaceTemplateSource;
    agentDefaults?: WorkspaceTemplateAgentDefaults;
}

// ============= Contexts =============

export const ConfigDataContext = createContext<ConfigDataValue | null>(null);
export const ConfigActionsContext = createContext<ConfigActionsValue | null>(null);

// ============= Provider Component =============

export function ConfigProvider({ children }: { children: React.ReactNode }) {
    const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
    const [projects, setProjects] = useState<Project[]>([]);
    const [rawProviders, setRawProviders] = useState<Provider[]>(PRESET_PROVIDERS);
    const [managedCodexRuntimeModels, setManagedCodexRuntimeModels] = useState<RuntimeModelInfo[]>([]);
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [providerVerifyStatus, setProviderVerifyStatus] = useState<Record<string, ProviderVerifyStatus>>({});
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [managedCodexRuntimeUpdateInFlight, setManagedCodexRuntimeUpdateInFlight] = useState(
        () => managedCodexRuntimeUpdateRequest !== null,
    );

    // Derived: merge preset custom models + apply user primary model overrides
    const providers = useMemo(() => {
        const catalog = withManagedCodexProviderCatalog(rawProviders, config, managedCodexRuntimeModels);
        const merged = mergePresetCustomModels(catalog, config.presetCustomModels, config.presetRemovedModels);
        const providerOrderSettings = {
            providerOrder: config.providerOrder,
            disabledProviderIds: config.disabledProviderIds,
        };
        const overrides = config.providerPrimaryModels;
        if (!overrides || Object.keys(overrides).length === 0) {
            return applyManagedCodexProviderReadiness(
                applyProviderEnablementAndOrder(merged, providerOrderSettings),
                config,
            );
        }
        // Apply user's primaryModel override directly on the Provider object
        // so ALL consumers see the correct value without needing getEffectivePrimaryModel()
        const withPrimaryOverrides = merged.map(p => {
            const userPrimary = overrides[p.id];
            if (!userPrimary || !p.models?.some(m => m.model === userPrimary)) return p;
            return { ...p, primaryModel: userPrimary };
        });
        return applyManagedCodexProviderReadiness(
            applyProviderEnablementAndOrder(withPrimaryOverrides, providerOrderSettings),
            config,
        );
    }, [
        config,
        rawProviders,
        managedCodexRuntimeModels,
    ]);
    const managedCodexReadiness = useMemo(
        () => getManagedCodexProviderReadiness(config),
        [config],
    );
    const managedCodexShouldAutoUpdate = shouldAutoUpdateManagedCodexRuntime(config);
    const managedCodexModelListKey = useMemo(
        () => [
            managedCodexReadiness.reason,
            config.managedCodexRuntimeInstall?.installedVersion ?? '',
            config.managedCodexRuntimeInstall?.requiredVersion ?? '',
            config.managedCodexAuth?.status ?? '',
            config.managedCodexAuth?.authMethod ?? '',
            config.managedCodexAuth?.verifiedAt ?? '',
        ].join('|'),
        [
            managedCodexReadiness.reason,
            config.managedCodexRuntimeInstall?.installedVersion,
            config.managedCodexRuntimeInstall?.requiredVersion,
            config.managedCodexAuth?.status,
            config.managedCodexAuth?.authMethod,
            config.managedCodexAuth?.verifiedAt,
        ],
    );

    // Mount guard
    const isMountedRef = useRef(true);
    const configRef = useRef<AppConfig>(DEFAULT_CONFIG);
    const diskSnapshotRevisionRef = useRef(0);
    const startupMaintenanceRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startupMaintenanceRetryAttemptedRef = useRef(false);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);
    useEffect(() => {
        configRef.current = config;
    }, [config]);

    // Proxy configuration is app-global, so propagation belongs to the config
    // authority rather than any Settings Tab. This guarantees exactly one
    // side-effect owner even when Settings and Capabilities are both kept
    // mounted to preserve their independent local UI state.
    const previousProxyRef = useRef<{ serialized: string; generalKey: string } | undefined>(undefined);
    useEffect(() => {
        if (isLoading) return;
        const serialized = JSON.stringify(config.proxySettings ?? null);
        const generalKey = effectiveGeneralProxyScopeKey(config.proxySettings);
        if (previousProxyRef.current === undefined) {
            previousProxyRef.current = { serialized, generalKey };
            return;
        }
        if (previousProxyRef.current.serialized === serialized) return;
        const restartGeneralOwners = previousProxyRef.current.generalKey !== generalKey;
        previousProxyRef.current = { serialized, generalKey };

        void import('@tauri-apps/api/core')
            .then(({ invoke }) => invoke('cmd_propagate_proxy', { restartGeneralOwners }))
            .catch((error) => console.error('[ConfigProvider] Proxy propagation failed:', error));
    }, [config.proxySettings, isLoading]);

    const publishConfigDiskSnapshot = useCallback((
        snapshot: ConfigDiskSnapshot,
        snapshotRevision: number,
    ): ConfigDiskSnapshot | null => {
        normalizeAgents(snapshot.config);
        if (!isMountedRef.current || snapshotRevision !== diskSnapshotRevisionRef.current) return null;
        setError(null);
        configRef.current = snapshot.config;
        setConfig(snapshot.config);
        setProjects(snapshot.projects);
        setRawProviders(snapshot.providers);
        setApiKeys(snapshot.apiKeys);
        setProviderVerifyStatus(snapshot.verifyStatus);
        return snapshot;
    }, []);

    const commitReadableConfigDiskSnapshot = useCallback(async (): Promise<ConfigDiskSnapshot | null> => {
        const snapshotRevision = ++diskSnapshotRevisionRef.current;
        const snapshot = await loadConfigDiskSnapshot();
        return publishConfigDiskSnapshot(snapshot, snapshotRevision);
    }, [publishConfigDiskSnapshot]);

    const commitConfigDiskSnapshot = useCallback(async (): Promise<ConfigDiskSnapshot | null> => {
        const snapshotRevision = ++diskSnapshotRevisionRef.current;
        let identity: Awaited<ReturnType<typeof reconcilePersistedAgentWorkspaceIdentities>>;
        try {
            identity = await reconcilePersistedAgentWorkspaceIdentities();
        } catch (error) {
            const healthySnapshot = await loadConfigDiskSnapshot();
            publishConfigDiskSnapshot(healthySnapshot, snapshotRevision);
            throw error;
        }
        const snapshot = await loadConfigDiskSnapshot();
        if (identity.repairDeferred) {
            snapshot.projects = identity.projects;
        }
        return publishConfigDiskSnapshot(snapshot, snapshotRevision);
    }, [publishConfigDiskSnapshot]);

    // Local disk commits share the snapshot revision owner. Advancing it
    // before mirroring the write into React prevents an older in-flight read
    // from overwriting newer local authority.
    const acceptLocalDiskWrite = useCallback((): boolean => {
        diskSnapshotRevisionRef.current += 1;
        return isMountedRef.current;
    }, []);

    // Startup maintenance may write config, but it must never own the
    // availability of an already-readable disk snapshot.
    const runStartupConfigMaintenance = useCallback(async () => {
        await ensureBundledWorkspace();
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const results = await Promise.allSettled([
                invoke('cmd_sync_admin_agent'),
                // Product-owned system Skills —
                // independent version gate (SYSTEM_SKILLS_VERSION in
                // commands.rs). Force-overwrites user copies so the
                // skill contracts always match the shipped CLI.
                invoke('cmd_sync_system_skills'),
            ]);
            for (const r of results) {
                if (r.status === 'rejected') {
                    console.warn('[ConfigProvider] Sync failed:', r.reason);
                }
            }
        } catch (e) {
            console.warn('[ConfigProvider] Agent/system-skills sync failed:', e);
        }

        try {
            await ensureManagedCodexProviderDevGateDefault();
        } catch (e) {
            if (isLockBusyError(e)) throw e;
            console.warn('[ConfigProvider] Managed Codex provider default migration failed:', e);
        }

        let loadedConfig!: AppConfig;
        let loadedProjects!: Project[];
        await withAgentConfigIntentLock(() => withProjectsLock(async () => {
            const rawConfig = await loadAppConfig();
            loadedProjects = await loadProjects();
            const projectsBefore = JSON.stringify(loadedProjects);
            const configBefore = JSON.stringify({
                agents: rawConfig.agents ?? [],
                imBotConfigs: rawConfig.imBotConfigs ?? [],
            });
            loadedConfig = migrateImBotConfigsToAgents(rawConfig, loadedProjects);
            const migrationChanged = configBefore !== JSON.stringify({
                agents: loadedConfig.agents ?? [],
                imBotConfigs: loadedConfig.imBotConfigs ?? [],
            });
            if (!migrationChanged && projectsBefore === JSON.stringify(loadedProjects)) return;

            // Create timestamped backup before persisting migration
            try {
                const { getConfigDir, CONFIG_FILE } = await import('./services/configStore');
                const { copyFile, exists } = await import('@tauri-apps/plugin-fs');
                const { join } = await import('@tauri-apps/api/path');
                const dir = await getConfigDir();
                const configPath = await join(dir, CONFIG_FILE);
                if (await exists(configPath)) {
                    const ts = new Date().toISOString().replace(/[:.]/g, '-');
                    await copyFile(configPath, await join(dir, `config.json.bak.${ts}`));
                }
            } catch (e) {
                console.warn('[ConfigProvider] Migration backup failed:', e);
            }
            // Project.agentId is the birth authority. Commit it before the
            // pathless Agent record; retry reuses the same id.
            if (projectsBefore !== JSON.stringify(loadedProjects)) {
                await saveProjects(loadedProjects);
            }
            if (migrationChanged) {
                loadedConfig = await atomicModifyConfig(current => ({
                    ...current,
                    agents: loadedConfig.agents,
                    imBotConfigs: loadedConfig.imBotConfigs,
                }));
            }
        }));

        const hiddenDefaultProject = loadedConfig.defaultWorkspacePath
            ? loadedProjects.find(p => p.hidden === true && workspacePathsEqual(p.path, loadedConfig.defaultWorkspacePath))
            : undefined;
        if (hiddenDefaultProject) {
            loadedConfig.defaultWorkspacePath = undefined;
            await atomicModifyConfig(c => (
                workspacePathsEqual(c.defaultWorkspacePath, hiddenDefaultProject.path)
                    ? { ...c, defaultWorkspacePath: undefined }
                    : c
            ));
            console.log('[ConfigProvider] Cleared defaultWorkspacePath pointing at hidden workspace');
        }

        // One-time cleanup: remove imBotConfigs entries whose credentials
        // now exist in agents[].channels[] (post-migration duplicates)
        // Re-read from disk in case migration cleared in-memory but didn't persist imBotConfigs
        const diskImBotConfigs = (await loadAppConfig())?.imBotConfigs ?? loadedConfig.imBotConfigs ?? [];
        if (loadedConfig.agents?.length && diskImBotConfigs.length) {
            loadedConfig.imBotConfigs = diskImBotConfigs;
            // Collect all credential fingerprints from agent channels
            const agentCredentials = new Set<string>();
            for (const agent of loadedConfig.agents) {
                for (const ch of (agent.channels ?? [])) {
                    if (ch.feishuAppId) agentCredentials.add(`feishu:${ch.feishuAppId}`);
                    if (ch.botToken) agentCredentials.add(`botToken:${ch.botToken}`);
                    if (ch.dingtalkClientId) agentCredentials.add(`dingtalk:${ch.dingtalkClientId}`);
                    if (ch.openclawPluginConfig?.appId) agentCredentials.add(`openclaw:${ch.openclawPluginConfig.appId}`);
                }
            }

            const remaining = loadedConfig.imBotConfigs.filter(bot => {
                if (bot.feishuAppId && agentCredentials.has(`feishu:${bot.feishuAppId}`)) return false;
                if (bot.botToken && agentCredentials.has(`botToken:${bot.botToken}`)) return false;
                if (bot.dingtalkClientId && agentCredentials.has(`dingtalk:${bot.dingtalkClientId}`)) return false;
                if (bot.openclawPluginConfig?.appId && agentCredentials.has(`openclaw:${bot.openclawPluginConfig.appId}`)) return false;
                return true;
            });

            const removedCount = loadedConfig.imBotConfigs.length - remaining.length;
            if (removedCount > 0) {
                console.log(`[ConfigProvider] Cleaning up ${removedCount} legacy imBotConfigs entry(ies) already migrated to agents`);
                loadedConfig.imBotConfigs = remaining;
                await atomicModifyConfig(c => ({ ...c, imBotConfigs: remaining }));
            }
        }

        await rebuildAndPersistAvailableProviders();

        // Normalize agents and self-heal corrupted config on disk
        if (normalizeAgents(loadedConfig) && loadedConfig.agents) {
            await persistAgents(loadedConfig.agents);
            console.log('[ConfigProvider] Repaired agents with missing channels — persisted to disk');
        }

        // Migrate old hardcoded tool groups → undefined (= all groups enabled)
        if (migrateToolGroups(loadedConfig) && loadedConfig.agents) {
            await persistAgents(loadedConfig.agents);
        }

        const snapshot = await commitConfigDiskSnapshot();
        if (!snapshot) return;
        void reconcileMemoryAutoUpdateTasks(snapshot.config.agents, snapshot.projects);
        void reconcileMemoryEvolutionTasks(snapshot.config.agents, snapshot.projects);
    }, [commitConfigDiskSnapshot]);

    const scheduleStartupMaintenanceRetry = useCallback(() => {
        if (!isMountedRef.current) return;
        if (startupMaintenanceRetryAttemptedRef.current) return;
        if (startupMaintenanceRetryTimerRef.current !== null) return;
        startupMaintenanceRetryTimerRef.current = setTimeout(() => {
            startupMaintenanceRetryTimerRef.current = null;
            if (!isMountedRef.current) return;
            startupMaintenanceRetryAttemptedRef.current = true;
            void runStartupConfigMaintenance().catch((error) => {
                console.warn('[ConfigProvider] Deferred startup config maintenance still unavailable:', error);
            });
        }, STARTUP_MAINTENANCE_RETRY_MS);
    }, [runStartupConfigMaintenance]);

    useEffect(() => () => {
        if (startupMaintenanceRetryTimerRef.current !== null) {
            clearTimeout(startupMaintenanceRetryTimerRef.current);
            startupMaintenanceRetryTimerRef.current = null;
        }
    }, []);

    // ============= Load All Data =============

    const load = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const snapshot = await commitReadableConfigDiskSnapshot();
            if (!snapshot && !isMountedRef.current) return;
        } catch (err) {
            console.error('Failed to load config:', err);
            if (isMountedRef.current) {
                setError(err instanceof Error ? err.message : 'Failed to load configuration');
            }
            return;
        } finally {
            if (isMountedRef.current) {
                setIsLoading(false);
            }
        }

        try {
            await runStartupConfigMaintenance();
        } catch (err) {
            console.warn('[ConfigProvider] Startup config maintenance deferred:', err);
            if (isLockBusyError(err)) {
                scheduleStartupMaintenanceRetry();
            }
        }
    }, [
        commitReadableConfigDiskSnapshot,
        runStartupConfigMaintenance,
        scheduleStartupMaintenanceRetry,
    ]);

    // Initial load
    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (managedCodexReadiness.reason !== 'ready' && managedCodexReadiness.reason !== 'provider-disabled') {
            setManagedCodexRuntimeModels([]);
            return;
        }

        let cancelled = false;
        apiGetJson<{ models?: RuntimeModelInfo[] }>('/api/runtime/models?type=codex&source=managed-provider')
            .then((result) => {
                if (cancelled) return;
                setManagedCodexRuntimeModels(Array.isArray(result.models) ? result.models : []);
            })
            .catch((err) => {
                if (cancelled) return;
                console.warn('[managed-codex] failed to load provider model list', err);
                setManagedCodexRuntimeModels([]);
            });

        return () => { cancelled = true; };
    }, [
        managedCodexReadiness.reason,
        managedCodexModelListKey,
    ]);

    const syncNativeUiLanguageFromConfig = useCallback(async () => {
        if (!isTauriEnvironment()) return;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('cmd_sync_ui_language_from_config');
        } catch (err) {
            console.warn('[ConfigProvider] Failed to sync native UI language:', err);
        }
    }, []);

    const refreshConfigFromDisk = useCallback(async (
        reason: string,
        options: { syncNativeUiLanguage: boolean },
    ) => {
        try {
            const previousUiLanguage = normalizeUiLanguage(configRef.current.uiLanguage);
            const snapshot = await commitConfigDiskSnapshot();
            if (!snapshot) return;
            const nextUiLanguage = normalizeUiLanguage(snapshot.config.uiLanguage);
            if (options.syncNativeUiLanguage && previousUiLanguage !== nextUiLanguage) {
                await syncNativeUiLanguageFromConfig();
            }
        } catch (err) {
            console.error(`[ConfigProvider] Failed to refresh config after ${reason}:`, err);
            if (isLockBusyError(err)) {
                scheduleStartupMaintenanceRetry();
                return;
            }
            if (isMountedRef.current) {
                setError(err instanceof Error ? err.message : 'Failed to refresh configuration');
            }
        }
    }, [commitConfigDiskSnapshot, scheduleStartupMaintenanceRetry, syncNativeUiLanguageFromConfig]);

    // ============= Listen for im:bot-config-changed =============

    useEffect(() => {
        if (!isTauriEnvironment()) return;
        const ac = new AbortController();

        const refreshOnConfigEvent = () => {
            if (!isMountedRef.current) return;
            void refreshConfigFromDisk('config-changed', { syncNativeUiLanguage: true });
        };
        const refreshOnUiLanguageEvent = () => {
            if (!isMountedRef.current) return;
            void refreshConfigFromDisk('ui-language-changed', { syncNativeUiLanguage: false });
        };

        void listenWithCleanup<{ botId: string }>('im:bot-config-changed', refreshOnConfigEvent, ac.signal);
        void listenWithCleanup('agent:config-changed', refreshOnConfigEvent, ac.signal);
        void listenWithCleanup('app:config-changed', refreshOnConfigEvent, ac.signal);
        // Native OAuth owns durable credential saving even when Settings is
        // unmounted. Rebuild the existing provider projection at app scope.
        void listenWithCleanup<TokenDanceAuthView>('tokendance:auth-changed', event => {
            if (event.payload.phase !== 'connected' || !isMountedRef.current) return;
            void rebuildAndPersistAvailableProviders()
                .then(() => refreshConfigFromDisk('provider authorization', { syncNativeUiLanguage: false }))
                .catch(() => {
                    if (isMountedRef.current) scheduleStartupMaintenanceRetry();
                });
        }, ac.signal);
        // PRD 0.2.35 — the Rust `cmd_set_force_wake_lock` command (called from
        // Settings.tsx OR triggered by the tray CheckMenuItem click) writes
        // disk and emits this event. We re-read disk so the React state
        // matches the durable truth. Without this, a tray-side toggle would
        // leave Settings.tsx stuck on its last-rendered value.
        void listenWithCleanup<boolean>('force-wake-lock-changed', refreshOnConfigEvent, ac.signal);
        void listenWithCleanup<{ uiLanguage: UiLanguage; locale: SupportedLocale }>('ui-language-changed', refreshOnUiLanguageEvent, ac.signal);

        return () => ac.abort();
    }, [refreshConfigFromDisk, scheduleStartupMaintenanceRetry]);

    // ============= Listen for Admin CLI config changes (via SSE → window event) =============

    useEffect(() => {
        const handler = () => {
            if (!isMountedRef.current) return;
            void refreshConfigFromDisk('admin CLI change', { syncNativeUiLanguage: true });
        };
        window.addEventListener('myagents:config-changed', handler);
        return () => window.removeEventListener('myagents:config-changed', handler);
    }, [refreshConfigFromDisk]);

    // ============= Actions =============

    const updateConfig = useCallback(async (updates: Partial<AppConfig>) => {
        if ('uiLanguage' in updates) {
            const value = normalizeUiLanguage(updates.uiLanguage);
            const { uiLanguage: _, ...rest } = updates;
            if (isTauriEnvironment()) {
                try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('cmd_set_ui_language', { value });
                    if (acceptLocalDiskWrite()) {
                        setConfig(prev => ({ ...prev, uiLanguage: value }));
                    }
                } catch (err) {
                    console.error('[ConfigProvider] cmd_set_ui_language failed:', err);
                    throw err;
                }
                if (Object.keys(rest).length === 0) return;
                updates = rest;
            } else {
                updates = { ...rest, uiLanguage: value };
            }
        }
        // PRD 0.2.35 D2 — `forceWakeLock` has OS-level side effects (acquire /
        // drop an IOPMAssertion-class lock, sync the tray CheckMenuItem, emit
        // to all renderers). Going through atomicModifyConfig writes disk
        // *before* Rust toggles the OS lock, opening a window where the
        // disk truth and the live OS state disagree. The Rust command is the
        // single chokepoint that does all four mirrors atomically — route
        // through it for this field; let any other co-updated keys flow
        // through the default path so we don't lose them.
        if ('forceWakeLock' in updates) {
            const value = !!updates.forceWakeLock;
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('cmd_set_force_wake_lock', { value });
                // Optimistic local mirror: snappy UI; the
                // `force-wake-lock-changed` listener will re-read disk and
                // arrive at the same value (no-op).
                if (acceptLocalDiskWrite()) {
                    setConfig(prev => ({ ...prev, forceWakeLock: value }));
                }
            } catch (err) {
                console.error('[ConfigProvider] cmd_set_force_wake_lock failed:', err);
                throw err;
            }
            const { forceWakeLock: _, ...rest } = updates;
            if (Object.keys(rest).length === 0) return;
            updates = rest;
        }
        const newConfig = await atomicModifyConfig(c => ({ ...c, ...updates }));
        if (acceptLocalDiskWrite()) setConfig(newConfig);
        // No more CONFIG_CHANGED event — all consumers share this Context
    }, [acceptLocalDiskWrite]);

    // #230: Merge-aware proxy patch. Callers pass only the field(s) they changed;
    // the merge happens against `c` (the disk-latest config) INSIDE the
    // atomicModifyConfig modifier, under withConfigLock. This is what prevents
    // lost updates when two proxy fields commit back-to-back from the same React
    // render — e.g. editing the host field then clicking the enable toggle in one
    // interaction: the host blur write lands on disk first, and the toggle's read
    // sees it, instead of both spreading a stale render-time `config.proxySettings`
    // base and the last writer clobbering the other's field. The base layering
    // (`enabled:false` → PROXY_DEFAULTS → c.proxySettings → partial) also yields a
    // complete ProxySettings even when proxySettings was previously undefined.
    const patchProxySettings = useCallback(async (partial: Partial<ProxySettings>) => {
        const newConfig = await atomicModifyConfig(c => ({
            ...c,
            proxySettings: {
                enabled: false,
                ...PROXY_DEFAULTS,
                ...c.proxySettings,
                ...partial,
            },
        }));
        if (acceptLocalDiskWrite()) setConfig(newConfig);
    }, [acceptLocalDiskWrite]);

    const refreshConfig = useCallback(async () => {
        await refreshConfigFromDisk('manual refresh', { syncNativeUiLanguage: true });
    }, [refreshConfigFromDisk]);

    const applyManagedCodexStatus = useCallback((status: ManagedCodexStatusResult) => {
        if (acceptLocalDiskWrite()) {
            setConfig(previous => {
                const next = {
                    ...previous,
                    managedCodexRuntimeInstall: status.runtimeInstall,
                    managedCodexAuth: status.auth,
                };
                configRef.current = next;
                return next;
            });
        }
    }, [acceptLocalDiskWrite]);

    const observeManagedCodexRuntimeUpdate = useCallback(async (
        request: Promise<ManagedCodexStatusResult>,
    ): Promise<void> => {
        setManagedCodexRuntimeUpdateInFlight(true);
        try {
            applyManagedCodexStatus(await request);
        } finally {
            // Disk remains authoritative. The command result above keeps the
            // UI coherent even if this follow-up disk read fails.
            await refreshConfig();
            if (isMountedRef.current && managedCodexRuntimeUpdateRequest !== request) {
                setManagedCodexRuntimeUpdateInFlight(false);
            }
        }
    }, [applyManagedCodexStatus, refreshConfig]);

    const requestManagedCodexRuntimeUpdateInternal = useCallback((
        hydrateBeforeDownload: boolean,
    ): Promise<void> => {
        if (!isTauriEnvironment()) {
            return Promise.reject(new Error('Managed Codex runtime updates require the desktop app'));
        }
        let request = managedCodexRuntimeUpdateRequest;
        if (!request) {
            const started = (async (): Promise<ManagedCodexStatusResult> => {
                const { invoke } = await import('@tauri-apps/api/core');
                if (hydrateBeforeDownload) {
                    try {
                        await invoke('cmd_managed_codex_status');
                        await refreshConfig();
                    } catch (err) {
                        console.warn('[managed-codex] startup status refresh failed:', err);
                    }
                }
                return invoke<ManagedCodexStatusResult>('cmd_managed_codex_download');
            })();
            const tracked = started.finally(() => {
                if (managedCodexRuntimeUpdateRequest === tracked) {
                    managedCodexRuntimeUpdateRequest = null;
                }
            });
            managedCodexRuntimeUpdateRequest = tracked;
            request = tracked;
        }
        return observeManagedCodexRuntimeUpdate(request);
    }, [observeManagedCodexRuntimeUpdate, refreshConfig]);

    const requestManagedCodexRuntimeUpdate = useCallback(
        () => requestManagedCodexRuntimeUpdateInternal(false),
        [requestManagedCodexRuntimeUpdateInternal],
    );

    useEffect(() => {
        const activeRequest = managedCodexRuntimeUpdateRequest;
        if (!activeRequest) {
            // A process request may settle between this Provider's render-time
            // state initializer and passive-effect registration after remount.
            setManagedCodexRuntimeUpdateInFlight(false);
            return;
        }
        void observeManagedCodexRuntimeUpdate(activeRequest).catch(() => {});
    }, [observeManagedCodexRuntimeUpdate]);

    useEffect(() => {
        if (!isTauriEnvironment()) return;
        if (isLoading) return;
        if (error) return;
        if (managedCodexStartupUpdateEvaluated) return;
        // This is a startup decision, not a subscription to later config
        // changes. The shared request action below is the single in-process
        // update owner for both startup and Settings-triggered updates.
        managedCodexStartupUpdateEvaluated = true;
        if (!managedCodexShouldAutoUpdate) return;

        // One automatic attempt per App module lifetime. A failed download is
        // persisted as `error`; the next App launch retries, while this launch
        // never loops on config refreshes of the same failure state.
        void (async () => {
            try {
                console.info(
                    `[managed-codex] auto update start runtime=codex runtimeSource=managed-provider requiredVersion=${MANAGED_CODEX_REQUIRED_RUNTIME.version}`,
                );
                // Claim the process-scoped request before the first preflight
                // await so manual update/auth operations observe in-flight now.
                await requestManagedCodexRuntimeUpdateInternal(true);
            } catch (err) {
                console.warn(
                    `[managed-codex] auto update failed runtime=codex runtimeSource=managed-provider requiredVersion=${MANAGED_CODEX_REQUIRED_RUNTIME.version}`,
                    err,
                );
            }
        })();
    }, [
        error,
        isLoading,
        managedCodexShouldAutoUpdate,
        requestManagedCodexRuntimeUpdateInternal,
    ]);

    const refreshProviderData = useCallback(async () => {
        await refreshConfigFromDisk('provider data refresh', { syncNativeUiLanguage: false });
    }, [refreshConfigFromDisk]);

    const refreshProviders = useCallback(async () => {
        await refreshConfigFromDisk('provider catalogue refresh', { syncNativeUiLanguage: false });
    }, [refreshConfigFromDisk]);

    // --- Projects ---

    const addProject = useCallback(async (path: string, options: AddProjectOptions = {}) => {
        let project!: Project;
        let identityResult!: Awaited<ReturnType<typeof reconcilePersistedAgentWorkspaceIdentitiesLocked>>;
        await withAgentConfigIntentLock(async () => {
            project = await addProjectService(path);

            const metadataPatch: Partial<Omit<Project, 'id'>> = {};
            if (options.icon) metadataPatch.icon = options.icon;
            if (options.displayName) metadataPatch.displayName = options.displayName;
            if (options.templateId) metadataPatch.templateId = options.templateId;
            if (options.templateSource) metadataPatch.templateSource = options.templateSource;
            if (project.hidden) {
                metadataPatch.hidden = false;
                metadataPatch.hiddenAt = undefined;
            }
            if (Object.keys(metadataPatch).length > 0) {
                project = await patchProjectService(project.id, metadataPatch) ?? project;
            }

            identityResult = await reconcilePersistedAgentWorkspaceIdentitiesLocked({
                agentDefaultsByProjectId: options.agentDefaults
                    ? new Map([[project.id, options.agentDefaults]])
                    : undefined,
            });
            project = identityResult.projects.find(item => item.id === project.id) ?? project;
        });

        for (const createdAgent of identityResult.createdAgents) {
            if (createdAgent.memoryAutoUpdate?.enabled) {
                try {
                    await configureMemoryAutoUpdateTaskForAgent(createdAgent, project.path);
                } catch (err) {
                    console.warn(`[ConfigProvider] Memory auto-update task provisioning deferred for ${createdAgent.id}:`, err);
                }
            }
            if (createdAgent.memoryEvolution?.enabled) {
                try {
                    await configureMemoryEvolutionTasksForAgent(createdAgent, project.id, project.path, true);
                } catch (err) {
                    console.warn(
                        `[ConfigProvider] Memory evolution task provisioning failed for agent ${createdAgent.id}:`,
                        err,
                    );
                }
            }
        }

        if (acceptLocalDiskWrite()) {
            setConfig(identityResult.config);
            setProjects([
                project,
                ...identityResult.projects.filter((item) => item.id !== project.id),
            ]);
        }
        return project;
    }, [acceptLocalDiskWrite]);

    const updateProject = useCallback(async (project: Project) => {
        await updateProjectService(project);
        if (acceptLocalDiskWrite()) {
            setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)));
        }
    }, [acceptLocalDiskWrite]);

    const patchProject = useCallback(async (projectId: string, updates: Partial<Omit<Project, 'id'>>) => {
        const updated = await patchProjectService(projectId, updates);
        if (updated) {
            if (acceptLocalDiskWrite()) {
                setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
            }
        }
    }, [acceptLocalDiskWrite]);

    const removeProject = useCallback(async (projectId: string) => {
        const result = await removeOrHideProjectService(projectId);
        if (!result) return;

        if (acceptLocalDiskWrite()) {
            if (result.action === 'hidden') {
                setProjects((prev) => prev.map((p) => (p.id === projectId ? result.project : p)));
            } else {
                setProjects((prev) => prev.filter((p) => p.id !== projectId));
            }
        }

        const newConfig = await atomicModifyConfig(c => (
            workspacePathsEqual(c.defaultWorkspacePath, result.project.path)
                ? { ...c, defaultWorkspacePath: undefined }
                : c
        ));
        if (acceptLocalDiskWrite()) setConfig(newConfig);
    }, [acceptLocalDiskWrite]);

    const touchProject = useCallback(async (projectId: string) => {
        const updated = await touchProjectService(projectId);
        if (updated) {
            if (acceptLocalDiskWrite()) {
                setProjects((prev) => {
                    const filtered = prev.filter((p) => p.id !== projectId);
                    return [updated, ...filtered];
                });
            }
        }
    }, [acceptLocalDiskWrite]);

    // --- API Keys ---

    const saveApiKey = useCallback(async (providerId: string, apiKey: string) => {
        await saveApiKeyService(providerId, apiKey);
        await rebuildAndPersistAvailableProviders();
        if (acceptLocalDiskWrite()) {
            setApiKeys((prev) => ({ ...prev, [providerId]: apiKey }));
        }
    }, [acceptLocalDiskWrite]);

    const deleteApiKey = useCallback(async (providerId: string) => {
        await deleteApiKeyService(providerId);
        await rebuildAndPersistAvailableProviders();
        if (acceptLocalDiskWrite()) {
            setApiKeys((prev) => {
                const next = { ...prev };
                delete next[providerId];
                return next;
            });
            setProviderVerifyStatus((prev) => {
                const next = { ...prev };
                delete next[providerId];
                return next;
            });
        }
    }, [acceptLocalDiskWrite]);

    // --- Verify Status ---

    const saveProviderVerifyStatus = useCallback(async (
        providerId: string,
        status: 'valid' | 'invalid',
        accountEmail?: string,
        metadata?: Pick<ProviderVerifyStatus, 'invalidReason' | 'error'>,
    ) => {
        await saveProviderVerifyStatusService(providerId, status, accountEmail, metadata);
        // Rebuild availableProvidersJson so IM /provider command sees the updated status.
        // Without this, subscription verification changes don't propagate to the on-disk
        // cache until some other action (API key change, provider add) triggers a rebuild.
        await rebuildAndPersistAvailableProviders();
        if (acceptLocalDiskWrite()) {
            setProviderVerifyStatus((prev) => ({
                ...prev,
                [providerId]: {
                    status,
                    verifiedAt: new Date().toISOString(),
                    accountEmail,
                    ...(metadata?.invalidReason ? { invalidReason: metadata.invalidReason } : {}),
                    ...(metadata?.error ? { error: metadata.error } : {}),
                },
            }));
        }
    }, [acceptLocalDiskWrite]);

    // --- Custom Providers ---

    const addCustomProvider = useCallback(async (provider: Provider) => {
        await saveCustomProviderService(provider);
        await rebuildAndPersistAvailableProviders();
        await refreshProviders();
    }, [refreshProviders]);

    const updateCustomProvider = useCallback(async (
        provider: Provider,
        discoveredModels?: DiscoveredModel[],
    ) => {
        if (discoveredModels) {
            // Discovery starts from a render snapshot and may finish after the
            // user edits the same model. Re-read under the Provider file lock
            // and merge only missing fields so a late result cannot overwrite
            // an explicit value or resurrect a deleted model.
            await atomicModifyCustomProvider(provider.id, current => {
                const models = enrichExistingModelsFromDiscovery(current.models, discoveredModels);
                return models === current.models ? current : { ...current, models };
            });
        } else {
            await saveCustomProviderService(provider);
        }
        await rebuildAndPersistAvailableProviders();
        await refreshProviders();
    }, [refreshProviders]);

    const deleteCustomProvider = useCallback(async (providerId: string) => {
        await deleteCustomProviderService(providerId);
        await deleteApiKeyService(providerId);
        // Scrub the deleted id from enablement/order arrays so they don't grow
        // unbounded across delete-and-re-add cycles (helpers strip unknown ids
        // at read time, but persisted disk state would otherwise accumulate).
        await atomicModifyConfig(c => {
            const providerOrder = c.providerOrder?.filter(id => id !== providerId);
            const disabledProviderIds = c.disabledProviderIds?.filter(id => id !== providerId);
            const proxySettings = removeProviderFromProxySettingsScope(c.proxySettings, providerId);
            return {
                ...c,
                providerOrder: providerOrder && providerOrder.length > 0 ? providerOrder : undefined,
                disabledProviderIds: disabledProviderIds && disabledProviderIds.length > 0 ? disabledProviderIds : undefined,
                ...(proxySettings ? { proxySettings } : {}),
            };
        });
        await rebuildAndPersistAvailableProviders();
        await refreshProviders();
    }, [refreshProviders]);

    // --- Preset Custom Models ---

    const savePresetCustomModels = useCallback(async (providerId: string, models: ModelEntity[]) => {
        const newConfig = await atomicModifyConfig(c => {
            const newPresetCustomModels = {
                ...c.presetCustomModels,
                [providerId]: models,
            };
            if (models.length === 0) {
                delete newPresetCustomModels[providerId];
            }
            return { ...c, presetCustomModels: newPresetCustomModels };
        });
        await rebuildAndPersistAvailableProviders();
        if (acceptLocalDiskWrite()) setConfig(newConfig);
    }, [acceptLocalDiskWrite]);

    const removePresetCustomModel = useCallback(async (providerId: string, modelId: string) => {
        const newConfig = await atomicModifyConfig(c => {
            const currentModels = c.presetCustomModels?.[providerId] ?? [];
            const newModels = currentModels.filter(m => m.model !== modelId);
            const newPresetCustomModels = { ...c.presetCustomModels, [providerId]: newModels };
            if (newModels.length === 0) {
                delete newPresetCustomModels[providerId];
            }
            return { ...c, presetCustomModels: newPresetCustomModels };
        });
        await rebuildAndPersistAvailableProviders();
        if (acceptLocalDiskWrite()) setConfig(newConfig);
    }, [acceptLocalDiskWrite]);

    const savePrimaryModel = useCallback(async (providerId: string, modelId: string) => {
        const newConfig = await atomicModifyConfig(c => ({
            ...c,
            providerPrimaryModels: { ...c.providerPrimaryModels, [providerId]: modelId },
        }));
        await rebuildAndPersistAvailableProviders();
        if (acceptLocalDiskWrite()) setConfig(newConfig);
    }, [acceptLocalDiskWrite]);

    const saveProviderModelAliases = useCallback(async (providerId: string, aliases: ModelAliases) => {
        // Strip empty strings — prevent sending model: "" upstream
        const cleaned: ModelAliases = {};
        if (aliases.fable) cleaned.fable = aliases.fable;
        if (aliases.sonnet) cleaned.sonnet = aliases.sonnet;
        if (aliases.opus) cleaned.opus = aliases.opus;
        if (aliases.haiku) cleaned.haiku = aliases.haiku;
        const newConfig = await atomicModifyConfig(c => {
            const newAliases = { ...c.providerModelAliases, [providerId]: cleaned };
            return { ...c, providerModelAliases: newAliases };
        });
        await rebuildAndPersistAvailableProviders();
        if (acceptLocalDiskWrite()) setConfig(newConfig);
    }, [acceptLocalDiskWrite]);

    // ============= Memoized Context Values =============

    const data = useMemo<ConfigDataValue>(() => ({
        config,
        projects,
        providers,
        apiKeys,
        providerVerifyStatus,
        isLoading,
        error,
        managedCodexRuntimeUpdateInFlight,
    }), [
        config,
        projects,
        providers,
        apiKeys,
        providerVerifyStatus,
        isLoading,
        error,
        managedCodexRuntimeUpdateInFlight,
    ]);

    const actions = useMemo<ConfigActionsValue>(() => ({
        updateConfig, patchProxySettings, refreshConfig, reload: load, refreshProviderData,
        addProject, updateProject, patchProject, removeProject, touchProject,
        addCustomProvider, updateCustomProvider, deleteCustomProvider, refreshProviders,
        savePresetCustomModels, removePresetCustomModel, savePrimaryModel, saveProviderModelAliases,
        saveApiKey, deleteApiKey,
        saveProviderVerifyStatus,
        requestManagedCodexRuntimeUpdate,
    }), [
        updateConfig, patchProxySettings, refreshConfig, load, refreshProviderData,
        addProject, updateProject, patchProject, removeProject, touchProject,
        addCustomProvider, updateCustomProvider, deleteCustomProvider, refreshProviders,
        savePresetCustomModels, removePresetCustomModel, savePrimaryModel, saveProviderModelAliases,
        saveApiKey, deleteApiKey,
        saveProviderVerifyStatus,
        requestManagedCodexRuntimeUpdate,
    ]);

    return (
        <ConfigActionsContext.Provider value={actions}>
            <ConfigDataContext.Provider value={data}>
                {children}
            </ConfigDataContext.Provider>
        </ConfigActionsContext.Provider>
    );
}
