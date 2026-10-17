/**
 * Example usage of useContinuousWatch hook
 *
 * This demonstrates how to integrate continuous watch into a component.
 * Replace the old polling/single-turn logic with this pattern.
 */

import React, { useState } from 'react';
import { useContinuousWatch } from './useContinuousWatch';

export function SessionExecutionMonitor({ sessionId }: { sessionId: string }) {
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);

  const watch = useContinuousWatch({
    sessionId,
    enabled: true,
    mode: 'continuous',
    handlers: {
      onTurnStarted: (turnId, turnIndex) => {
        console.log(`Turn ${turnIndex} started: ${turnId}`);
        setCurrentTurnId(turnId);
        setProgress(`Starting turn ${turnIndex}...`);
        setIsExecuting(true);
        setError(null);
      },

      onTurnProgress: (turnId, step, percent, message) => {
        console.log(`Turn ${turnId} progress: ${step} (${percent}%)`);
        const progressText = percent !== undefined
          ? `${step} (${percent}%)`
          : step;
        setProgress(message || progressText);
      },

      onTurnCompleted: (turnId, result, terminalStatus) => {
        console.log(`Turn ${turnId} completed:`, result);
        setProgress(`Turn completed (${terminalStatus})`);
        setIsExecuting(false);
        setCurrentTurnId(null);

        // Display the result
        // appendMessageToChat(result);
      },

      onTurnTimeout: (turnId, elapsedMs, message) => {
        console.warn(`Turn ${turnId} timeout after ${elapsedMs}ms: ${message}`);
        setError(`Execution timeout: ${message}`);
        setIsExecuting(false);
        setCurrentTurnId(null);
      },

      onTurnError: (turnId, errorInfo) => {
        console.error(`Turn ${turnId} error:`, errorInfo);
        setError(errorInfo.message);
        setIsExecuting(false);
        setCurrentTurnId(null);

        if (errorInfo.recoverable) {
          setProgress('Retrying...');
        }
      },

      onSessionIdle: (finalTurnId, totalTurns) => {
        console.log(`Session idle after ${totalTurns} turns`);
        setIsExecuting(false);
        setProgress(`All ${totalTurns} turns completed`);
      },

      onSessionCancelled: (reason, message) => {
        console.log(`Session cancelled: ${reason}`, message);
        setError(`Cancelled: ${message || reason}`);
        setIsExecuting(false);
      },

      onHeartbeat: (uptime) => {
        // Optional: update connection status
        console.debug(`Watch heartbeat (uptime: ${uptime}s)`);
      },
    },
  });

  return (
    <div className="session-execution-monitor">
      {isExecuting && (
        <div className="execution-status">
          <div className="spinner" />
          <span>{progress}</span>
          {currentTurnId && (
            <span className="turn-id">Turn: {currentTurnId.slice(0, 8)}</span>
          )}
        </div>
      )}

      {error && (
        <div className="execution-error">
          <span className="error-icon">⚠️</span>
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {watch.isSubscribed && (
        <div className="watch-status">
          ✓ Real-time monitoring active
        </div>
      )}
    </div>
  );
}

/**
 * Integration guide for TabProvider.tsx:
 *
 * 1. Import the hook:
 *    import { useContinuousWatch } from '../hooks/useContinuousWatch';
 *
 * 2. Replace old session-state polling with continuous watch:
 *
 *    // OLD (remove this):
 *    const pollState = async () => {
 *      const state = await apiGetJson('/api/session-state');
 *      setSessionState(state.sessionState);
 *    };
 *    useEffect(() => {
 *      const interval = setInterval(pollState, 5000);
 *      return () => clearInterval(interval);
 *    }, []);
 *
 *    // NEW (add this):
 *    const watch = useContinuousWatch({
 *      sessionId: currentSessionId,
 *      enabled: true,
 *      mode: 'continuous',
 *      handlers: {
 *        onTurnStarted: (turnId) => {
 *          setSessionState('running');
 *          setCurrentTurnId(turnId);
 *        },
 *        onTurnCompleted: (turnId, result) => {
 *          appendMessage(result);
 *          // Don't set to idle yet - might have more turns
 *        },
 *        onSessionIdle: () => {
 *          setSessionState('idle');
 *        },
 *        onTurnError: (turnId, error) => {
 *          showError(error.message);
 *        },
 *        onTurnTimeout: (turnId, elapsedMs, message) => {
 *          showWarning(`Execution taking longer than expected: ${message}`);
 *        },
 *      },
 *    });
 *
 * 3. Handle watch events from SSE:
 *    In your SSE event handler, add:
 *
 *    if (event.type.startsWith('watch:')) {
 *      const watchEvent = JSON.parse(event.data);
 *      watch.handleWatchEvent(watchEvent);
 *    }
 */
