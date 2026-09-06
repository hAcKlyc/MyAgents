import { act, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

type VirtuosoMockProps = {
  context?: unknown;
  components?: {
    Footer?: React.ComponentType<{ context?: unknown }>;
  };
};

vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: VirtuosoMockProps) => {
    const Footer = props.components?.Footer;
    return (
      <div data-testid="virtuoso">
        {Footer ? <Footer context={props.context} /> : null}
      </div>
    );
  },
}));

vi.mock('@/components/Message', () => ({ default: () => <div data-testid="msg" /> }));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));

import MessageList from './MessageList';
import { useQueryElapsedClock } from '@/hooks/useQueryElapsedClock';

function msg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): MessageType {
  return { id, role, content, timestamp: new Date() } as MessageType;
}

function createBaseProps(overrides: Partial<React.ComponentProps<typeof MessageList>> = {}) {
  return {
    messages: [msg('h1', 'hello', 'user')],
    streamingMessage: null,
    isLoading: false,
    sessionId: 's1',
    isActive: true,
    firstItemIndex: 1_000_000,
    virtuosoRef: { current: null },
    followEnabledRef: { current: true } as React.MutableRefObject<boolean | 'force'>,
    scrollToBottom: vi.fn(),
    handleAtBottomChange: vi.fn(),
    ...overrides,
  };
}

function renderList(overrides: Partial<React.ComponentProps<typeof MessageList>> = {}) {
  const props: React.ComponentProps<typeof MessageList> = createBaseProps(overrides);
  return render(<MessageList {...props} />);
}

function ClockOwner({
  props,
  mounted = true,
  waiting = false,
}: {
  props: React.ComponentProps<typeof MessageList>;
  mounted?: boolean;
  waiting?: boolean;
}) {
  const getQueryElapsedSeconds = useQueryElapsedClock(props.isLoading, waiting, props.sessionId ?? null);
  return mounted ? <MessageList {...props} getQueryElapsedSeconds={getQueryElapsedSeconds} /> : null;
}

describe('MessageList footer status positioning', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps query elapsed time and the status row across footer content/layout changes', () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const props = createBaseProps({ isLoading: true, getQueryElapsedSeconds: () => Math.floor((Date.now() - startedAt) / 1000) });
    const { rerender } = render(<MessageList {...props} />);
    act(() => vi.advanceTimersByTime(3000));
    const row = document.querySelector('[data-chat-status-row]');
    expect(row?.textContent).toMatch(/3/);
    rerender(<MessageList {...props} systemStatus="compacting" bottomSpacerPx={300} />);
    expect(document.querySelector('[data-chat-status-row]')).toBe(row);
    act(() => vi.advanceTimersByTime(2000));
    expect(row?.textContent).toMatch(/5/);
  });

  it('keeps Tab-owned time while the list is hidden or remounted, including human waits while hidden', () => {
    vi.useFakeTimers();
    const props = createBaseProps({ isLoading: true });
    const { rerender } = render(<ClockOwner props={props} />);
    act(() => vi.advanceTimersByTime(3000));
    expect(document.querySelector('[data-chat-status-row]')?.textContent).toMatch(/3/);
    rerender(<ClockOwner props={{ ...props, isActive: false }} waiting />);
    act(() => vi.advanceTimersByTime(30000));
    rerender(<ClockOwner props={props} waiting />);
    expect(document.querySelector('[data-chat-status-row]')?.textContent).toMatch(/3/);
    rerender(<ClockOwner props={props} mounted={false} />);
    act(() => vi.advanceTimersByTime(5000));
    rerender(<ClockOwner props={props} />);
    expect(document.querySelector('[data-chat-status-row]')?.textContent).toMatch(/8/);
    rerender(<ClockOwner props={{ ...props, isLoading: false }} />);
    expect(document.querySelector('[data-chat-status-row]')).toBeNull();
    act(() => vi.advanceTimersByTime(20000));
    rerender(<ClockOwner props={props} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(document.querySelector('[data-chat-status-row]')?.textContent).toMatch(/2/);
  });

  it('keeps loading status in the Virtuoso footer flow above the measured spacer', () => {
    renderList({
      isLoading: true,
      bottomSpacerPx: 152.2,
    });

    expect(document.querySelector('[data-chat-status-overlay]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-chat-footer-status-placeholder]')).not.toBeInTheDocument();

    const row = document.querySelector<HTMLElement>('[data-chat-status-row]');
    expect(row).toBeInTheDocument();
    if (!row) throw new Error('expected status row');
    expect(row).toHaveStyle({ height: '30px' });
    expect(row).not.toHaveClass('absolute');
    expect(row).not.toHaveClass('sticky');

    const spacer = document.querySelector<HTMLElement>('[data-chat-footer-spacer]');
    expect(spacer).toBeInTheDocument();
    if (!spacer) throw new Error('expected footer spacer');
    expect(spacer).toHaveStyle({ height: '193px' });
    expect(row.compareDocumentPosition(spacer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uses the same footer slot for idle system notices', () => {
    renderList({
      systemNotice: { kind: 'compact', level: 'success', message: 'Saved' },
    });

    expect(document.querySelector('[data-chat-status-row]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-chat-footer-spacer]')).toBeInTheDocument();
    expect(document.body).toHaveTextContent('Saved');
  });
});
