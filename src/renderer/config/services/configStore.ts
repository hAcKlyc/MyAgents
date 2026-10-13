// Infrastructure layer — async locks, safe file I/O, config directory management
import {
    copyFile,
    exists,
    mkdir,
    readTextFile,
    writeTextFile,
    remove,
    rename,
    stat,
} from '@tauri-apps/plugin-fs';
import { homeDir, join, dirname } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { isBrowserDevMode } from '@/utils/browserMock';
import { APP_DATA_DIR_NAME } from '../../../shared/appProfile';
import { stripBom } from '../../../shared/utils';

// Re-export for convenience
export { isBrowserDevMode };

// ============= Async Lock =============

export function createAsyncLock() {
    let queue: Promise<void> = Promise.resolve();
    return function withLock<T>(fn: () => Promise<T>): Promise<T> {
        let release: () => void;
        const next = new Promise<void>(resolve => { release = resolve; });
        const prev = queue;
        queue = next;
        return prev.then(fn).finally(() => release!());
    };
}

const withProjectsProcessLock = createAsyncLock();
const withAgentConfigIntentProcessLock = createAsyncLock();
const withConfigProcessLock = createAsyncLock();

const CONFIG_LOCK_TIMEOUT_MS = 5000;
const CONFIG_LOCK_POLL_MS = 50;
const CONFIG_LOCK_STALE_MS = 30000;

export class FileBusyError extends Error {
    readonly code: string = 'FILE_BUSY';

    constructor(
        readonly lockPath: string,
        readonly timeoutMs: number,
        message = `File busy: could not acquire ${lockPath} within ${timeoutMs}ms; retry`,
    ) {
        super(message);
        this.name = 'FileBusyError';
    }
}

export class ConfigBusyError extends FileBusyError {
    readonly code = 'CONFIG_BUSY';

    constructor(lockPath: string, timeoutMs: number) {
        super(lockPath, timeoutMs, `Config busy: could not acquire config.json.lock within ${timeoutMs}ms; retry`);
        this.name = 'ConfigBusyError';
    }
}

export class ProjectsBusyError extends FileBusyError {
    readonly code = 'PROJECTS_BUSY';

    constructor(lockPath: string, timeoutMs: number) {
        super(lockPath, timeoutMs, `Projects busy: could not acquire projects.json.lock within ${timeoutMs}ms; retry`);
        this.name = 'ProjectsBusyError';
    }
}

export class AgentConfigIntentBusyError extends FileBusyError {
    readonly code = 'AGENT_CONFIG_INTENT_BUSY';

    constructor(lockPath: string, timeoutMs: number) {
        super(lockPath, timeoutMs, `Agent config intent busy: could not acquire agent-config-intent.lock within ${timeoutMs}ms; retry`);
        this.name = 'AgentConfigIntentBusyError';
    }
}

const LOCK_BUSY_CODES = new Set([
    'FILE_BUSY',
    'CONFIG_BUSY',
    'PROJECTS_BUSY',
    'AGENT_CONFIG_INTENT_BUSY',
    'PROVIDER_BUSY',
]);

export function isLockBusyError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false;
    return LOCK_BUSY_CODES.has(String(error.code));
}

// ============= Constants =============

export const CONFIG_DIR_NAME = APP_DATA_DIR_NAME;
export const CONFIG_FILE = 'config.json';
export const PROJECTS_FILE = 'projects.json';
export const PROVIDERS_DIR = 'providers';

export async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    return withConfigProcessLock(async () => {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const configPath = await join(dir, CONFIG_FILE);
        try {
            return await withFileLock(configPath, fn);
        } catch (error) {
            if (error instanceof FileBusyError && error.code === 'FILE_BUSY') {
                throw new ConfigBusyError(error.lockPath, error.timeoutMs);
            }
            throw error;
        }
    });
}

/**
 * Serialize a projects.json read-modify-write across renderer and Sidecar
 * processes. Callers still own the in-lock read and write; this helper owns
 * both the in-process queue and the shared mkdir lock.
 */
export async function withProjectsLock<T>(fn: () => Promise<T>): Promise<T> {
    return withProjectsProcessLock(async () => {
        if (typeof window === 'undefined' || isBrowserDevMode()) return fn();
        await ensureConfigDir();
        const dir = await getConfigDir();
        const projectsPath = await join(dir, PROJECTS_FILE);
        try {
            return await withFileLock(projectsPath, fn);
        } catch (error) {
            if (error instanceof FileBusyError && error.code === 'FILE_BUSY') {
                throw new ProjectsBusyError(error.lockPath, error.timeoutMs);
            }
            throw error;
        }
    });
}

/**
 * Serialize one logical Agent-default intent across config.json and the
 * projects.json compatibility mirror. This path intentionally matches the
 * Sidecar lock (`~/.myagents/agent-config-intent.lock`).
 */
export async function withAgentConfigIntentLock<T>(fn: () => Promise<T>): Promise<T> {
    return withAgentConfigIntentProcessLock(async () => {
        if (typeof window === 'undefined' || isBrowserDevMode()) return fn();
        await ensureConfigDir();
        const dir = await getConfigDir();
        const intentPath = await join(dir, 'agent-config-intent');
        try {
            return await withFileLock(intentPath, fn);
        } catch (error) {
            if (error instanceof FileBusyError && error.code === 'FILE_BUSY') {
                throw new AgentConfigIntentBusyError(error.lockPath, error.timeoutMs);
            }
            throw error;
        }
    });
}

// ============= Safe File I/O Utilities =============

/**
 * Atomically write JSON data to a file with .bak backup.
 *
 * Steps:
 * 1. Write to .tmp (if interrupted here, original file is untouched)
 * 2. Copy current file → .bak (best-effort backup; main file stays intact)
 * 3. Rename .tmp → target (atomic overwrite — main is never absent)
 *
 * Key invariant: the main file is never removed. rename() atomically replaces
 * the destination on both POSIX (rename syscall) and Windows (MOVEFILE_REPLACE_EXISTING).
 * This eliminates the window where concurrent readers would see "file not found".
 */
export async function safeWriteJson(filePath: string, data: unknown): Promise<void> {
    const tmpPath = filePath + '.tmp';
    const bakPath = filePath + '.bak';
    const content = JSON.stringify(data, null, 2);

    // 1. Write new data to .tmp
    await writeTextFile(tmpPath, content);
    await fsyncPath(tmpPath, false);

    // 2. Backup current file → .bak (best-effort, copy preserves main)
    try {
        if (await exists(filePath)) {
            // Tauri fs copyFile uses std::fs::copy, which overwrites an existing
            // destination. Removing first adds an ENOENT race and a backup gap.
            await copyFile(filePath, bakPath);
        }
    } catch (bakErr) {
        console.warn('[configStore] Failed to create .bak backup:', bakErr);
    }

    // 3. Atomic overwrite: .tmp → target (main file is never absent)
    await rename(tmpPath, filePath);
    await fsyncPath(await dirname(filePath), true);
}

/**
 * Load and parse a JSON file with automatic recovery from .bak and .tmp.
 *
 * Read-only: this function never writes files. Recovery from .bak/.tmp is
 * transparent — the next safeWriteJson call will overwrite main with fresh data.
 * This avoids race conditions where a "recovery write" inside a read could
 * conflict with a concurrent writer holding the config lock.
 */
export async function safeLoadJson<T>(
    filePath: string,
    validate?: (data: unknown) => data is T,
): Promise<T | null> {
    const candidates = [
        { path: filePath, label: 'main' },
        { path: filePath + '.bak', label: 'bak' },
        { path: filePath + '.tmp', label: 'tmp' },
    ];

    for (const { path, label } of candidates) {
        if (!(await exists(path))) continue;
        try {
            const content = await readTextFile(path);
            const parsed = JSON.parse(stripBom(content));
            if (validate && !validate(parsed)) {
                console.error(`[configStore] ${label} file has invalid structure, skipping`);
                continue;
            }
            if (label !== 'main') {
                console.warn(`[configStore] Recovered data from .${label} file (next write will restore main)`);
            }
            return parsed as T;
        } catch (err) {
            console.error(`[configStore] ${label} file corrupted or unreadable:`, err);
        }
    }
    return null;
}

// ============= Config Directory =============

let configDirPath: string | null = null;

export async function getConfigDir(): Promise<string> {
    if (configDirPath) return configDirPath;

    const home = await homeDir();
    configDirPath = await join(home, CONFIG_DIR_NAME);
    console.log('[configStore] Config directory:', configDirPath);
    return configDirPath;
}

export async function ensureConfigDir(): Promise<void> {
    const dir = await getConfigDir();
    if (!(await exists(dir))) {
        console.log('[configStore] Creating config directory:', dir);
        await mkdir(dir, { recursive: true });
    }

    const providersDir = await join(dir, PROVIDERS_DIR);
    if (!(await exists(providersDir))) {
        await mkdir(providersDir, { recursive: true });
    }
}

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = filePath + '.lock';
    const ownerToken = await acquireFileLock(lockDir);
    try {
        return await fn();
    } finally {
        await releaseFileLock(lockDir, ownerToken);
    }
}

async function acquireFileLock(lockDir: string): Promise<string> {
    const start = Date.now();
    while (true) {
        try {
            await mkdir(lockDir);
        } catch (error) {
            // A mkdir failure only means contention while the target lock
            // directory actually exists. Permission and filesystem errors
            // must retain their real identity.
            if (!(await exists(lockDir))) throw error;

            // mkdir failed — lock dir already exists. Try stale-recovery before
            // sleeping. The renderer can't observe other processes' pids, so it
            // relies on the renderer-written owner timestamp (`renderer:<ts>`)
            // and falls through to age-based break for non-renderer owners (a
            // node/rust crash leaves a long-stale dir; 30s is generous).
            if (await tryBreakStaleLock(lockDir)) {
                continue;
            }

            if (Date.now() - start >= CONFIG_LOCK_TIMEOUT_MS) {
                throw new FileBusyError(lockDir, CONFIG_LOCK_TIMEOUT_MS);
            }
            await delay(CONFIG_LOCK_POLL_MS);
            continue;
        }

        const ownerToken = `renderer:${Date.now()}:${crypto.randomUUID()}`;
        try {
            await writeTextFile(await join(lockDir, 'owner'), `${ownerToken}\n`);
        } catch (error) {
            // Owner identity is part of safe release, not merely diagnostic.
            // Never retain a lock we cannot prove is ours.
            await remove(lockDir, { recursive: true }).catch(() => undefined);
            throw error;
        }
        return ownerToken;
    }
}

/**
 * Decide whether a lock with the given age (ms) and owner string should be
 * forcibly broken.
 *
 * The renderer can't probe Node/Rust pid liveness directly (it's sandboxed in
 * Tauri's WebView), so for non-renderer owners the best it can do is age-only
 * break. We use a more conservative threshold (4× staleMs) for those owners
 * to avoid breaking a slow-but-live writer — Node/Rust recover their own stale
 * locks much faster on the next acquire, and at worst we race with their
 * recovery and the loser just retries.
 *
 * Trade-off: if a sidecar / Rust process truly crashes mid-write, the renderer
 * will block for ~4× staleMs before recovering. That's acceptable because (a)
 * sidecar crashes are rare, and (b) on next sidecar restart the Node-side
 * helper observes its own dead pid and breaks the lock immediately.
 */
const RENDERER_OWNER_PATTERN = /^renderer:(\d+)(?::[0-9a-f-]+)?$/i;

function shouldBreakStaleLock(ageMs: number, owner: string, staleMs: number): boolean {
    if (RENDERER_OWNER_PATTERN.test(owner)) {
        return ageMs > staleMs; // we trust mtime for our own runtime.
    }
    if (owner.startsWith('node:') || owner.startsWith('rust:')) {
        // Node/Rust owners: pid-liveness probe not available from the renderer.
        // Use a 4× threshold to be conservative.
        return ageMs > staleMs * 4;
    }
    // Missing, malformed, and legacy owner metadata must not create a
    // permanent lock. Use the same conservative age threshold as an owner
    // whose liveness the renderer cannot inspect.
    return ageMs > staleMs * 4;
}

async function tryBreakStaleLock(lockDir: string): Promise<boolean> {
    let owner = '';
    try {
        owner = (await readTextFile(await join(lockDir, 'owner'))).trim();
    } catch {
        // A writer can terminate between mkdir and owner metadata creation.
        // Age-only recovery below prevents that partial acquisition from
        // blocking all future writers forever.
    }

    // Compute age. For renderer:<ts> owners we have an embedded timestamp
    // (used as a fast path). For node:/rust: owners we read mtime from the
    // lockdir itself. In all cases the owner string also gates whether we're
    // willing to break this kind of owner at all.
    let ageMs: number | null = null;
    const rendererMatch = RENDERER_OWNER_PATTERN.exec(owner);
    if (rendererMatch) {
        const ts = Number(rendererMatch[1]);
        if (Number.isFinite(ts)) ageMs = Date.now() - ts;
    }
    if (ageMs === null) {
        try {
            const info = await stat(lockDir);
            if (info.mtime instanceof Date) {
                ageMs = Date.now() - info.mtime.getTime();
            }
        } catch {
            // Lock dir disappeared between EEXIST and stat — caller will retry mkdir.
            return true;
        }
    }
    if (ageMs === null) return false;

    if (!shouldBreakStaleLock(ageMs, owner, CONFIG_LOCK_STALE_MS)) return false;

    console.warn(`[configStore] Breaking stale lock ${lockDir} (age=${ageMs}ms owner=${owner})`);
    const tombstone = `${lockDir}.stale-renderer-${crypto.randomUUID()}`;
    try {
        await rename(lockDir, tombstone);
        await remove(tombstone, { recursive: true }).catch(() => undefined);
        return true;
    } catch {
        return false;
    }
}

async function releaseFileLock(lockDir: string, ownerToken: string): Promise<void> {
    try {
        const currentOwner = (await readTextFile(await join(lockDir, 'owner'))).trim();
        if (currentOwner !== ownerToken) {
            console.warn(`[configStore] Lock owner changed before release; preserving successor lock ${lockDir}`);
            return;
        }
        await remove(lockDir, { recursive: true });
    } catch (error) {
        console.warn(`[configStore] Failed to release lock ${lockDir}:`, error);
    }
}

async function fsyncPath(path: string, directory: boolean): Promise<void> {
    if (isBrowserDevMode()) return;
    await invoke('cmd_fsync_path', { path, directory });
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
