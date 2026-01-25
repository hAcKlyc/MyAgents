// Open external URLs and files using system default applications
// Uses Tauri shell plugin in desktop mode, falls back to window.open in browser mode

import { isTauriEnvironment } from './browserMock';

/**
 * Open a URL or file path using the system default application
 * - HTTP/HTTPS URLs: Opens in system default browser
 * - mailto: URLs: Opens in system default email client
 * - File paths: Opens with system default application
 *
 * Security: Tauri's shell.open() has built-in security measures:
 * - Only allows opening URLs and file paths
 * - Does not execute arbitrary commands
 * - Respects system security policies
 *
 * @param target - URL or file path to open
 * @returns Promise that resolves when the open command is executed
 */
export async function openExternal(target: string): Promise<void> {
    if (!target || typeof target !== 'string') {
        console.warn('[openExternal] Invalid target provided');
        return;
    }

    // Trim whitespace
    const trimmedTarget = target.trim();
    if (!trimmedTarget) {
        console.warn('[openExternal] Empty target provided');
        return;
    }

    if (isTauriEnvironment()) {
        // Use Tauri shell plugin for desktop mode
        try {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open(trimmedTarget);
        } catch (error) {
            console.error('[openExternal] Failed to open:', error);
            // Fallback to window.open for URLs only
            if (isExternalUrl(trimmedTarget)) {
                window.open(trimmedTarget, '_blank', 'noopener,noreferrer');
            }
        }
    } else {
        // Browser mode: use window.open for URLs only
        if (isExternalUrl(trimmedTarget)) {
            window.open(trimmedTarget, '_blank', 'noopener,noreferrer');
        } else {
            console.warn('[openExternal] Cannot open file paths in browser mode:', trimmedTarget);
        }
    }
}

/**
 * Check if a string is an external URL (http, https, mailto)
 */
export function isExternalUrl(url: string): boolean {
    if (!url) return false;
    const lowerUrl = url.toLowerCase();
    return lowerUrl.startsWith('http://') ||
           lowerUrl.startsWith('https://') ||
           lowerUrl.startsWith('mailto:');
}

/**
 * Check if a string is any URL (including file:// protocol)
 */
export function isUrl(url: string): boolean {
    if (!url) return false;
    const lowerUrl = url.toLowerCase();
    return lowerUrl.startsWith('http://') ||
           lowerUrl.startsWith('https://') ||
           lowerUrl.startsWith('mailto:') ||
           lowerUrl.startsWith('file://');
}

/**
 * Check if a string looks like a file path (internal use)
 * Note: This is kept for potential future use but currently
 * openExternal handles all targets uniformly via Tauri shell.open()
 */
function isFilePath(str: string): boolean {
    if (!str) return false;
    // Absolute paths on Unix/macOS
    if (str.startsWith('/')) return true;
    // Absolute paths on Windows
    if (/^[a-zA-Z]:\\/.test(str)) return true;
    // Home directory paths
    if (str.startsWith('~/')) return true;
    return false;
}

// Export for potential future use
export { isFilePath };
