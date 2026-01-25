/**
 * Shared utilities for logging system
 */

import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const MYAGENTS_DIR = join(homedir(), '.myagents');
export const LOGS_DIR = join(MYAGENTS_DIR, 'logs');
export const LOG_RETENTION_DAYS = 30;

/**
 * Ensure logs directory exists
 */
export function ensureLogsDir(): void {
  if (!existsSync(MYAGENTS_DIR)) {
    mkdirSync(MYAGENTS_DIR, { recursive: true });
  }
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}
