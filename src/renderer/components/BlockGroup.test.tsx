import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ContentBlock } from '@/types/chat';
import BlockGroup from './BlockGroup';
import { ChatRowLayoutProvider } from '@/context/ChatRowLayoutContext';

function tool(id: string, name = 'Read', patch: Record<string, unknown> = {}): ContentBlock {
  return { type: 'tool_use', tool: { id, name, input: {}, inputJson: '{}', result: `OUTPUT_${id}`, streamIndex: 0, ...patch } } as ContentBlock;
}
const details = () => screen.getByRole('button', { name: /展开执行详情|收起执行详情/ });

describe('BlockGroup stage summaries and folding', () => {
  it('defaults to a result summary with heavy tool bodies unmounted; can unfold and refold', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => tool(String(i), 'Read', { parsedInput: { file_path: `/tmp/salary-source-${i}.ts` } }));
    const { container } = render(<BlockGroup blocks={blocks} />);
    expect(container.querySelectorAll('[data-process-row]')).toHaveLength(0);
    expect(screen.getByText('12 次工具调用')).toBeTruthy();
    expect(screen.getByText('12 项已返回')).toBeTruthy();
    expect(screen.queryByText('OUTPUT_0')).toBeNull();
    fireEvent.click(details());
    expect(container.querySelectorAll('[data-process-row]')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: /读取 salary-source-0.ts/ }));
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
    expect(screen.getByText('1 项未确认')).toBeTruthy();
  });
  it('updates a live summary to its actual terminal result without unfolding raw logs', () => {
    const { container, rerender } = render(<BlockGroup blocks={[tool('live', 'Read', { result: undefined, isLoading: true })]} isStreaming />);
    expect(container.querySelector('[data-phase-outcome="running"]')).toBeTruthy();
    rerender(<BlockGroup blocks={[tool('live', 'Read', { result: '', isLoading: false })]} />);
    expect(container.querySelector('[data-phase-outcome="succeeded"]')).toBeTruthy();
    expect(details()).toHaveAttribute('aria-expanded', 'false');
  });
  it('binds the successful command exit code to its action when another command failed', () => {
    render(<BlockGroup blocks={[
      tool('failed', 'Bash', { parsedInput: { command: 'npm test', description: '失败的隔离检查' }, isError: true, resultMeta: { exitCode: 1 } }),
      tool('passed', 'Bash', { parsedInput: { command: 'npm run typecheck', description: '成功的类型检查' }, resultMeta: { exitCode: 0, durationMs: 860 } }),
    ]} />);
    expect(screen.getByText('最近结果对应：成功的类型检查')).toBeTruthy();
    expect(screen.getByText('退出码 0')).toBeTruthy();
    expect(screen.getByRole('button', { name: /失败的隔离检查/ })).toBeTruthy();
  });
  it('notifies the chat layout owner when a visible running row folds after completion', () => {
    const notify = vi.fn();
    const view = (blocks: ContentBlock[], live: boolean) => <ChatRowLayoutProvider messageId="message" onRowLayoutChanged={notify}>
      <BlockGroup blocks={blocks} isStreaming={live} />
    </ChatRowLayoutProvider>;
    const { rerender } = render(view([tool('run', 'Read', { result: undefined, isLoading: true })], true));
    rerender(view([tool('run', 'Read', { result: '', isLoading: false })], false));
    expect(notify).toHaveBeenCalledWith('message', 'tool-complete');
    fireEvent.click(details());
    expect(notify).toHaveBeenCalledWith('message', 'block-group-expand');
    fireEvent.click(details());
    expect(notify).toHaveBeenCalledWith('message', 'block-group-collapse');
  });

  it('keeps a directly opened active tool mounted after it completes', () => {
    const input = { file_path: '/tmp/live.ts' };
    const { rerender } = render(<BlockGroup blocks={[tool('active', 'Read', { parsedInput: input, result: undefined, isLoading: true })]} isStreaming />);
    const row = screen.getByRole('button', { name: /读取 live.ts/ });
    fireEvent.click(row);
    expect(details()).toHaveAttribute('aria-expanded', 'true');
    rerender(<BlockGroup blocks={[tool('active', 'Read', { parsedInput: input, isLoading: false })]} />);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('OUTPUT_active')).toBeTruthy();
    expect(screen.getByRole('button', { name: /读取 live.ts/ })).toBe(row);
  });

});
