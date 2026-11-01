// Provider management — custom providers, API keys, verify status, provider availability
import { exists, lstat, readDir, readTextFile, remove } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

import type { Provider, ProviderVerifyStatus, AppConfig, Project } from '../types';
import {
    PRESET_PROVIDERS,
    applyManagedCodexProviderReadiness,
    applyProviderEnablementAndOrder,
    isProviderEnabled,
    withManagedCodexProviderCatalog,
} from '../types';
import type { AgentConfig } from '../../../shared/types/agent';
import {
    isRuntimeBackedProvider,
    isRuntimeBackedProviderId,
} from '../../../shared/providerExecution';
import { buildAvailableProvidersJson } from '../../../shared/availableProvidersProjection';
import {
    isImageUnderstandingModelSelectable,
    isImageUnderstandingToolConfigured,
    type OfficialToolSettings,
} from '../../../shared/official-tools';
import {
    isBrowserDevMode,
    ensureConfigDir,
    getConfigDir,
    PROVIDERS_DIR,
    safeWriteJson,
    withFileLock,
} from './configStore';
import {
    loadAppConfig,
    atomicModifyConfig,
    mergePresetCustomModels,
} from './appConfigService';
import { isDebugMode } from '@/utils/debug';

// Re-export mergePresetCustomModels for barrel
export { mergePresetCustomModels };

// ============= Custom Providers =============

async function writeProviderJson(providerPath: string, provider: Provider): Promise<void> {
    await withFileLock(providerPath, async () => {
        try {
            const metadata = await lstat(providerPath);
            if (metadata.isDirectory) {
                throw new Error(`Provider path is a directory: ${providerPath}`);
            }
            if (metadata.isSymlink) await remove(providerPath);
        } catch (error) {
            // Missing paths are safe to create; an existing path with
            // unreadable metadata must fail closed.
            if (await exists(providerPath)) throw error;
        }
        await safeWriteJson(providerPath, provider);
    });
}

/**
 * Read-modify-write a custom Provider while holding its cross-process file
 * lock. Callers that only own one field (for example model discovery) must use
 * this instead of saving a Provider snapshot captured before asynchronous IO.
 */
export async function atomicModifyCustomProvider(
    providerId: string,
    modify: (provider: Provider) => Provider,
): Promise<Provider | null> {
    if (isBrowserDevMode()) return null;

    await ensureConfigDir();
    const dir = await getConfigDir();
    const providerPath = await join(dir, PROVIDERS_DIR, `${providerId}.json`);
    return withFileLock(providerPath, async () => {
        if (!(await exists(providerPath))) return null;
        const metadata = await lstat(providerPath);
        if (metadata.isDirectory || metadata.isSymlink) {
            throw new Error(`Provider path is not a regular file: ${providerPath}`);
        }
        const parsed = JSON.parse(await readTextFile(providerPath)) as Provider;
        if (parsed.id !== providerId || !Array.isArray(parsed.models)) {
            throw new Error(`Invalid custom provider file: ${providerPath}`);
        }
        const next = modify(parsed);
        if (next.id !== providerId) {
            throw new Error(`Custom provider updater cannot change id: ${providerId}`);
        }
        if (next !== parsed) await safeWriteJson(providerPath, next);
        return next;
    });
}

export async function loadCustomProviders(): Promise<Provider[]> {
    if (isBrowserDevMode()) {
        return [];
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const providersDir = await join(dir, PROVIDERS_DIR);

        if (!(await exists(providersDir))) {
            return [];
        }

        const entries = await readDir(providersDir);
        const providers: Provider[] = [];

        for (const entry of entries) {
            if (entry.isFile && entry.name.endsWith('.json')) {
                try {
                    const filePath = await join(providersDir, entry.name);
                    const content = await readTextFile(filePath);
                    const parsed = JSON.parse(content);
                    if (!parsed.id || !parsed.name || !parsed.config || !Array.isArray(parsed.models)) {
                        console.warn('[configService] Invalid provider file, skipping:', entry.name);
                        continue;
                    }
                    const p = parsed as Provider;
                    // 若 primaryModel 不在 models 中（如删除模型后未正确保存），自动修正并持久化
                    if (p.models.length > 0) {
                        const modelIds = p.models.map((m: { model: string }) => m.model);
                        if (!modelIds.includes(p.primaryModel)) {
                            p.primaryModel = p.models[0].model;
                            if (isDebugMode()) {
                                console.log('[configService] Fixed invalid primaryModel for provider:', p.id, '->', p.primaryModel);
                            }
                            try {
                                const providerPath = await join(providersDir, entry.name);
                                await writeProviderJson(providerPath, p);
                            } catch (e) {
                                console.warn('[configService] Failed to persist primaryModel fix:', e);
                            }
                        }
                    }
                    providers.push(p);
                } catch (parseError) {
                    console.error('[configService] Failed to parse provider file:', entry.name, parseError);
                }
            }
        }

        if (isDebugMode()) {
            console.log('[configService] Loaded custom providers:', providers.length);
        }
        return providers;
    } catch (error) {
        console.error('[configService] Failed to load custom providers:', error);
        return [];
    }
}

export async function getAllProviders(config?: AppConfig): Promise<Provider[]> {
    const effectiveConfig = config ?? await loadAppConfig();
    if (isBrowserDevMode()) {
        return withManagedCodexProviderCatalog(PRESET_PROVIDERS, effectiveConfig);
    }

    const customProviders = await loadCustomProviders();
    return withManagedCodexProviderCatalog([...PRESET_PROVIDERS, ...customProviders], effectiveConfig);
}

export async function saveCustomProvider(provider: Provider): Promise<void> {
    if (isBrowserDevMode()) {
        console.warn('[configService] Custom providers not supported in browser mode');
        return;
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const providerPath = await join(dir, PROVIDERS_DIR, `${provider.id}.json`);
        await writeProviderJson(providerPath, provider);
        if (isDebugMode()) {
            console.log('[configService] Saved custom provider:', provider.id);
        }
    } catch (error) {
        console.error('[configService] Failed to save custom provider:', error);
        throw error;
    }
}

export async function deleteCustomProvider(providerId: string): Promise<void> {
    if (isBrowserDevMode()) {
        return;
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const providerPath = await join(dir, PROVIDERS_DIR, `${providerId}.json`);

        await withFileLock(providerPath, async () => {
            if (await exists(providerPath)) {
                await remove(providerPath);
                if (isDebugMode()) {
                    console.log('[configService] Deleted custom provider:', providerId);
                }
            }
        });
    } catch (error) {
        console.error('[configService] Failed to delete custom provider:', error);
        throw error;
    }
}

// ============= API Keys =============

export async function saveApiKey(providerId: string, apiKey: string): Promise<void> {
    await atomicModifyConfig(c => ({
        ...c,
        providerApiKeys: { ...(c.providerApiKeys ?? {}), [providerId]: apiKey },
    }));
    console.log('[configService] Saved API key for provider:', providerId);
}

export async function loadApiKeys(): Promise<Record<string, string>> {
    const config = await loadAppConfig();
    return config.providerApiKeys ?? {};
}

export async function deleteApiKey(providerId: string): Promise<void> {
    await atomicModifyConfig(c => {
        const apiKeys = { ...c.providerApiKeys };
        delete apiKeys[providerId];
        const verifyStatus = { ...c.providerVerifyStatus };
        delete verifyStatus[providerId];
        return { ...c, providerApiKeys: apiKeys, providerVerifyStatus: verifyStatus };
    });
    console.log('[configService] Deleted API key for provider:', providerId);
}

// ============= Provider Verify Status =============

export async function saveProviderVerifyStatus(
    providerId: string,
    status: 'valid' | 'invalid',
    accountEmail?: string,
    metadata?: Pick<ProviderVerifyStatus, 'invalidReason' | 'error'>,
): Promise<void> {
    await atomicModifyConfig(c => ({
        ...c,
        providerVerifyStatus: {
            ...(c.providerVerifyStatus ?? {}),
            [providerId]: {
                status,
                verifiedAt: new Date().toISOString(),
                accountEmail,
                ...(metadata?.invalidReason ? { invalidReason: metadata.invalidReason } : {}),
                ...(metadata?.error ? { error: metadata.error } : {}),
            },
        },
    }));
    console.log('[configService] Saved verify status for provider:', providerId, status);
}

export async function loadProviderVerifyStatus(): Promise<Record<string, ProviderVerifyStatus>> {
    const config = await loadAppConfig();
    return config.providerVerifyStatus ?? {};
}

/** A transient verification attempt cannot revoke an earlier credential fact. */
export function shouldInvalidateProviderAfterVerification(result: {
    success: boolean;
    retryable?: boolean;
}): boolean {
    return !result.success && result.retryable !== true;
}

export async function deleteProviderVerifyStatus(providerId: string): Promise<void> {
    await atomicModifyConfig(c => {
        const verifyStatus = { ...c.providerVerifyStatus };
        delete verifyStatus[providerId];
        return { ...c, providerVerifyStatus: verifyStatus };
    });
    console.log('[configService] Deleted verify status for provider:', providerId);
}

// ============= Available Providers Cache =============

export async function rebuildAndPersistAvailableProviders(): Promise<void> {
    try {
        const config = await loadAppConfig();
        const allProviders = await getAllProviders(config);
        const apiKeys = config.providerApiKeys ?? {};
        const verifyStatus = config.providerVerifyStatus ?? {};

        const mergedProviders = applyManagedCodexProviderReadiness(
            applyProviderEnablementAndOrder(
                mergePresetCustomModels(
                    allProviders,
                    config.presetCustomModels,
                    config.presetRemovedModels as Record<string, string[]> | undefined,
                ),
                config,
            ),
            config,
        );
        const json = buildAvailableProvidersJson({
            providers: mergedProviders,
            apiKeys,
            verifyStatus,
            primaryModels: config.providerPrimaryModels,
        });
        await atomicModifyConfig(c => ({ ...c, availableProvidersJson: json }));
    } catch (err) {
        console.warn('[configService] Failed to rebuild availableProvidersJson:', err);
        throw err;
    }
}

// ===== Provider Availability (shared logic — used by Chat, Launcher, SimpleChatInput, etc.) =====

/**
 * Check if a provider has valid credentials (subscription verified or API key present).
 * Subscription providers need verifyStatus.status === 'valid' (accountEmail is
 * enrichment only — see Issue #203).
 * API providers just need a non-blank API key (whitespace-only is treated
 * as absent, matching the sidecar's strict check in
 * `admin-config.ts::resolveProviderEnv`). Without this trim, a provider
 * with `apiKey="   "` shows as available in the model picker but the
 * cron tick rejects it with "no API Key" — the surfaced/runtime
 * symmetry is what closes the gap.
 */
export function isProviderAvailable(
    provider: Provider,
    apiKeys: Record<string, string>,
    verifyStatus: Record<string, ProviderVerifyStatus>,
): boolean {
    if (!isProviderEnabled(provider)) return false;
    if (isRuntimeBackedProvider(provider)) {
        // Model discovery populates the picker; it does not decide whether a
        // saved execution identity can run (including an existing Session).
        return provider.runtimeReady === true;
    }
    if (provider.type === 'subscription') {
        // Issue #203: `accountEmail` is enrichment only — a valid SDK verify
        // already proves the OAuth token works. Users who only ran
        // `claude auth login` (without ever opening the CLI REPL) have no
        // email cached, but they ARE authenticated. Don't gate on email.
        const result = verifyStatus[provider.id];
        return result?.status === 'valid';
    }
    const key = apiKeys[provider.id];
    return !!key && key.trim().length > 0;
}

/**
 * Find the first available provider from the list (one with valid credentials).
 * Returns undefined if no providers are available — caller should show empty state.
 */
export function getFirstAvailableProvider(
    providers: Provider[],
    apiKeys: Record<string, string>,
    verifyStatus: Record<string, ProviderVerifyStatus>,
): Provider | undefined {
    return providers.find(p => isProviderAvailable(p, apiKeys, verifyStatus));
}

/**
 * Resolve provider by ID, with fallback to first available.
 * Returns undefined if requested provider not found AND no available provider exists.
 */
export function resolveProvider(
    providerId: string | undefined,
    providers: Provider[],
    apiKeys: Record<string, string>,
    verifyStatus: Record<string, ProviderVerifyStatus>,
): Provider | undefined {
    if (providerId) {
        const exact = providers.find(p => p.id === providerId);
        if (exact && isProviderAvailable(exact, apiKeys, verifyStatus)) return exact;
        if (isRuntimeBackedProviderId(providerId) || isRuntimeBackedProvider(exact)) return undefined;
    }
    return getFirstAvailableProvider(providers, apiKeys, verifyStatus);
}

// ===== Builtin Runtime (provider, model) Selection =====

/** Paired (provider, model) result. Both fields are guaranteed valid by the helper:
 *  - provider satisfies isProviderAvailable
 *  - model is concrete; managed runtime selections do not require catalogue membership
 *  This is the only correct way to construct InitialMessage.builtinSelection. */
export interface ProviderModelPair {
    readonly provider: Provider;
    readonly model: string;
}

/**
 * Resolve a paired (provider, model) for builtin-runtime sessions.
 *
 * Provider priority: agent → workspace → config.defaultProviderId → first available.
 * Each candidate is checked with isProviderAvailable; an unavailable candidate falls through
 * to the next layer (it does NOT short-circuit to first-available — that was a logic bug
 * in an earlier iteration).
 *
 * Model priority (after provider is selected): agent.model → workspace.model → provider.primaryModel.
 * API providers validate catalogue membership; managed providers preserve the saved
 * model paired with that provider and let the native runtime validate it.
 * (provider.primaryModel already has the user's providerPrimaryModels override applied
 * by rebuildAndPersistAvailableProviders, so we don't read raw config here.)
 *
 * Returns undefined when no provider in the system is available — caller decides UX.
 */
export function resolveBuiltinSelection(
    ctx: { agent?: AgentConfig; workspace?: Project },
    config: AppConfig,
    providers: Provider[],
    apiKeys: Record<string, string>,
    verifyStatus: Record<string, ProviderVerifyStatus>,
): ProviderModelPair | undefined {
    const candidates = [
        ctx.agent?.providerId,
        ctx.workspace?.providerId,
        config.defaultProviderId,
    ].filter((id): id is string => !!id);

    let provider: Provider | undefined;
    for (const id of candidates) {
        const p = providers.find(x => x.id === id);
        if (p && isProviderAvailable(p, apiKeys, verifyStatus)) {
            provider = p;
            break;
        }
    }
    provider ??= getFirstAvailableProvider(providers, apiKeys, verifyStatus);
    if (!provider) return undefined;

    if (isRuntimeBackedProvider(provider)) {
        const model = [
            ctx.agent?.providerId === provider.id ? ctx.agent.model : undefined,
            ctx.workspace?.providerId === provider.id ? ctx.workspace.model : undefined,
            provider.primaryModel,
        ].find(candidate => candidate?.trim());
        return model ? { provider, model } : undefined;
    }

    const modelSet = new Set(provider.models?.map(m => m.model) ?? []);
    const modelCandidates = [
        ctx.agent?.model,
        ctx.workspace?.model,
        provider.primaryModel,
    ].filter((m): m is string => !!m);
    const model = modelCandidates.find(m => modelSet.has(m)) ?? provider.primaryModel;

    return { provider, model };
}

/**
 * Pair a known provider with a model hint, enforcing the same model invariant as
 * resolveBuiltinSelection: the returned model is guaranteed to be in provider.models
 * (falling back to provider.primaryModel if the hint is stale or absent).
 *
 * Use this when the caller has already resolved a provider via UI state — e.g.
 * Launcher's launcherProvider (computed from launcherProviderId/agent/workspace/default
 * via useMemo) or BugReportOverlay's picked tuple. It closes the "stale model paired with
 * fallback provider" hole identified in cross-review: when launcherProvider falls through
 * to first-available because the primary provider's key was deleted, launcherSelectedModel
 * may still be the original agent's model — incompatible with the fallback provider.
 *
 * Returns the InitialMessage.builtinSelection shape directly so call sites need no further
 * transformation.
 */
export function pairBuiltinSelection(
    provider: Provider,
    modelHint: string | undefined,
): { providerId: string; model: string } {
    const ok = !!modelHint && (provider.models?.some(m => m.model === modelHint) ?? false);
    return {
        providerId: provider.id,
        model: ok ? (modelHint as string) : provider.primaryModel,
    };
}

/**
 * Look up the input modalities of a model on a given provider. Mirrors the
 * Sidecar-side `lookupModelCapability` semantics for the modality field —
 * the provider passed in is already merge-with-discovery (see
 * `mergePresetCustomModels`), so a simple linear scan is authoritative.
 *
 * Returns `undefined` when the model isn't registered or has no
 * `inputModalities` recorded — callers MUST treat that as "default-allow"
 * (optimistic) so unknown / brand-new / user-defined models aren't blocked.
 */
export function lookupModelInputModalities(
    provider: Provider | null | undefined,
    modelId: string | undefined | null,
): string[] | undefined {
    if (!provider || !modelId) return undefined;
    const entry = provider.models?.find(m => m.model === modelId);
    return entry?.inputModalities;
}

/**
 * Whether a given (provider, model) accepts the modality. Symmetric with
 * Sidecar `modelSupportsModality`: text always allowed; unknown
 * inputModalities defaults to true (optimistic).
 */
export function modelSupportsModality(
    provider: Provider | null | undefined,
    modelId: string | undefined | null,
    kind: 'text' | 'image' | 'video' | 'audio',
): boolean {
    if (kind === 'text') return true;
    const mods = lookupModelInputModalities(provider, modelId);
    if (!mods) return true; // unknown → optimistic default-allow
    return mods.includes(kind);
}

/**
 * Renderer mirror of the server's image-helper selection policy. A configured
 * model is usable when its provider is callable and its offering row does not
 * explicitly exclude image input; omitted modality metadata stays allowed
 * because selecting/saving the helper is an explicit user confirmation.
 */
export function isImageUnderstandingSelectionAvailable(
    providers: readonly Provider[],
    apiKeys: Record<string, string>,
    verifyStatus: Record<string, ProviderVerifyStatus>,
    settings: OfficialToolSettings | undefined,
): boolean {
    if (!isImageUnderstandingToolConfigured(settings)) return false;
    const selection = settings?.imageUnderstanding;
    const provider = providers.find(item => item.id === selection?.providerId);
    if (!provider || isRuntimeBackedProvider(provider)) return false;
    if (!isProviderAvailable(provider, apiKeys, verifyStatus)) return false;
    const model = provider.models.find(item => item.model === selection?.model);
    return isImageUnderstandingModelSelectable(model);
}
