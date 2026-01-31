// Config service for managing app configuration using Tauri FS plugin
// Falls back to localStorage in browser development mode
import {
    exists,
    mkdir,
    readTextFile,
    writeTextFile,
    readDir,
    remove,
} from '@tauri-apps/plugin-fs';
import { homeDir, join, basename } from '@tauri-apps/api/path';

import {
    type AppConfig,
    DEFAULT_CONFIG,
    type Project,
    type Provider,
    PRESET_PROVIDERS,
    type McpInstallStatus,
    type McpInstallState,
} from './types';
import {
    isBrowserDevMode,
    mockLoadConfig,
    mockSaveConfig,
    mockLoadProjects,
    mockSaveProjects,
    mockAddProject,
} from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';

const CONFIG_DIR_NAME = '.myagents';
const CONFIG_FILE = 'config.json';
const PROJECTS_FILE = 'projects.json';
const PROVIDERS_DIR = 'providers';

let configDirPath: string | null = null;

async function getConfigDir(): Promise<string> {
    if (configDirPath) return configDirPath;

    const home = await homeDir();
    configDirPath = await join(home, CONFIG_DIR_NAME);
    console.log('[configService] Config directory:', configDirPath);
    return configDirPath;
}

async function ensureConfigDir(): Promise<void> {
    const dir = await getConfigDir();
    if (!(await exists(dir))) {
        console.log('[configService] Creating config directory:', dir);
        await mkdir(dir, { recursive: true });
    }

    const providersDir = await join(dir, PROVIDERS_DIR);
    if (!(await exists(providersDir))) {
        await mkdir(providersDir, { recursive: true });
    }
}

// App Config Management
export async function loadAppConfig(): Promise<AppConfig> {
    // Dynamic default: showDevTools defaults to true in dev mode, false in production
    const dynamicDefault: AppConfig = {
        ...DEFAULT_CONFIG,
        showDevTools: isDebugMode(),
    };

    // Browser mode: use localStorage
    if (isBrowserDevMode()) {
        console.log('[configService] Browser mode: loading from localStorage');
        const loaded = mockLoadConfig();
        // Merge with dynamic defaults, preserving explicit user settings
        return { ...dynamicDefault, ...loaded };
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const configPath = await join(dir, CONFIG_FILE);

        if (await exists(configPath)) {
            const content = await readTextFile(configPath);
            const loaded = JSON.parse(content);
            // Merge with dynamic defaults: if showDevTools was never explicitly set,
            // it will use the environment-based default
            return { ...dynamicDefault, ...loaded };
        }
        return dynamicDefault;
    } catch (error) {
        console.error('[configService] Failed to load app config:', error);
        return dynamicDefault;
    }
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
    if (isBrowserDevMode()) {
        mockSaveConfig(config);
        return;
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const configPath = await join(dir, CONFIG_FILE);
        await writeTextFile(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
        console.error('[configService] Failed to save app config:', error);
        throw error;
    }
}

// API Key Management (stored in AppConfig.providerApiKeys)
export async function saveApiKey(providerId: string, apiKey: string): Promise<void> {
    const config = await loadAppConfig();
    const apiKeys = config.providerApiKeys ?? {};
    apiKeys[providerId] = apiKey;
    await saveAppConfig({ ...config, providerApiKeys: apiKeys });
    console.log('[configService] Saved API key for provider:', providerId);
}

export async function loadApiKeys(): Promise<Record<string, string>> {
    const config = await loadAppConfig();
    return config.providerApiKeys ?? {};
}

export async function deleteApiKey(providerId: string): Promise<void> {
    const config = await loadAppConfig();
    const apiKeys = { ...config.providerApiKeys };
    delete apiKeys[providerId];
    // Also delete verification status when API key is deleted
    const verifyStatus = { ...config.providerVerifyStatus };
    delete verifyStatus[providerId];
    await saveAppConfig({ ...config, providerApiKeys: apiKeys, providerVerifyStatus: verifyStatus });
    console.log('[configService] Deleted API key for provider:', providerId);
}

// Provider Verification Status Management
import type { ProviderVerifyStatus } from './types';

export async function saveProviderVerifyStatus(
    providerId: string,
    status: 'valid' | 'invalid',
    accountEmail?: string
): Promise<void> {
    const config = await loadAppConfig();
    const verifyStatus = config.providerVerifyStatus ?? {};
    verifyStatus[providerId] = {
        status,
        verifiedAt: new Date().toISOString(),
        accountEmail,
    };
    await saveAppConfig({ ...config, providerVerifyStatus: verifyStatus });
    console.log('[configService] Saved verify status for provider:', providerId, status);
}

export async function loadProviderVerifyStatus(): Promise<Record<string, ProviderVerifyStatus>> {
    const config = await loadAppConfig();
    return config.providerVerifyStatus ?? {};
}

export async function deleteProviderVerifyStatus(providerId: string): Promise<void> {
    const config = await loadAppConfig();
    const verifyStatus = { ...config.providerVerifyStatus };
    delete verifyStatus[providerId];
    await saveAppConfig({ ...config, providerVerifyStatus: verifyStatus });
    console.log('[configService] Deleted verify status for provider:', providerId);
}

// ===== MCP Server Management =====
import { type McpServerDefinition, PRESET_MCP_SERVERS } from './types';

/**
 * Get all available MCP servers (preset + custom)
 */
export async function getAllMcpServers(): Promise<McpServerDefinition[]> {
    const config = await loadAppConfig();
    const customServers = config.mcpServers ?? [];
    return [...PRESET_MCP_SERVERS, ...customServers];
}

/**
 * Get globally enabled MCP server IDs
 */
export async function getEnabledMcpServerIds(): Promise<string[]> {
    const config = await loadAppConfig();
    return config.mcpEnabledServers ?? [];
}

/**
 * Toggle MCP server enabled status globally
 */
export async function toggleMcpServerEnabled(serverId: string, enabled: boolean): Promise<void> {
    const config = await loadAppConfig();
    const enabledServers = new Set(config.mcpEnabledServers ?? []);

    if (enabled) {
        enabledServers.add(serverId);
    } else {
        enabledServers.delete(serverId);
    }

    await saveAppConfig({ ...config, mcpEnabledServers: Array.from(enabledServers) });
    console.log('[configService] MCP server toggled:', serverId, enabled);
}

/**
 * Add a custom MCP server
 */
export async function addCustomMcpServer(server: McpServerDefinition): Promise<void> {
    const config = await loadAppConfig();
    const customServers = [...(config.mcpServers ?? [])];

    // Check if server with same ID exists
    const existingIndex = customServers.findIndex(s => s.id === server.id);
    if (existingIndex >= 0) {
        customServers[existingIndex] = server;
    } else {
        customServers.push(server);
    }

    await saveAppConfig({ ...config, mcpServers: customServers });
    console.log('[configService] Custom MCP server added:', server.id);
}

/**
 * Delete a custom MCP server
 */
export async function deleteCustomMcpServer(serverId: string): Promise<void> {
    const config = await loadAppConfig();
    const customServers = (config.mcpServers ?? []).filter(s => s.id !== serverId);

    // Also remove from enabled list
    const enabledServers = (config.mcpEnabledServers ?? []).filter(id => id !== serverId);

    await saveAppConfig({
        ...config,
        mcpServers: customServers,
        mcpEnabledServers: enabledServers,
    });
    console.log('[configService] Custom MCP server deleted:', serverId);
}

/**
 * Save MCP server environment variables (for servers requiring config like API keys)
 */
export async function saveMcpServerEnv(serverId: string, env: Record<string, string>): Promise<void> {
    const config = await loadAppConfig();
    const mcpServerEnv = { ...(config.mcpServerEnv ?? {}) };
    mcpServerEnv[serverId] = env;
    await saveAppConfig({ ...config, mcpServerEnv });
    console.log('[configService] MCP server env saved:', serverId);
}

/**
 * Get MCP server environment variables
 */
export async function getMcpServerEnv(serverId: string): Promise<Record<string, string>> {
    const config = await loadAppConfig();
    return config.mcpServerEnv?.[serverId] ?? {};
}

/**
 * Update workspace-level MCP enabled servers
 */
export async function updateProjectMcpServers(projectId: string, enabledServerIds: string[]): Promise<void> {
    const projects = await loadProjects();
    const index = projects.findIndex(p => p.id === projectId);
    if (index >= 0) {
        projects[index] = { ...projects[index], mcpEnabledServers: enabledServerIds };
        await saveProjects(projects);
        console.log('[configService] Project MCP servers updated:', projectId, enabledServerIds);
    }
}

/**
 * Get effective MCP servers for a project (called at query time)
 * Returns the MCP server configs that should be passed to the SDK
 */
export async function getEffectiveMcpServers(projectId: string): Promise<McpServerDefinition[]> {
    const projects = await loadProjects();
    const project = projects.find(p => p.id === projectId);
    const workspaceEnabledIds = project?.mcpEnabledServers ?? [];

    if (workspaceEnabledIds.length === 0) {
        return [];
    }

    const allServers = await getAllMcpServers();
    const config = await loadAppConfig();
    const globalEnabledIds = new Set(config.mcpEnabledServers ?? []);

    // Return servers that are: 1) globally enabled AND 2) enabled for this workspace
    return allServers.filter(s =>
        globalEnabledIds.has(s.id) && workspaceEnabledIds.includes(s.id)
    );
}

/**
 * Get MCP installation status for a server
 */
export async function getMcpInstallStatus(serverId: string): Promise<McpInstallState> {
    const config = await loadAppConfig();
    return config.mcpInstallStatus?.[serverId] ?? { status: 'idle' };
}

/**
 * Set MCP installation status for a server
 */
export async function setMcpInstallStatus(
    serverId: string,
    status: McpInstallStatus,
    error?: string
): Promise<void> {
    const config = await loadAppConfig();
    const mcpInstallStatus = { ...(config.mcpInstallStatus ?? {}) };
    mcpInstallStatus[serverId] = {
        status,
        error,
        installedAt: status === 'ready' ? new Date().toISOString() : undefined,
    };
    await saveAppConfig({ ...config, mcpInstallStatus });
    console.log('[configService] MCP install status updated:', serverId, status);
}

/**
 * Get all MCP installation statuses
 */
export async function getAllMcpInstallStatus(): Promise<Record<string, McpInstallState>> {
    const config = await loadAppConfig();
    return config.mcpInstallStatus ?? {};
}

// Helper to sort projects by lastOpened (most recent first)
function sortProjectsByLastOpened(projects: Project[]): Project[] {
    return [...projects].sort((a, b) => {
        const timeA = a.lastOpened ? new Date(a.lastOpened).getTime() : 0;
        const timeB = b.lastOpened ? new Date(b.lastOpened).getTime() : 0;
        return timeB - timeA; // Descending order (most recent first)
    });
}

// Projects Management
export async function loadProjects(): Promise<Project[]> {
    if (isBrowserDevMode()) {
        console.log('[configService] Browser mode: loading projects from localStorage');
        const projects = mockLoadProjects();
        return sortProjectsByLastOpened(projects);
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const projectsPath = await join(dir, PROJECTS_FILE);

        if (await exists(projectsPath)) {
            const content = await readTextFile(projectsPath);
            console.log('[configService] Loaded projects:', content.slice(0, 100));
            const projects = JSON.parse(content);
            return sortProjectsByLastOpened(projects);
        }
        console.log('[configService] No projects file found, returning empty array');
        return [];
    } catch (error) {
        console.error('[configService] Failed to load projects:', error);
        return [];
    }
}

export async function saveProjects(projects: Project[]): Promise<void> {
    if (isBrowserDevMode()) {
        mockSaveProjects(projects);
        return;
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const projectsPath = await join(dir, PROJECTS_FILE);
        console.log('[configService] Saving projects to:', projectsPath);
        await writeTextFile(projectsPath, JSON.stringify(projects, null, 2));
        console.log('[configService] Projects saved successfully');
    } catch (error) {
        console.error('[configService] Failed to save projects:', error);
        throw error;
    }
}

export async function addProject(path: string): Promise<Project> {
    console.log('[configService] addProject called with path:', path);

    if (isBrowserDevMode()) {
        console.log('[configService] Browser mode: using mock addProject');
        return mockAddProject(path);
    }

    const projects = await loadProjects();

    // Check if project already exists
    const existing = projects.find((p) => p.path === path);
    if (existing) {
        console.log('[configService] Project already exists, updating lastOpened');
        // Update lastOpened
        existing.lastOpened = new Date().toISOString();
        await saveProjects(projects);
        return existing;
    }

    // Create new project - use Tauri's basename for cross-platform path handling
    let name: string;
    try {
        name = await basename(path);
        // Validate basename result
        if (!name || name.trim().length === 0) {
            throw new Error('Empty basename result');
        }
    } catch (err) {
        console.warn('[configService] basename() failed, using fallback:', err);
        // Fallback: robust manual path parsing
        const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
        name = parts[parts.length - 1] || 'Unknown';
    }

    const newProject: Project = {
        id: crypto.randomUUID(),
        name,
        path,
        lastOpened: new Date().toISOString(),
        providerId: null,
        permissionMode: null,
    };

    console.log('[configService] Creating new project:', newProject);
    projects.push(newProject);
    await saveProjects(projects);
    return newProject;
}

export async function updateProject(project: Project): Promise<void> {
    const projects = await loadProjects();
    const index = projects.findIndex((p) => p.id === project.id);
    if (index >= 0) {
        projects[index] = project;
        await saveProjects(projects);
    }
}

export async function removeProject(projectId: string): Promise<void> {
    const projects = await loadProjects();
    const filtered = projects.filter((p) => p.id !== projectId);
    await saveProjects(filtered);
}

/**
 * Update lastOpened timestamp for a project (when it's opened/launched)
 * Returns the updated project or null if not found
 */
export async function touchProject(projectId: string): Promise<Project | null> {
    const projects = await loadProjects();
    const index = projects.findIndex((p) => p.id === projectId);
    if (index < 0) {
        console.warn('[configService] touchProject: project not found:', projectId);
        return null;
    }

    const updatedProject = {
        ...projects[index],
        lastOpened: new Date().toISOString(),
    };
    projects[index] = updatedProject;
    await saveProjects(projects);
    console.log('[configService] Project touched:', projectId);
    return updatedProject;
}

// Custom Providers Management
export async function loadCustomProviders(): Promise<Provider[]> {
    // Browser mode: no custom providers support
    if (isBrowserDevMode()) {
        return [];
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const providersDir = await join(dir, PROVIDERS_DIR);

        // Check if providers directory exists
        if (!(await exists(providersDir))) {
            return [];
        }

        // Read all JSON files in providers directory
        const entries = await readDir(providersDir);
        const providers: Provider[] = [];

        for (const entry of entries) {
            if (entry.isFile && entry.name.endsWith('.json')) {
                try {
                    const filePath = await join(providersDir, entry.name);
                    const content = await readTextFile(filePath);
                    const parsed = JSON.parse(content);
                    // Validate required fields
                    if (!parsed.id || !parsed.name || !parsed.config || !Array.isArray(parsed.models)) {
                        console.warn('[configService] Invalid provider file, skipping:', entry.name);
                        continue;
                    }
                    providers.push(parsed as Provider);
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

export async function getAllProviders(): Promise<Provider[]> {
    // Browser mode: just return preset providers
    if (isBrowserDevMode()) {
        return PRESET_PROVIDERS;
    }

    const customProviders = await loadCustomProviders();
    return [...PRESET_PROVIDERS, ...customProviders];
}

export async function saveCustomProvider(provider: Provider): Promise<void> {
    // Browser mode: custom providers not supported
    if (isBrowserDevMode()) {
        console.warn('[configService] Custom providers not supported in browser mode');
        return;
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const providerPath = await join(dir, PROVIDERS_DIR, `${provider.id}.json`);
        await writeTextFile(providerPath, JSON.stringify(provider, null, 2));
        if (isDebugMode()) {
            console.log('[configService] Saved custom provider:', provider.id);
        }
    } catch (error) {
        console.error('[configService] Failed to save custom provider:', error);
        throw error;
    }
}

export async function deleteCustomProvider(providerId: string): Promise<void> {
    // Browser mode: custom providers not supported
    if (isBrowserDevMode()) {
        return;
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const providerPath = await join(dir, PROVIDERS_DIR, `${providerId}.json`);

        if (await exists(providerPath)) {
            await remove(providerPath);
            if (isDebugMode()) {
                console.log('[configService] Deleted custom provider:', providerId);
            }
        }
    } catch (error) {
        console.error('[configService] Failed to delete custom provider:', error);
        throw error;
    }
}

// Project Settings Management (.claude/settings.json)
const PROJECT_SETTINGS_DIR = '.claude';
const PROJECT_SETTINGS_FILE = 'settings.json';

import { type ProjectSettings } from './types';

export async function loadProjectSettings(projectPath: string): Promise<ProjectSettings> {
    // Browser mode: return empty settings
    if (isBrowserDevMode()) {
        return {};
    }

    try {
        const settingsDir = await join(projectPath, PROJECT_SETTINGS_DIR);
        const settingsPath = await join(settingsDir, PROJECT_SETTINGS_FILE);

        if (await exists(settingsPath)) {
            const content = await readTextFile(settingsPath);
            return JSON.parse(content);
        }
        return {};
    } catch (error) {
        console.error('[configService] Failed to load project settings:', error);
        return {};
    }
}

export async function saveProjectSettings(projectPath: string, settings: ProjectSettings): Promise<void> {
    // Browser mode: no-op
    if (isBrowserDevMode()) {
        console.log('[configService] Browser mode: skipping project settings save');
        return;
    }

    try {
        const settingsDir = await join(projectPath, PROJECT_SETTINGS_DIR);
        const settingsPath = await join(settingsDir, PROJECT_SETTINGS_FILE);

        // Ensure .claude directory exists
        if (!(await exists(settingsDir))) {
            console.log('[configService] Creating .claude directory:', settingsDir);
            await mkdir(settingsDir, { recursive: true });
        }

        await writeTextFile(settingsPath, JSON.stringify(settings, null, 2));
        console.log('[configService] Saved project settings to:', settingsPath);
    } catch (error) {
        console.error('[configService] Failed to save project settings:', error);
        throw error;
    }
}

/**
 * Update project settings when provider changes
 * Maps provider config to environment variables
 */
export async function syncProviderToProjectSettings(
    projectPath: string,
    provider: Provider,
    apiKey?: string
): Promise<void> {
    const settings = await loadProjectSettings(projectPath);

    // Build env from provider config
    const env: Record<string, string> = {};
    if (provider.config.baseUrl) {
        env['ANTHROPIC_BASE_URL'] = provider.config.baseUrl;
    }
    if (apiKey) {
        env['ANTHROPIC_AUTH_TOKEN'] = apiKey;
    }
    // Use primaryModel as the default model
    if (provider.primaryModel) {
        env['ANTHROPIC_MODEL'] = provider.primaryModel;
    }
    // Set other model variants from models array if available
    const models = provider.models ?? [];
    for (const model of models) {
        if (model.modelSeries === 'claude') {
            if (model.modelName.toLowerCase().includes('haiku')) {
                env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = model.model;
            } else if (model.modelName.toLowerCase().includes('opus')) {
                env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = model.model;
            } else if (model.modelName.toLowerCase().includes('sonnet')) {
                env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = model.model;
            }
        }
    }

    await saveProjectSettings(projectPath, { ...settings, env });
}
