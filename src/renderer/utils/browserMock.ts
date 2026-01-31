// Browser Mock for Tauri APIs
// Allows the app to run in browser for rapid development without Tauri

import type { Project, Provider, AppConfig, PermissionMode } from '@/config/types';
import { DEFAULT_CONFIG, PRESET_PROVIDERS } from '@/config/types';

// Storage keys
const STORAGE_KEYS = {
    CONFIG: 'myagents:config',
    PROJECTS: 'myagents:projects',
    PROVIDERS: 'myagents:providers',
};

/** Check if running in Tauri environment */
export function isTauriEnvironment(): boolean {
    if (typeof window === 'undefined') return false;

    // Check multiple Tauri indicators
    const hasTauriGlobal = '__TAURI__' in window;
    const hasTauriInternals = '__TAURI_INTERNALS__' in window;

    // Also check if we're running from tauri:// protocol (bundled app)
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const isTauriProtocol = protocol === 'tauri:' ||
        (protocol === 'https:' && hostname === 'tauri.localhost');

    const result = hasTauriGlobal || hasTauriInternals || isTauriProtocol;

    // Log detection result on first check
    if (!isTauriEnvironment._logged) {
        isTauriEnvironment._logged = true;
        console.log('[isTauriEnvironment] Detection:', {
            hasTauriGlobal,
            hasTauriInternals,
            protocol,
            hostname,
            isTauriProtocol,
            result
        });
    }

    return result;
}
// Flag to log only once
isTauriEnvironment._logged = false;

/** Check if running in development browser mode */
export function isBrowserDevMode(): boolean {
    // Only consider browser mode if NOT in Tauri AND running on localhost dev server
    if (isTauriEnvironment()) return false;

    // Check if we're on localhost (Vite dev server)
    const isLocalhost = typeof window !== 'undefined' &&
        (window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1');

    return isLocalhost;
}

// ============= FS Mock =============

/** Load config from localStorage */
export function mockLoadConfig(): AppConfig {
    try {
        const stored = localStorage.getItem(STORAGE_KEYS.CONFIG);
        if (stored) {
            return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
        }
    } catch (e) {
        console.warn('[browserMock] Failed to load config:', e);
    }
    return DEFAULT_CONFIG;
}

/** Save config to localStorage */
export function mockSaveConfig(config: AppConfig): void {
    try {
        localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(config));
        console.log('[browserMock] Config saved');
    } catch (e) {
        console.warn('[browserMock] Failed to save config:', e);
    }
}

/** Load projects from localStorage */
export function mockLoadProjects(): Project[] {
    try {
        const stored = localStorage.getItem(STORAGE_KEYS.PROJECTS);
        if (stored) {
            return JSON.parse(stored);
        }
    } catch (e) {
        console.warn('[browserMock] Failed to load projects:', e);
    }
    return [];
}

/** Save projects to localStorage */
export function mockSaveProjects(projects: Project[]): void {
    try {
        localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(projects));
        console.log('[browserMock] Projects saved:', projects.length);
    } catch (e) {
        console.warn('[browserMock] Failed to save projects:', e);
    }
}

/** Add a project (mock version) */
export function mockAddProject(path: string): Project {
    const projects = mockLoadProjects();

    // Check if exists
    const existing = projects.find(p => p.path === path);
    if (existing) {
        existing.lastOpened = new Date().toISOString();
        mockSaveProjects(projects);
        return existing;
    }

    // Create new - normalize path separators and extract folder name
    const normalizedPath = path.replace(/\\/g, '/');
    const parts = normalizedPath.split('/').filter(p => p.length > 0);
    const name = parts[parts.length - 1] || 'Mock Project';
    const newProject: Project = {
        id: `mock-${Date.now()}`,
        name,
        path,
        lastOpened: new Date().toISOString(),
        providerId: null,
        permissionMode: null,
    };

    projects.push(newProject);
    mockSaveProjects(projects);
    return newProject;
}

// ============= Dialog Mock =============

// Storage key for last used project directory
const LAST_PROJECT_DIR_KEY = 'myagents:lastProjectDir';

/**
 * Get a smart default project directory based on:
 * 1. Last manually entered project path
 * 2. Existing project paths in localStorage
 * 3. Common macOS project location
 */
function getSmartDefaultProjectDir(): string {
    // Check last used directory
    const lastDir = localStorage.getItem(LAST_PROJECT_DIR_KEY);
    if (lastDir) {
        return lastDir;
    }

    // Check existing projects for common parent directory
    const projects = mockLoadProjects();
    if (projects.length > 0) {
        const lastProject = projects[projects.length - 1];
        // Get parent directory of the last project
        const parentDir = lastProject.path.split('/').slice(0, -1).join('/');
        if (parentDir) {
            return parentDir;
        }
    }

    // Default to common macOS project location
    return `/Users/user/Documents/project`;
}

/**
 * Pick a folder and return folder info for custom dialog
 * Returns folder name and smart default path, without showing prompt
 * The calling component should show its own dialog for path confirmation
 */
export async function pickFolderForDialog(): Promise<{ folderName: string; defaultPath: string } | null> {
    let folderName = 'my-project';

    if ('showDirectoryPicker' in window) {
        try {
            // @ts-expect-error - showDirectoryPicker is not in TypeScript's lib yet
            const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
            folderName = dirHandle.name;
            console.log('[browserMock] Selected directory name:', folderName);
        } catch (err) {
            if ((err as Error).name === 'AbortError') {
                // In some environments (e.g., Playwright, some browsers), showDirectoryPicker
                // may be automatically cancelled. Fall through to show the path dialog instead.
                console.log('[browserMock] Directory picker cancelled, showing path dialog instead');
            }
            // Fall through with default folder name
        }
    }

    // Always show path dialog in browser dev mode (even if directory picker was cancelled)
    // This allows users to manually enter paths when the native picker doesn't work

    // Get smart default directory based on existing projects
    const defaultParentDir = getSmartDefaultProjectDir();
    const defaultPath = `${defaultParentDir}/${folderName}`;

    return { folderName, defaultPath };
}

/** @deprecated Use pickFolderForDialog instead - window.prompt gets blocked by browser security */
export async function mockOpenFolderDialog(): Promise<string | null> {
    // Try using showDirectoryPicker to get directory name as a hint
    let dirNameHint = 'my-project';

    if ('showDirectoryPicker' in window) {
        try {
            // @ts-expect-error - showDirectoryPicker is not in TypeScript's lib yet
            const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
            dirNameHint = dirHandle.name;
            console.log('[browserMock] Selected directory name:', dirNameHint);
        } catch (err) {
            if ((err as Error).name === 'AbortError') {
                console.log('[browserMock] User cancelled directory selection');
                return null;
            }
            // Fall through to prompt
        }
    }

    // Get smart default directory based on existing projects
    const defaultParentDir = getSmartDefaultProjectDir();
    const defaultPath = `${defaultParentDir}/${dirNameHint}`;

    // Prompt for full path confirmation
    const path = window.prompt(
        `确认项目路径\n\n` +
        `已选择文件夹: ${dirNameHint}\n` +
        `请确认或修改完整路径:`,
        defaultPath
    );

    // Save the parent directory for next time
    if (path) {
        const parentDir = path.split('/').slice(0, -1).join('/');
        if (parentDir) {
            localStorage.setItem(LAST_PROJECT_DIR_KEY, parentDir);
        }
    }

    return path;
}

// ============= Server URL Mock =============

/** Get server URL - browser mode uses localhost:3000 */
export function mockGetServerUrl(): string {
    return 'http://localhost:3000';
}

// ============= Debug Console =============

interface LogEntry {
    time: string;
    level: 'log' | 'warn' | 'error';
    message: string;
}

const logBuffer: LogEntry[] = [];
const MAX_LOGS = 100;

/** Capture logs for debug console */
export function captureLog(level: 'log' | 'warn' | 'error', ...args: unknown[]): void {
    const entry: LogEntry = {
        time: new Date().toLocaleTimeString(),
        level,
        message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
    };

    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOGS) {
        logBuffer.shift();
    }
}

/** Get all captured logs */
export function getLogs(): LogEntry[] {
    return [...logBuffer];
}

/** Clear logs */
export function clearLogs(): void {
    logBuffer.length = 0;
}

// Override console in development
if (isBrowserDevMode()) {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args) => {
        captureLog('log', ...args);
        originalLog.apply(console, args);
    };

    console.warn = (...args) => {
        captureLog('warn', ...args);
        originalWarn.apply(console, args);
    };

    console.error = (...args) => {
        captureLog('error', ...args);
        originalError.apply(console, args);
    };

    console.log('[browserMock] 🌐 Running in browser development mode');
}
