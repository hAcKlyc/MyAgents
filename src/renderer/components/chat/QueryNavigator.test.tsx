import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QueryNavigator from './QueryNavigator';
import type { Message } from '../../types/chat';
import { SPACE_ISSUE_CONTEXT_TAG, buildFloatingBallContextReminder } from '../../../shared/systemReminder';
import { projectVisibleChatTimelineRows } from '@/utils/chatTimelineRows';

class IntersectionObserverMock {
  observe() {}
  disconnect() {}
}

class MutationObserverMock {
  observe() {}
  disconnect() {}
}

function userMessage(id: string, content: string): Message {
  return {
    id,
    role: 'user',
    content,
    timestamp: new Date('2026-05-26T00:00:00Z'),
  };
}

describe('QueryNavigator', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
    vi.stubGlobal('MutationObserver', MutationObserverMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bounds the number of mounted controls while scrolling through 5000 questions', () => {
    const navigate = vi.fn();
    const { container } = render(<QueryNavigator
      messages={Array.from({ length: 5000 }, (_, index) => userMessage(String(index), 'Question ' + index))}
      scrollContainerRef={{ current: document.createElement('div') }}
      pauseAutoScroll={vi.fn()} onNavigateToQuery={navigate} />);
    expect(container.querySelectorAll('button').length).toBeLessThan(40);
    const list = container.querySelector<HTMLElement>('.overflow-y-auto')!;
    fireEvent.mouseEnter(list.parentElement!);
    fireEvent.scroll(list, { target: { scrollTop: 34000 } });
    expect(container.querySelectorAll('button').length).toBeLessThan(40);
    const target = Array.from(container.querySelectorAll('button')).find(row => row.textContent === 'Question 1000');
    fireEvent.click(target!);
    expect(navigate).toHaveBeenCalledWith('1000');
  });

  it('keeps the rail clear of the native message scrollbar gutter', () => {
    const scrollContainerRef = { current: document.createElement('div') };

    const { container } = render(
      <QueryNavigator
        messages={[
          userMessage('u1', 'First question'),
          userMessage('u2', 'Second question'),
          userMessage('u3', 'Third question'),
        ]}
        scrollContainerRef={scrollContainerRef}
        pauseAutoScroll={vi.fn()}
      />,
    );

    expect(container.firstElementChild).toHaveClass('right-4');
    expect(container.firstElementChild).not.toHaveClass('right-0');
  });

  it('does not count task notifications toward the navigator threshold', () => {
    const scrollContainerRef = { current: document.createElement('div') };

    const { container } = render(
      <QueryNavigator
        messages={projectVisibleChatTimelineRows([
          userMessage('u1', 'First question'),
          userMessage(
            'task-notification-bg-1',
            '<task-notification>{"taskId":"bg-1","status":"completed"}</task-notification>',
          ),
          userMessage('u2', 'Second question'),
        ])}
        scrollContainerRef={scrollContainerRef}
        pauseAutoScroll={vi.fn()}
      />,
    );

    expect(container.firstElementChild).toBeNull();
  });

  it('hides task notifications when real user queries are present', () => {
    const scrollContainerRef = { current: document.createElement('div') };

    const { container } = render(
      <QueryNavigator
        messages={projectVisibleChatTimelineRows([
          userMessage('u1', 'First question'),
          userMessage(
            'task-notification-bg-1',
            '<task-notification>{"taskId":"bg-1","status":"completed"}</task-notification>',
          ),
          userMessage('u2', 'Second question'),
          userMessage('u3', 'Third question'),
        ])}
        scrollContainerRef={scrollContainerRef}
        pauseAutoScroll={vi.fn()}
      />,
    );

    expect(container).toHaveTextContent('First question');
    expect(container).toHaveTextContent('Second question');
    expect(container).toHaveTextContent('Third question');
    expect(container).not.toHaveTextContent('task-notification');
    expect(container).not.toHaveTextContent('bg-1');
  });

  it('uses the visible user query after a floating-ball context reminder', () => {
    const scrollContainerRef = { current: document.createElement('div') };
    const mixed = `${buildFloatingBallContextReminder({
      appName: 'Safari',
      selectedText: 'selected text',
    })}\n\nExplain this`;

    const { container } = render(
      <QueryNavigator
        messages={[
          userMessage('u1', 'First question'),
          userMessage('u2', mixed),
          userMessage('u3', 'Third question'),
        ]}
        scrollContainerRef={scrollContainerRef}
        pauseAutoScroll={vi.fn()}
      />,
    );

    expect(container).toHaveTextContent('First question');
    expect(container).toHaveTextContent('Explain this');
    expect(container).toHaveTextContent('Third question');
    expect(container).not.toHaveTextContent('FLOATING_BALL_CONTEXT');
    expect(container).not.toHaveTextContent('selected text');
  });

  it('uses the visible Space issue status after a hidden delivery reminder', () => {
    const scrollContainerRef = { current: document.createElement('div') };
    const visible = 'MyAgents Space 已投递一个 Issue 通知，Registered Agent 开始处理。';
    const mixed = [
      '<system-reminder>',
      `<${SPACE_ISSUE_CONTEXT_TAG}>`,
      '<issue-instruction>hidden issue instructions</issue-instruction>',
      `</${SPACE_ISSUE_CONTEXT_TAG}>`,
      '</system-reminder>',
      visible,
    ].join('\n');

    const { container } = render(
      <QueryNavigator
        messages={[
          userMessage('u1', 'First question'),
          userMessage('u2', mixed),
          userMessage('u3', 'Third question'),
        ]}
        scrollContainerRef={scrollContainerRef}
        pauseAutoScroll={vi.fn()}
      />,
    );

    expect(container).toHaveTextContent('First question');
    expect(container).toHaveTextContent(visible);
    expect(container).toHaveTextContent('Third question');
    expect(container).not.toHaveTextContent('hidden issue instructions');
  });

  it('navigates a visible turn even when its hidden reminder is maintenance-shaped', () => {
    const scrollContainerRef = { current: document.createElement('div') };
    const mixed = '<system-reminder><HEARTBEAT>hidden schedule state</HEARTBEAT></system-reminder>Visible follow-up';

    const { container } = render(
      <QueryNavigator
        messages={[
          userMessage('u1', 'First question'),
          userMessage('u2', mixed),
          userMessage('u3', 'Third question'),
        ]}
        scrollContainerRef={scrollContainerRef}
        pauseAutoScroll={vi.fn()}
      />,
    );

    expect(container).toHaveTextContent('Visible follow-up');
    expect(container).not.toHaveTextContent('hidden schedule state');
  });
});
