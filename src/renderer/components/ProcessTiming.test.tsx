import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from '@/types/chat';
import ProcessTiming from './ProcessTiming';

afterEach(() => vi.useRealTimers());
describe('event time presentation', () => {
  it('shows one observed start and only a reported execution duration, keeping the finish in details', () => {
    const start = Date.parse('2026-10-16T01:00:00Z');
    const block: ContentBlock = { type: 'tool_use', tool: { id: 'read', name: 'Read', input: {}, streamIndex: 0,
      executionTiming: { startedAt: start, finishedAt: start + 1, source: 'observed' }, resultMeta: { durationMs: 2500 } } };
    const view = render(<ProcessTiming blocks={[block]} running={false} />);
    expect(view.container.querySelectorAll('time')).toHaveLength(1);
    expect(screen.getByText(/观测开始/)).toBeTruthy();
    expect(screen.getByText('执行耗时 2.5 s')).toBeTruthy();
    expect(view.container.textContent).not.toContain('1 ms');
    expect(view.container.querySelector('[data-process-timing]')?.getAttribute('title')).toContain('结束');
    view.rerender(<ProcessTiming blocks={[{ ...block, tool: { ...block.tool!, resultMeta: { durationMs: 0 } } }]} running={false} />);
    expect(screen.getByText('执行耗时 0 ms')).toBeTruthy();
  });
  it('labels parallel operations as a whole phase span without adding execution durations', () => {
    const start = Date.parse('2026-10-16T01:00:00Z');
    const tool = (offset: number, end: number): ContentBlock => ({ type: 'tool_use', tool: { id: String(offset), name: 'Read', input: {}, streamIndex: 0,
      executionTiming: { startedAt: start + offset, finishedAt: start + end, source: 'observed' }, resultMeta: { durationMs: 5000 } } });
    render(<ProcessTiming blocks={[tool(0, 4000), tool(1000, 6000)]} running={false} />);
    expect(screen.getByText('整段跨度 6.0 s')).toBeTruthy();
    expect(screen.queryByText(/执行耗时/)).toBeNull();
  });

  it('ticks elapsed time without advancing last activity, then freezes on a real completion', () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-16T01:00:00Z');
    vi.setSystemTime(start + 10_000);
    const block: ContentBlock = { type: 'thinking', executionTiming: { startedAt: start, lastActivityAt: start + 2000, source: 'observed' } };
    const view = render(<ProcessTiming blocks={[block]} running />);
    expect(screen.getByText('已等待 10.0 s')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText('已等待 12.0 s')).toBeTruthy();
    expect(screen.getByText(/10.0 s 未见新事件/)).toBeTruthy();
    view.rerender(<ProcessTiming blocks={[{ ...block, executionTiming: { ...block.executionTiming!, finishedAt: start + 12_000 } }]} running={false} />);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('执行耗时未记录')).toBeTruthy();
    expect(view.container.querySelector('[data-process-timing]')?.getAttribute('title')).toContain('观测跨度 12.0 s');
    expect(screen.queryByText(/最近事件/)).toBeNull();
  });
});
