import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import type { Message } from '@/types/chat';

const BOTTOM_SNAP_THRESHOLD_PX = 32;
const SCROLL_DEBOUNCE_MS = 16; // ~1 frame

export interface AutoScrollControls {
  containerRef: RefObject<HTMLDivElement | null>;
  /**
   * Temporarily pause auto-scroll (e.g., during collapse animations)
   * @param duration Duration in ms to pause (default: 250ms)
   */
  pauseAutoScroll: (duration?: number) => void;
}

export function useAutoScroll(
  isLoading: boolean,
  messages: Message[]
): AutoScrollControls {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAutoScrollEnabledRef = useRef(true);
  const isPausedRef = useRef(false);
  const scrollAnimationFrameRef = useRef<number | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pauseTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastScrollHeightRef = useRef<number>(0);

  const cancelScheduledScroll = useCallback(() => {
    if (scrollAnimationFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(scrollAnimationFrameRef.current);
      scrollAnimationFrameRef.current = null;
    }
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const isNearBottom = useCallback(() => {
    const element = containerRef.current;
    if (!element) return true;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    return distanceFromBottom <= BOTTOM_SNAP_THRESHOLD_PX;
  }, []);

  /**
   * Pause auto-scroll temporarily (useful during collapse animations)
   */
  const pauseAutoScroll = useCallback((duration = 250) => {
    isPausedRef.current = true;
    if (pauseTimerRef.current) {
      clearTimeout(pauseTimerRef.current);
    }
    pauseTimerRef.current = setTimeout(() => {
      isPausedRef.current = false;
      pauseTimerRef.current = null;
    }, duration);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (!isAutoScrollEnabledRef.current || isPausedRef.current) return;
    const element = containerRef.current;
    if (!element) return;

    const runScroll = () => {
      scrollAnimationFrameRef.current = null;
      if (!containerRef.current || !isAutoScrollEnabledRef.current || isPausedRef.current) return;
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      cancelScheduledScroll();
      scrollAnimationFrameRef.current = window.requestAnimationFrame(runScroll);
    } else {
      runScroll();
    }
  }, [cancelScheduledScroll]);

  /**
   * Debounced scroll - merges multiple rapid calls into one
   */
  const debouncedScrollToBottom = useCallback(() => {
    if (!isAutoScrollEnabledRef.current || isPausedRef.current) return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      scrollToBottom();
    }, SCROLL_DEBOUNCE_MS);
  }, [scrollToBottom]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelScheduledScroll();
      if (pauseTimerRef.current) {
        clearTimeout(pauseTimerRef.current);
      }
    };
  }, [cancelScheduledScroll]);

  // Scroll when messages change
  useEffect(() => {
    debouncedScrollToBottom();
  }, [messages, debouncedScrollToBottom]);

  // Scroll when loading starts
  useEffect(() => {
    if (isLoading) {
      debouncedScrollToBottom();
    }
  }, [isLoading, debouncedScrollToBottom]);

  // Handle user scroll - detect if near bottom
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const handleScroll = () => {
      if (isNearBottom()) {
        if (!isAutoScrollEnabledRef.current) {
          isAutoScrollEnabledRef.current = true;
          debouncedScrollToBottom();
        }
        return;
      }
      isAutoScrollEnabledRef.current = false;
    };

    element.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      element.removeEventListener('scroll', handleScroll);
    };
  }, [isNearBottom, debouncedScrollToBottom]);

  // ResizeObserver - only scroll when height INCREASES (new content)
  // Skip scrolling when height decreases (collapse animations)
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const element = containerRef.current;
    if (!element) return;

    // Initialize last height
    lastScrollHeightRef.current = element.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      if (!isAutoScrollEnabledRef.current || isPausedRef.current) return;

      const currentHeight = element.scrollHeight;
      const heightDelta = currentHeight - lastScrollHeightRef.current;

      // Only scroll when height increases (new content added)
      // Skip when height decreases (collapse) or stays same
      if (heightDelta > 0) {
        debouncedScrollToBottom();
      }

      lastScrollHeightRef.current = currentHeight;
    });

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [debouncedScrollToBottom]);

  return { containerRef, pauseAutoScroll };
}
