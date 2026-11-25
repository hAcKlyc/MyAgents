import { describe, expect, it } from 'vitest';

import {
  CODEX_LONG_CONTEXT_MAX_TIMEOUT_MS,
  CODEX_LONG_CONTEXT_MIN_TIMEOUT_MS,
  EXTERNAL_WATCHDOG_ASYNC_WORK_TIMEOUT_MS,
  EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS,
  estimatedContextTokensFromMessages,
  externalRuntimeWatchdogTimeoutMs,
} from './external-watchdog-policy';

describe('externalRuntimeWatchdogTimeoutMs', () => {
  it('keeps the default timeout for non-Codex runtimes', () => {
    expect(externalRuntimeWatchdogTimeoutMs('claude-code', { inputTokens: 8_000_000, outputTokens: 0 })).toBe(
      EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS,
    );
  });

  it('uses the bounded async-work ceiling when a runtime reports active background work', () => {
    expect(
      externalRuntimeWatchdogTimeoutMs('antigravity', null, { activeAsyncWork: true }),
    ).toBe(EXTERNAL_WATCHDOG_ASYNC_WORK_TIMEOUT_MS);
    expect(
      externalRuntimeWatchdogTimeoutMs('antigravity', null, { activeAsyncWork: false }),
    ).toBe(EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS);
    expect(
      externalRuntimeWatchdogTimeoutMs('codex', { inputTokens: 2_000_000, outputTokens: 0 }, { activeAsyncWork: true }),
    ).toBe(EXTERNAL_WATCHDOG_ASYNC_WORK_TIMEOUT_MS);
  });

  it('keeps the default timeout for small Codex contexts', () => {
    expect(externalRuntimeWatchdogTimeoutMs('codex', { inputTokens: 999_999, outputTokens: 0 })).toBe(
      EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS,
    );
  });

  it('uses a larger minimum timeout for million-token Codex contexts', () => {
    expect(externalRuntimeWatchdogTimeoutMs('codex', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      CODEX_LONG_CONTEXT_MIN_TIMEOUT_MS,
    );
  });

  it('scales Codex timeout with multi-million token contexts and caps it', () => {
    expect(externalRuntimeWatchdogTimeoutMs('codex', { inputTokens: 6_514_414, outputTokens: 0 })).toBe(
      45 * 60 * 1000,
    );
    expect(externalRuntimeWatchdogTimeoutMs('codex', { inputTokens: 20_000_000, outputTokens: 0 })).toBe(
      CODEX_LONG_CONTEXT_MAX_TIMEOUT_MS,
    );
  });
});

// observedContextTokens / resolveContextOccupancyTokens moved to
// src/server/utils/context-occupancy.{ts,unit.test.ts} — they are consumed by
// BOTH runtime families, not just the external watchdog (cross-review 0.2.32).

describe('estimatedContextTokensFromMessages', () => {
  it('estimates pre-usage context size from persisted message content and the new turn text', () => {
    expect(estimatedContextTokensFromMessages([
      { content: 'a'.repeat(16) },
      { content: '界'.repeat(4) },
    ], 'b'.repeat(4))).toBe(8);
  });
});
