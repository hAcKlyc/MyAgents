import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from '@/types/chat';
import ProcessTiming from './ProcessTiming';

afterEach(() => vi.useRealTimers());
describe('event time presentation', () => {
  it('ticks elapsed time without advancing last activity, then freezes on a real completion', () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-16T01:00:00Z');
    vi.setSystemTime(start + 10_000);
    const block: ContentBlock = { type: 'thinking', executionTiming: { startedAt: start, lastActivityAt: start + 2000, source: 'observed' } };
    const view = render(<ProcessTiming blocks={[block]} running />);
    expect(screen.getByText('已用时 10.0 s')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText('已用时 12.0 s')).toBeTruthy();
    expect(screen.getByText(/10.0 s 未见新事件/)).toBeTruthy();
    view.rerender(<ProcessTiming blocks={[{ ...block, executionTiming: { ...block.executionTiming!, finishedAt: start + 12_000 } }]} running={false} />);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('耗时 12.0 s')).toBeTruthy();
    expect(screen.queryByText(/最近活动/)).toBeNull();
  });
});
