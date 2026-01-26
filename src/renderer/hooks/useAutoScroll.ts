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

  // Keep isLoading in a ref so animation loop can access it
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;

  // Track scroll position to detect user scroll direction
  const lastScrollTopRef = useRef(0);

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
   * Keeps running while loading to catch new content
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

    // At bottom (or very close)
    if (distance <= SNAP_THRESHOLD_PX) {
      element.scrollTop = targetScrollTop;
      // Keep animation loop running while loading to catch new content
      if (isLoadingRef.current) {
        animationFrameRef.current = requestAnimationFrame(animateSmoothScroll);
      } else {
        isAnimatingRef.current = false;
      }
      return;
    }

    const now = performance.now();
    const deltaTime = lastFrameTimeRef.current ? now - lastFrameTimeRef.current : 16;
    lastFrameTimeRef.current = now;

    // Calculate adaptive scroll speed - faster when far behind
    let speed = SCROLL_SPEED_PX_PER_MS;
    if (distance > SPEED_RAMP_DISTANCE) {
      const speedMultiplier = Math.min(distance / SPEED_RAMP_DISTANCE, MAX_SCROLL_SPEED_PX_PER_MS / SCROLL_SPEED_PX_PER_MS);
      speed = SCROLL_SPEED_PX_PER_MS * speedMultiplier;
    }

    // Calculate scroll amount for this frame
    const scrollAmount = speed * deltaTime;

    // Don't overshoot
    const newScrollTop = Math.min(currentScrollTop + scrollAmount, targetScrollTop);
    element.scrollTop = newScrollTop;

    // Continue animation
    animationFrameRef.current = requestAnimationFrame(animateSmoothScroll);
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

  // Start smooth scroll when loading starts, stop when loading ends
  useEffect(() => {
    if (isLoading && isAutoScrollEnabledRef.current) {
      startSmoothScroll();
    } else if (!isLoading && isAnimatingRef.current) {
      // Loading stopped - let the current animation frame finish naturally
      // The animation loop will check isLoadingRef and stop
    }
  }, [isLoading, startSmoothScroll]);

  // Handle user scroll - detect scroll direction to distinguish user vs programmatic scroll
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    // Initialize last scroll position
    lastScrollTopRef.current = element.scrollTop;

    const handleScroll = () => {
      const currentScrollTop = element.scrollTop;
      const scrollDelta = currentScrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = currentScrollTop;

      // User scrolled UP (negative delta) - immediately disable auto-scroll
      // Use a small threshold (-5px) to avoid triggering on tiny fluctuations
      if (scrollDelta < -5) {
        if (isAutoScrollEnabledRef.current) {
          isAutoScrollEnabledRef.current = false;
          cancelAnimation();
        }
        return;
      }

      // Check if user scrolled back to bottom - re-enable auto-scroll
      if (isNearBottom()) {
        if (!isAutoScrollEnabledRef.current) {
          isAutoScrollEnabledRef.current = true;
          // Resume scrolling if still loading
          if (isLoadingRef.current) {
            startSmoothScroll();
          }
        }
      }
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

      // Only trigger scroll when height increases (new content added)
      // The animation loop will decide whether to actually scroll based on mode
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only run on mount
  }, []);

  return { containerRef, pauseAutoScroll };
}
