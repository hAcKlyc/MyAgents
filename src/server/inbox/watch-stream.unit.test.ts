/**
 * Unit tests for continuous watch stream
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionWatchStream, WatchStreamManager } from './watch-stream';
import type { WatchSubscriber, ContinuousWatchEvent } from '../../shared/session-watch-protocol';

describe('SessionWatchStream', () => {
  let stream: SessionWatchStream;
  const sessionId = 'test-session-123';

  beforeEach(() => {
    stream = new SessionWatchStream(sessionId);
  });

  afterEach(() => {
    stream.destroy();
  });

  it('should subscribe and unsubscribe', () => {
    const subscriber: WatchSubscriber = {
      watchId: 'watch-1',
      sessionId,
      mode: 'continuous',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      notify: vi.fn(),
    };

    stream.subscribe(subscriber);
    expect(stream.getStats().subscriberCount).toBe(1);

    const removed = stream.unsubscribe('watch-1');
    expect(removed).toBe(true);
    expect(stream.getStats().subscriberCount).toBe(0);
  });

  it('should notify continuous subscribers of turn events', async () => {
    const events: ContinuousWatchEvent[] = [];
    const subscriber: WatchSubscriber = {
      watchId: 'watch-1',
      sessionId,
      mode: 'continuous',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      notify: vi.fn(async (event) => {
        events.push(event);
      }),
    };

    stream.subscribe(subscriber);

    await stream.notifyTurnStarted('turn-1', 0);
    await stream.notifyTurnProgress('turn-1', 'processing', 50, 'halfway there');
    await stream.notifyTurnCompleted('turn-1', { text: 'result' }, 'success');

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('turn.started');
    expect(events[1].type).toBe('turn.progress');
    expect(events[2].type).toBe('turn.completed');
  });

  it('should filter events for single-turn subscribers', async () => {
    const events: ContinuousWatchEvent[] = [];
    const subscriber: WatchSubscriber = {
      watchId: 'watch-1',
      sessionId,
      mode: 'single-turn',
      turnId: 'turn-1',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      notify: vi.fn(async (event) => {
        events.push(event);
      }),
    };

    stream.subscribe(subscriber);

    // Should receive events for turn-1
    await stream.notifyTurnStarted('turn-1', 0);
    await stream.notifyTurnCompleted('turn-1', { text: 'result' }, 'success');

    // Should NOT receive events for turn-2
    await stream.notifyTurnStarted('turn-2', 1);
    await stream.notifyTurnCompleted('turn-2', { text: 'result2' }, 'success');

    // Single-turn only gets completion events, not start
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('turn.completed');
    expect('turnId' in events[0] && events[0].turnId).toBe('turn-1');
  });

  it('should handle turn timeout', async () => {
    const events: ContinuousWatchEvent[] = [];
    const subscriber: WatchSubscriber = {
      watchId: 'watch-1',
      sessionId,
      mode: 'continuous',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      notify: vi.fn(async (event) => {
        events.push(event);
      }),
    };

    stream.subscribe(subscriber);

    await stream.notifyTurnStarted('turn-1', 0);
    await stream.notifyTurnTimeout('turn-1', 'API timeout after 120s');

    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('turn.timeout');
    expect('message' in events[1] && events[1].message).toContain('timeout');
  });

  it('should handle turn error', async () => {
    const events: ContinuousWatchEvent[] = [];
    const subscriber: WatchSubscriber = {
      watchId: 'watch-1',
      sessionId,
      mode: 'continuous',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      notify: vi.fn(async (event) => {
        events.push(event);
      }),
    };

    stream.subscribe(subscriber);

    await stream.notifyTurnStarted('turn-1', 0);
    await stream.notifyTurnError('turn-1', 'NETWORK_ERROR', 'Connection lost', false);

    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('turn.error');
    expect('error' in events[1] && events[1].error.code).toBe('NETWORK_ERROR');
    expect('error' in events[1] && events[1].error.recoverable).toBe(false);
  });

  it('should handle session idle', async () => {
    const events: ContinuousWatchEvent[] = [];
    const subscriber: WatchSubscriber = {
      watchId: 'watch-1',
      sessionId,
      mode: 'continuous',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      notify: vi.fn(async (event) => {
        events.push(event);
      }),
    };

    stream.subscribe(subscriber);

    await stream.notifySessionIdle('turn-3', 3);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session.idle');
    expect('totalTurns' in events[0] && events[0].totalTurns).toBe(3);
  });

  it('should handle multiple subscribers', async () => {
    const events1: ContinuousWatchEvent[] = [];
    const events2: ContinuousWatchEvent[] = [];

    const subscriber1: WatchSubscriber = {
      watchId: 'watch-1',
      sessionId,
      mode: 'continuous',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      notify: vi.fn(async (event) => {
        events1.push(event);
      }),
    };

    const subscriber2: WatchSubscriber = {
      watchId: 'watch-2',
      sessionId,
      mode: 'continuous',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      notify: vi.fn(async (event) => {
        events2.push(event);
      }),
    };

    stream.subscribe(subscriber1);
    stream.subscribe(subscriber2);

    await stream.notifyTurnCompleted('turn-1', { text: 'result' }, 'success');

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });
});

describe('WatchStreamManager', () => {
  let manager: WatchStreamManager;

  beforeEach(() => {
    manager = new WatchStreamManager();
  });

  it('should create and retrieve streams', () => {
    const stream1 = manager.getStream('session-1');
    const stream2 = manager.getStream('session-1');
    const stream3 = manager.getStream('session-2');

    expect(stream1).toBe(stream2); // Same session returns same stream
    expect(stream1).not.toBe(stream3); // Different session returns different stream
  });

  it('should remove streams', () => {
    const stream = manager.getStream('session-1');
    const subscriber: WatchSubscriber = {
      watchId: 'watch-1',
      sessionId: 'session-1',
      mode: 'continuous',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      notify: vi.fn(),
    };
    stream.subscribe(subscriber);

    expect(manager.getAllStats()).toHaveLength(1);

    manager.removeStream('session-1');
    expect(manager.getAllStats()).toHaveLength(0);
  });

  it('should cleanup inactive streams', () => {
    manager.getStream('session-1');
    const stream2 = manager.getStream('session-2');

    // Add subscriber to stream2 only
    const subscriber: WatchSubscriber = {
      watchId: 'watch-1',
      sessionId: 'session-2',
      mode: 'continuous',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      notify: vi.fn(),
    };
    stream2.subscribe(subscriber);

    manager.cleanup();

    const stats = manager.getAllStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].sessionId).toBe('session-2');
  });
});
