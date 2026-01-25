/**
 * AgentLogger - Handles agent session logging with lazy file creation
 *
 * Features:
 * - Lazy file creation: only creates log file on first write
 * - Centralized log directory: ~/.myagents/logs/
 * - Session-based naming: {date}-{sessionId}.log
 * - Auto cleanup: removes logs older than 30 days on startup
 */

import { readdirSync, unlinkSync, statSync } from 'fs';
import { createWriteStream, type WriteStream } from 'fs';
import { join } from 'path';

import { LOGS_DIR, LOG_RETENTION_DAYS, ensureLogsDir } from './logUtils';

// In-memory log buffer for UI display
const logLines: string[] = [];
const MAX_LOG_LINES = 2000;

// Current log stream state
let logStream: WriteStream | null = null;
let currentSessionId: string | null = null;
let currentLogFilePath: string | null = null;

/**
 * Get log file path for a session
 * Format: {YYYY-MM-DD}-{sessionId}.log
 */
function getLogFilePath(sessionId: string): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return join(LOGS_DIR, `${date}-${sessionId}.log`);
}

/**
 * Clean up old log files (older than LOG_RETENTION_DAYS)
 * Called on startup
 */
export function cleanupOldLogs(): void {
  ensureLogsDir();

  const now = Date.now();
  const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000; // 30 days in ms
  let deletedCount = 0;

  try {
    const files = readdirSync(LOGS_DIR);

    for (const file of files) {
      // Only clean agent session logs, skip unified-*.log files
      if (!file.endsWith('.log')) continue;
      if (file.startsWith('unified-')) continue;

      const filePath = join(LOGS_DIR, file);
      try {
        const stat = statSync(filePath);
        const age = now - stat.mtimeMs;

        if (age > maxAge) {
          unlinkSync(filePath);
          deletedCount++;
        }
      } catch (err) {
        // Ignore errors for individual files
        console.warn(`[AgentLogger] Failed to check/delete ${file}:`, err);
      }
    }

    if (deletedCount > 0) {
      console.log(`[AgentLogger] Cleaned up ${deletedCount} old log files`);
    }
  } catch (err) {
    console.error('[AgentLogger] Failed to cleanup old logs:', err);
  }
}

/**
 * Initialize logger for a new session
 * Does NOT create the file - just prepares the session ID
 */
export function initLogger(sessionId: string): void {
  // Close previous stream if exists
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  currentSessionId = sessionId;
  currentLogFilePath = null; // Reset - will be created on first write
  logLines.length = 0; // Clear in-memory buffer
}

/**
 * Append a log line (lazy file creation)
 * Creates the log file on first write
 */
export function appendLog(line: string): void {
  // Add to in-memory buffer
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) {
    logLines.shift();
  }

  // Lazy file creation
  if (!logStream && currentSessionId) {
    ensureLogsDir();
    currentLogFilePath = getLogFilePath(currentSessionId);
    logStream = createWriteStream(currentLogFilePath, { flags: 'a' });
  }

  // Write to file
  logStream?.write(`${line}\n`);
}

/**
 * Get current log lines (for UI display)
 */
export function getLogLines(): string[] {
  return logLines;
}

/**
 * Get current log file path (for debugging)
 */
export function getLogFilePath_(): string | null {
  return currentLogFilePath;
}

/**
 * Close the current log stream
 */
export function closeLogger(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
  currentSessionId = null;
  currentLogFilePath = null;
}
