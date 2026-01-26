// Tauri IPC client for communicating with the Rust backend
// Handles sidecar lifecycle and provides server URL for HTTP communication

import { invoke } from '@tauri-apps/api/core';
import { isBrowserDevMode, isTauriEnvironment } from '@/utils/browserMock';

/** Sidecar status returned from Rust backend */
export interface SidecarStatus {
    running: boolean;
    port: number;
    agent_dir: string;
}

/** Check if we're running in Tauri environment */
export function isTauri(): boolean {
    return isTauriEnvironment();
}

/** Cache for server URL to avoid repeated IPC calls */
let cachedServerUrl: string | null = null;

/**
 * Start the sidecar for a project
 * @param agentDir - The directory for the agent workspace
 * @param initialPrompt - Optional initial prompt to start with
 * @returns Sidecar status with port and agent directory
 */
export async function startSidecar(
    agentDir: string,
    initialPrompt?: string
): Promise<SidecarStatus> {
    if (!isTauri()) {
        // Browser mode: call /agent/switch API to change directory
        console.debug('[tauriClient] Browser mode: calling /agent/switch API');
        try {
            const response = await fetch('/agent/switch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentDir, initialPrompt }),
            });
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Failed to switch agent directory');
            }
            console.debug('[tauriClient] Switched to:', result.agentDir);
            return {
                running: true,
                port: 3000,
                agent_dir: result.agentDir,
            };
        } catch (error) {
            console.error('[tauriClient] Failed to switch agent:', error);
            // Fallback to mock on error
            return {
                running: true,
                port: 3000,
                agent_dir: agentDir,
            };
        }
    }

    try {
        const status = await invoke<SidecarStatus>('cmd_start_sidecar', {
            agentDir,
            initialPrompt: initialPrompt ?? null,
        });

        // Update cached URL
        cachedServerUrl = `http://127.0.0.1:${status.port}`;

        return status;
    } catch (error) {
        console.error('Failed to start sidecar:', error);
        throw error;
    }
}

/**
 * Stop the running sidecar
 */
export async function stopSidecar(): Promise<void> {
    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_stop_sidecar');
        cachedServerUrl = null;
    } catch (error) {
        console.error('Failed to stop sidecar:', error);
        throw error;
    }
}

/**
 * Get the current sidecar status
 * @returns Sidecar status or null if not in Tauri
 */
export async function getSidecarStatus(): Promise<SidecarStatus | null> {
    if (!isTauri()) {
        return null;
    }

    try {
        return await invoke<SidecarStatus>('cmd_get_sidecar_status');
    } catch (error) {
        console.error('Failed to get sidecar status:', error);
        return null;
    }
}

/**
 * Get the backend server URL
 * Uses cached value if available, otherwise queries from Tauri
 * Returns empty string in browser mode so requests use relative paths (Vite proxy)
 * 
 * IMPORTANT: This does NOT cache failed URLs - each call will retry if sidecar is not running
 */
export async function getServerUrl(): Promise<string> {
    // Browser mode: return empty string so API calls use relative paths
    // This allows Vite's proxy to forward requests to localhost:3000
    if (!isTauri()) {
        console.debug('[tauriClient] Browser mode: using relative URLs (Vite proxy)');
        return '';
    }

    // Return cached URL if available
    if (cachedServerUrl) {
        return cachedServerUrl;
    }

    try {
        const url = await invoke<string>('cmd_get_server_url');
        cachedServerUrl = url;
        return url;
    } catch (error) {
        // Don't cache failed URL - let next call retry
        console.warn('[tauriClient] Sidecar not running:', error);
        throw new Error('Sidecar is not running');
    }
}

/**
 * Get server URL, auto-restarting sidecar if needed
 * This is the preferred method for resilient connections
 */
export async function getServerUrlWithAutoRestart(): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    try {
        // First, try to get the URL normally
        const url = await invoke<string>('cmd_get_server_url');
        cachedServerUrl = url;
        return url;
    } catch {
        // Sidecar not running, try to ensure it's running
        console.debug('[tauriClient] Sidecar not running, attempting auto-restart...');
        try {
            const status = await invoke<SidecarStatus>('cmd_ensure_sidecar_running');
            if (status.running) {
                const url = `http://127.0.0.1:${status.port}`;
                cachedServerUrl = url;
                console.debug('[tauriClient] Sidecar auto-restarted:', url);
                return url;
            }
        } catch (restartError) {
            console.error('[tauriClient] Auto-restart failed:', restartError);
        }
        throw new Error('Sidecar is not running and could not be restarted');
    }
}

/**
 * Restart the sidecar process
 */
export async function restartSidecar(): Promise<SidecarStatus> {
    if (!isTauri()) {
        return { running: true, port: 3000, agent_dir: '' };
    }

    resetServerUrlCache();
    return invoke<SidecarStatus>('cmd_restart_sidecar');
}

/**
 * Ensure sidecar is running, restart if needed
 */
export async function ensureSidecarRunning(): Promise<SidecarStatus> {
    if (!isTauri()) {
        return { running: true, port: 3000, agent_dir: '' };
    }

    resetServerUrlCache();
    return invoke<SidecarStatus>('cmd_ensure_sidecar_running');
}

/**
 * Check if sidecar process is still alive (real-time check)
 */
export async function checkSidecarAlive(): Promise<boolean> {
    if (!isTauri()) {
        return true;
    }

    try {
        return await invoke<boolean>('cmd_check_sidecar_alive');
    } catch {
        return false;
    }
}

/**
 * Build a full API URL for the given endpoint
 * @param endpoint - The API endpoint (e.g., '/chat/send')
 */
export async function getApiUrl(endpoint: string): Promise<string> {
    const baseUrl = await getServerUrl();
    return `${baseUrl}${endpoint}`;
}

/**
 * Reset the cached server URL (useful when stopping/restarting sidecar)
 */
export function resetServerUrlCache(): void {
    cachedServerUrl = null;
}

/** HTTP response from Rust proxy */
interface ProxyHttpResponse {
    status: number;
    body: string;
    headers: Record<string, string>;
    /** True if body is base64 encoded (for binary responses like images) */
    is_base64: boolean;
}

/**
 * Proxy HTTP request through Rust to bypass WebView CORS
 * Falls back to native fetch in browser mode
 */
export async function proxyFetch(
    url: string,
    options?: RequestInit
): Promise<Response> {
    // Browser mode: use native fetch (Vite proxy handles CORS)
    if (!isTauri()) {
        return fetch(url, options);
    }

    const method = options?.method || 'GET';
    const body = options?.body ? String(options.body) : undefined;

    // Extract headers
    const headers: Record<string, string> = {};
    if (options?.headers) {
        if (options.headers instanceof Headers) {
            options.headers.forEach((value, key) => {
                headers[key] = value;
            });
        } else if (Array.isArray(options.headers)) {
            options.headers.forEach(([key, value]) => {
                headers[key] = value;
            });
        } else {
            Object.assign(headers, options.headers);
        }
    }

    try {
        const result = await invoke<ProxyHttpResponse>('proxy_http_request', {
            request: {
                url,
                method,
                body,
                headers: Object.keys(headers).length > 0 ? headers : null,
            }
        });

        // Handle base64 encoded binary responses
        if (result.is_base64) {
            // Decode base64 to binary
            const binaryString = atob(result.body);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return new Response(bytes, {
                status: result.status,
                headers: result.headers,
            });
        }

        // Create a Response-like object for text responses
        return new Response(result.body, {
            status: result.status,
            headers: result.headers,
        });
    } catch (error) {
        console.error('[proxyFetch] Error:', error);
        throw error;
    }
}

/**
 * POST JSON through Rust proxy
 */
export async function proxyPostJson<T>(endpoint: string, data: unknown): Promise<T> {
    const baseUrl = await getServerUrl();
    const url = `${baseUrl}${endpoint}`;

    const response = await proxyFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return response.json();
}

/**
 * POST JSON with automatic sidecar restart on failure
 * This is the resilient version that handles sidecar crashes
 * 
 * @param endpoint - API endpoint
 * @param data - Request payload
 * @param maxRetries - Maximum retry attempts (default: 1)
 */
export async function proxyPostJsonWithRetry<T>(
    endpoint: string,
    data: unknown,
    maxRetries: number = 1
): Promise<T> {
    // Browser mode: use normal fetch without retry logic
    if (!isTauri()) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        return response.json();
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // Use auto-restart URL getter for resilience
            const baseUrl = await getServerUrlWithAutoRestart();
            const url = `${baseUrl}${endpoint}`;

            const response = await proxyFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            return await response.json();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.warn(`[tauriClient] Request failed (attempt ${attempt + 1}/${maxRetries + 1}):`, lastError.message);

            if (attempt < maxRetries) {
                // Clear cache and try to restart sidecar before next attempt
                resetServerUrlCache();
                console.debug('[tauriClient] Attempting sidecar restart before retry...');
                try {
                    await ensureSidecarRunning();
                    // Wait a bit for sidecar to be fully ready
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (restartError) {
                    console.error('[tauriClient] Sidecar restart failed:', restartError);
                }
            }
        }
    }

    throw lastError || new Error('Request failed after retries');
}

// ============= Multi-instance Sidecar API =============
// These functions support per-Tab Sidecar instances

/** Cache for per-Tab server URLs */
const tabServerUrls = new Map<string, string>();

/**
 * Start a Sidecar for a specific Tab
 * @param tabId - Unique Tab identifier
 * @param agentDir - Optional agent directory (null for global sidecar)
 */
export async function startTabSidecar(
    tabId: string,
    agentDir?: string
): Promise<SidecarStatus> {
    if (!isTauri()) {
        // Browser mode: call /agent/switch for compatibility
        if (agentDir) {
            try {
                const response = await fetch('/agent/switch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agentDir }),
                });
                const result = await response.json();
                if (result.success) {
                    tabServerUrls.set(tabId, '');
                    return { running: true, port: 3000, agent_dir: result.agentDir };
                }
            } catch (error) {
                console.error('[tauriClient] Browser mode switch failed:', error);
            }
        }
        tabServerUrls.set(tabId, '');
        return { running: true, port: 3000, agent_dir: agentDir || '' };
    }

    try {
        const status = await invoke<SidecarStatus>('cmd_start_tab_sidecar', {
            tabId,
            agentDir: agentDir ?? null,
        });
        const url = `http://127.0.0.1:${status.port}`;
        tabServerUrls.set(tabId, url);
        console.debug(`[tauriClient] Tab ${tabId} sidecar started on port ${status.port}`);
        return status;
    } catch (error) {
        console.error(`[tauriClient] Failed to start sidecar for tab ${tabId}:`, error);
        throw error;
    }
}

/**
 * Stop a Sidecar for a specific Tab
 * @param tabId - Tab identifier
 */
export async function stopTabSidecar(tabId: string): Promise<void> {
    tabServerUrls.delete(tabId);

    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_stop_tab_sidecar', { tabId });
        console.debug(`[tauriClient] Tab ${tabId} sidecar stopped`);
    } catch (error) {
        console.error(`[tauriClient] Failed to stop sidecar for tab ${tabId}:`, error);
        // Don't throw - cleanup should be best-effort
    }
}

/**
 * Get server URL for a specific Tab
 * @param tabId - Tab identifier
 */
export async function getTabServerUrl(tabId: string): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    // Check cache first
    const cached = tabServerUrls.get(tabId);
    if (cached !== undefined) {
        return cached;
    }

    try {
        const url = await invoke<string>('cmd_get_tab_server_url', { tabId });
        tabServerUrls.set(tabId, url);
        return url;
    } catch (error) {
        console.warn(`[tauriClient] No sidecar for tab ${tabId}:`, error);
        throw new Error(`No running sidecar for tab ${tabId}`);
    }
}

/**
 * Get sidecar status for a specific Tab
 * @param tabId - Tab identifier
 */
export async function getTabSidecarStatus(tabId: string): Promise<SidecarStatus | null> {
    if (!isTauri()) {
        return null;
    }

    try {
        return await invoke<SidecarStatus>('cmd_get_tab_sidecar_status', { tabId });
    } catch (error) {
        console.error(`[tauriClient] Failed to get status for tab ${tabId}:`, error);
        return null;
    }
}

/**
 * Start the global Sidecar (used by Settings page)
 */
export async function startGlobalSidecar(): Promise<SidecarStatus> {
    if (!isTauri()) {
        return { running: true, port: 3000, agent_dir: '' };
    }

    try {
        const status = await invoke<SidecarStatus>('cmd_start_global_sidecar');
        const url = `http://127.0.0.1:${status.port}`;
        tabServerUrls.set('__global__', url);
        console.debug(`[tauriClient] Global sidecar started on port ${status.port}`);
        return status;
    } catch (error) {
        console.error('[tauriClient] Failed to start global sidecar:', error);
        throw error;
    }
}

/** Promise that resolves when global sidecar is ready */
let globalSidecarReadyPromise: Promise<void> | null = null;
let globalSidecarReadyResolve: (() => void) | null = null;

/**
 * Initialize the global sidecar ready promise
 * Called from App.tsx before starting the sidecar
 */
export function initGlobalSidecarReadyPromise(): void {
    if (!globalSidecarReadyPromise) {
        globalSidecarReadyPromise = new Promise<void>((resolve) => {
            globalSidecarReadyResolve = resolve;
        });
    }
}

/**
 * Mark global sidecar as ready
 * Called from App.tsx after sidecar starts successfully
 */
export function markGlobalSidecarReady(): void {
    if (globalSidecarReadyResolve) {
        globalSidecarReadyResolve();
        globalSidecarReadyResolve = null;
    }
}

/**
 * Reset global sidecar ready promise for retry scenarios
 * Called from App.tsx when retrying sidecar startup
 */
export function resetGlobalSidecarReadyPromise(): void {
    globalSidecarReadyPromise = null;
    globalSidecarReadyResolve = null;
}

/**
 * Wait for global sidecar to be ready (with timeout)
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 60000)
 * Note: Timeout is set higher to accommodate macOS permission dialogs
 * that may appear on first launch and require user interaction
 */
export async function waitForGlobalSidecar(timeoutMs: number = 60000): Promise<void> {
    if (!isTauri()) {
        return;
    }

    if (!globalSidecarReadyPromise) {
        // Promise not initialized yet, create one that will resolve when sidecar starts
        initGlobalSidecarReadyPromise();
    }

    // Race between the ready promise and a timeout
    // Use a cleanup pattern to avoid timer leaks
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Global sidecar startup timeout')), timeoutMs);
    });

    try {
        await Promise.race([globalSidecarReadyPromise, timeoutPromise]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * Get global sidecar server URL (for Settings page)
 */
export async function getGlobalServerUrl(): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    const cached = tabServerUrls.get('__global__');
    if (cached !== undefined) {
        return cached;
    }

    try {
        const url = await invoke<string>('cmd_get_global_server_url');
        tabServerUrls.set('__global__', url);
        return url;
    } catch (error) {
        console.warn('[tauriClient] Global sidecar not running:', error);
        throw new Error('Global sidecar is not running');
    }
}

/**
 * Get global sidecar server URL, waiting for it to be ready if needed
 * This is the preferred method for components that need the global sidecar
 */
export async function getGlobalServerUrlWithWait(): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    // First check cache
    const cached = tabServerUrls.get('__global__');
    if (cached !== undefined) {
        return cached;
    }

    // Wait for sidecar to be ready
    await waitForGlobalSidecar();

    // Now get the URL
    return getGlobalServerUrl();
}

/**
 * Stop all Sidecar instances (for app exit)
 */
export async function stopAllSidecars(): Promise<void> {
    tabServerUrls.clear();

    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_stop_all_sidecars');
        console.debug('[tauriClient] All sidecars stopped');
    } catch (error) {
        console.error('[tauriClient] Failed to stop all sidecars:', error);
    }
}

/**
 * Reset Tab server URL cache for a specific Tab
 */
export function resetTabServerUrlCache(tabId: string): void {
    tabServerUrls.delete(tabId);
}
