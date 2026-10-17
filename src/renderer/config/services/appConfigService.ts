import { APP_DISPLAY_NAME } from '../../../shared/appProfile';
// AppConfig core — load, save, atomicModify, migration, availableProviders, bundledWorkspace, selfAwareness
import { join } from '@tauri-apps/api/path';

import {
    type AppConfig,
    DEFAULT_CONFIG,
    type Project,
    DEFAULT_SYSTEM_PRESET_WORKSPACE_ID,
    getSystemPresetProjectMetadataPatch,
    normalizeClaudeTranscriptCleanupPeriodDays,
    normalizeMarkdownReadingSize,
} from '../types';
export { mergePresetCustomModels } from '../../../shared/config-types';
import {
    isBrowserDevMode,
    withConfigLock,
    ensureConfigDir,
    getConfigDir,
    CONFIG_FILE,
    safeLoadJson,
    safeWriteJson,
    isLockBusyError,
} from './configStore';
import {
    mockLoadConfig,
    mockSaveConfig,
} from '@/utils/browserMock';
import { normalizeStringifiedJsonFields, promoteAgentMcpJsonToGlobal } from './configNormalize';
import { workspacePathsEqual } from '../../../shared/workspacePath';
import { type ImBotConfig, DEFAULT_IM_BOT_CONFIG } from '../../../shared/types/im';
import { normalizeUiLanguage } from '../../../shared/i18n';
import { normalizeThemeConfigRecord } from '../../../shared/theme';
// Agent migration is triggered from ConfigProvider after both config + projects are loaded
import { isDebugMode } from '@/utils/debug';

// ============= Validation =============

function isValidAppConfig(data: unknown): data is AppConfig {
    return data !== null && typeof data === 'object' && !Array.isArray(data);
}

// Rust owns this private credential envelope. It must never enter the ordinary
// Renderer AppConfig projection, where unrelated settings consumers and React
// dev tooling could observe it. Writes preserve the latest on-disk envelope
// under the same config lock below.
const PRIVATE_EXTERNAL_CLI_CONFIG_KEY = 'externalCliAccess';

function omitPrivateConfigEnvelope(config: AppConfig): AppConfig {
    const projected = { ...config } as AppConfig & Record<string, unknown>;
    delete projected[PRIVATE_EXTERNAL_CLI_CONFIG_KEY];
    return projected;
}

// ============= cronNotifications → osNotifications Migration =============
//
// Pre-0.2.14 the master notification toggle was named `cronNotifications`
// but only 1 of 6 trigger sites was actually cron-related (it was a
// decorative toggle that no code path read). 0.2.14 renamed the field to
// `osNotifications` AND made it functional. Without this migration, users
// who deliberately set `cronNotifications: false` would silently get the
// new default (true) — they'd start receiving notifications they expected
// to be off. Mirror the legacy value into the new field so opt-out is
// preserved across the rename.
//
// Idempotent — a `_done` latch suppresses repeat runs after the first
// successful save flushes both fields out of the loaded shape.
let _osNotificationsMigrationDone = false;

export function migrateOsNotificationsField(config: AppConfig): AppConfig {
    if (_osNotificationsMigrationDone) return config;
    // Use a record cast so we can talk about the legacy field that the
    // current AppConfig type no longer declares. Narrowing against the
    // *required* `osNotifications` via `in` would narrow to `never` and
    // break later property access; index-access on the record sidesteps it.
    const raw = config as unknown as Record<string, unknown>;
    const legacy = raw['cronNotifications'];
    const hasNew = 'osNotifications' in raw && typeof raw['osNotifications'] === 'boolean';
    if (typeof legacy === 'boolean' && !hasNew) {
        raw['osNotifications'] = legacy;
        delete raw['cronNotifications'];
        _osNotificationsMigrationDone = true;
        // Cross-review (#0.2.29) — IN-MEMORY ONLY, do NOT fire-and-forget
        // saveAppConfig here. This runs inside loadAppConfig, which
        // atomicModifyConfig calls while holding withConfigLock; a queued save
        // would land AFTER the modifier's write and clobber it with this
        // pre-modifier snapshot. The disk heals on the next real config write
        // (same strategy as the #301 normalizeStringifiedJsonFields below).
        return config;
    }
    // Already had osNotifications (or no legacy field) — strip dead field
    // if present so it can't drift back into the shape on next save.
    if ('cronNotifications' in raw) {
        delete raw['cronNotifications'];
    }
    _osNotificationsMigrationDone = true;
    return config;
}

// ============= IM Bot Migration =============

let _imBotMigrationDone = false;

export function migrateImBotConfig(config: AppConfig): AppConfig {
    if (config.imBotConfig && !config.imBotConfigs && !_imBotMigrationDone) {
        _imBotMigrationDone = true;
        const legacy = config.imBotConfig;
        const migrated: ImBotConfig = {
            ...DEFAULT_IM_BOT_CONFIG,
            ...legacy,
            id: legacy.id || crypto.randomUUID(),
            name: legacy.name || 'Telegram Bot',
            platform: legacy.platform || 'telegram',
            setupCompleted: true,
        };
        config.imBotConfigs = [migrated];
        delete config.imBotConfig;
        // Cross-review (#0.2.29) — IN-MEMORY ONLY (see migrateOsNotificationsField):
        // this also runs inside loadAppConfig, so a fire-and-forget save races
        // atomicModifyConfig's withConfigLock and clobbers the modifier write.
        // Disk heals on the next real config write.
    }
    return config;
}

function normalizeDeveloperSettings(config: AppConfig): AppConfig {
    config.uiLanguage = normalizeUiLanguage(config.uiLanguage);
    config.markdownReadingSize = normalizeMarkdownReadingSize(config.markdownReadingSize);
    config.claudeTranscriptCleanupPeriodDays = normalizeClaudeTranscriptCleanupPeriodDays(
        config.claudeTranscriptCleanupPeriodDays,
    );
    return config;
}

export function migrateUiLanguageField(config: AppConfig): AppConfig {
    const raw = config as unknown as Record<string, unknown>;
    if (!('uiLanguage' in raw)) {
        config.uiLanguage = 'zh-CN';
        return config;
    }
    config.uiLanguage = normalizeUiLanguage(raw['uiLanguage']);
    return config;
}

function normalizeLoadedConfig(config: AppConfig): AppConfig {
    normalizeStringifiedJsonFields(config);
    promoteAgentMcpJsonToGlobal(config);
    return omitPrivateConfigEnvelope(normalizeDeveloperSettings(
        normalizeThemeConfigRecord(config as unknown as Record<string, unknown>) as unknown as AppConfig,
    ));
}

export async function ensureManagedCodexProviderDevGateDefault(): Promise<void> {
    if (isBrowserDevMode()) {
        let latest: Partial<AppConfig> = {};
        try {
            const stored = localStorage.getItem('myagents:config');
            latest = stored ? JSON.parse(stored) as Partial<AppConfig> : {};
        } catch {
            latest = {};
        }
        if (Object.prototype.hasOwnProperty.call(latest, 'managedCodexProviderDevGate')) {
            return;
        }
        const normalized = normalizeThemeConfigRecord(latest);
        localStorage.setItem('myagents:config', JSON.stringify({
            ...normalized,
            managedCodexProviderDevGate: true,
        }));
        return;
    }

    await withConfigLock(async () => {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const configPath = await join(dir, CONFIG_FILE);
        const latest = await safeLoadJson<Partial<AppConfig>>(configPath, isValidAppConfig) ?? {};
        if (Object.prototype.hasOwnProperty.call(latest, 'managedCodexProviderDevGate')) {
            return;
        }
        const normalized = normalizeThemeConfigRecord(latest);
        await safeWriteJson(configPath, {
            ...normalized,
            managedCodexProviderDevGate: true,
        });
    });
}

// ============= Load / Save =============

export async function loadAppConfig(): Promise<AppConfig> {
    const dynamicDefault: AppConfig = {
        ...DEFAULT_CONFIG,
        showDevTools: isDebugMode(),
    };

    if (isBrowserDevMode()) {
        console.log('[configService] Browser mode: loading from localStorage');
        const loaded = mockLoadConfig();
        if (Object.keys(loaded).length > 0) {
            migrateUiLanguageField(loaded);
        }
        const migrated = normalizeThemeConfigRecord(
            loaded as unknown as Record<string, unknown>,
        ) as unknown as AppConfig;
        return normalizeLoadedConfig({ ...dynamicDefault, ...migrated });
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const configPath = await join(dir, CONFIG_FILE);

        const loaded = await safeLoadJson<AppConfig>(configPath, isValidAppConfig);
        if (loaded) {
            migrateUiLanguageField(loaded);
            // Run the cronNotifications migration BEFORE the dynamicDefault
            // merge — once the default supplies `osNotifications: true`, the
            // legacy field is masked and we can no longer distinguish "user
            // had cron on" from "user had cron off".
            const migrated = migrateOsNotificationsField(
                normalizeThemeConfigRecord(
                    loaded as unknown as Record<string, unknown>,
                ) as unknown as AppConfig,
            );
            // Heal agent config load-boundary drift before any consumer sees it:
            // - issue #301: `providerEnvJson`/`mcpServersJson` persisted as raw
            //   objects instead of stringified JSON;
            // - issue #398: selected custom MCP definitions stranded only in
            //   `agents[].mcpServersJson`, missing from global `mcpServers`.
            // Done before the dynamicDefault merge (agents live in `loaded`).
            //
            // Deliberately IN-MEMORY ONLY — we do NOT persist here. A
            // fire-and-forget `saveAppConfig` from `loadAppConfig` races with
            // `atomicModifyConfig` (which calls `loadAppConfig` while holding
            // `withConfigLock`): the queued save would land after the modifier's
            // write and clobber it. The disk heals opportunistically on the next
            // real config write (its `before` snapshot is taken post-normalize),
            // and the independent Rust reader normalizes the same way at boot.
            normalizeStringifiedJsonFields(migrated);
            promoteAgentMcpJsonToGlobal(migrated);
            const merged = normalizeDeveloperSettings({ ...dynamicDefault, ...migrated });
            return migrateImBotConfig(merged);
        }
        return normalizeLoadedConfig(dynamicDefault);
    } catch (error) {
        console.error('[configService] Failed to load app config:', error);
        return normalizeLoadedConfig(dynamicDefault);
    }
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
    if (isBrowserDevMode()) {
        mockSaveConfig(config);
        return;
    }

    return withConfigLock(async () => {
        try {
            await _writeAppConfigLocked(config);
        } catch (error) {
            console.error('[configService] Failed to save app config:', error);
            throw error;
        }
    });
}

export { CONFIG_CHANGED_EVENT, notifyConfigChanged, type ConfigChangeNotification } from './configEvents';
import { notifyConfigChanged, type ConfigChangeNotification } from './configEvents';

/**
 * Atomically read-modify-write the app config.
 *
 * On a real write (modifier produced a diff), normally fires
 * CONFIG_CHANGED_EVENT so ConfigProvider re-syncs its React state and effects
 * keyed on config fields (e.g. Chat's MCP push) re-run with the new values.
 * Composite multi-file transactions pass `notification: 'deferred'` and
 * publish once after every disk half reaches its final state. Idempotent writes
 * (before === after) do NOT fire the event — keeps the refresh cost
 * proportional to actual change.
 */
export async function atomicModifyConfig(
    modifier: (config: AppConfig) => AppConfig | Promise<AppConfig>,
    options: { notification: ConfigChangeNotification } = { notification: 'immediate' },
): Promise<AppConfig> {
    if (isBrowserDevMode()) {
        const latest = await loadAppConfig();
        const before = JSON.stringify(latest);
        const modified = await modifier(latest);
        mockSaveConfig(modified);
        if (JSON.stringify(modified) !== before && options.notification === 'immediate') {
            notifyConfigChanged('atomicModifyConfig');
        }
        return modified;
    }
    const result = await withConfigLock(async () => {
        const latest = await loadAppConfig();
        const before = JSON.stringify(latest);
        const modified = await modifier(latest);
        if (JSON.stringify(modified) === before) {
            return { config: modified, changed: false };
        }
        await _writeAppConfigLocked(modified);
        return { config: modified, changed: true };
    });
    if (result.changed && options.notification === 'immediate') {
        notifyConfigChanged('atomicModifyConfig');
    }
    return result.config;
}

/**
 * Internal: write config to disk without acquiring withConfigLock.
 * MUST only be called from within a withConfigLock block.
 */
async function _writeAppConfigLocked(config: AppConfig): Promise<void> {
    const normalized = normalizeLoadedConfig(config);
    if (isBrowserDevMode()) {
        mockSaveConfig(normalized);
        return;
    }
    await ensureConfigDir();
    const dir = await getConfigDir();
    const configPath = await join(dir, CONFIG_FILE);
    const latest = await safeLoadJson<AppConfig>(configPath, isValidAppConfig);
    const privateEnvelope = latest
        ? (latest as AppConfig & Record<string, unknown>)[PRIVATE_EXTERNAL_CLI_CONFIG_KEY]
        : undefined;
    await safeWriteJson(configPath, {
        ...normalized,
        ...(privateEnvelope === undefined
            ? {}
            : { [PRIVATE_EXTERNAL_CLI_CONFIG_KEY]: privateEnvelope }),
    });
}

// ============= Available Providers Cache =============

// ============= Bundled Workspace =============

let _bundledWorkspaceChecked = false;

export async function ensureBundledWorkspace(): Promise<boolean> {
    if (_bundledWorkspaceChecked) return false;
    _bundledWorkspaceChecked = true;

    if (isBrowserDevMode()) return false;

    try {
        // Lazy import to break circular dep (addProject is in projectService)
        const { addProject } = await import('./projectService');
        const { loadProjects } = await import('./projectService');

        const { invoke } = await import('@tauri-apps/api/core');
        const result = await invoke<{ path: string; is_new: boolean }>('cmd_initialize_bundled_workspace');
        const projects = await loadProjects();
        const found = projects.find(p => workspacePathsEqual(p.path, result.path));

        if (found) {
            const metadataPatch = getSystemPresetProjectMetadataPatch(found, DEFAULT_SYSTEM_PRESET_WORKSPACE_ID);
            if (Object.keys(metadataPatch).length > 0) {
                const { patchProject } = await import('./projectService');
                try {
                    await patchProject(found.id, metadataPatch);
                } catch (e) {
                    if (isLockBusyError(e)) throw e;
                    console.warn('[configService] Failed to repair bundled workspace metadata:', e);
                }
            }
            return result.is_new;
        }

        const project = await addProject(result.path);
        // Set Mino icon and display name for the bundled workspace
        const { patchProject } = await import('./projectService');
        try {
            const metadataPatch = getSystemPresetProjectMetadataPatch(project, DEFAULT_SYSTEM_PRESET_WORKSPACE_ID);
            await patchProject(project.id, metadataPatch);
        } catch (e) {
            if (isLockBusyError(e)) throw e;
            console.warn('[configService] Failed to set bundled workspace icon:', e);
        }

        if (result.is_new && !project.hidden) {
            await withConfigLock(async () => {
                const config = await loadAppConfig();
                if (!config.defaultWorkspacePath) {
                    await _writeAppConfigLocked({ ...config, defaultWorkspacePath: result.path });
                }
            });
            console.log('[configService] Bundled workspace initialized:', result.path);
            return result.is_new;
        }

        console.log(result.is_new
            ? '[configService] Bundled workspace initialized without default selection:'
            : '[configService] Bundled workspace recovered into projects:', result.path);
        return true;
    } catch (err) {
        if (isLockBusyError(err)) {
            _bundledWorkspaceChecked = false;
            throw err;
        }
        console.warn('[configService] ensureBundledWorkspace failed:', err);
        return false;
    }
}

// ============= Self-Awareness Workspace (Bug Report) =============

/**
 * Ensure ~/.myagents is registered as an internal project. Called on-demand when user triggers bug report.
 *
 * Accepts ConfigProvider's wrapped actions (addProject/patchProject) so that both disk AND React state
 * are updated. Calling projectService directly would only write to disk, leaving ConfigProvider stale.
 */
export async function ensureSelfAwarenessWorkspace(
    projects: Project[],
    addProject: (path: string) => Promise<Project>,
    patchProject: (id: string, updates: Partial<Omit<Project, 'id'>>) => Promise<void>,
): Promise<Project | null> {
    if (isBrowserDevMode()) return null;
    try {
        const dir = await getConfigDir();
        let project = projects.find(p => workspacePathsEqual(p.path, dir));
        if (!project) {
            project = await addProject(dir);
        }
        if (project && !project.internal) {
            await patchProject(project.id, { internal: true, name: `${APP_DISPLAY_NAME} 诊断` });
            // patchProject updates both disk and React state; use the patched fields locally
            project = { ...project, internal: true, name: `${APP_DISPLAY_NAME} 诊断` };
        }
        return project ?? null;
    } catch (err) {
        console.warn('[configService] ensureSelfAwarenessWorkspace failed:', err);
        return null;
    }
}
