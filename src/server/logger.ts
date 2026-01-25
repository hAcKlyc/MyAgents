/**
 * Unified Logger - Intercepts console.log/error/warn and forwards to SSE
 * 
 * This module provides automatic log forwarding from Bun Sidecar to the frontend.
 * All console.log/error/warn calls are intercepted and sent via SSE events.
 * 
 * Fixes applied based on ChatGPT/Gemini feedback:
 * 1. Debug logging to trace clients.length and broadcast calls
 * 2. Ring Buffer to cache early logs (before SSE client connects)
 * 3. getLogHistory() for sending cached logs when client connects
 */

import type { createSseClient } from './sse';
import { SSE_INSTANCE_ID } from './sse';
import { appendUnifiedLog } from './UnifiedLogger';
import type { LogEntry, LogLevel } from '../renderer/types/log';

// Re-export types for backward compatibility
export type { LogEntry, LogLevel };

// ==================== Ring Buffer for Log History ====================
// (Per Gemini's suggestion: cache logs before any SSE client connects)
const MAX_HISTORY = 100;
const logHistory: LogEntry[] = [];

/**
 * Get cached log history (for sending to newly connected clients)
 */
export function getLogHistory(): LogEntry[] {
    return logHistory;
}

// ==================== Original Console Methods ====================
const originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    debug: console.debug.bind(console),
};

// ==================== Broadcast Function ====================
let broadcastLog: ((entry: LogEntry) => void) | null = null;

/**
 * Format arguments to string (safely handles objects)
 */
function formatArgs(args: unknown[]): string {
    return args.map(arg => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
        try {
            // Use simpler stringification to avoid circular reference issues
            return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
        } catch {
            return String(arg);
        }
    }).join(' ');
}

/**
 * Create a log entry and broadcast it
 * Also stores in history buffer (Ring Buffer per Gemini's suggestion)
 */
function createAndBroadcast(level: LogLevel, args: unknown[]): void {
    // Skip if the message is from our own debug logging (prevent infinite loop)
    const message = formatArgs(args);
    if (message.includes('[sse] getClients')) return; // Avoid recursion
    if (message.startsWith('[sse]')) return; // Filter noisy SSE logs from UI

    const entry: LogEntry = {
        source: 'bun',
        level,
        message,
        timestamp: new Date().toISOString(),
    };

    // Store in history buffer (Ring Buffer)
    logHistory.push(entry);
    if (logHistory.length > MAX_HISTORY) {
        logHistory.shift();
    }

    // Persist to unified log file
    appendUnifiedLog(entry);

    // Broadcast to connected clients
    if (broadcastLog) {
        try {
            broadcastLog(entry);
        } catch (e) {
            // Log error using original console to prevent infinite loops
            originalConsole.error('[Logger] Broadcast failed:', e);
        }
    }
}

/**
 * Initialize the logger with SSE broadcast capability
 * @param getSseClients Function that returns all active SSE clients
 */
export function initLogger(getSseClients: () => ReturnType<typeof createSseClient>['client'][]): void {
    broadcastLog = (entry: LogEntry) => {
        const clients = getSseClients();
        for (const client of clients) {
            try {
                client.send('chat:log', entry);
            } catch (e) {
                originalConsole.error('[Logger] client.send failed:', e);
            }
        }
    };

    // Override console methods
    console.log = (...args: unknown[]) => {
        originalConsole.log(...args);
        createAndBroadcast('info', args);
    };

    console.error = (...args: unknown[]) => {
        originalConsole.error(...args);
        createAndBroadcast('error', args);
    };

    console.warn = (...args: unknown[]) => {
        originalConsole.warn(...args);
        createAndBroadcast('warn', args);
    };

    console.debug = (...args: unknown[]) => {
        originalConsole.debug(...args);
        createAndBroadcast('debug', args);
    };

    // Mark console.log as patched (for diagnostics endpoint)
    (console.log as unknown as Record<string, boolean>).__patched_by_logger__ = true;

    originalConsole.log('[Logger] Unified logging initialized');
}

/**
 * Restore original console methods (for testing)
 */
export function restoreConsole(): void {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.debug = originalConsole.debug;
    broadcastLog = null;
}

/**
 * Manually send a log entry (for direct usage without console)
 */
export function sendLog(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
        source: 'bun',
        level,
        message,
        timestamp: new Date().toISOString(),
        meta,
    };

    originalConsole[level === 'info' ? 'log' : level](message);

    // Store in history
    logHistory.push(entry);
    if (logHistory.length > MAX_HISTORY) {
        logHistory.shift();
    }

    // Persist to unified log file
    appendUnifiedLog(entry);

    if (broadcastLog) {
        try {
            broadcastLog(entry);
        } catch {
            // Ignore
        }
    }
}

/**
 * Get logger diagnostics for debugging (exposed via /debug/logger endpoint)
 */
export function getLoggerDiagnostics() {
    return {
        initialized: broadcastLog !== null,
        consolePatched: (console.log as unknown as Record<string, boolean>).__patched_by_logger__ ?? false,
        historySize: logHistory.length,
        recentLogs: logHistory.slice(-5).map(l => ({ level: l.level, message: l.message.slice(0, 50) })),
        sseInstanceId: SSE_INSTANCE_ID,
    };
}
