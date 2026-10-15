import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@/types/chat';
import { applySubagentLifecycleToContent } from '@/components/tools/subagentActivity';
import type { SubagentLifecycle } from '../../shared/types/subagent-lifecycle';
import { buildProcessPhases, getProcessOutcome, getProcessPhaseKind, summarizeProcessPhase } from './processPresentation';

function tool(name = 'Read', patch: Record<string, unknown> = {}): ContentBlock {
  return { type: 'tool_use', tool: { id: 'call', name, input: {}, streamIndex: 0, ...patch } } as ContentBlock;
}

describe('process status evidence', () => {
  it.each([
    [{ result: '' }, false, 'succeeded'],
    [{ result: 'ok' }, false, 'succeeded'],
    [{}, false, 'unknown'],
    [{ isLoading: false }, true, 'unknown'],
    [{ isLoading: true }, false, 'unknown'],
    [{ isLoading: true }, true, 'running'],
    [{ isLoading: true, isError: true }, true, 'failed'],
    [{ result: 'ok', isFailed: true }, false, 'failed'],
    [{ result: 'ok', isStopped: true }, false, 'stopped'],
    [{ resultMeta: { exitCode: 3 } }, false, 'failed'],
    [{ resultMeta: { status: 'completed' } }, false, 'succeeded'],
  ] as const)('uses explicit evidence %j live=%s → %s', (patch, live, expected) => {
    expect(getProcessOutcome(tool('Read', patch), live)).toBe(expected);
  });
  it('does not convert success words in output to business acceptance', () => {
    expect(getProcessOutcome(tool('Read', { result: '228 tests passed; deployed successfully', isError: true }), false)).toBe('failed');
  });
  it.each([
    [{ isLoading: true }, true, 'running'],
    [{ isLoading: true }, false, 'unknown'],
    [{ result: JSON.stringify({ stdout: '', stderr: '', interrupted: true }) }, false, 'stopped'],
    [{ resultMeta: { status: 'timeout' } }, false, 'failed'],
    [{ result: '', resultMeta: { exitCode: 1 } }, false, 'failed'],
    [{ result: '', resultMeta: { exitCode: 0 } }, false, 'succeeded'],
    [{ resultMeta: { exitCode: 0 } }, false, 'succeeded'],
    [{ result: 'background started', parsedInput: { run_in_background: true } }, false, 'unknown'],
  ] as const)('keeps folded shell status aligned with transcript %j', (patch, live, expected) => {
    expect(getProcessOutcome(tool('Bash', patch), live)).toBe(expected);
  });
  it('treats parallel calls independently and freezes legacy child traces in history', () => {
    const blocks = [tool('Read', { id: 'a', isLoading: true }), tool('Read', { id: 'b', isLoading: true })];
    expect(buildProcessPhases(blocks, true)[0].entries.map(e => e.outcome)).toEqual(['running', 'running']);
    const child = tool('Task', { result: '{}', subagentCalls: [{ isLoading: true }] });
    expect(getProcessOutcome(child, false)).toBe('unknown');
    expect(getProcessOutcome(child, true)).toBe('running');
  });
  it('uses the current child activation over retained parent history interruption flags', () => {
    const stopped = tool('Agent', { isStopped: true, isFailed: true, isLoading: false,
      subagentLifecycle: { status: 'interrupted', startedAt: 1, activation: { id: 'old', ordinal: 1, state: 'aborted' } },
    });
    const running: SubagentLifecycle = { status: 'running', startedAt: 2, activation: { id: 'new', ordinal: 2, state: 'running' } };
    const next = applySubagentLifecycleToContent([stopped], 'call', running)!;
    expect(next[0].tool?.isStopped).toBe(true); // Real owner intentionally retains legacy flags.
    expect(getProcessOutcome(next[0], false)).toBe('running');
    const completed = applySubagentLifecycleToContent(next, 'call', { ...running, status: 'completed', finishedAt: 3 })!;
    expect(getProcessOutcome(completed[0], false)).toBe('succeeded');
  });
  it('honors completed child lifecycle even when handle remains open', () => {
    expect(getProcessOutcome(tool('Agent', { isLoading: true, subagentLifecycle: { status: 'completed', handleState: 'open' } }), false)).toBe('succeeded');
  });
  it('retains authoritative background lifecycle after parent stops streaming', () => {
    expect(getProcessOutcome(tool('Agent', { subagentLifecycle: { status: 'running' } }), false)).toBe('running');
  });
  it.each(['failed', 'stopped', 'unknown', 'succeeded'] as const)('reports %s thinking honestly', outcome => {
    const block: ContentBlock = { type: 'thinking', isFailed: outcome === 'failed', isStopped: outcome === 'stopped', isComplete: outcome === 'succeeded' };
    expect(getProcessOutcome(block, false)).toBe(outcome);
  });
});

describe('chronological process stages', () => {
  it('merges only adjacent kinds; never moves reads across writes', () => {
    const blocks = [tool('Read', { id: 'a' }), tool('grep', { id: 'b' }), tool('write', { id: 'c' }), tool('Read', { id: 'd' })];
    const phases = buildProcessPhases(blocks, false);
    expect(phases.map(p => p.kind)).toEqual(['explore', 'change', 'explore']);
    expect(phases.flatMap(p => p.entries.map(e => e.block))).toEqual(blocks);
    expect(buildProcessPhases([...blocks, tool('Read')], true).map(p => p.key)).toEqual(phases.map(p => p.key));
  });
  it.each(['npm run test:unit', 'pnpm build', 'npx vitest run', 'cargo test', 'node --test checks.test.mjs'])('classifies known check entry point %s', command => {
    expect(getProcessPhaseKind(tool('Bash', { parsedInput: { command } }))).toBe('verify');
  });
  it('does not classify by aspirational descriptions, output or embedded shell strings', () => {
    expect(getProcessPhaseKind(tool('Bash', { parsedInput: { command: 'echo "npm test"', description: '验证所有测试通过' }, result: 'all tests passed' }))).toBe('execute');
  });
  it('parses completed raw inputJson even if placeholder input is empty', () => {
    expect(getProcessPhaseKind(tool('Bash', { inputJson: '{"command":"npm test"}' }))).toBe('verify');
  });
  it('does not mark a mixed failed/unknown phase successful', () => {
    const entries = buildProcessPhases([tool('Read', { result: '' }), tool('Read', { isError: true }), tool('Read')], false)[0].entries;
    expect(summarizeProcessPhase(entries)).toEqual({ outcome: 'failed', counts: { succeeded: 1, failed: 1, unknown: 1, stopped: 0, running: 0 } });
  });
});
