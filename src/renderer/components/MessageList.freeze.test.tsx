// Regression test for the "phantom repeated rows + blank viewport" Virtuoso
// corruption (2026-05-25, /cross-bugfix).
//
// Root cause: while a tab is inactive the host wraps the list in
// `content-visibility:hidden`; WebKit skips its layout, so any data/height churn
// Virtuoso processes in that state poisons its offset/range cache. The streaming
// reveal loop kept growing the last row while hidden. The fix freezes the
// `data`/`firstItemIndex` handed to Virtuoso while `!isActive`, so no measurement
// churn reaches it; on re-activation we swap back to the live array.
//
// This test pins that invariant at the Virtuoso boundary: it captures the `data`
// / `firstItemIndex` props Virtuoso receives and asserts they stay frozen while
// inactive and resume live on re-activation.
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SizeFunction, VirtuosoHandle } from 'react-virtuoso';

import type { Message as MessageType } from '@/types/chat';

// ── Capture the props handed to Virtuoso on every render ──
type Recorded = {
  data: MessageType[];
  firstItemIndex: number | undefined;
  heightEstimates: number[] | undefined;
  components?: unknown;
  context?: unknown;
  atBottomStateChange?: (atBottom: boolean) => void;
  followOutput?: (isAtBottom: boolean) => false | 'smooth';
  startReached?: () => void;
  skipAnimationFrameInResizeObserver?: boolean;
  itemSize?: SizeFunction;
};
const recorded: Recorded[] = [];
vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: {
    data: MessageType[];
    firstItemIndex?: number;
    heightEstimates?: number[];
    components?: unknown;
    context?: unknown;
    atBottomStateChange?: (atBottom: boolean) => void;
    followOutput?: (isAtBottom: boolean) => false | 'smooth';
    startReached?: () => void;
    skipAnimationFrameInResizeObserver?: boolean;
    itemSize?: SizeFunction;
    itemContent?: (index: number, message: MessageType, context?: unknown) => React.ReactNode;
  }) => {
    recorded.push({
      data: props.data,
      firstItemIndex: props.firstItemIndex,
      heightEstimates: props.heightEstimates,
      components: props.components,
      context: props.context,
      atBottomStateChange: props.atBottomStateChange,
      followOutput: props.followOutput,
      startReached: props.startReached,
      skipAnimationFrameInResizeObserver: props.skipAnimationFrameInResizeObserver,
      itemSize: props.itemSize,
    });
    return (
      <div data-testid="virtuoso" data-count={props.data.length}>
        {props.data.map((message, index) => (
          <React.Fragment key={message.id}>
            {props.itemContent?.(index, message, props.context)}
          </React.Fragment>
        ))}
      </div>
    );
  },
}));

// Heavy children — stub so jsdom doesn't pull Markdown / tool / prompt trees.
vi.mock('@/components/Message', () => ({ default: () => <div data-testid="msg" /> }));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));
vi.mock('@/context/ChatRowLayoutContext', () => ({
  ChatRowLayoutProvider: ({
    messageId,
    onRowLayoutChanged,
    children,
  }: {
    messageId: string;
    onRowLayoutChanged: (messageId: string, reason: string) => void;
    children: React.ReactNode;
  }) => (
    <div>
      {['process-row-collapse', 'user-message-collapse-measured', 'process-row-expand'].map(reason => (
        <button
          key={reason}
          type="button"
          data-testid={`${reason}-${messageId}`}
          onClick={() => onRowLayoutChanged(messageId, reason)}
        />
      ))}
      {children}
    </div>
  ),
}));

import MessageList from './MessageList';
import type { MainWindowPresentation } from '@/utils/mainWindowPresentation';

function msg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): MessageType {
  return { id, role, content, timestamp: new Date() } as MessageType;
}

function createFollowProps(initial: boolean | 'force' = true) {
  const followEnabledRef: React.MutableRefObject<boolean | 'force'> = { current: initial };
  return {
    followEnabledRef,
  };
}

function renderList(overrides: Partial<React.ComponentProps<typeof MessageList>>) {
  const props: React.ComponentProps<typeof MessageList> = {
    messages: [],
    streamingMessage: null,
    isLoading: false,
    sessionId: 's1',
    isActive: true,
    firstItemIndex: 1_000_000,
    virtuosoRef: { current: null },
    ...createFollowProps(),
    scrollToBottom: vi.fn(),
    handleAtBottomChange: vi.fn(),
    ...overrides,
  };
  return render(<MessageList {...props} />);
}

const lastData = () => recorded[recorded.length - 1];
const AVAILABLE_PRESENTATION: MainWindowPresentation = { surfaceAvailable: true, generation: 0 };
const SUSPENDED_PRESENTATION: MainWindowPresentation = { surfaceAvailable: false, generation: 1 };
const RESTORED_PRESENTATION: MainWindowPresentation = { surfaceAvailable: true, generation: 1 };
const streamingText = (r: Recorded) => {
  const last = r.data[r.data.length - 1];
  return typeof last?.content === 'string' ? last.content : '';
};

describe('MessageList — freeze data while inactive (Virtuoso cache-poisoning regression)', () => {
  beforeEach(() => {
    recorded.length = 0;
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(1_000);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reveals restored history without resetting the visible list opacity on the next frame', () => {
    const { rerender } = renderList({
      messages: [],
    });

    rerender(
      <MessageList
        messages={[msg('restored', 'already restored')]}
        streamingMessage={null}
        isLoading={false}
        isActive
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('virtuoso').parentElement).not.toHaveStyle({
      animation: 'message-list-fade-in 600ms ease-out both',
    });
  });

  it('does not mount a second restore spinner beneath the boot overlay', () => {
    const { container } = renderList({
      messages: [],
    });

    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it.each(['process-row-collapse', 'user-message-collapse-measured'])(
    'defers Virtuoso measurement only while %s settles',
    (reason) => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
      renderList({ messages: [msg('tool-row', 'variable-height tool output')] });

      expect(lastData().skipAnimationFrameInResizeObserver).toBe(true);

      fireEvent.click(screen.getByTestId(`${reason}-tool-row`));
      expect(lastData().skipAnimationFrameInResizeObserver).toBe(false);

      act(() => frames.shift()?.(1_001));
      expect(lastData().skipAnimationFrameInResizeObserver).toBe(false);

      act(() => frames.shift()?.(1_002));
      expect(lastData().skipAnimationFrameInResizeObserver).toBe(true);
    },
  );

  it('keeps synchronous Virtuoso measurement for row expansion', () => {
    renderList({ messages: [msg('tool-row', 'variable-height tool output')] });

    fireEvent.click(screen.getByTestId('process-row-expand-tool-row'));

    expect(lastData().skipAnimationFrameInResizeObserver).toBe(true);
  });

  it.each(['before shrink measurement', 'while shrink settles'])(
    'lets expansion preempt a pending shrink %s',
    (timing) => {
      let nextFrameId = 1;
      const frames = new Map<number, FrameRequestCallback>();
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        frames.delete(id);
      });
      renderList({ messages: [msg('tool-row', 'variable-height tool output')] });

      fireEvent.click(screen.getByTestId('process-row-collapse-tool-row'));
      expect(lastData().skipAnimationFrameInResizeObserver).toBe(false);

      if (timing === 'while shrink settles') {
        const [id, frame] = frames.entries().next().value as [number, FrameRequestCallback];
        frames.delete(id);
        act(() => frame(1_001));
        expect(lastData().skipAnimationFrameInResizeObserver).toBe(false);
      }

      fireEvent.click(screen.getByTestId('process-row-expand-tool-row'));

      expect(frames.size).toBe(0);
      expect(lastData().skipAnimationFrameInResizeObserver).toBe(true);
    },
  );

  it('coalesces overlapping large shrinks into one bounded measurement transaction', () => {
    let nextFrameId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });
    renderList({ messages: [msg('tool-row', 'variable-height tool output')] });

    fireEvent.click(screen.getByTestId('process-row-collapse-tool-row'));
    fireEvent.click(screen.getByTestId('user-message-collapse-measured-tool-row'));

    expect(frames.size).toBe(1);
    expect(lastData().skipAnimationFrameInResizeObserver).toBe(false);

    const [measureId, measure] = frames.entries().next().value as [number, FrameRequestCallback];
    frames.delete(measureId);
    act(() => measure(1_001));
    const [settleId, settle] = frames.entries().next().value as [number, FrameRequestCallback];
    frames.delete(settleId);
    act(() => settle(1_002));

    expect(frames.size).toBe(0);
    expect(lastData().skipAnimationFrameInResizeObserver).toBe(true);
  });

  it('cancels shrink settlement and rejects hidden geometry when the Tab becomes inactive', () => {
    let nextFrameId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });
    const messages = [msg('tool-row', 'variable-height tool output')];
    const { rerender } = renderList({ messages });

    fireEvent.click(screen.getByTestId('process-row-collapse-tool-row'));
    expect(lastData().skipAnimationFrameInResizeObserver).toBe(false);
    const queuedItemMeasurement = lastData().itemSize;

    rerender(
      <MessageList
        messages={messages}
        streamingMessage={null}
        isLoading={false}
        isActive={false}
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );

    expect(frames.size).toBe(0);
    expect(lastData().skipAnimationFrameInResizeObserver).toBe(true);

    const hiddenItem = document.createElement('div');
    hiddenItem.dataset.knownSize = '321';
    vi.spyOn(hiddenItem, 'getBoundingClientRect').mockReturnValue({ height: 0 } as DOMRect);
    expect(queuedItemMeasurement?.(hiddenItem, 'offsetHeight')).toBe(321);
  });

  it('rejects transient zero geometry while active without overriding valid live measurements', () => {
    renderList({ messages: [msg('tool-row', 'variable-height tool output')] });
    const itemMeasurement = lastData().itemSize;

    const transientlyZeroItem = document.createElement('div');
    transientlyZeroItem.dataset.knownSize = '321';
    vi.spyOn(transientlyZeroItem, 'getBoundingClientRect').mockReturnValue({ height: 0 } as DOMRect);
    expect(itemMeasurement?.(transientlyZeroItem, 'offsetHeight')).toBe(321);

    const measurableItem = document.createElement('div');
    measurableItem.dataset.knownSize = '321';
    vi.spyOn(measurableItem, 'getBoundingClientRect').mockReturnValue({ height: 456 } as DOMRect);
    expect(itemMeasurement?.(measurableItem, 'offsetHeight')).toBe(456);
  });

  it('does NOT forward streaming growth to Virtuoso while inactive, and resumes live on re-activation', () => {
    const history = [msg('h1', 'hello', 'user'), msg('h2', 'hi there')];

    // 1. Active, streaming "a".
    const { rerender } = renderList({
      messages: [...history, msg('stream', 'a')],
      streamingMessage: msg('stream', 'a'),
      isLoading: true,
      isActive: true,
    });
    expect(streamingText(lastData())).toBe('a');

    // 2. Go inactive (content-visibility:hidden). The reveal loop keeps growing the
    //    streaming row — emulate by re-rendering with a longer streaming message.
    rerender(
      <MessageList
        messages={[...history, msg('stream', 'abc')]}
        streamingMessage={msg('stream', 'abc')}
        isLoading isActive={false}
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    // FROZEN: Virtuoso must still see the pre-hidden snapshot ("a"), not "abc".
    expect(streamingText(lastData())).toBe('a');

    // 3. More growth while still hidden → still frozen.
    rerender(
      <MessageList
        messages={[...history, msg('stream', 'abcdef')]}
        streamingMessage={msg('stream', 'abcdef')}
        isLoading isActive={false}
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(streamingText(lastData())).toBe('a');

    // 4. Re-activate → Virtuoso swaps to the live (grown) array.
    rerender(
      <MessageList
        messages={[...history, msg('stream', 'abcdefghi')]}
        streamingMessage={msg('stream', 'abcdefghi')}
        isLoading isActive
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(streamingText(lastData())).toBe('abcdefghi');
  });

  it('freezes row-action context while inactive and publishes the live context on re-activation', () => {
    const user = msg('user-anchor', 'question', 'user');
    const assistant = {
      ...msg('assistant-anchor', 'answer'),
      runtimeTurnAnchor: { turnId: 'turn-anchor', rootUserMessageId: user.id },
    };
    const initialRewind = vi.fn();
    const followProps = createFollowProps();
    const baseProps = {
      messages: [user, assistant],
      streamingMessage: null,
      isLoading: false,
      firstItemIndex: 1_000_000,
      sessionId: 's1',
      virtuosoRef: { current: null },
      ...followProps,
      scrollToBottom: vi.fn(),
      handleAtBottomChange: vi.fn(),
      conversationOperations: 'codex' as const,
    };
    const { rerender } = renderList({
      ...baseProps,
      rewindableUserMessageIds: new Set([user.id]),
      onRewind: initialRewind,
      isActive: true,
    });
    const activeContext = lastData().context;

    rerender(
      <MessageList
        {...baseProps}
        isActive={false}
        rewindableUserMessageIds={new Set()}
      />,
    );
    expect(lastData().context).toBe(activeContext);

    rerender(
      <MessageList
        {...baseProps}
        isActive
        rewindableUserMessageIds={new Set()}
      />,
    );
    expect(lastData().context).not.toBe(activeContext);
  });

  it('keeps Virtuoso live while the active Tab remains visible but the window is unfocused', () => {
    const history = [msg('h1', 'hello', 'user'), msg('h2', 'hi there')];
    const onLoadOlder = vi.fn();
    const scrollToBottom = vi.fn();
    const followProps = createFollowProps();
    const handleAtBottomChange = vi.fn((atBottom: boolean) => {
      followProps.followEnabledRef.current = atBottom;
    });
    const { rerender } = renderList({
      messages: [...history, msg('stream', 'a')],
      streamingMessage: msg('stream', 'a'),
      isLoading: true,
      isActive: true,
      firstItemIndex: 1_000_000,
      heightEstimateSeed: [120, 240, 360],
      onLoadOlder,
      handleAtBottomChange,
      scrollToBottom,
      ...followProps,
    });
    const focusedComponents = lastData().components;
    const focusedContext = lastData().context;
    scrollToBottom.mockClear();

    rerender(
      <MessageList
        messages={[...history, msg('assistant-final', 'final hidden result')]}
        streamingMessage={null}
        isLoading={false}
        isActive
        firstItemIndex={999_995}
        heightEstimateSeed={[150, 270, 900]}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...followProps}
        scrollToBottom={scrollToBottom}
        handleAtBottomChange={handleAtBottomChange}
        onLoadOlder={onLoadOlder}
      />,
    );

    const unfocused = lastData();
    expect(unfocused.data.at(-1)?.id).toBe('assistant-final');
    expect(unfocused.firstItemIndex).toBe(999_995);
    expect(unfocused.heightEstimates).toEqual([150, 270, 900]);
    expect(unfocused.components).toBe(focusedComponents);
    expect(unfocused.context).not.toBe(focusedContext);
    expect((unfocused.context as { footer: { showStatus: boolean } }).footer.showStatus).toBe(false);

    unfocused.atBottomStateChange?.(false);
    expect(handleAtBottomChange).toHaveBeenCalledWith(false);
    expect(followProps.followEnabledRef.current).toBe(false);
    expect(unfocused.followOutput?.(true)).toBe(false);
    unfocused.atBottomStateChange?.(true);
    expect(handleAtBottomChange).toHaveBeenCalledWith(true);
    expect(followProps.followEnabledRef.current).toBe(true);
    expect(unfocused.followOutput?.(true)).toBe('smooth');
    unfocused.startReached?.();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).toHaveBeenCalledWith('auto');

    rerender(
      <MessageList
        messages={[...history, msg('assistant-final', 'final hidden result')]}
        streamingMessage={null}
        isLoading={false}
        isActive
        firstItemIndex={999_995}
        heightEstimateSeed={[150, 270, 900]}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...followProps}
        scrollToBottom={scrollToBottom}
        handleAtBottomChange={handleAtBottomChange}
        onLoadOlder={onLoadOlder}
      />,
    );

    expect(lastData().data.at(-1)?.id).toBe('assistant-final');
    expect(lastData().firstItemIndex).toBe(999_995);
    expect(lastData().heightEstimates).toEqual([150, 270, 900]);
    expect(lastData().components).toBe(focusedComponents);
    expect(lastData().context).not.toBe(focusedContext);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('does NOT carry a stale "scrolled-up" follow snapshot across a session switch made while hidden', () => {
    // Repro: user scrolls up in session s1, switches tab away (snapshot=false@s1),
    // the tab's session is switched to s2 while hidden, then user returns. The old
    // s1 "don't follow" intent must NOT disable follow for the fresh s2 — otherwise
    // s2 loads at bottom but never auto-scrolls new streaming.
    const followRef: React.MutableRefObject<boolean | 'force'> = { current: true };
    const followProps = () => ({
      followEnabledRef: followRef,
    });
    // Realistic scrollToBottom: mirrors the hook by flipping the ref to 'force'.
    const scrollToBottom = vi.fn(() => {
      followRef.current = 'force';
    });

    const s1 = [msg('a1', 'x', 'user'), msg('a2', 'y')];
    const { rerender } = renderList({
      sessionId: 's1', messages: s1, isActive: true,
      ...followProps(), scrollToBottom,
    });

    // User scrolls up in s1 → follow disabled.
    followRef.current = false;

    // Switch tab away → inactive snapshot captures (false @ s1).
    rerender(
      <MessageList
        sessionId="s1" messages={s1} streamingMessage={null}
        isLoading={false} isActive={false} firstItemIndex={1_000_000}
        virtuosoRef={{ current: null }} {...followProps()}
        scrollToBottom={scrollToBottom} handleAtBottomChange={vi.fn()}
      />,
    );

    // Session switched to s2 while still hidden, then user returns (isActive=true).
    const s2 = [msg('b1', 'p', 'user'), msg('b2', 'q')];
    rerender(
      <MessageList
        sessionId="s2" messages={s2} streamingMessage={null}
        isLoading={false} isActive firstItemIndex={1_000_000}
        virtuosoRef={{ current: null }} {...followProps()}
        scrollToBottom={scrollToBottom} handleAtBottomChange={vi.fn()}
      />,
    );

    // The stale s1 "false" must have been dropped: s2 ends up following, not disabled.
    expect(followRef.current).not.toBe(false);
  });

  it('freezes native suspension until the restored presentation has non-zero container geometry', () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const onViewportAdmissionChanged = vi.fn();
    const history = [msg('h1', 'x', 'user')];
    const baseProps = {
      streamingMessage: null,
      isLoading: false,
      isActive: true,
      firstItemIndex: 1_000_000,
      sessionId: 's1',
      virtuosoRef: { current: null },
      ...createFollowProps(),
      scrollToBottom: vi.fn(),
      handleAtBottomChange: vi.fn(),
      onViewportAdmissionChanged,
    };
    const { rerender } = renderList({
      ...baseProps,
      messages: [...history, msg('stream', 'a')],
      streamingMessage: msg('stream', 'a'),
      isLoading: true,
      windowPresentation: AVAILABLE_PRESENTATION,
    });
    expect(streamingText(lastData())).toBe('a');
    expect(onViewportAdmissionChanged).toHaveBeenLastCalledWith(true, 0);

    rerender(
      <MessageList
        {...baseProps}
        messages={[...history, msg('stream', 'abc')]}
        streamingMessage={msg('stream', 'abc')}
        isLoading
        windowPresentation={SUSPENDED_PRESENTATION}
      />,
    );
    expect(streamingText(lastData())).toBe('a');
    expect(onViewportAdmissionChanged).toHaveBeenLastCalledWith(false, 1);

    rerender(
      <MessageList
        {...baseProps}
        messages={[...history, msg('stream', 'abcdef')]}
        streamingMessage={msg('stream', 'abcdef')}
        isLoading
        windowPresentation={RESTORED_PRESENTATION}
      />,
    );
    expect(streamingText(lastData())).toBe('a');
    expect(onViewportAdmissionChanged).toHaveBeenLastCalledWith(false, 1);

    act(() => resizeCallback?.([
      { contentRect: { width: 800, height: 600 } as DOMRectReadOnly } as ResizeObserverEntry,
    ], {} as ResizeObserver));

    expect(streamingText(lastData())).toBe('abcdef');
    expect(onViewportAdmissionChanged).toHaveBeenLastCalledWith(true, 1);
  });

  it('does not admit live data when Chat first mounts inside a restored generation', () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const onViewportAdmissionChanged = vi.fn();
    renderList({
      messages: [msg('m1', 'restored content')],
      windowPresentation: { surfaceAvailable: true, generation: 3 },
      onViewportAdmissionChanged,
    });

    expect(lastData().data).toEqual([]);
    expect(onViewportAdmissionChanged).toHaveBeenLastCalledWith(false, 3);

    act(() => resizeCallback?.([
      { contentRect: { width: 800, height: 600 } as DOMRectReadOnly } as ResizeObserverEntry,
    ], {} as ResizeObserver));

    expect(lastData().data.map(message => message.id)).toEqual(['m1']);
    expect(onViewportAdmissionChanged).toHaveBeenLastCalledWith(true, 3);
  });

  it('freezes firstItemIndex while inactive (no prepend anchor drift mid-hide)', () => {
    const history = [msg('h1', 'a', 'user'), msg('h2', 'b')];
    const { rerender } = renderList({
      messages: history,
      isActive: true,
      firstItemIndex: 1_000_000,
    });
    expect(lastData().firstItemIndex).toBe(1_000_000);

    // Inactive: even if a stray prepend decrements firstItemIndex, Virtuoso keeps the snapshot.
    rerender(
      <MessageList
        messages={history}
        streamingMessage={null}
        isLoading={false} isActive={false}
        firstItemIndex={999_995}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(lastData().firstItemIndex).toBe(1_000_000);
  });

  it('freezes heightEstimateSeed while inactive', () => {
    const history = [msg('h1', 'a', 'user'), msg('h2', 'b')];
    const { rerender } = renderList({
      messages: history,
      isActive: true,
      heightEstimateSeed: [120, 480],
    });
    expect(lastData().heightEstimates).toEqual([120, 480]);

    rerender(
      <MessageList
        messages={[...history, msg('stream', 'hidden growth')]}
        streamingMessage={msg('stream', 'hidden growth')}
        isLoading isActive={false}
        firstItemIndex={1_000_000}
        heightEstimateSeed={[120, 480, 900]}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );

    expect(lastData().heightEstimates).toEqual([120, 480]);
  });

  it('keeps active streaming pinned before paint through Virtuoso LAST/end alignment while following', () => {
    const scrollToIndex = vi.fn();
    const autoscrollToBottom = vi.fn();
    renderList({
      messages: [msg('h1', 'hello', 'user'), msg('stream', 'partial')],
      streamingMessage: msg('stream', 'partial'),
      isLoading: true,
      isActive: true,
      ...createFollowProps(),
      virtuosoRef: {
        current: { scrollToIndex, autoscrollToBottom },
      } as unknown as React.RefObject<VirtuosoHandle | null>,
    });

    expect(scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end', behavior: 'auto' });
    expect(autoscrollToBottom).not.toHaveBeenCalled();
  });

  it('pins to bottom once when a turn completes while follow is enabled', () => {
    const followRef: React.MutableRefObject<boolean | 'force'> = { current: true };
    const scrollToBottom = vi.fn();
    const history = [msg('h1', 'hello', 'user')];
    const baseProps = {
      firstItemIndex: 1_000_000,
      sessionId: 's1',
      virtuosoRef: { current: null },
      followEnabledRef: followRef,
      scrollToBottom,
      handleAtBottomChange: vi.fn(),
    };
    const { rerender } = renderList({
      ...baseProps,
      messages: [...history, msg('stream', 'partial')],
      streamingMessage: msg('stream', 'partial'),
      isLoading: true,
      isActive: true,
    });
    scrollToBottom.mockClear();

    rerender(
      <MessageList
        {...baseProps}
        messages={[...history, msg('assistant-1', 'final')]}
        streamingMessage={null}
        isLoading={false}
        isActive
      />,
    );

    expect(scrollToBottom).toHaveBeenCalledWith('auto');
  });
});
