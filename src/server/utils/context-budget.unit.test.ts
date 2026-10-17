import { describe, expect, it } from 'vitest';
import {
  classifyContextTurnFailure,
  resolveBuiltinContextBudget,
} from './context-budget';

describe('resolveBuiltinContextBudget', () => {
  it('caps an unverified 1.024M API declaration at the 200K safety budget', () => {
    expect(resolveBuiltinContextBudget({ declaredWindow: 1_024_000, apiRoute: true }))
      .toEqual({ window: 200_000, declaredWindow: 1_024_000, source: 'safety-budget' });
  });

  it('uses a known smaller declaration as the effective route budget', () => {
    expect(resolveBuiltinContextBudget({ declaredWindow: 128_000, apiRoute: true }))
      .toEqual({ window: 128_000, declaredWindow: 128_000, source: 'registry' });
  });

  it('honors an explicit route budget while respecting a smaller declaration', () => {
    expect(resolveBuiltinContextBudget({ operationalWindow: 500_000, apiRoute: true }))
      .toEqual({ window: 500_000, source: 'safety-budget' });
    expect(resolveBuiltinContextBudget({ declaredWindow: 128_000, operationalWindow: 500_000, apiRoute: true }))
      .toEqual({ window: 128_000, declaredWindow: 128_000, source: 'registry' });
  });

  it('preserves official declared windows and defaults when unknown', () => {
    expect(resolveBuiltinContextBudget({ declaredWindow: 1_000_000, apiRoute: false }))
      .toEqual({ window: 1_000_000, declaredWindow: 1_000_000, source: 'registry' });
    expect(resolveBuiltinContextBudget({ apiRoute: false }))
      .toEqual({ window: 200_000, source: 'default' });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 20_000_001])(
    'falls back for implausible declared or operational input %s', (value) => {
      expect(resolveBuiltinContextBudget({ declaredWindow: value, apiRoute: false }))
        .toEqual({ window: 200_000, source: 'default' });
      expect(resolveBuiltinContextBudget({ operationalWindow: value, apiRoute: true }))
        .toEqual({ window: 200_000, source: 'safety-budget' });
    },
  );
});

describe('classifyContextTurnFailure', () => {
  it('preserves an explicit failed compaction even if the outer SDK reports success', () => {
    expect(classifyContextTurnFailure({ compactResult: 'failed', errorText: 'outer SDK success' }))
      .toBe('compaction_failed');
  });

  it('distinguishes stable recovery and replay codes from generic invalid requests', () => {
    expect(classifyContextTurnFailure({ errorText: 'context_recovery_required' }))
      .toBe('context_recovery_required');
    expect(classifyContextTurnFailure({ errorText: 'automatic_replay_blocked' }))
      .toBe('automatic_replay_blocked');
    expect(classifyContextTurnFailure({ apiErrorStatus: 400, errorText: 'invalid parameter' }))
      .toBe('provider_invalid_request');
  });

  it('recognizes explicit capacity errors and leaves transient 429s unclassified', () => {
    expect(classifyContextTurnFailure({ errorText: 'context_length_exceeded' }))
      .toBe('context_recovery_required');
    expect(classifyContextTurnFailure({ apiErrorStatus: 429, errorText: 'rate limited' }))
      .toBeUndefined();
  });
});
