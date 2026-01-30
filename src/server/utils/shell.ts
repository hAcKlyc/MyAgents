import { execSync } from 'child_process';
import { join } from 'path';
import { readdirSync, existsSync } from 'fs';

const isWindows = process.platform === 'win32';
const PATH_SEPARATOR = isWindows ? ';' : ':';

/**
 * Common binary paths for the current platform
 */
function getFallbackPaths(): string[] {
    if (isWindows) {
        const userProfile = process.env.USERPROFILE || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        const programFiles = process.env.PROGRAMFILES || '';

        return [
            userProfile ? join(userProfile, '.bun', 'bin') : '',
            localAppData ? join(localAppData, 'bun', 'bin') : '',
            programFiles ? join(programFiles, 'nodejs') : '',
            userProfile ? join(userProfile, 'AppData', 'Roaming', 'npm') : '',
        ].filter(Boolean);
    }

    // macOS/Linux paths
    const paths = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        process.env.HOME ? `${process.env.HOME}/.bun/bin` : '',
        process.env.HOME ? `${process.env.HOME}/.npm-global/bin` : '',
        process.env.HOME ? `${process.env.HOME}/Library/pnpm` : '',
    ];

    // Attempt to resolve NVM path manually if exists
    if (process.env.HOME) {
        const nvmDir = join(process.env.HOME, '.nvm', 'versions', 'node');
        if (existsSync(nvmDir)) {
            try {
                const versions = readdirSync(nvmDir)
                    .filter(v => v.startsWith('v'))
                    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

                if (versions.length > 0) {
                    const nvmBin = join(nvmDir, versions[0], 'bin');
                    paths.push(nvmBin);
                    console.log('[shell] Found NVM node path:', nvmBin);
                }
            } catch (e) {
                console.warn('[shell] Failed to resolve NVM paths:', e);
            }
        }
    }

    return paths.filter(Boolean);
}

let cachedPath: string | null = null;

/**
 * Detects the user's full shell PATH.
 * Essential for GUI apps (like Tauri) on macOS which don't inherit the user's shell environment.
 */
export function getShellPath(): string {
    if (cachedPath) return cachedPath;

    const fallback = getFallbackPaths().join(PATH_SEPARATOR);

    // On Windows, just use existing PATH with fallback paths prepended
    if (isWindows) {
        const existing = process.env.PATH || '';
        cachedPath = existing ? `${fallback}${PATH_SEPARATOR}${existing}` : fallback;
        console.log('[shell] Windows PATH configured');
        return cachedPath;
    }

    // macOS/Linux: Try to detect shell PATH
    try {
        const shell = process.env.SHELL || '/bin/zsh';
        const detectedPath = execSync(`${shell} -l -c 'echo $PATH'`, {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();

        if (detectedPath && detectedPath.length > 10) {
            console.log('[shell] Detected user PATH via shell');
            cachedPath = `${fallback}${PATH_SEPARATOR}${detectedPath}`;
            console.log('[shell] Final Merged PATH:', cachedPath);
            return cachedPath;
        }
    } catch (error) {
        console.warn('[shell] Failed to detect shell PATH via spawn:', error);
    }

    // Fallback
    console.log('[shell] Using fallback PATH construction ONLY');
    const existing = process.env.PATH || '';
    cachedPath = existing ? `${fallback}${PATH_SEPARATOR}${existing}` : fallback;
    console.log('[shell] Fallback PATH:', cachedPath);
    return cachedPath!;
}

/**
 * Returns an environment object with the corrected PATH
 */
export function getShellEnv(): Record<string, string> {
    const path = getShellPath();
    return {
        ...process.env,
        PATH: path
    };
}
