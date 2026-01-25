/**
 * Shared log types for the unified logging system
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogSource = 'bun' | 'rust' | 'react';

export interface LogEntry {
    source: LogSource;
    level: LogLevel;
    message: string;
    timestamp: string;
    meta?: Record<string, unknown>;
}
