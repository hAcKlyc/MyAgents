import { describe, it, expect } from 'vitest';
import { planRetraction, type RetractionCandidate } from './message-retraction';

const msg = (id: string, sdkUuid?: string, role: string = 'assistant'): RetractionCandidate =>
  ({ id, role, sdkUuid });
const user = (id: string, sdkUuid?: string): RetractionCandidate => msg(id, sdkUuid, 'user');

describe('planRetraction', () => {
  it('preserves human inputs whose legacy anchor was incorrectly bound to a tool result', () => {
    const messages = [user('human', 'tool-result'), msg('answer', 'refused-answer')];
    expect(planRetraction(messages, ['tool-result', 'refused-answer']).removedMessageIds).toEqual(['answer']);
    expect(planRetraction([user('human', 'tool-result')], ['tool-result'])).toEqual({
      removedMessageIds: [], removedStreamingTail: false,
    });
  });

  it('removes the bubble whose sdkUuid is retracted (refused streaming tail)', () => {
    const messages = [user('1', 'u-user'), msg('2', 'u-refused')];
    const plan = planRetraction(messages, ['u-refused']);
    expect(plan.removedMessageIds).toEqual(['2']);
    expect(plan.removedStreamingTail).toBe(true);
  });

  it('is a no-op for unknown or already-removed uuids (idempotent)', () => {
    const messages = [user('1', 'u-a'), msg('2', 'u-b')];
    const plan = planRetraction(messages, ['u-gone', 'u-never-existed']);
    expect(plan.removedMessageIds).toEqual([]);
    expect(plan.removedStreamingTail).toBe(false);
  });

  it('handles multi-uuid retraction lists (per-block derived uuids + tombstoned tool_results)', () => {
    // SDK sends one uuid per normalized message; only the bubble's LATEST
    // uuid matches, the rest are no-ops by design.
    const messages = [user('1', 'u-user'), msg('2', 'u-refused-final')];
    const plan = planRetraction(messages, [
      'u-refused-thinking',
      'u-refused-final',
      'u-tombstoned-tool-result',
    ]);
    expect(plan.removedMessageIds).toEqual(['2']);
    expect(plan.removedStreamingTail).toBe(true);
  });

  it('does not flag streaming tail when only an earlier bubble is retracted and no stream is open', () => {
    const messages = [msg('1', 'u-old-refused'), user('2', 'u-current')];
    const plan = planRetraction(messages, ['u-old-refused']);
    expect(plan.removedMessageIds).toEqual(['1']);
    expect(plan.removedStreamingTail).toBe(false);
  });

  it('ignores messages without sdkUuid when no stream is open (pre-echo bubbles, legacy storage)', () => {
    const messages = [user('1'), msg('2', 'u-refused'), user('3')];
    const plan = planRetraction(messages, ['u-refused']);
    expect(plan.removedMessageIds).toEqual(['2']);
    // tail ('3') is a user message → never the refused streaming bubble
    expect(plan.removedStreamingTail).toBe(false);
  });

  it('returns empty plan for empty inputs', () => {
    expect(planRetraction([], ['u-x']).removedMessageIds).toEqual([]);
    expect(planRetraction([msg('1', 'u-x')], []).removedMessageIds).toEqual([]);
  });

  describe('fallbackToStreamingTail (refusal cut the stream before any final assistant frame)', () => {
    it('evicts the uuid-less streaming tail assistant bubble', () => {
      // The refused bubble accumulated only stream_event deltas — no final
      // assistant frame ever stamped an sdkUuid, so uuid matching misses it.
      const messages = [user('1', 'u-user'), msg('2' /* no sdkUuid */)];
      const plan = planRetraction(messages, ['u-refused-partial'], { fallbackToStreamingTail: true });
      expect(plan.removedMessageIds).toEqual(['2']);
      expect(plan.removedStreamingTail).toBe(true);
    });

    it('evicts a stale-uuid streaming tail (uuid belongs to a previous leg)', () => {
      const messages = [msg('1', 'u-previous-turn'), msg('2', 'u-stale')];
      const plan = planRetraction(messages, ['u-refused-partial'], { fallbackToStreamingTail: true });
      expect(plan.removedMessageIds).toEqual(['2']);
      expect(plan.removedStreamingTail).toBe(true);
    });

    it('does not double-add the tail when uuid matching already caught it', () => {
      const messages = [user('1', 'u-user'), msg('2', 'u-refused')];
      const plan = planRetraction(messages, ['u-refused'], { fallbackToStreamingTail: true });
      expect(plan.removedMessageIds).toEqual(['2']);
      expect(plan.removedStreamingTail).toBe(true);
    });

    it('never evicts a non-assistant tail', () => {
      const messages = [msg('1', 'u-a'), user('2')];
      const plan = planRetraction(messages, ['u-refused-partial'], { fallbackToStreamingTail: true });
      expect(plan.removedMessageIds).toEqual([]);
      expect(plan.removedStreamingTail).toBe(false);
    });

    it('double-channel replay: second call after eviction + streaming reset is an empty plan', () => {
      // Channel 1 (model_refusal_fallback) evicts the tail and the caller
      // resets isStreamingMessage. Channel 2 (assistant.supersedes) replays
      // the same uuids with fallback now false — must be a pure no-op.
      const before = [user('1', 'u-user'), msg('2', 'u-refused')];
      const first = planRetraction(before, ['u-refused'], { fallbackToStreamingTail: true });
      expect(first.removedMessageIds).toEqual(['2']);

      const after = before.filter(m => !first.removedMessageIds.includes(m.id));
      const second = planRetraction(after, ['u-refused'], { fallbackToStreamingTail: false });
      expect(second.removedMessageIds).toEqual([]);
      expect(second.removedStreamingTail).toBe(false);
    });
  });
});
