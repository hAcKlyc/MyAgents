/**
 * Format token count for display with smart unit selection
 * - >= 1M: "1.2M"
 * - >= 1K: "12.5K"
 * - < 1K: raw number
 */
export function formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
        return `${(tokens / 1000000).toFixed(1)}M`;
    }
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`;
    }
    return String(tokens);
}

/**
 * Format duration in milliseconds for display
 * - >= 60s: "1m 30s"
 * - >= 1s: "1.5s"
 * - < 1s: "500ms"
 */
export function formatDuration(ms: number): string {
    if (ms >= 60000) {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.round((ms % 60000) / 1000);
        return `${minutes}m ${seconds}s`;
    }
    if (ms >= 1000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    return `${ms}ms`;
}
