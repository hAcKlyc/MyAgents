/**
 * Developer Mode Unlock State Management
 *
 * Manages the hidden developer section unlock state:
 * - Default: hidden
 * - Unlock: tap logo 5 times within 10 seconds
 * - State persists in memory until app restart
 */

// Module-level state - persists across component mounts but resets on app restart
let developerSectionUnlocked = false;

/**
 * Check if developer section is unlocked
 */
export function isDeveloperSectionUnlocked(): boolean {
    return developerSectionUnlocked;
}

/**
 * Unlock the developer section (called when tap trigger completes)
 */
export function unlockDeveloperSection(): void {
    developerSectionUnlocked = true;
}

/**
 * Configuration for the tap-to-unlock gesture
 */
export const UNLOCK_CONFIG = {
    /** Number of taps required to unlock */
    requiredTaps: 5,
    /** Time window in milliseconds (10 seconds) */
    timeWindowMs: 10000,
} as const;
