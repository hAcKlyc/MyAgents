import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import type { Message } from '@/types/chat';

const BOTTOM_SNAP_THRESHOLD_PX = 32;

// Smooth scroll configuration
const SCROLL_SPEED_PX_PER_MS = 2.5;      // Base scroll speed (pixels per millisecond)
const MAX_SCROLL_SPEED_PX_PER_MS = 8;    // Maximum scroll speed when far behind
const SPEED_RAMP_DISTANCE = 200;          // Distance at which speed starts ramping up
const SNAP_THRESHOLD_PX = 3;              // Snap to bottom when this close

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
  const pauseTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastScrollHeightRef = useRef<number>(0);

  // Smooth scroll animation state
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const isAnimatingRef = useRef(false);

  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    isAnimatingRef.current = false;
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
    cancelAnimation();
    if (pauseTimerRef.current) {
      clearTimeout(pauseTimerRef.current);
    }
    pauseTimerRef.current = setTimeout(() => {
      isPausedRef.current = false;
      pauseTimerRef.current = null;
    }, duration);
  }, [cancelAnimation]);

  /**
   * Smooth scroll animation using RAF
   * Scrolls at a consistent speed that ramps up when far from bottom
   */
  const animateSmoothScroll = useCallback(() => {
    if (!isAutoScrollEnabledRef.current || isPausedRef.current) {
      isAnimatingRef.current = false;
      return;
    }

    const element = containerRef.current;
    if (!element) {
      isAnimatingRef.current = false;
      return;
    }

    const targetScrollTop = element.scrollHeight - element.clientHeight;
    const currentScrollTop = element.scrollTop;
    const distance = targetScrollTop - currentScrollTop;

    // Already at bottom (or very close), stop animation
    if (distance <= SNAP_THRESHOLD_PX) {
      element.scrollTop = targetScrollTop;
      isAnimatingRef.current = false;
      return;
    }

    const now = performance.now();
    const deltaTime = lastFrameTimeRef.current ? now - lastFrameTimeRef.current : 16;
    lastFrameTimeRef.current = now;

    // Calculate adaptive scroll speed
    // Speed increases when we're far behind, to catch up faster
    let speed = SCROLL_SPEED_PX_PER_MS;
    if (distance > SPEED_RAMP_DISTANCE) {
      // Ramp up speed proportionally to how far we are
      const speedMultiplier = Math.min(distance / SPEED_RAMP_DISTANCE, MAX_SCROLL_SPEED_PX_PER_MS / SCROLL_SPEED_PX_PER_MS);
      speed = SCROLL_SPEED_PX_PER_MS * speedMultiplier;
    }

    // Calculate scroll amount for this frame
    const scrollAmount = speed * deltaTime;

    // Don't overshoot
    const newScrollTop = Math.min(currentScrollTop + scrollAmount, targetScrollTop);
    element.scrollTop = newScrollTop;

    // Continue animation if not at bottom
    if (newScrollTop < targetScrollTop) {
      animationFrameRef.current = requestAnimationFrame(animateSmoothScroll);
    } else {
      isAnimatingRef.current = false;
    }
  }, []);

  /**
   * Start smooth scroll animation (or continue if already running)
   */
  const startSmoothScroll = useCallback(() => {
    if (!isAutoScrollEnabledRef.current || isPausedRef.current) return;

    // If already animating, just let it continue - it will catch up
    if (isAnimatingRef.current) return;

    isAnimatingRef.current = true;
    lastFrameTimeRef.current = performance.now();
    animationFrameRef.current = requestAnimationFrame(animateSmoothScroll);
  }, [animateSmoothScroll]);

  /**
   * Instant scroll to bottom (used for initial load or large jumps)
   */
  const scrollToBottomInstant = useCallback(() => {
    if (!isAutoScrollEnabledRef.current || isPausedRef.current) return;
    const element = containerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimation();
      if (pauseTimerRef.current) {
        clearTimeout(pauseTimerRef.current);
      }
    };
  }, [cancelAnimation]);

  // Start smooth scroll when messages change
  useEffect(() => {
    if (isAutoScrollEnabledRef.current) {
      startSmoothScroll();
    }
  }, [messages, startSmoothScroll]);

  // Start smooth scroll when loading starts
  useEffect(() => {
    if (isLoading && isAutoScrollEnabledRef.current) {
      startSmoothScroll();
    }
  }, [isLoading, startSmoothScroll]);

  // Handle user scroll - detect if near bottom
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const handleScroll = () => {
      // Don't interfere while animating
      if (isAnimatingRef.current) return;

      if (isNearBottom()) {
        if (!isAutoScrollEnabledRef.current) {
          isAutoScrollEnabledRef.current = true;
          // User scrolled back to bottom, resume smooth scrolling
          startSmoothScroll();
        }
        return;
      }
      // User scrolled up, disable auto-scroll
      isAutoScrollEnabledRef.current = false;
      cancelAnimation();
    };

    element.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      element.removeEventListener('scroll', handleScroll);
    };
  }, [isNearBottom, startSmoothScroll, cancelAnimation]);

  // ResizeObserver - trigger smooth scroll when content grows
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
      if (heightDelta > 0) {
        startSmoothScroll();
      }

      lastScrollHeightRef.current = currentHeight;
    });

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [startSmoothScroll]);

  // Initial scroll to bottom when first rendered with content
  useEffect(() => {
    if (messages.length > 0) {
      // Use instant scroll for initial load
      scrollToBottomInstant();
    }
  }, []); // Only on mount

  return { containerRef, pauseAutoScroll };
}
