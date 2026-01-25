import { execSync } from 'child_process';
import { join } from 'path';
import { readdirSync, existsSync } from 'fs';

/**
 * Common binary paths for macOS to look for if shell detection fails
 */
function getFallbackPaths(): string[] {
    const paths = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        process.env.HOME ? `${process.env.HOME}/.bun/bin` : '',
        process.env.HOME ? `${process.env.HOME}/.npm-global/bin` : '', // npm global without nvm
        process.env.HOME ? `${process.env.HOME}/Library/pnpm` : '', // pnpm
    ];

    // Attempt to resolve NVM path manually if exists
    if (process.env.HOME) {
        const nvmDir = join(process.env.HOME, '.nvm', 'versions', 'node');
        if (existsSync(nvmDir)) {
            try {
                // Find the latest version directory
                const versions = readdirSync(nvmDir)
                    .filter(v => v.startsWith('v'))
                    .sort((a, b) => {
                        // Simple sort by version desc (string compare works for v20 vs v19, but v20 vs v9 needs numeric)
                        return b.localeCompare(a, undefined, { numeric: true });
                    });

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

    // Always calculate fallback/common paths
    const fallback = getFallbackPaths().join(':');

    try {
        // execute shell with login flag (-l) and command (-c) to print PATH
        const shell = process.env.SHELL || '/bin/zsh';
        const detectedPath = execSync(`${shell} -l -c 'echo $PATH'`, {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();

        if (detectedPath && detectedPath.length > 10) {
            console.log('[shell] Detected user PATH via zsh');
            // CRITICAL FIX: Merge fallback into detected path to ensure npx is found 
            // even if zsh profile is incomplete or non-interactive
            cachedPath = `${fallback}:${detectedPath}`;
            console.log('[shell] Final Merged PATH:', cachedPath);
            return cachedPath;
        }
    } catch (error) {
        console.warn('[shell] Failed to detect shell PATH via spawn:', error);
    }

    // 2. Fallback configuration
    console.log('[shell] Using fallback PATH construction ONLY');
    const existing = process.env.PATH || '';

    // Put additional paths FIRST
    cachedPath = existing ? `${fallback}:${existing}` : fallback;
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
