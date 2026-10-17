/**
 * Watch Stream Manager — Continuous Session Subscriptions
 *
 * Manages session-scoped watch subscriptions that span multiple turns.
 * Replaces the single-turn watch pattern with continuous event streaming.
 */

import { randomUUID } from 'crypto';
import type {
  ContinuousWatchEvent,
  WatchSubscriber,
  TurnStartedEvent,
  TurnProgressEvent,
  TurnCompletedEvent,
  TurnTimeoutEvent,
  TurnErrorEvent,
  SessionIdleEvent,
  SessionCancelledEvent,
  WatchHeartbeatEvent,
} from '../../shared/session-watch-protocol';
import { eventBufferManager } from './watch-buffer';

/**
 * Watch stream for a single session
 */
class SessionWatchStream {
  private sessionId: string;
  private subscribers = new Map<string, WatchSubscriber>();
  private heartbeatInterval?: NodeJS.Timeout;
  private turnStartTime = new Map<string, number>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.startHeartbeat();
  }

  /**
   * Subscribe to this session's events
   */
  subscribe(subscriber: WatchSubscriber): void {
    this.subscribers.set(subscriber.watchId, subscriber);
    console.log(`[watch-stream] ${subscriber.watchId} subscribed to ${this.sessionId} (mode: ${subscriber.mode})`);
  }

  /**
   * Unsubscribe from this session
   */
  unsubscribe(watchId: string): boolean {
    const removed = this.subscribers.delete(watchId);
    if (removed) {
      console.log(`[watch-stream] ${watchId} unsubscribed from ${this.sessionId}`);
    }
    if (this.subscribers.size === 0) {
      this.stopHeartbeat();
    }
    return removed;
  }

  /**
   * Broadcast event to all subscribers
   */
  private async broadcast(event: ContinuousWatchEvent): Promise<void> {
    // Add to buffer for reconnection
    const buffer = eventBufferManager.getBuffer(this.sessionId);
    buffer.push(event);

    // Notify all subscribers
    const promises: Promise<void>[] = [];
    for (const subscriber of this.subscribers.values()) {
      // Filter events for single-turn subscribers
      if (subscriber.mode === 'single-turn') {
        if (!this.shouldNotifySingleTurn(subscriber, event)) {
          continue;
        }
      }

      promises.push(
        subscriber.notify(event).catch(err => {
          console.error(`[watch-stream] failed to notify ${subscriber.watchId}:`, err);
        })
      );
    }

    await Promise.all(promises);
  }

  /**
   * Check if single-turn subscriber should receive this event
   */
  private shouldNotifySingleTurn(subscriber: WatchSubscriber, event: ContinuousWatchEvent): boolean {
    if (!subscriber.turnId) return false;

    switch (event.type) {
      case 'turn.completed':
      case 'turn.error':
      case 'turn.timeout':
        return 'turnId' in event && event.turnId === subscriber.turnId;
      default:
        return false;
    }
  }

  /**
   * Notify turn started
   */
  async notifyTurnStarted(turnId: string, turnIndex: number): Promise<void> {
    this.turnStartTime.set(turnId, Date.now());

    const event: TurnStartedEvent = {
      version: 2,
      type: 'turn.started',
      eventId: randomUUID(),
      watchId: '', // filled by subscriber
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      turnId,
      turnIndex,
    };

    await this.broadcast(event);
  }

  /**
   * Notify turn progress
   */
  async notifyTurnProgress(turnId: string, step: string, percent?: number, message?: string): Promise<void> {
    const event: TurnProgressEvent = {
      version: 2,
      type: 'turn.progress',
      eventId: randomUUID(),
      watchId: '',
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      turnId,
      step,
      percent,
      message,
    };

    await this.broadcast(event);
  }

  /**
   * Notify turn completed
   */
  async notifyTurnCompleted(turnId: string, result: unknown, terminalStatus?: 'success' | 'partial'): Promise<void> {
    this.turnStartTime.delete(turnId);

    const event: TurnCompletedEvent = {
      version: 2,
      type: 'turn.completed',
      eventId: randomUUID(),
      watchId: '',
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      turnId,
      result,
      terminalStatus,
    };

    await this.broadcast(event);
  }

  /**
   * Notify turn timeout
   */
  async notifyTurnTimeout(turnId: string, message: string): Promise<void> {
    const startTime = this.turnStartTime.get(turnId) ?? Date.now();
    const elapsedMs = Date.now() - startTime;
    this.turnStartTime.delete(turnId);

    const event: TurnTimeoutEvent = {
      version: 2,
      type: 'turn.timeout',
      eventId: randomUUID(),
      watchId: '',
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      turnId,
      elapsedMs,
      message,
    };

    await this.broadcast(event);
  }

  /**
   * Notify turn error
   */
  async notifyTurnError(turnId: string, code: string, message: string, recoverable: boolean): Promise<void> {
    this.turnStartTime.delete(turnId);

    const event: TurnErrorEvent = {
      version: 2,
      type: 'turn.error',
      eventId: randomUUID(),
      watchId: '',
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      turnId,
      error: { code, message, recoverable },
    };

    await this.broadcast(event);
  }

  /**
   * Notify session idle (all turns complete)
   */
  async notifySessionIdle(finalTurnId: string | undefined, totalTurns: number): Promise<void> {
    const event: SessionIdleEvent = {
      version: 2,
      type: 'session.idle',
      eventId: randomUUID(),
      watchId: '',
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      finalTurnId,
      totalTurns,
    };

    await this.broadcast(event);
  }

  /**
   * Notify session cancelled
   */
  async notifySessionCancelled(reason: 'user' | 'timeout' | 'error', message?: string): Promise<void> {
    const event: SessionCancelledEvent = {
      version: 2,
      type: 'session.cancelled',
      eventId: randomUUID(),
      watchId: '',
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      reason,
      message,
    };

    await this.broadcast(event);
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      if (this.subscribers.size === 0) {
        this.stopHeartbeat();
        return;
      }

      const event: WatchHeartbeatEvent = {
        version: 2,
        type: 'watch.heartbeat',
        eventId: randomUUID(),
        watchId: '',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };

      this.broadcast(event).catch(err => {
        console.error('[watch-stream] heartbeat broadcast failed:', err);
      });
    }, 30_000); // 30 seconds
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  /**
   * Get stream stats
   */
  getStats() {
    return {
      sessionId: this.sessionId,
      subscriberCount: this.subscribers.size,
      subscribers: Array.from(this.subscribers.values()).map(s => ({
        watchId: s.watchId,
        mode: s.mode,
        turnId: s.turnId,
        createdAt: s.createdAt,
        lastHeartbeat: s.lastHeartbeat,
      })),
      activeTurns: Array.from(this.turnStartTime.keys()),
    };
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stopHeartbeat();
    this.subscribers.clear();
    this.turnStartTime.clear();
  }
}

/**
 * Global watch stream manager
 */
class WatchStreamManager {
  private streams = new Map<string, SessionWatchStream>();

  /**
   * Get or create stream for session
   */
  getStream(sessionId: string): SessionWatchStream {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = new SessionWatchStream(sessionId);
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  /**
   * Remove stream for session
   */
  removeStream(sessionId: string): void {
    const stream = this.streams.get(sessionId);
    if (stream) {
      stream.destroy();
      this.streams.delete(sessionId);
      eventBufferManager.removeBuffer(sessionId);
    }
  }

  /**
   * Get all stream stats
   */
  getAllStats() {
    return Array.from(this.streams.values()).map(s => s.getStats());
  }

  /**
   * Cleanup inactive streams
   */
  cleanup(): void {
    for (const [sessionId, stream] of this.streams.entries()) {
      const stats = stream.getStats();
      if (stats.subscriberCount === 0) {
        this.removeStream(sessionId);
      }
    }
  }
}

// Global singleton
const watchStreamManager = new WatchStreamManager();

// Periodic cleanup
setInterval(() => {
  watchStreamManager.cleanup();
}, 5 * 60 * 1000); // 5 minutes

export { watchStreamManager, SessionWatchStream, WatchStreamManager };
