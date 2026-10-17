/**
 * Continuous Watch Hook
 *
 * Subscribes to continuous session watch events and provides real-time updates.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { ContinuousWatchEvent } from '../../shared/session-watch-protocol';

export interface WatchEventHandlers {
  onTurnStarted?: (turnId: string, turnIndex: number) => void;
  onTurnProgress?: (turnId: string, step: string, percent?: number, message?: string) => void;
  onTurnCompleted?: (turnId: string, result: unknown, terminalStatus?: 'success' | 'partial') => void;
  onTurnTimeout?: (turnId: string, elapsedMs: number, message: string) => void;
  onTurnError?: (turnId: string, error: { code: string; message: string; recoverable: boolean }) => void;
  onSessionIdle?: (finalTurnId?: string, totalTurns?: number) => void;
  onSessionCancelled?: (reason: 'user' | 'timeout' | 'error', message?: string) => void;
  onHeartbeat?: (uptime: number) => void;
}

export interface UseContinuousWatchOptions {
  sessionId: string;
  enabled?: boolean;
  mode?: 'continuous' | 'single-turn';
  turnId?: string; // required for single-turn mode
  handlers: WatchEventHandlers;
}

export function useContinuousWatch(options: UseContinuousWatchOptions) {
  const { sessionId, enabled = true, mode = 'continuous', turnId, handlers } = options;
  const watchIdRef = useRef<string | null>(null);
  const subscribedRef = useRef(false);
  const [subscription, setSubscription] = useState<{ isSubscribed: boolean; watchId: string | null }>({ isSubscribed: false, watchId: null });

  const subscribe = useCallback(async () => {
    if (!enabled || subscribedRef.current) return;

    try {
      const watchId = `watch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      watchIdRef.current = watchId;

      const response = await fetch('/api/session-watch/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          watchId,
          watcherSessionId: sessionId,
          targetSessionId: sessionId,
          mode,
          ...(mode === 'single-turn' && turnId ? { turnId } : {}),
        }),
      });

      const result = await response.json();

      if (result.accepted) {
        subscribedRef.current = true;
        setSubscription({ isSubscribed: true, watchId });
        console.log(`[useContinuousWatch] subscribed in ${mode} mode:`, result);
      } else {
        console.warn('[useContinuousWatch] subscription rejected:', result.reason);
        watchIdRef.current = null;
      }
    } catch (error) {
      console.error('[useContinuousWatch] subscription failed:', error);
      watchIdRef.current = null;
    }
  }, [sessionId, enabled, mode, turnId]);

  const unsubscribe = useCallback(async () => {
    if (!watchIdRef.current || !subscribedRef.current) return;

    try {
      await fetch('/api/session-watch/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          watchId: watchIdRef.current,
          targetSessionId: sessionId,
        }),
      });

      subscribedRef.current = false;
      watchIdRef.current = null;
      setSubscription({ isSubscribed: false, watchId: null });
      console.log('[useContinuousWatch] unsubscribed');
    } catch (error) {
      console.error('[useContinuousWatch] unsubscribe failed:', error);
    }
  }, [sessionId]);

  // Handle incoming watch events from SSE
  const handleWatchEvent = useCallback((event: ContinuousWatchEvent) => {
    // Filter events for this watch
    if (watchIdRef.current && event.watchId !== watchIdRef.current) {
      return;
    }

    switch (event.type) {
      case 'turn.started':
        handlers.onTurnStarted?.(event.turnId, event.turnIndex);
        break;
      case 'turn.progress':
        handlers.onTurnProgress?.(event.turnId, event.step, event.percent, event.message);
        break;
      case 'turn.completed':
        handlers.onTurnCompleted?.(event.turnId, event.result, event.terminalStatus);
        break;
      case 'turn.timeout':
        handlers.onTurnTimeout?.(event.turnId, event.elapsedMs, event.message);
        break;
      case 'turn.error':
        handlers.onTurnError?.(event.turnId, event.error);
        break;
      case 'session.idle':
        handlers.onSessionIdle?.(event.finalTurnId, event.totalTurns);
        break;
      case 'session.cancelled':
        handlers.onSessionCancelled?.(event.reason, event.message);
        break;
      case 'watch.heartbeat':
        handlers.onHeartbeat?.(event.uptime);
        break;
    }
  }, [handlers]);

  useEffect(() => {
    let active = true;
    if (enabled) queueMicrotask(() => { if (active) void subscribe(); });

    return () => {
      active = false;
      if (subscribedRef.current) {
        unsubscribe();
      }
    };
  }, [enabled, subscribe, unsubscribe]);

  return {
    ...subscription,
    handleWatchEvent,
    subscribe,
    unsubscribe,
  };
}
