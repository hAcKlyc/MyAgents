import type { RuntimeType } from '../../shared/types/runtime';
import type { MessageUsage } from '../types/session';
import { observedContextTokens } from '../utils/context-occupancy';

export const EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Bounded ceiling when a runtime explicitly reports live async/background work
 *  (such as a background shell task waiting on a remote query with no ACP frames). */
export const EXTERNAL_WATCHDOG_ASYNC_WORK_TIMEOUT_MS = 60 * 60 * 1000;
export const CODEX_LONG_CONTEXT_THRESHOLD_TOKENS = 1_000_000;
export const CODEX_LONG_CONTEXT_MIN_TIMEOUT_MS = 30 * 60 * 1000;
export const CODEX_LONG_CONTEXT_MAX_TIMEOUT_MS = 60 * 60 * 1000;
export const CODEX_LONG_CONTEXT_EXTRA_PER_MILLION_MS = 5 * 60 * 1000;
export const CODEX_WATCHDOG_ESTIMATED_BYTES_PER_TOKEN = 4;

export interface WatchdogContextMessage {
  content: string;
}

export interface ExternalWatchdogBudgetOptions {
  activeAsyncWork?: boolean;
}

export function estimatedContextTokensFromMessages(
  messages: WatchdogContextMessage[],
  extraText = '',
): number {
  let bytes = Buffer.byteLength(extraText, 'utf8');
  for (const message of messages) {
    bytes += Buffer.byteLength(message.content, 'utf8');
  }
  return Math.ceil(bytes / CODEX_WATCHDOG_ESTIMATED_BYTES_PER_TOKEN);
}

export function externalRuntimeWatchdogTimeoutMs(
  runtimeType: RuntimeType,
  usage: MessageUsage | null | undefined,
  options?: ExternalWatchdogBudgetOptions,
): number {
  const baseTimeoutMs = options?.activeAsyncWork
    ? EXTERNAL_WATCHDOG_ASYNC_WORK_TIMEOUT_MS
    : EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS;

  if (runtimeType !== 'codex') return baseTimeoutMs;

  const tokens = observedContextTokens(usage);
  if (tokens < CODEX_LONG_CONTEXT_THRESHOLD_TOKENS) {
    return baseTimeoutMs;
  }

  const scaledTimeout = EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS
    + Math.ceil(tokens / 1_000_000) * CODEX_LONG_CONTEXT_EXTRA_PER_MILLION_MS;

  return Math.max(
    baseTimeoutMs,
    Math.min(
      CODEX_LONG_CONTEXT_MAX_TIMEOUT_MS,
      Math.max(CODEX_LONG_CONTEXT_MIN_TIMEOUT_MS, scaledTimeout),
    ),
  );
}
