// Regression test: a thinking block must NOT auto-expand while streaming.
//
// Previously a live (streaming) thinking block auto-expanded and then auto-
// collapsed on completion — the expand→collapse made the page jump during
// streaming. We deliberately removed that: thinking blocks are now collapsed by
// default and only open on user click (like tool blocks), while the collapsed
// header still shows the live "思考中…" indicator. This test guards against the
// auto-expand reappearing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, fireEvent } from '@testing-library/react';

import { renderWithTheme as render } from '@/test/renderWithTheme';

import ProcessRow from './ProcessRow';
import type { ContentBlock } from '@/types/chat';

afterEach(() => cleanup());

const REASONING = 'secret reasoning detail';

it('shows a completed open child handle without a running indicator', () => {
  const block = { type: 'tool_use', tool: {
    id: 'completed-child-call', name: 'Agent', parsedInput: { description: 'Research fixture' },
    result: '{"taskId":"work-1","agentId":"child-1","state":"background"}', isLoading: false,
    subagentLifecycle: {
      activation: { id: 'activation-1', ordinal: 1, state: 'completed' }, handleState: 'open',
      status: 'completed', startedAt: 100, finishedAt: 200,
    },
  } } as ContentBlock;
  const { container } = render(<ProcessRow block={block} index={0} totalBlocks={1} isStreaming={false} />);
  expect(screen.getByText('已完成，可继续')).toBeTruthy();
  expect(container.querySelector('.animate-spin')).toBeNull();
});

function thinkingBlock(overrides: Partial<ContentBlock> = {}): ContentBlock {
  return { type: 'thinking', thinking: REASONING, isComplete: false, ...overrides } as ContentBlock;
}

describe('ProcessRow thinking block expand behaviour', () => {
  it('does NOT auto-expand a live (streaming) thinking block', () => {
    render(<ProcessRow block={thinkingBlock()} index={0} totalBlocks={1} isStreaming />);
    // Collapsed: the reasoning body is unmounted …
    expect(screen.queryByText(new RegExp(REASONING, 'i'))).toBeNull();
    // … but the live "thinking" indicator is still shown.
    expect(screen.getByText(/思考中/)).toBeTruthy();
  });

  it('expands only when the user clicks the row', () => {
    render(<ProcessRow block={thinkingBlock()} index={0} totalBlocks={1} isStreaming />);
    expect(screen.queryByText(new RegExp(REASONING, 'i'))).toBeNull();
    fireEvent.click(screen.getByRole('button')); // the header is the only button while collapsed
    expect(screen.getByText(new RegExp(REASONING, 'i'))).toBeTruthy();
  });

  it('signals onUserExpand when opened, but not when collapsing', () => {
    const onUserExpand = vi.fn();
    render(<ProcessRow block={thinkingBlock()} index={0} totalBlocks={1} isStreaming onUserExpand={onUserExpand} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn); // open
    expect(onUserExpand).toHaveBeenCalledTimes(1);
    fireEvent.click(btn); // collapse — must NOT re-signal
    expect(onUserExpand).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed thinking block collapsed by default', () => {
    render(
      <ProcessRow
        block={thinkingBlock({ isComplete: true, thinkingDurationMs: 3000 })}
        index={0}
        totalBlocks={1}
        isStreaming={false}
      />,
    );
    expect(screen.queryByText(new RegExp(REASONING, 'i'))).toBeNull();
  });
});

describe('ProcessRow Codex CollabAgent activity', () => {
  it('keeps a completed parent row active while a nested sub-agent call is still streaming', () => {
    const block = {
      type: 'tool_use',
      tool: {
        id: 'card-1',
        name: 'CollabAgent',
        input: { tool: 'spawnAgent', prompt: 'review analytics', model: 'gpt-5.5' },
        parsedInput: { tool: 'spawnAgent', prompt: 'review analytics', model: 'gpt-5.5' },
        streamIndex: 0,
        result: 'Tool: spawnAgent\nStatus: completed',
        isLoading: false,
        taskStartTime: Date.now() - 10_000,
        subagentCalls: [
          { id: 'child-1', name: 'AgentMessage', input: {}, result: 'still reviewing', isLoading: true },
        ],
      },
    } as ContentBlock;

    const { container } = render(<ProcessRow block={block} index={0} totalBlocks={1} isStreaming />);

    expect(screen.getByText('子 Agent')).toBeInTheDocument();
    expect(screen.getByText('Agent 消息')).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.querySelector('[data-process-status="running"]')).toHaveTextContent('执行中');
  });
});

describe('ProcessRow tool body layout ownership', () => {
  it('gives only Edit/Write the full-width body while preserving header expansion semantics', () => {
    const editBlock = {
      type: 'tool_use',
      tool: {
        id: 'edit-full-width',
        name: 'Edit',
        input: {
          file_path: '/tmp/example.ts',
          old_string: 'const oldValue = 1;',
          new_string: 'const newValue = 2;',
        },
        inputJson: JSON.stringify({
          file_path: '/tmp/example.ts',
          old_string: 'const oldValue = 1;',
          new_string: 'const newValue = 2;',
        }),
        streamIndex: 0,
      },
    } as ContentBlock;

    const { container } = render(<ProcessRow block={editBlock} index={0} totalBlocks={1} />);
    const header = screen.getByRole('button', { expanded: false });
    fireEvent.click(header);

    expect(header).toHaveAttribute('aria-expanded', 'true');
    const body = container.querySelector('[data-process-body-layout="full"]');
    expect(body).toBeInTheDocument();
    expect(body).not.toHaveClass('ml-7');
  });

  it('keeps non-file tools on the established indented body layout', () => {
    const readBlock = {
      type: 'tool_use',
      tool: {
        id: 'read-indented',
        name: 'Read',
        input: { file_path: '/tmp/example.ts' },
        inputJson: JSON.stringify({ file_path: '/tmp/example.ts' }),
        result: 'const value = 1;',
        streamIndex: 0,
      },
    } as ContentBlock;

    const { container } = render(<ProcessRow block={readBlock} index={0} totalBlocks={1} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(container.querySelector('[data-process-body-layout="indented"]')).toHaveClass('ml-7');
  });
});

describe('ProcessRow Provider tool ownership', () => {
  it.each([
    { isLoading: false, result: undefined, isError: false, streaming: false, outcome: 'unknown', label: '结果未确认' },
    { isLoading: false, result: '', isError: false, streaming: false, outcome: 'succeeded', label: '已返回结果' },
    { isLoading: false, result: 'Service error', isError: true, streaming: false, outcome: 'failed', label: '失败' },
    { isLoading: true, result: undefined, isError: false, streaming: true, outcome: 'running', label: '执行中' },
    { isLoading: true, result: undefined, isError: false, streaming: false, outcome: 'unknown', label: '结果未确认' },
  ])('shows $outcome from Provider evidence for live and reopened rows', ({ isLoading, result, isError, streaming, outcome, label }) => {
    const block = {
      type: 'server_tool_use', providerRouteId: 'fixture-provider', providerBlockType: 'server_tool_use',
      tool: { id: 'provider-call', name: 'vendor_tool', input: {}, result, isError, isLoading, streamIndex: 0 },
    } as ContentBlock;
    const { container } = render(<ProcessRow block={block} index={0} totalBlocks={2} isStreaming={streaming} />);
    expect(container.querySelector(`[data-provider-outcome="${outcome}"]`)).toHaveTextContent(label);
    expect(Boolean(container.querySelector('.animate-spin'))).toBe(outcome === 'running');
  });

  it('labels server tool activity as Provider-owned', () => {
    const block = {
      type: 'server_tool_use',
      providerRouteId: 'fixture-provider',
      providerBlockType: 'server_tool_use',
      tool: {
        id: 'provider-call-1',
        name: 'web_search',
        input: { query: 'reference' },
        result: '[]',
        isLoading: false,
        streamIndex: 0,
      },
    } as ContentBlock;

    const { container } = render(<ProcessRow block={block} index={0} totalBlocks={1} />);

    expect(container.querySelector('[data-provider-owned="true"]')).toHaveTextContent('Provider 执行');
  });
});
