/**
 * UnifiedLogger - Persists unified logs (React/Bun/Rust) to daily files
 *
 * Features:
 * - Daily log files: ~/.myagents/logs/unified-{YYYY-MM-DD}.log
 * - Lazy file creation on first write
 * - Auto cleanup: removes logs older than 30 days on startup
 * - Shared cleanup with AgentLogger
 */

import { appendFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';

import type { LogEntry } from '../renderer/types/log';
import { LOGS_DIR, LOG_RETENTION_DAYS, ensureLogsDir } from './logUtils';

// Track current date for file rotation
let currentDate: string | null = null;
let currentFilePath: string | null = null;

/**
 * Get today's date string (YYYY-MM-DD)
 */
function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get log file path for today
 */
function getLogFilePath(): string {
  const today = getTodayDate();

  // Check if we need to rotate to a new day's file
  if (currentDate !== today) {
    currentDate = today;
    currentFilePath = join(LOGS_DIR, `unified-${today}.log`);
  }

  return currentFilePath!;
}

/**
 * Clean up old unified log files (older than LOG_RETENTION_DAYS)
 * Called on startup
 */
export function cleanupOldUnifiedLogs(): void {
  ensureLogsDir();

  const now = Date.now();
  const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  try {
    const files = readdirSync(LOGS_DIR);

    for (const file of files) {
      // Only clean unified-*.log files (not agent session logs)
      if (!file.startsWith('unified-') || !file.endsWith('.log')) continue;

      const filePath = join(LOGS_DIR, file);
      try {
        const stat = statSync(filePath);
        const age = now - stat.mtimeMs;

        if (age > maxAge) {
          unlinkSync(filePath);
          deletedCount++;
        }
      } catch {
        // Ignore errors for individual files
      }
    }

    if (deletedCount > 0) {
      console.log(`[UnifiedLogger] Cleaned up ${deletedCount} old unified log files`);
    }
  } catch (err) {
    console.error('[UnifiedLogger] Failed to cleanup old logs:', err);
  }
}

/**
 * Format a log entry for file output
 */
function formatLogEntry(entry: LogEntry): string {
  const level = entry.level.toUpperCase().padEnd(5);
  const source = entry.source.toUpperCase().padEnd(5);
  return `${entry.timestamp} [${source}] [${level}] ${entry.message}`;
}

/**
 * Append a log entry to the unified log file
 */
export function appendUnifiedLog(entry: LogEntry): void {
  try {
    ensureLogsDir();
    const filePath = getLogFilePath();
    const line = formatLogEntry(entry) + '\n';
    appendFileSync(filePath, line);
  } catch {
    // Silently ignore write errors to avoid log loops
  }
}

/**
 * Append multiple log entries (batch write)
 */
export function appendUnifiedLogBatch(entries: LogEntry[]): void {
  if (entries.length === 0) return;

  try {
    ensureLogsDir();
    const filePath = getLogFilePath();
    const lines = entries.map(formatLogEntry).join('\n') + '\n';
    appendFileSync(filePath, lines);
  } catch {
    // Silently ignore write errors
  }
}
