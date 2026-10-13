import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
import { execFile } from 'child_process';
import { posix as pathPosix, win32 as pathWin32 } from 'path';
import { readdirSync, existsSync } from 'fs';
import { getMyAgentsNpmGlobalBinDir } from './npm-prefix-env';
import { getBundledNodeDir } from './runtime';

const isWindows = process.platform === 'win32';
const PATH_KEY = isWindows ? 'Path' : 'PATH';

type PathPlatform = NodeJS.Platform;
type EnvLike = Record<string, string | undefined>;

interface FallbackPathOptions {
    platform?: PathPlatform;
    env?: EnvLike;
    bundledNodeDir?: string | null;
    exists?: (path: string) => boolean;
    readDir?: (path: string) => string[];
}

function joinForPlatform(platform: PathPlatform, ...parts: string[]): string {
    return platform === 'win32' ? pathWin32.join(...parts) : pathPosix.join(...parts);
}

function normalizeForPlatform(platform: PathPlatform, value: string): string {
    return platform === 'win32' ? pathWin32.normalize(value) : pathPosix.normalize(value);
}

function pathSeparatorFor(platform: PathPlatform): string {
    return platform === 'win32' ? ';' : ':';
}

function pathKeyFor(platform: PathPlatform): 'Path' | 'PATH' {
    return platform === 'win32' ? 'Path' : 'PATH';
}

function envValue(env: EnvLike, key: string): string {
    return env[key] || '';
}

function pushPath(parts: string[], value: string | null | undefined, platform: PathPlatform): void {
    if (!value) return;
    const normalized = normalizeForPlatform(platform, value);
    const comparable = platform === 'win32' ? normalized.toLowerCase() : normalized;
    const existsAlready = parts.some((part) => {
        const existing = normalizeForPlatform(platform, part);
        return (platform === 'win32' ? existing.toLowerCase() : existing) === comparable;
    });
    if (!existsAlready) {
        parts.push(normalized);
    }
}

/**
 * Common binary paths for the current platform
 */
export function getFallbackPaths(options: FallbackPathOptions = {}): string[] {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const exists = options.exists ?? existsSync;
    const readDir = options.readDir ?? readdirSync;
    const bundledNodeDir = options.bundledNodeDir === undefined
        ? getBundledNodeDir()
        : options.bundledNodeDir;

    if (platform === 'win32') {
        const userProfile = envValue(env, 'USERPROFILE');
        const localAppData = envValue(env, 'LOCALAPPDATA');
        const appData = envValue(env, 'APPDATA');
        const programFiles = envValue(env, 'PROGRAMFILES');
        const programFilesX86 = envValue(env, 'PROGRAMFILES(X86)');
        const nvmSymlink = envValue(env, 'NVM_SYMLINK');
        const fnmPath = envValue(env, 'FNM_MULTISHELL_PATH');
        const paths: string[] = [];

        // Keep this in sync with buildClaudeSessionEnv(): product-owned
        // launchers first, then runtimes and package-manager fallbacks.
        pushPath(paths, userProfile ? joinForPlatform(platform, userProfile, APP_DATA_DIR_NAME, 'bin') : '', platform);
        pushPath(paths, programFiles ? joinForPlatform(platform, programFiles, 'nodejs') : '', platform);
        pushPath(paths, programFilesX86 ? joinForPlatform(platform, programFilesX86, 'nodejs') : '', platform);
        pushPath(paths, nvmSymlink, platform);
        pushPath(paths, localAppData ? joinForPlatform(platform, localAppData, 'Volta', 'bin') : '', platform);
        pushPath(paths, fnmPath, platform);
        pushPath(paths, appData ? joinForPlatform(platform, appData, 'npm') : '', platform);
        pushPath(paths, userProfile ? joinForPlatform(platform, userProfile, 'AppData', 'Roaming', 'npm') : '', platform);
        pushPath(paths, bundledNodeDir, platform);
        pushPath(paths, localAppData ? joinForPlatform(platform, localAppData, 'MyAgents', 'nodejs') : '', platform);
        pushPath(paths, getMyAgentsNpmGlobalBinDir(userProfile, platform), platform);
        pushPath(paths, userProfile ? joinForPlatform(platform, userProfile, '.bun', 'bin') : '', platform);
        pushPath(paths, localAppData ? joinForPlatform(platform, localAppData, 'bun', 'bin') : '', platform);
        // Git for Windows — SDK requires git; PATH may be stale after NSIS install
        pushPath(paths, programFiles ? joinForPlatform(platform, programFiles, 'Git', 'cmd') : '', platform);
        pushPath(paths, programFilesX86 ? joinForPlatform(platform, programFilesX86, 'Git', 'cmd') : '', platform);
        pushPath(paths, localAppData ? joinForPlatform(platform, localAppData, 'Programs', 'Git', 'cmd') : '', platform);
        return paths;
    }

    // macOS/Linux paths — cover common package managers and version managers.
    // GUI apps don't inherit shell PATH, so we enumerate known binary directories.
    const home = envValue(env, 'HOME');
    const paths: string[] = [];
    pushPath(paths, home ? `${home}/${APP_DATA_DIR_NAME}/bin` : '', platform);
    pushPath(paths, '/opt/homebrew/bin', platform);        // macOS Apple Silicon homebrew
    pushPath(paths, '/usr/local/bin', platform);           // macOS Intel homebrew / Linux system
    pushPath(paths, '/usr/bin', platform);
    pushPath(paths, '/bin', platform);
    pushPath(paths, bundledNodeDir, platform);
    pushPath(paths, getMyAgentsNpmGlobalBinDir(home, platform), platform);
    pushPath(paths, home ? `${home}/.local/bin` : '', platform);          // Claude Code / pipx / XDG user-local
    pushPath(paths, home ? `${home}/.bun/bin` : '', platform);            // Bun global installs
    pushPath(paths, home ? `${home}/.npm-global/bin` : '', platform);     // npm custom global prefix
    pushPath(paths, home ? `${home}/.cargo/bin` : '', platform);          // Rust / cargo installs
    pushPath(paths, home ? `${home}/.volta/bin` : '', platform);          // Volta (Node version manager)
    pushPath(paths, home ? `${home}/Library/pnpm` : '', platform);        // pnpm (macOS)

    // Attempt to resolve NVM paths manually if exists.
    // Add ALL installed versions (sorted highest-first so the newest takes PATH priority).
    // Used only after the inherited/detected PATH, including when shell discovery
    // fails. Never let this version ordering override the user's selected Node.
    if (home) {
        const nvmDir = joinForPlatform(platform, home, '.nvm', 'versions', 'node');
        if (exists(nvmDir)) {
            try {
                const versions = readDir(nvmDir)
                    .filter(v => v.startsWith('v'))
                    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

                for (const v of versions) {
                    pushPath(paths, joinForPlatform(platform, nvmDir, v, 'bin'), platform);
                }
                if (versions.length > 0) {
                    console.log('[shell] Found NVM node versions:', versions.join(', '));
                }
            } catch (e) {
                console.warn('[shell] Failed to resolve NVM paths:', e);
            }
        }

        // fnm (Fast Node Manager) — ~/.local/share/fnm/aliases/default/bin
        const fnmDir = joinForPlatform(platform, home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin');
        if (exists(fnmDir)) pushPath(paths, fnmDir, platform);

        // asdf version manager — ~/.asdf/shims
        const asdfDir = joinForPlatform(platform, home, '.asdf', 'shims');
        if (exists(asdfDir)) pushPath(paths, asdfDir, platform);

        // mise (formerly rtx) — ~/.local/share/mise/shims
        const miseDir = joinForPlatform(platform, home, '.local', 'share', 'mise', 'shims');
        if (exists(miseDir)) pushPath(paths, miseDir, platform);
    }

    return paths;
}

/**
 * Preserve the selected shell's directory order, then append missing inherited
 * and fallback directories. Rust system_binary uses the same fixture cases.
 */
export function mergeSearchPaths(options: {
    platform: PathPlatform;
    inheritedPath: string;
    shellPath?: string | null;
    fallbackPaths: string[];
}): string {
    const separator = pathSeparatorFor(options.platform);
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const value of [
        ...(options.shellPath ?? '').split(separator),
        ...options.inheritedPath.split(separator),
        ...options.fallbackPaths,
    ]) {
        if (!value) continue;
        const key = options.platform === 'win32' ? value.toLowerCase() : value;
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push(value);
    }
    return parts.join(separator);
}

/** Inherited PATH first; common directories are only a discovery fallback. */
export function buildFallbackPath(options: FallbackPathOptions = {}): string {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const pathKey = pathKeyFor(platform);
    const existing = env[pathKey] || env.PATH || '';
    return mergeSearchPaths({ platform, inheritedPath: existing, fallbackPaths: getFallbackPaths(options) });
}

// Populated lazily with the fallback PATH on first sync read.
let cachedPath: string | null = null;
// Set once the async interactive-shell detection completes. Its order takes
// precedence over the inherited GUI environment and fallback directories.
let detectedUserPath: string | null = null;
// Promise guard — ensures exactly one concurrent execFile to the shell.
let warmupInFlight: Promise<void> | null = null;

/**
 * Proxy env vars captured from the user's interactive shell during warmup
 * (issue #194). When the user runs `codex` / `claude` directly in terminal,
 * THESE are the values their CLI subprocess inherits. RuntimeEnvPolicy
 * `proxy: 'terminal'` will substitute these into the external-runtime spawn
 * env so MyAgents behaves consistently with terminal invocations.
 *
 * Each key's value is `null` while warmup hasn't completed, an empty string
 * `''` if the user's shell has the var explicitly unset, or the value otherwise.
 * `''` is intentionally distinct from null: it means "we asked, user said no".
 */
const TERMINAL_PROXY_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
] as const;
type TerminalProxyEnv = Partial<Record<typeof TERMINAL_PROXY_KEYS[number], string>>;
let detectedTerminalProxyEnv: TerminalProxyEnv | null = null;

/**
 * Synchronous PATH getter. Non-blocking by design:
 *   - First call returns the fallback PATH immediately
 *   - After warmup, preserves detected user PATH before fallback directories
 *   - Never calls execSync (which would block the Node event loop and starve
 *     TCP accept during sidecar startup — measured 4-5s hang on slow .zshrc)
 *
 * Call `warmupShellPath()` once at process startup to kick off the async
 * interactive-shell detection. Callers that need the *detected* PATH (not just
 * fallback) and can wait should use `ensureShellPath()`.
 */
export function getShellPath(): string {
    if (cachedPath && detectedUserPath === null) {
        // Fallback-only cache. Return it; warmup may still be pending.
        return cachedPath;
    }
    if (cachedPath && detectedUserPath) {
        return cachedPath;
    }
    cachedPath = buildFallbackPath();
    return cachedPath;
}

/**
 * Returns an environment object with the corrected PATH.
 * Sync — uses whatever PATH `getShellPath()` can return right now.
 */
export function getShellEnv(): Record<string, string> {
    const path = getShellPath();
    const env = { ...process.env } as Record<string, string>;
    // Ensure single PATH key — Windows env may have Path or PATH;
    // spreading process.env into a plain object loses case-insensitivity,
    // so both casings can coexist and confuse child_process.spawn().
    delete env.PATH;
    delete env.Path;
    env[PATH_KEY] = path;
    return env;
}

/**
 * Awaitable PATH getter — waits for the interactive-shell detection if it's
 * still in flight, then returns the enriched PATH. Falls back to the sync
 * PATH on Windows or if detection failed.
 *
 * Use this from async user-initiated flows (e.g. MCP verify) where we'd rather
 * wait ~1-3s for a complete PATH than miss a user-installed binary.
 */
export async function ensureShellPath(): Promise<string> {
    await warmupShellPath();
    return getShellPath();
}

/**
 * Kick off interactive-shell PATH detection in the background.
 *
 * Why not synchronous (the way this used to work):
 *   User shells with heavy .zshrc (oh-my-zsh, p10k, conda, etc.) can take
 *   3-5 seconds to spawn interactively. execSync would block the Node event
 *   loop for that entire duration — and since Node's HTTP accept is serviced
 *   on the event loop, TCP connections from Rust's health check were silently
 *   queued. Sidecar startup appeared frozen until the shell returned.
 *
 * Now: `execFile` is used with a Promise-wrapped callback, so detection runs
 * asynchronously without blocking. Startup is instant; detection finishes
 * whenever the shell returns (or times out).
 *
 * Safe to call multiple times — subsequent calls no-op while the first
 * detection is in flight or after it has completed.
 */
export function warmupShellPath(): Promise<void> {
    if (warmupInFlight) return warmupInFlight;
    if (detectedUserPath !== null) return Promise.resolve(); // already done

    // Windows: no interactive-shell detection, just prime the fallback cache.
    if (isWindows) {
        detectedUserPath = '';
        cachedPath = buildFallbackPath();
        console.log('[shell] Windows PATH configured (fallback only)');
        return Promise.resolve();
    }

    warmupInFlight = new Promise<void>((resolve) => {
        const shell = process.env.SHELL || '/bin/zsh';
        const pathMarker = `__MYAGENTS_PATH_${process.pid}__`;
        const proxyMarker = `__MYAGENTS_PROXY_${process.pid}__`;
        // Compose one shell invocation that captures BOTH the user's PATH and
        // their proxy-related env vars (issue #194). Cheaper than two shell
        // spawns; each var emitted between dedicated markers so we can parse
        // them out regardless of MOTD / p10k banner noise. `${VAR:-}` ensures
        // unset vars still produce empty output rather than aborting the echo.
        //
        // CRITICAL: each proxy line MUST be wrapped in `echo "..."` — without
        // it, `__MARKER__KEY=VALUE__MARKER__` parses as a shell *assignment*,
        // not output, so the entire proxy capture silently produces nothing
        // (Codex review #1 catch — would have made `proxy: 'terminal'` behave
        // identically to `direct` for everyone).
        const proxyEcho = TERMINAL_PROXY_KEYS
            .map(k => `echo "${proxyMarker}${k}=\${${k}:-}${proxyMarker}"`)
            .join(';');
        const cmd = `echo "${pathMarker}\${PATH}${pathMarker}";${proxyEcho}`;

        // -i interactive + -l login → sources both .zprofile and .zshrc (where
        // NVM/fnm/pnpm typically live). Marker isolates $PATH from noisy output
        // (MOTD, p10k banners, conda activation msgs).
        execFile(
            shell,
            ['-i', '-l', '-c', cmd],
            {
                encoding: 'utf-8',
                timeout: 5000,
                maxBuffer: 1024 * 1024,
            },
            (error, stdout) => {
                try {
                    if (error) {
                        console.warn(
                            '[shell] Interactive PATH detection failed, staying on fallback:',
                            error.message,
                        );
                        return;
                    }
                    const pathMatch = stdout.match(new RegExp(`${pathMarker}(.+?)${pathMarker}`));
                    if (pathMatch && pathMatch[1].length > 10) {
                        detectedUserPath = pathMatch[1];
                        cachedPath = mergeSearchPaths({
                            platform: process.platform,
                            shellPath: detectedUserPath,
                            inheritedPath: buildFallbackPath(),
                            fallbackPaths: [],
                        });
                        console.log('[shell] Detected user PATH via interactive shell');
                    }
                    // Parse proxy env vars — each `${proxyMarker}KEY=VALUE${proxyMarker}`.
                    // Capture both case spellings; both can coexist in user rc files.
                    const captured: TerminalProxyEnv = {};
                    const proxyRe = new RegExp(`${proxyMarker}([A-Z_a-z]+)=([^]*?)${proxyMarker}`, 'g');
                    let m: RegExpExecArray | null;
                    while ((m = proxyRe.exec(stdout)) !== null) {
                        const key = m[1] as typeof TERMINAL_PROXY_KEYS[number];
                        if (TERMINAL_PROXY_KEYS.includes(key)) {
                            captured[key] = m[2]; // empty string means "user has no value set"
                        }
                    }
                    detectedTerminalProxyEnv = captured;
                    const present = (Object.entries(captured) as Array<[string, string]>)
                        .filter(([_, v]) => v.length > 0)
                        .map(([k]) => k);
                    if (present.length > 0) {
                        console.log(`[shell] Detected terminal proxy env: ${present.join(', ')}`);
                    } else {
                        console.log('[shell] No terminal-shell proxy env detected (user has none)');
                    }
                } finally {
                    // Make sure we don't leave warmupInFlight dangling; future
                    // sync callers still work off the fallback even if detection
                    // produced nothing useful.
                    detectedUserPath = detectedUserPath ?? '';
                    // Empty-object fallback so getDetectedTerminalProxy() never
                    // returns null after warmup, distinguishing "not yet warmed"
                    // from "warmed, user has nothing".
                    detectedTerminalProxyEnv = detectedTerminalProxyEnv ?? {};
                    warmupInFlight = null;
                    resolve();
                }
            },
        );
    });
    return warmupInFlight;
}

/**
 * Return the proxy env vars detected from the user's interactive shell during
 * `warmupShellPath()` (issue #194).
 *
 * Return value semantics:
 *  - `null`: warmup hasn't run yet. Caller should treat as "no info".
 *  - `{}`: warmup ran but user has no proxy env set. Distinct from null —
 *     caller can safely strip MyAgents-injected proxy vars from the subprocess
 *     env in this case (terminal-parity = unset).
 *  - `{ HTTP_PROXY: '…', … }`: real values to inject into subprocess env.
 *     Always check both upper- and lower-case keys when applying.
 */
export function getDetectedTerminalProxyEnv(): TerminalProxyEnv | null {
    return detectedTerminalProxyEnv;
}
