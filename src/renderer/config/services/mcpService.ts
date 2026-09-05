// MCP server management — CRUD, env, args, effective servers
import type { AppConfig, McpServerDefinition } from '../types';
import { PRESET_MCP_SERVERS } from '../types';
import { withProjectsLock } from './configStore';
import { loadAppConfig, atomicModifyConfig } from './appConfigService';
import { loadProjects, saveProjects } from './projectService';
import { apiPostJson } from '@/api/apiFetch';
import { applyMcpServerConfigAdditions } from '../../../shared/mcpConfig';
import {
    DEFAULT_STANDARD_PLAYWRIGHT_ARGS,
    MANAGED_BROWSER_MCP_ID,
    STANDARD_PLAYWRIGHT_MCP_ID,
    isReservedBuiltinBrowserMcpId,
} from '../../../shared/browserTools';

/**
 * Detect host platform in the renderer using the same vocabulary as
 * `process.platform` (`'darwin' | 'win32' | 'linux'`). `navigator.platform`
 * is reliable enough for a coarse 3-way split and matches the existing
 * pattern used elsewhere in the renderer (see App.tsx, TitleBar.tsx).
 */
function getRendererPlatform(): NodeJS.Platform {
    if (typeof navigator === 'undefined') return 'linux';
    const p = navigator.platform.toLowerCase();
    if (p.includes('mac')) return 'darwin';
    if (p.includes('win')) return 'win32';
    return 'linux';
}

/**
 * Filter out presets whose `platforms` field doesn't include the host.
 * Keeps platform-specific presets invisible
 * everywhere on unsupported hosts. Mirror of admin-config.ts filter —
 * the two sites share the same semantic so catalogue and effective server
 * list stay in sync.
 */
function getPlatformFilteredPresets(): McpServerDefinition[] {
    const host = getRendererPlatform();
    return PRESET_MCP_SERVERS.filter(p => !p.platforms || p.platforms.includes(host));
}

/**
 * Synchronous variant — merges preset + custom MCP servers from an
 * already-loaded `AppConfig`. Same semantics as `getAllMcpServers` (custom
 * overrides ordinary presets on id collision; reserved Browser IDs remain
 * built-in; user args/env are merged; presets are
 * filtered by host platform), but takes the config as a parameter so
 * callers that already hold an in-memory snapshot (`useConfig().config`)
 * don't pay the disk-read round-trip and don't need an async hook.
 *
 * Single source of truth for "what MCP catalogue does the renderer
 * consider available right now" — both `getAllMcpServers` (async / disk)
 * and renderer components (sync / in-memory) go through this. Without
 * the shared core, components were duplicating preset+custom merge logic
 * (and silently dropping args/env overrides; see TaskAdvancedConfigEditor
 * v0.2.4 review).
 */
export function getAllMcpServersFromConfig(config: AppConfig): McpServerDefinition[] {
    const customServers = (Array.isArray(config.mcpServers) ? config.mcpServers : [])
        .filter(server => !isReservedBuiltinBrowserMcpId(server.id));
    // Custom servers may override ordinary presets, but the two product-owned
    // Browser identities are reserved and always resolve to their presets.
    // (aligned with server-side getAllMcpServers in admin-config.ts)
    const customIds = new Set(customServers.map(s => s.id));
    const allServers = [
        ...getPlatformFilteredPresets().filter(p => !customIds.has(p.id)),
        ...customServers,
    ];
    return applyMcpServerConfigAdditions(allServers, config);
}

/**
 * Async variant — loads the config from disk and returns the merged MCP
 * catalogue. Use when the caller has no in-memory config (most legacy
 * callers); for components inside `<ConfigProvider>` prefer the sync
 * `getAllMcpServersFromConfig(config)` to avoid the disk round-trip.
 *
 * Defensive: all disk-loaded array fields are validated with Array.isArray()
 * before spread, because config.json is a trust boundary.
 */
export async function getAllMcpServers(): Promise<McpServerDefinition[]> {
    const config = await loadAppConfig();
    return getAllMcpServersFromConfig(config);
}

export async function getEnabledMcpServerIds(): Promise<string[]> {
    const config = await loadAppConfig();
    return Array.isArray(config.mcpEnabledServers) ? config.mcpEnabledServers : [];
}

/** Global catalogue availability: toggling one server never changes a peer. */
export function applyMcpServerAvailabilityToggle(
    current: readonly string[],
    serverId: string,
    enabled: boolean,
    managedBrowserReady: boolean,
): string[] {
    const next = new Set(current);
    if (!enabled) {
        next.delete(serverId);
        return [...next];
    }
    if (serverId === MANAGED_BROWSER_MCP_ID && !managedBrowserReady) {
        return [...next];
    }
    next.add(serverId);
    return [...next];
}

export function applyMcpServerToggleToConfig(
    config: AppConfig,
    serverId: string,
    enabled: boolean,
    managedBrowserReady: boolean,
): AppConfig {
    const current = Array.isArray(config.mcpEnabledServers) ? config.mcpEnabledServers : [];
    const shouldPersistPlaywrightDefault = enabled
        && serverId === STANDARD_PLAYWRIGHT_MCP_ID
        && config.mcpServerArgs?.[STANDARD_PLAYWRIGHT_MCP_ID] === undefined;
    return {
        ...config,
        mcpEnabledServers: applyMcpServerAvailabilityToggle(
            current,
            serverId,
            enabled,
            managedBrowserReady,
        ),
        ...(shouldPersistPlaywrightDefault ? {
            mcpServerArgs: {
                ...(config.mcpServerArgs ?? {}),
                [STANDARD_PLAYWRIGHT_MCP_ID]: [...DEFAULT_STANDARD_PLAYWRIGHT_ARGS],
            },
        } : {}),
    };
}

export async function toggleMcpServerEnabled(
    serverId: string,
    enabled: boolean,
    managedBrowserReady: boolean,
): Promise<void> {
    await atomicModifyConfig(c => applyMcpServerToggleToConfig(
        c,
        serverId,
        enabled,
        managedBrowserReady,
    ));
    console.log('[configService] MCP server toggled:', serverId, enabled);
}

export async function addCustomMcpServer(server: McpServerDefinition): Promise<void> {
    if (isReservedBuiltinBrowserMcpId(server.id)) {
        throw new Error(`MCP ID "${server.id}" is reserved by a built-in Browser tool`);
    }
    await atomicModifyConfig(c => {
        const customServers = [...(Array.isArray(c.mcpServers) ? c.mcpServers : [])];
        const existingIndex = customServers.findIndex(s => s.id === server.id);
        if (existingIndex >= 0) {
            customServers[existingIndex] = server;
        } else {
            customServers.push(server);
        }
        return { ...c, mcpServers: customServers };
    });
    console.log('[configService] Custom MCP server added:', server.id);
}

export async function deleteCustomMcpServer(serverId: string): Promise<void> {
    const result = await apiPostJson<{ success: boolean; error?: string }>('/api/admin/mcp/remove', { id: serverId });
    if (!result.success) {
        throw new Error(result.error ?? 'Failed to delete MCP server');
    }
    console.log('[configService] Custom MCP server deleted:', serverId);
}

export async function saveMcpServerEnv(serverId: string, env: Record<string, string>): Promise<void> {
    await atomicModifyConfig(c => ({
        ...c,
        mcpServerEnv: { ...(c.mcpServerEnv ?? {}), [serverId]: env },
    }));
    console.log('[configService] MCP server env saved:', serverId);
}

export async function getMcpServerEnv(serverId: string): Promise<Record<string, string>> {
    const config = await loadAppConfig();
    return config.mcpServerEnv?.[serverId] ?? {};
}

export async function saveMcpServerArgs(serverId: string, args: string[]): Promise<void> {
    await atomicModifyConfig(c => ({
        ...c,
        mcpServerArgs: { ...(c.mcpServerArgs ?? {}), [serverId]: args },
    }));
    console.log('[configService] MCP server args saved:', serverId);
}

export async function getMcpServerArgs(serverId: string): Promise<string[] | undefined> {
    const config = await loadAppConfig();
    const args = config.mcpServerArgs?.[serverId];
    return Array.isArray(args) ? args : undefined;
}

export async function updateProjectMcpServers(projectId: string, enabledServerIds: string[]): Promise<void> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const index = projects.findIndex(p => p.id === projectId);
        if (index >= 0) {
            projects[index] = { ...projects[index], mcpEnabledServers: enabledServerIds };
            await saveProjects(projects);
            console.log('[configService] Project MCP servers updated:', projectId, enabledServerIds);
        }
    });
}

export async function getEffectiveMcpServers(projectId: string): Promise<McpServerDefinition[]> {
    const projects = await loadProjects();
    const project = projects.find(p => p.id === projectId);
    const workspaceEnabledIds = Array.isArray(project?.mcpEnabledServers) ? project.mcpEnabledServers : [];

    if (workspaceEnabledIds.length === 0) {
        return [];
    }

    const allServers = await getAllMcpServers();
    const config = await loadAppConfig();
    const globalEnabledIds = new Set(Array.isArray(config.mcpEnabledServers) ? config.mcpEnabledServers : []);

    return allServers.filter(s =>
        globalEnabledIds.has(s.id) && workspaceEnabledIds.includes(s.id)
    );
}
