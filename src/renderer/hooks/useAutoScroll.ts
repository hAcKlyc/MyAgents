import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import type { Message } from '@/types/chat';

const BOTTOM_SNAP_THRESHOLD_PX = 32;

export function useAutoScroll(
  isLoading: boolean,
  messages: Message[]
): RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAutoScrollEnabledRef = useRef(true);
  const scrollAnimationFrameRef = useRef<number | null>(null);

  const cancelScheduledScroll = useCallback(() => {
    if (scrollAnimationFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(scrollAnimationFrameRef.current);
      scrollAnimationFrameRef.current = null;
    }
  }, []);

  const isNearBottom = useCallback(() => {
    const element = containerRef.current;
    if (!element) return true;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    return distanceFromBottom <= BOTTOM_SNAP_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (!isAutoScrollEnabledRef.current) return;
    const element = containerRef.current;
    if (!element) return;

    const runScroll = () => {
      scrollAnimationFrameRef.current = null;
      if (!containerRef.current || !isAutoScrollEnabledRef.current) return;
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      cancelScheduledScroll();
      scrollAnimationFrameRef.current = window.requestAnimationFrame(runScroll);
    } else {
      runScroll();
    }
  }, [cancelScheduledScroll]);

  useEffect(() => {
    return () => {
      cancelScheduledScroll();
    };
  }, [cancelScheduledScroll]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (isLoading) {
      scrollToBottom();
    }
  }, [isLoading, scrollToBottom]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const handleScroll = () => {
      if (isNearBottom()) {
        if (!isAutoScrollEnabledRef.current) {
          isAutoScrollEnabledRef.current = true;
          scrollToBottom();
        }
        return;
      }
      isAutoScrollEnabledRef.current = false;
    };

    element.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      element.removeEventListener('scroll', handleScroll);
    };
  }, [isNearBottom, scrollToBottom]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const element = containerRef.current;
    if (!element) return;

    const resizeObserver = new ResizeObserver(() => {
      if (isAutoScrollEnabledRef.current) {
        scrollToBottom();
      }
    });

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [scrollToBottom]);

  return containerRef;
}
