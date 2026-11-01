// Compatibility wrapper — delegates to ConfigProvider's dual Context
// Existing consumers can continue using useConfig() without changes.
// New code should prefer useConfigData() / useConfigActions() directly.
import { useConfigData } from '@/config/useConfigData';
import { useConfigActions } from '@/config/useConfigActions';
import type { AddProjectOptions } from '@/config/ConfigProvider';
import type {
    AppConfig,
    ModelAliases,
    ModelEntity,
    Project,
    Provider,
    ProviderVerifyStatus,
    ProxySettings,
} from '@/config/types';

export interface UseConfigResult {
    // Config state
    config: AppConfig;
    isLoading: boolean;
    error: string | null;
    managedCodexRuntimeUpdateInFlight: boolean;

    // Projects
    projects: Project[];
    addProject: (path: string, options?: AddProjectOptions) => Promise<Project>;
    updateProject: (project: Project) => Promise<void>;
    /** Partially update a project — only merges specified fields, safe against stale React state */
    patchProject: (projectId: string, updates: Partial<Omit<Project, 'id'>>) => Promise<void>;
    removeProject: (projectId: string) => Promise<void>;
    touchProject: (projectId: string) => Promise<void>;

    // Providers (preset providers have custom models merged)
    providers: Provider[];
    addCustomProvider: (provider: Provider) => Promise<void>;
    updateCustomProvider: (provider: Provider) => Promise<void>;
    deleteCustomProvider: (providerId: string) => Promise<void>;
    refreshProviders: () => Promise<void>;

    // Preset provider custom models (user-added models for preset providers)
    savePresetCustomModels: (providerId: string, models: ModelEntity[]) => Promise<void>;
    removePresetCustomModel: (providerId: string, modelId: string) => Promise<void>;
    // Provider primary model override
    savePrimaryModel: (providerId: string, modelId: string) => Promise<void>;
    // Provider model aliases (SDK sub-agent model mapping)
    saveProviderModelAliases: (providerId: string, aliases: ModelAliases) => Promise<void>;

    // API Keys
    apiKeys: Record<string, string>;
    saveApiKey: (providerId: string, apiKey: string) => Promise<void>;
    deleteApiKey: (providerId: string) => Promise<void>;

    // Provider verify status (persisted)
    providerVerifyStatus: Record<string, ProviderVerifyStatus>;
    saveProviderVerifyStatus: (
        providerId: string,
        status: 'valid' | 'invalid',
        accountEmail?: string,
        metadata?: Pick<ProviderVerifyStatus, 'invalidReason' | 'error'>,
    ) => Promise<void>;

    // Config updates
    updateConfig: (updates: Partial<AppConfig>) => Promise<void>;
    /** Merge-aware proxy update — pass only changed fields; merges against disk-latest config (#230) */
    patchProxySettings: (partial: Partial<ProxySettings>, editableScopeProviderIds?: readonly string[]) => Promise<void>;

    /** Lightweight config-only refresh from disk (no loading state, no projects/providers reload) */
    refreshConfig: () => Promise<void>;

    // Reload all data
    reload: () => Promise<void>;

    // Refresh only provider-related data (apiKeys and verifyStatus) - lightweight, no loading state
    refreshProviderData: () => Promise<void>;

    /** Shared single-flight owner for startup and Settings-triggered Managed Codex updates. */
    requestManagedCodexRuntimeUpdate: () => Promise<void>;
}

export function useConfig(): UseConfigResult {
    const data = useConfigData();
    const actions = useConfigActions();
    return { ...data, ...actions };
}
