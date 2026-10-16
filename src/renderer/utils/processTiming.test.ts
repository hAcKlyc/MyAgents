import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@/types/chat';
import { getProcessTiming, summarizeProcessTiming } from './processTiming';

const block = (start: number, end?: number): ContentBlock => ({ type: 'tool_use', tool: { id: String(start), name: 'Read', input: {}, streamIndex: 0, executionTiming: { startedAt: start, ...(end === undefined ? {} : { finishedAt: end }), lastActivityAt: start + 5, source: 'observed' } } });
describe('observed execution timing', () => {
  it.each([0, 1])('does not call a %i ms complete-frame observation execution duration', ms => {
    const complete = block(100, 100 + ms);
    expect(summarizeProcessTiming([complete], false, 1000)).toMatchObject({ spanMs: ms, durationMs: undefined });
    complete.tool!.resultMeta = { durationMs: 1234 };
    expect(summarizeProcessTiming([complete], false, 1000).durationMs).toBe(1234);
    complete.tool!.resultMeta.durationMs = 0;
    expect(summarizeProcessTiming([complete], false, 1000).durationMs).toBe(0);
  });
  it('does not treat thinking observation duration as runtime execution', () => {
    expect(summarizeProcessTiming([{ type: 'thinking', thinkingDurationMs: 3000 }], false, 9999).durationMs).toBeUndefined();
  });

  it('uses a wall-clock span for parallel operations instead of adding durations', () => {
    expect(summarizeProcessTiming([block(100, 400), block(150, 500)], false, 900)).toMatchObject({ startedAt: 100, finishedAt: 500, spanMs: 400, durationMs: undefined });
  });
  it('never invents old or partial phase timestamps from a task or UI fallback', () => {
    const legacy: ContentBlock = { type: 'tool_use', tool: { id: 'legacy', name: 'Read', input: {}, streamIndex: 0, taskStartTime: 100, resultMeta: { durationMs: 45 } } };
    expect(getProcessTiming(legacy)).toBeUndefined();
    expect(summarizeProcessTiming([legacy], false, 9999)).toMatchObject({ startedAt: undefined, durationMs: 45 });
    expect(summarizeProcessTiming([legacy, block(100, 400)], false, 9999)).toMatchObject({ startedAt: undefined, durationMs: undefined });
  });
  it('advances elapsed time only for live evidence and leaves last activity fixed', () => {
    expect(summarizeProcessTiming([block(100)], true, 500)).toMatchObject({ elapsedMs: 400, durationMs: undefined, lastActivityAt: 105 });
    expect(summarizeProcessTiming([block(100)], true, 900)).toMatchObject({ elapsedMs: 800, lastActivityAt: 105 });
    expect(summarizeProcessTiming([block(100)], false, 900)).toMatchObject({ durationMs: undefined });
  });
  it('rejects invalid and backwards clocks instead of displaying NaN or negative time', () => {
    expect(getProcessTiming(block(NaN))).toBeUndefined();
    expect(summarizeProcessTiming([block(100, 90)], false, 500).spanMs).toBeUndefined();
    expect(summarizeProcessTiming([block(100)], true, 90).elapsedMs).toBeUndefined();
  });
  it('uses a reactivated child lifecycle instead of the old launch completion', () => {
    const child = block(100, 200);
    child.tool!.name = 'CollabAgent';
    child.tool!.subagentLifecycle = { status: 'running', startedAt: 400, lastActivityAt: 450, activation: { id: 'second', ordinal: 2, state: 'running' } };
    expect(summarizeProcessTiming([child], true, 1000)).toMatchObject({ startedAt: 400, finishedAt: undefined, elapsedMs: 600, lastActivityAt: 450 });
    child.tool!.subagentLifecycle.timingVerified = false;
    expect(summarizeProcessTiming([child], true, 1000).elapsedMs).toBeUndefined();
  });
});
