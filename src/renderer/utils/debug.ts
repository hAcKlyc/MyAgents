/**
 * Debug Mode Utilities
 * 
 * Provides a unified way to check if the app is running in debug/development mode
 * across different build configurations:
 * 
 * - `npm run dev:web` (Vite dev server): Always debug mode
 * - `build_dev.sh` (Dev build): Debug mode via VITE_DEBUG_MODE=true
 * - `build_macos.sh` (Production build): Not debug mode
 * 
 * Usage:
 * ```tsx
 * import { isDebugMode } from '@/utils/debug';
 * 
 * // In component
 * {isDebugMode() && <DebugButton />}
 * ```
 */

// Defined in vite.config.ts via `define` option
// Will be replaced at build time with either true or false
declare const __DEBUG_MODE__: boolean;

// Build-time version info for developer mode
declare const __BUILD_VERSIONS__: {
    claudeAgentSdk: string;
    bun: string;
    tauri: string;
};

/**
 * Check if the app is running in debug mode.
 * 
 * Debug mode is enabled when:
 * 1. Running via Vite dev server (import.meta.env.DEV)
 * 2. Built with VITE_DEBUG_MODE=true (e.g., build_dev.sh)
 * 
 * Note: __DEBUG_MODE__ is replaced at compile time by Vite's define option.
 * 
 * @returns true if debug mode is enabled
 */
export function isDebugMode(): boolean {
    // Vite dev server mode
    if (import.meta.env.DEV) {
        return true;
    }

    // Build-time flag from VITE_DEBUG_MODE env var
    // __DEBUG_MODE__ is replaced with true/false at compile time
    return __DEBUG_MODE__;
}

/**
 * Shorthand constant for debug mode (evaluated at module load)
 */
export const DEBUG = isDebugMode();

/**
 * Build-time version information for core dependencies.
 * Used in developer mode to help debug packaging issues.
 */
export interface BuildVersions {
    claudeAgentSdk: string;
    bun: string;
    tauri: string;
}

/**
 * Get build-time version information.
 * These values are injected at build time from package.json and Cargo.toml.
 */
export function getBuildVersions(): BuildVersions {
    return __BUILD_VERSIONS__;
}

