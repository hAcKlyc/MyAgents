import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useChatScrollModel } from './useChatScrollModel';
import type { Message } from '@/types/chat';

function message(id: string, content: string): Message {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: new Date('2026-07-02T00:00:00Z'),
  };
}

describe('useChatScrollModel', () => {
  it('derives Virtuoso data and height estimates with matching lengths', () => {
    const history = [message('m1', 'hello')];
    const streaming = message('m2', 'streaming');

    const { result } = renderHook(() => useChatScrollModel({
      historyMessages: history,
      streamingMessage: streaming,
      firstItemIndex: 999,
      sessionId: 'sid',
    }));

    expect(result.current.data.map(m => m.id)).toEqual(['m1', 'm2']);
    expect(result.current.firstItemIndex).toBe(999);
    expect(result.current.heightEstimateSeed).toHaveLength(result.current.data.length);
    expect(result.current.layoutByMessageId.has('m1')).toBe(true);
    expect(result.current.layoutByMessageId.has('m2')).toBe(true);
  });

  it('excludes persisted task notifications before building geometry', () => {
    const history = [
      message('m1', 'hello'),
      message(
        'task-notification-bg-1',
        '<task-notification>{"taskId":"bg-1","status":"completed"}</task-notification>',
      ),
      message('m2', 'done'),
    ];

    const { result } = renderHook(() => useChatScrollModel({
      historyMessages: history,
      streamingMessage: null,
      firstItemIndex: 999,
      sessionId: 'sid',
    }));

    expect(result.current.data.map(m => m.id)).toEqual(['m1', 'm2']);
    expect(result.current.heightEstimateSeed).toHaveLength(2);
    expect([...result.current.layoutByMessageId.keys()]).toEqual(['m1', 'm2']);
  });

  it('keeps estimate seed stable for token-level text changes in the same layout bucket', () => {
    const firstHistory = [message('m1', 'short reply')];
    const { result, rerender } = renderHook(
      ({ historyMessages }) => useChatScrollModel({
        historyMessages,
        streamingMessage: null,
        firstItemIndex: 100,
        sessionId: 'sid',
      }),
      { initialProps: { historyMessages: firstHistory } },
    );
    const firstSeed = result.current.heightEstimateSeed;
    const firstLayout = result.current.layoutByMessageId;

    const nextHistory = [message('m1', 'short reply with a few more streamed tokens')];
    rerender({ historyMessages: nextHistory });

    expect(result.current.data[0]?.content).toBe(nextHistory[0].content);
    expect(result.current.heightEstimateSeed).toBe(firstSeed);
    expect(result.current.layoutByMessageId).toBe(firstLayout);
  });

  it('retains index and height seeds when the same visible tail enters history', () => {
    const first = message('id-1', 'question');
    const last = message('id-2', 'answer');
    const { result, rerender } = renderHook(({ historyMessages, streamingMessage }: {
      historyMessages: Message[]; streamingMessage: Message | null;
    }) => useChatScrollModel({ historyMessages, streamingMessage, sessionId: 's' }),
    { initialProps: { historyMessages: [first], streamingMessage: last as Message | null } });
    const { messageIndices, heightEstimateSeed } = result.current;
    rerender({ historyMessages: [first,last], streamingMessage: null });
    expect(result.current.messageIndices).toBe(messageIndices);
    expect(result.current.heightEstimateSeed).toBe(heightEstimateSeed);
  });

  it('keeps estimate seed stable while the same streaming message crosses layout buckets', () => {
    const history = [message('m1', 'short reply')];
    const { result, rerender } = renderHook(
      ({ streamingMessage }) => useChatScrollModel({
        historyMessages: history,
        streamingMessage,
        firstItemIndex: 100,
        sessionId: 'sid',
      }),
      { initialProps: { streamingMessage: message('stream', 'starting') } },
    );
    const firstSeed = result.current.heightEstimateSeed;
    const firstStreamEstimate = firstSeed[1];

    rerender({
      streamingMessage: message('stream', 'streaming '.repeat(240)),
    });

    expect(result.current.data[1]?.content).toBe('streaming '.repeat(240));
    expect(result.current.heightEstimateSeed).toBe(firstSeed);
    expect(result.current.heightEstimateSeed[1]).toBe(firstStreamEstimate);
  });
});
