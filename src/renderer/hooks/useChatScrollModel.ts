import { useEffect, useMemo, useState } from 'react';

import type { Message as MessageType } from '@/types/chat';
import {
  buildMessageLayoutFingerprint,
  estimateMessageRowHeight,
  type RowLayoutContract,
} from '@/utils/chatRowLayout';
import { isVisibleChatTimelineRow, projectVisibleChatTimelineRows } from '@/utils/chatTimelineRows';

export interface ChatScrollModel {
  data: readonly MessageType[];
  visibleHistory: readonly MessageType[];
  messageIndices: ReadonlyMap<string, number>;
  firstItemIndex?: number;
  heightEstimateSeed: number[];
  layoutByMessageId: ReadonlyMap<string, RowLayoutContract>;
}

export interface UseChatScrollModelOptions {
  historyMessages: readonly MessageType[];
  streamingMessage: MessageType | null;
  firstItemIndex?: number;
  sessionId?: string | null;
}

interface HeightEstimateSeedCache {
  sessionId?: string | null;
  orderedIdsKey: string;
  estimatesById: ReadonlyMap<string, number>;
  seed: number[];
}

function getViewportHeight(): number {
  if (typeof window === 'undefined') return 800;
  return window.innerHeight || 800;
}

// Several immutable message versions can describe the same order or layout.
// Retain only the last derived value for each selector in this mounted Tab.
function lastValueForKey<T>() {
  let previous: { key: string; value: T } | undefined;
  return (key: string, derive: () => T): T => {
    if (!previous || previous.key !== key) previous = { key, value: derive() };
    return previous.value;
  };
}

export function useChatScrollModel({
  historyMessages,
  streamingMessage,
  firstItemIndex,
  sessionId,
}: UseChatScrollModelOptions): ChatScrollModel {
  const [viewportHeight, setViewportHeight] = useState(getViewportHeight);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      const next = getViewportHeight();
      setViewportHeight(prev => (Math.abs(prev - next) < 80 ? prev : next));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const visibleHistory = useMemo(() => projectVisibleChatTimelineRows(historyMessages), [historyMessages]);
  const tail = streamingMessage && isVisibleChatTimelineRow(streamingMessage) ? streamingMessage : null;
  const data = useMemo(() => tail ? [...visibleHistory, tail] : visibleHistory, [visibleHistory, tail]);
  const historyKeys = useMemo(() => JSON.stringify(visibleHistory.map(row => row.id)), [visibleHistory]);
  const tailId = tail?.id;
  const orderedIdsKey = useMemo(() => {
    if (tailId === undefined) return historyKeys;
    const separator = historyKeys === '[]' ? '' : ',';
    return historyKeys.slice(0, -1) + separator + JSON.stringify(tailId) + ']';
  }, [historyKeys, tailId]);
  const selectIndices = useMemo(() => lastValueForKey<ReadonlyMap<string, number>>(), []);
  const messageIndices = useMemo(() => selectIndices(orderedIdsKey, () => {
    const map = new Map<string, number>();
    visibleHistory.forEach((message, index) => map.set(message.id, index));
    if (tailId !== undefined) map.set(tailId, visibleHistory.length);
    return map;
  }), [selectIndices, orderedIdsKey, visibleHistory, tailId]);
  const selectHistoryLayouts = useMemo(() => lastValueForKey<Map<string, RowLayoutContract>>(), []);
  const historyLayouts = useMemo(() => {
    const key = JSON.stringify([sessionId, ...visibleHistory.map(message => buildMessageLayoutFingerprint(message, viewportHeight))]);
    return selectHistoryLayouts(key, () => new Map(visibleHistory.map(message =>
      [message.id, estimateMessageRowHeight(message, viewportHeight)] as const)));
  }, [selectHistoryLayouts, sessionId, visibleHistory, viewportHeight]);
  const selectTailLayout = useMemo(() => lastValueForKey<RowLayoutContract>(), []);
  const tailLayout = tail ? selectTailLayout(buildMessageLayoutFingerprint(tail, viewportHeight),
    () => estimateMessageRowHeight(tail, viewportHeight)) : null;
  const layoutByMessageId = useMemo(() => {
    if (!tailLayout) return historyLayouts;
    const layouts = new Map(historyLayouts);
    layouts.set(tailLayout.messageId, tailLayout);
    return layouts;
  }, [historyLayouts, tailLayout]);

  // A seed is the first committed estimate for an ID in this Session.
  // React discards speculative renders, including their seed, on interruption.
  const [previousSeed, setSeed] = useState<HeightEstimateSeedCache | null>(null);
  let heightEstimateSeedCache = previousSeed;
  if (!previousSeed || previousSeed.sessionId !== sessionId || previousSeed.orderedIdsKey !== orderedIdsKey) {
    const prior = previousSeed?.sessionId === sessionId ? previousSeed?.estimatesById : undefined;
    const estimatesById = new Map<string, number>();
    const seed = data.map(message => {
      const estimate = prior?.get(message.id) ?? estimateMessageRowHeight(message, viewportHeight).estimatedHeight;
      estimatesById.set(message.id, estimate);
      return estimate;
    });
    heightEstimateSeedCache = { sessionId, orderedIdsKey, estimatesById, seed };
    setSeed(heightEstimateSeedCache);
  }

  return {
    data,
    visibleHistory,
    messageIndices,
    firstItemIndex,
    heightEstimateSeed: heightEstimateSeedCache!.seed,
    layoutByMessageId,
  };
}
