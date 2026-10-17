import { describe, expect, it, vi } from 'vitest';
import { screen, fireEvent, render as renderDom } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ThemeRuntimeProvider } from '@/theme';
import type { ContentBlock } from '@/types/chat';
import BlockGroup from './BlockGroup';
import { ChatRowLayoutProvider } from '@/context/ChatRowLayoutContext';

const render = (ui: ReactElement) => renderDom(ui, { wrapper: ({ children }) =>
  <ThemeRuntimeProvider selection={{ themeId: 'myagents-default', appearanceMode: 'light' }}>{children}</ThemeRuntimeProvider> });

function tool(id: string, name = 'Read', patch: Record<string, unknown> = {}): ContentBlock {
  return { type: 'tool_use', tool: { id, name, input: {}, inputJson: '{}', result: `OUTPUT_${id}`, streamIndex: 0, ...patch } } as ContentBlock;
}
const details = () => screen.getByRole('button', { name: /展开结果与时间|收起结果与时间/ });

describe('BlockGroup stage summaries and folding', () => {
  it('defaults to a result summary with heavy tool bodies unmounted; can unfold and refold', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => tool(String(i), 'Read', { parsedInput: { file_path: `/tmp/salary-source-${i}.ts` } }));
    const { container } = render(<BlockGroup blocks={blocks} />);
    expect(container.querySelectorAll('[data-process-row]')).toHaveLength(0);
    expect(screen.getByText('成功返回 12/12')).toBeTruthy();
    expect(screen.getByText('已返回 12 项结果')).toBeTruthy();
    expect(screen.queryByText('OUTPUT_0')).toBeNull();
    fireEvent.click(details());
    expect(container.querySelectorAll('[data-process-row]')).toHaveLength(12);
    fireEvent.click(screen.getAllByRole('button', { name: /已读取 salary-source-0.ts/ })[0]);
    expect(screen.getByText('OUTPUT_0')).toBeTruthy();
    fireEvent.click(details());
    expect(container.querySelectorAll('[data-process-row]')).toHaveLength(0);
    expect(screen.queryByText('OUTPUT_0')).toBeNull();
  });
  it('preserves stage order and shows repeated types as separate chronological stages', () => {
    const { container } = render(<BlockGroup blocks={[tool('a'), tool('b', 'Write'), tool('c')]} />);
    expect(Array.from(container.querySelectorAll('[data-process-phase]')).map(e => e.getAttribute('data-process-phase'))).toEqual(['explore', 'change', 'explore']);
  });
  it('keeps failures, interrupted calls and running parallel calls visible behind the default fold', () => {
    const { container } = render(<BlockGroup isStreaming blocks={[
      tool('done'), tool('error', 'Read', { isError: true }), tool('stopped', 'Read', { isStopped: true }),
      tool('running1', 'Read', { result: undefined, isLoading: true }), tool('running2', 'Read', { result: undefined, isLoading: true }),
    ]} />);
    expect(container.querySelectorAll('[data-process-row]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-process-row="running"]')).toHaveLength(2);
    expect(screen.getByText('1 项失败')).toBeTruthy();
    expect(screen.getByText('1 项中断')).toBeTruthy();
    expect(screen.getByText('2 项执行中')).toBeTruthy();
  });
  it('does not lose manually expanded details when another event or stage arrives', () => {
    const initial = [tool('a', 'Read', { parsedInput: { file_path: '/tmp/a.ts' } }), tool('b')];
    const { rerender } = render(<BlockGroup blocks={initial} isStreaming />);
    fireEvent.click(details());
    const row = screen.getAllByRole('button', { expanded: false })[0];
    fireEvent.click(row);
    expect(screen.getByText('OUTPUT_a')).toBeTruthy();
    rerender(<BlockGroup blocks={[...initial, tool('c'), tool('d', 'Write')]} isStreaming />);
    expect(screen.getByText('OUTPUT_a')).toBeTruthy();
    expect(row).toHaveAttribute('aria-expanded', 'true');
  });
  it('retains every subagent navigation anchor without expanding details', () => {
    const { container } = render(<BlockGroup blocks={Array.from({ length: 5 }, (_, i) => tool(`agent-${i}`, 'Task'))} />);
    expect(container.querySelectorAll('[data-tool-id]')).toHaveLength(5);
  });
  it('never labels missing historical output as successful or running', () => {
    const { container } = render(<BlockGroup blocks={[tool('stale', 'Read', { result: undefined, isLoading: true })]} />);
    expect(container.querySelector('[data-phase-outcome="unknown"]')).toBeTruthy();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('[data-process-status="unknown"]')).toBeTruthy();
  });
  it('updates a live summary to its actual terminal result without unfolding raw logs', () => {
    const { container, rerender } = render(<BlockGroup blocks={[tool('live', 'Read', { result: undefined, isLoading: true })]} isStreaming />);
    expect(container.querySelector('[data-phase-outcome="running"]')).toBeTruthy();
    rerender(<BlockGroup blocks={[tool('live', 'Read', { result: '', isLoading: false })]} />);
    expect(container.querySelector('[data-phase-outcome="succeeded"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /展开结果与时间/ })).toBeNull();
    expect(container.querySelector('[data-process-row] button')).toBeDisabled();
  });
  it('binds the successful command exit code to its action when another command failed', () => {
    render(<BlockGroup blocks={[
      tool('failed', 'Bash', { parsedInput: { command: 'npm test', description: '失败的隔离检查' }, isError: true, resultMeta: { exitCode: 1 } }),
      tool('passed', 'Bash', { parsedInput: { command: 'npm run typecheck', description: '成功的类型检查' }, resultMeta: { exitCode: 0, durationMs: 860 } }),
    ]} />);
    expect(screen.queryByText(/最近结果对应/)).toBeNull();
    expect(screen.queryByText('退出码 0')).toBeNull();
    expect(screen.getByRole('button', { name: /OUTPUT_failed/ })).toBeTruthy();
  });
  it('notifies the chat layout owner when a directly visible result completes and toggles', () => {
    const notify = vi.fn();
    const view = (blocks: ContentBlock[], live: boolean) => <ChatRowLayoutProvider messageId="message" onRowLayoutChanged={notify}>
      <BlockGroup blocks={blocks} isStreaming={live} />
    </ChatRowLayoutProvider>;
    const { rerender } = render(view([tool('run', 'Read', { result: undefined, isLoading: true })], true));
    rerender(view([tool('run', 'Read', { result: 'completed-result', isLoading: false })], false));
    expect(notify).toHaveBeenCalledWith('message', 'tool-complete');
    const row = screen.getByRole('button', { name: /相关资料已返回/ });
    fireEvent.click(row);
    expect(notify).toHaveBeenCalledWith('message', 'process-row-expand');
    fireEvent.click(row);
    expect(notify).toHaveBeenCalledWith('message', 'process-row-collapse');
  });

  it('keeps a directly opened active tool mounted after it completes', () => {
    const input = { file_path: '/tmp/live.ts' };
    const { rerender } = render(<BlockGroup blocks={[tool('active', 'Read', { parsedInput: input, result: 'partial-result', isLoading: true })]} isStreaming />);
    const row = screen.getByRole('button', { name: /正在查看相关资料/ });
    fireEvent.click(row);
    expect(screen.queryByRole('button', { name: /展开结果与时间|收起结果与时间/ })).toBeNull();
    rerender(<BlockGroup blocks={[tool('active', 'Read', { parsedInput: input, isLoading: false })]} />);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('OUTPUT_active')).toBeTruthy();
    expect(screen.getByRole('button', { name: /已读取 live.ts/ })).toBe(row);
  });

  it('retains opened output when finishing an update aggregates it with the same file', () => {
    const input = { file_path: '/tmp/a.ts', old_string: 'old', new_string: 'new' };
    const first = tool('first', 'Edit', { parsedInput: input });
    const second = tool('second', 'Edit', { parsedInput: input, isLoading: true, result: undefined });
    const { rerender, container } = render(<BlockGroup blocks={[first, second]} isStreaming />);
    fireEvent.click(screen.getByRole('button', { name: /正在更新文件/ }));
    expect(container.querySelector('[data-process-row="running"] button')).toHaveAttribute('aria-expanded', 'true');
    rerender(<BlockGroup blocks={[first, tool('second', 'Edit', { parsedInput: input })]} />);
    expect(screen.getByRole('button', { name: /第 2 次更新结果/ })).toHaveAttribute('aria-expanded', 'true');
    expect(container).toHaveTextContent('a.ts · 2 次更新');
    expect(container.querySelector('[data-process-body-layout]')).toBeTruthy();
    expect(container.querySelector('[data-phase-result]')).toBeNull();
  });

  it('opens a single result directly with one label and one timing, without a phase fold', () => {
    const start = Date.parse('2026-10-16T12:11:21Z');
    const { container } = render(<BlockGroup blocks={[tool('single', 'Grep', {
      result: JSON.stringify({ numLines: 11, content: 'salary.ts:21: subjectId' }),
      executionTiming: { startedAt: start, finishedAt: start + 1, source: 'observed' },
    })]} />);
    expect(screen.queryByText('资料结果')).toBeNull();
    expect(screen.queryByText('成功返回 1/1')).toBeNull();
    expect(screen.getAllByText('返回 11 条匹配行')).toHaveLength(1);
    const row = screen.getByRole('button', { name: /返回 11 条匹配行/ });
    expect(container.querySelectorAll('[data-process-timing]')).toHaveLength(1);
    fireEvent.click(row);
    expect(container).toHaveTextContent('salary.ts:21: subjectId');
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelectorAll('[data-process-row]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-process-timing]')).toHaveLength(1);
  });

  it('does not offer an empty result or empty reasoning disclosure', () => {
    const { container } = render(<BlockGroup blocks={[
      tool('empty', 'Read', { result: '  ' }),
      tool('empty-grep', 'Grep', { result: JSON.stringify({ numLines: 0, content: '' }) }),
      tool('empty-read', 'Read', { result: JSON.stringify({ type: 'text', file: { content: '' } }) }),
      { id: 'empty-think', type: 'thinking', thinking: '  ', isComplete: true },
    ]} />);
    fireEvent.click(details());
    expect(container.querySelectorAll('[data-process-row]')).toHaveLength(4);
    for (const row of container.querySelectorAll('[data-process-row] button')) {
      expect(row).toBeDisabled();
      expect(row).not.toHaveAttribute('aria-expanded');
    }
    expect(container.querySelector('[data-process-body-layout]')).toBeNull();
  });

  it('drops the aggregate summary and time while expanded and restores them when collapsed', () => {
    const { container } = render(<BlockGroup blocks={[tool('one'), tool('two')]} />);
    expect(container.querySelectorAll('[data-process-timing]')).toHaveLength(1);
    fireEvent.click(details());
    expect(screen.queryByText('已返回 2 项结果')).toBeNull();
    expect(container.querySelectorAll('[data-process-timing]')).toHaveLength(2);
    expect(container.querySelector('[data-phase-result]')).toBeNull();
    fireEvent.click(details());
    expect(screen.getByText('已返回 2 项结果')).toBeTruthy();
    expect(container.querySelectorAll('[data-process-timing]')).toHaveLength(1);
  });

  it('preserves a single opened result when its chronological phase grows', () => {
    const first = tool('one');
    const { rerender } = render(<BlockGroup blocks={[first]} isStreaming />);
    fireEvent.click(screen.getByRole('button', { name: /相关资料已返回/ }));
    expect(screen.getByText('OUTPUT_one')).toBeTruthy();
    rerender(<BlockGroup blocks={[first, tool('two')]} isStreaming />);
    expect(details()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('OUTPUT_one')).toBeTruthy();
    fireEvent.click(details());
    fireEvent.click(details());
    expect(screen.getByText('OUTPUT_one')).toBeTruthy();
  });

});
