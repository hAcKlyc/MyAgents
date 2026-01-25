/**
 * Shared utility functions
 * Cross-platform compatible utilities for both frontend and backend
 */

/**
 * Windows reserved file names that cannot be used as folder/file names
 * These names are reserved regardless of extension (e.g., CON.txt is also invalid)
 */
const WINDOWS_RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Check if a name is a Windows reserved file name
 * @param name - The name to check (case-insensitive)
 */
export function isWindowsReservedName(name: string): boolean {
    // Get the base name without extension
    const baseName = name.split('.')[0].toUpperCase();
    return WINDOWS_RESERVED_NAMES.has(baseName);
}

/**
 * Sanitize a string to be safe for use as a folder/file name
 * Supports Unicode (Chinese, Japanese, etc.) while removing dangerous characters
 * Cross-platform compatible (macOS, Windows, Linux)
 *
 * @param name - The name to sanitize
 * @returns A safe folder/file name, or fallback if input is empty/invalid
 */
export function sanitizeFolderName(name: string): string {
    let sanitized = name.trim();
    // Remove path separators and Windows reserved characters: / \ < > : " | ? *
    sanitized = sanitized.replace(/[/\\<>:"|?*]/g, '');
    // Remove control characters (0x00-0x1F, 0x7F)
    sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, '');
    // Replace multiple spaces/hyphens with single hyphen
    sanitized = sanitized.replace(/[\s-]+/g, '-');
    // Remove leading/trailing hyphens
    sanitized = sanitized.replace(/^-+|-+$/g, '');
    // Handle Windows reserved names by adding suffix
    if (sanitized && isWindowsReservedName(sanitized)) {
        sanitized = `${sanitized}-file`;
    }
    // Fallback if result is empty
    return sanitized || `item-${Date.now()}`;
}

/**
 * Semantic version comparison
 * @param a - First version string (e.g., "1.2.3")
 * @param b - Second version string (e.g., "1.2.10")
 * @returns -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    const maxLen = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < maxLen; i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA < numB) return -1;
        if (numA > numB) return 1;
    }
    return 0;
}
