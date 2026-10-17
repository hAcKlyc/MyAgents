import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithTheme as render } from '@/test/renderWithTheme';
import type { AgentStatusTodoSnapshot, Message, ToolUseSimple } from '@/types/chat';
import { BACKGROUND_TASK_STATUS_EVENT } from '@/utils/backgroundTaskStatus';

import AgentStatusPanel from './AgentStatusPanel';

const panelHarness = vi.hoisted(() => ({
  messages: [] as Message[],
  streamingMessage: null as Message | null,
  sessionState: 'idle' as 'idle' | 'running',
  agentPlanTodos: null as AgentStatusTodoSnapshot[] | null,
}));

vi.mock('@/context/TabContext', () => ({
  useTabStateOptional: () => ({
    messages: panelHarness.messages,
    streamingMessage: panelHarness.streamingMessage,
    sessionState: panelHarness.sessionState,
    agentPlanTodos: panelHarness.agentPlanTodos,
    sessionId: 'session-panel',
  }),
}));

function messageWithLifecycle(status: 'running' | 'completed'): Message {
  const tool: ToolUseSimple = {
    id: 'spawn-card',
    name: 'CollabAgent',
    input: { tool: 'spawnAgent' },
    parsedInput: { tool: 'spawnAgent', prompt: 'Review lifecycle' },
    streamIndex: 0,
    subagentLifecycle: status === 'running'
      ? { status, startedAt: 100 }
      : { status, startedAt: 100, finishedAt: 1_100 },
  };
  return {
    id: 'assistant-turn',
    role: 'assistant',
    timestamp: new Date(0),
    content: [{ type: 'tool_use', tool }],
  };
}

function completedTodos(source: 'TodoWrite' | 'TaskList' | 'runtime') {
  if (source === 'runtime') {
    panelHarness.agentPlanTodos = [{ key: 'todo', content: 'Finished work', status: 'completed', activeForm: 'Working' }];
    return;
  }
  panelHarness.messages = [{
    id: 'todo-turn', role: 'assistant', timestamp: new Date(0),
    content: [{ type: 'tool_use', tool: {
      id: 'todo-tool', name: source, input: {}, streamIndex: 0,
      parsedInput: source === 'TodoWrite' ? { todos: [{ content: 'Finished work', status: 'completed', activeForm: 'Working' }] } : {},
      result: source === 'TaskList' ? JSON.stringify({ tasks: [{ id: '1', subject: 'Finished work', status: 'completed' }] }) : undefined,
    } }],
  }];
}

function refreshPanel() {
  act(() => window.dispatchEvent(new CustomEvent(BACKGROUND_TASK_STATUS_EVENT, {
    detail: { sessionId: 'session-panel' },
  })));
}

function finishPresentation() {
  act(() => vi.advanceTimersByTime(500));
  act(() => vi.advanceTimersByTime(1500));
}

describe('AgentStatusPanel child lifecycle group', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    panelHarness.messages = [];
    panelHarness.streamingMessage = null;
    panelHarness.sessionState = 'idle';
    panelHarness.agentPlanTodos = null;
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('surfaces the actual in-progress task beside its count without inferring the next pending task', () => {
    panelHarness.sessionState = 'running';
    panelHarness.agentPlanTodos = [
      { key: 'done', content: 'Finished', activeForm: 'Finished', status: 'completed' },
      { key: 'active', content: '核对工资汇总逻辑', activeForm: '正在核对工资汇总逻辑', status: 'in_progress' },
      { key: 'next', content: '稍后发布', activeForm: '发布中', status: 'pending' },
    ];
    const { container } = render(<AgentStatusPanel containerRef={createRef<HTMLElement>()} onJumpToTool={() => undefined} />);
    act(() => vi.advanceTimersByTime(80));
    expect(screen.getByText('Todo 1/3')).toBeTruthy();
    expect(container.querySelector('[data-current-todo]')).toHaveTextContent('正在核对工资汇总逻辑');
    expect(container.querySelector('[data-current-todo]')).not.toHaveTextContent('发布中');
  });


  it.each(['TodoWrite', 'TaskList', 'runtime'] as const)('does not revive completed %s history on cold open', source => {
    completedTodos(source);
    const { container } = render(<AgentStatusPanel containerRef={createRef<HTMLElement>()} onJumpToTool={() => undefined} />);
    for (let cycle = 0; cycle < 3; cycle++) {
      act(() => vi.advanceTimersByTime(40));
      expect(container).toBeEmptyDOMElement();
      finishPresentation();
      refreshPanel();
    }
  });

  it.each(['TodoWrite', 'TaskList', 'runtime'] as const)('shows a live terminal-first %s once, then stays unmounted', source => {
    completedTodos(source);
    panelHarness.sessionState = 'running';
    panelHarness.streamingMessage = panelHarness.messages[0] ?? messageWithLifecycle('completed');
    const { container } = render(<AgentStatusPanel containerRef={createRef<HTMLElement>()} onJumpToTool={() => undefined} />);
    act(() => vi.advanceTimersByTime(40)); // arm the current turn
    act(() => vi.advanceTimersByTime(40)); // mount and fade in
    expect(container.firstElementChild).toHaveClass('opacity-100');
    finishPresentation();
    for (let cycle = 0; cycle < 3; cycle++) {
      act(() => vi.advanceTimersByTime(40));
      expect(container).toBeEmptyDOMElement();
      refreshPanel();
      finishPresentation();
    }
    // A real new turn can present another terminal-first completion.
    panelHarness.sessionState = 'idle';
    panelHarness.streamingMessage = null;
    refreshPanel();
    panelHarness.sessionState = 'running';
    refreshPanel();
    act(() => vi.advanceTimersByTime(40));
    act(() => vi.advanceTimersByTime(40));
    expect(container.firstElementChild).toHaveClass('opacity-100');
  });

  it('does not remount a terminal child while its streaming projection is retained', () => {
    panelHarness.messages = [messageWithLifecycle('completed')];
    panelHarness.streamingMessage = panelHarness.messages[0];
    panelHarness.sessionState = 'running';
    const { container } = render(<AgentStatusPanel containerRef={createRef<HTMLElement>()} onJumpToTool={() => undefined} />);
    act(() => vi.advanceTimersByTime(40));
    act(() => vi.advanceTimersByTime(40));
    expect(container.firstElementChild).toHaveClass('opacity-100');
    finishPresentation();
    act(() => vi.advanceTimersByTime(40));
    expect(container).toBeEmptyDOMElement();
    refreshPanel();
    act(() => vi.advanceTimersByTime(3000));
    expect(container).toBeEmptyDOMElement();
  });

  it('cancels a pending fade when new activity arrives', () => {
    panelHarness.messages = [messageWithLifecycle('running')];
    panelHarness.streamingMessage = panelHarness.messages[0];
    panelHarness.sessionState = 'running';
    render(<AgentStatusPanel containerRef={createRef<HTMLElement>()} onJumpToTool={() => undefined} />);
    act(() => vi.advanceTimersByTime(40));
    act(() => vi.advanceTimersByTime(40));
    panelHarness.messages = [messageWithLifecycle('completed')];
    panelHarness.streamingMessage = panelHarness.messages[0];
    refreshPanel();
    act(() => vi.advanceTimersByTime(500));
    panelHarness.messages = [messageWithLifecycle('running')];
    panelHarness.streamingMessage = panelHarness.messages[0];
    refreshPanel();
    act(() => vi.advanceTimersByTime(40));
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('button', { name: '展开 Agent 状态面板' }).parentElement).toHaveClass('opacity-100');
  });

  it('shows terminal rows for one 500ms group linger before fading', () => {
    panelHarness.messages = [messageWithLifecycle('running')];
    panelHarness.streamingMessage = panelHarness.messages[0];
    panelHarness.sessionState = 'running';
    render(
      <AgentStatusPanel containerRef={createRef<HTMLElement>()} onJumpToTool={() => undefined} />,
    );
    act(() => vi.advanceTimersByTime(40));
    fireEvent.click(screen.getByRole('button', { name: '展开 Agent 状态面板' }));
    expect(screen.getByText('Review lifecycle')).toBeInTheDocument();

    panelHarness.messages = [messageWithLifecycle('completed')];
    panelHarness.streamingMessage = panelHarness.messages[0];
    act(() => window.dispatchEvent(new CustomEvent(BACKGROUND_TASK_STATUS_EVENT, {
      detail: { sessionId: 'session-panel' },
    })));
    expect(screen.getByText('Review lifecycle')).toBeInTheDocument();
    expect(document.querySelector('[aria-label="已完成"]')).not.toBeNull();
    const panel = document.querySelector('button[aria-label="收起 Agent 状态面板"]')?.parentElement;
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass('opacity-100');

    act(() => vi.advanceTimersByTime(499));
    expect(panel).toHaveClass('opacity-100');
    act(() => vi.advanceTimersByTime(1));
    expect(panel).toHaveClass('opacity-0');
    expect(panel).toHaveAttribute('inert');
  });

  it('mounts a live terminal-first group when running and terminal updates batch', () => {
    panelHarness.messages = [messageWithLifecycle('completed')];
    panelHarness.streamingMessage = panelHarness.messages[0];
    panelHarness.sessionState = 'running';

    render(<AgentStatusPanel containerRef={createRef<HTMLElement>()} onJumpToTool={() => undefined} />);
    act(() => vi.advanceTimersByTime(40));

    act(() => vi.advanceTimersByTime(40)); // live-turn arm precedes terminal presentation
    expect(screen.getByText('Agents 1')).toBeInTheDocument();
    const panel = screen.getByRole('button', { name: '展开 Agent 状态面板' }).parentElement;
    expect(panel).toHaveClass('opacity-100');
    act(() => vi.advanceTimersByTime(499));
    expect(panel).toHaveClass('opacity-100');
  });

  it('does not mount a cold terminal history group', () => {
    panelHarness.messages = [messageWithLifecycle('completed')];
    render(<AgentStatusPanel containerRef={createRef<HTMLElement>()} onJumpToTool={() => undefined} />);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByText('Agents 1')).not.toBeInTheDocument();
  });
});
