/**
 * Cross-platform utilities for environment and path handling
 *
 * Windows vs Unix environment variables:
 * - Home directory: USERPROFILE (Win) vs HOME (Unix)
 * - Username: USERNAME (Win) vs USER (Unix)
 * - Temp directory: TEMP/TMP (Win) vs TMPDIR (Unix)
 */

/**
 * Check if running on Windows
 */
export function isWindows(): boolean {
    return process.platform === 'win32';
}

/**
 * Get cross-platform environment variables
 * Returns consistent values regardless of platform
 */
export function getCrossPlatformEnv(): {
    home: string;
    user: string;
    temp: string;
} {
    const isWin = isWindows();

    // Safe fallback for temp directory:
    // - Windows: TEMP > TMP > C:\Windows\Temp (always exists)
    // - Unix: TMPDIR > /tmp (always exists)
    const tempFallback = isWin ? 'C:\\Windows\\Temp' : '/tmp';

    return {
        home: isWin
            ? (process.env.USERPROFILE || '')
            : (process.env.HOME || ''),
        user: process.env.USER || process.env.USERNAME || '',
        temp: isWin
            ? (process.env.TEMP || process.env.TMP || tempFallback)
            : (process.env.TMPDIR || tempFallback),
    };
}

/**
 * Get home directory with validation
 * Throws if home directory is not available
 */
export function getHomeDir(): string {
    const { home } = getCrossPlatformEnv();
    if (!home) {
        throw new Error('Home directory not found (HOME/USERPROFILE not set)');
    }
    return home;
}

/**
 * Get home directory or null if not available
 * Use this when you want to handle missing home directory gracefully
 */
export function getHomeDirOrNull(): string | null {
    const { home } = getCrossPlatformEnv();
    return home || null;
}

/**
 * Build environment variables for child processes
 * Ensures both Windows and Unix variants are set for maximum compatibility
 */
export function buildCrossPlatformEnv(additionalEnv?: Record<string, string>): Record<string, string> {
    const { home, user, temp } = getCrossPlatformEnv();

    return {
        ...process.env as Record<string, string>,
        // Set both variants for cross-platform compatibility
        HOME: home,
        USERPROFILE: home,
        USER: user,
        USERNAME: user,
        TMPDIR: temp,
        TEMP: temp,
        TMP: temp,
        ...(additionalEnv || {}),
    };
}
