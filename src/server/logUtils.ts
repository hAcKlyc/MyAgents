import { APP_DATA_DIR_NAME } from '../shared/appProfile';
/**
 * Shared utilities for logging system
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ensureDirSync } from './utils/fs-utils';

export const MYAGENTS_DIR = join(homedir(), APP_DATA_DIR_NAME);
export const LOGS_DIR = join(MYAGENTS_DIR, 'logs');
// Retention policy moved to `./log-retention.ts` (#121, 2026-05). Keeping a
// re-export of LOGS_DIR + ensureLogsDir as the only API of this module.

/**
 * Ensure logs directory exists
 */
export function ensureLogsDir(): void {
  if (!existsSync(MYAGENTS_DIR)) {
    ensureDirSync(MYAGENTS_DIR);
  }
  if (!existsSync(LOGS_DIR)) {
    ensureDirSync(LOGS_DIR);
  }
}
