/**
 * Unit tests for event buffer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionEventBuffer, EventBufferManager } from './watch-buffer';
import type { ContinuousWatchEvent } from '../../shared/session-watch-protocol';

describe('SessionEventBuffer', () => {
  let buffer: SessionEventBuffer;
  const sessionId = 'test-session-123';

  beforeEach(() => {
    buffer = new SessionEventBuffer(sessionId);
  });

  it('should push and retrieve events', () => {
    const event1: ContinuousWatchEvent = {
      version: 2,
      type: 'turn.started',
      eventId: 'evt-1',
      watchId: 'watch-1',
      sessionId,
      timestamp: new Date().toISOString(),
      turnId: 'turn-1',
      turnIndex: 0,
    };

    buffer.push(event1);

    const recent = buffer.getRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].eventId).toBe('evt-1');
  });

  it('should get events since a sequence ID', () => {
    const createEvent = (id: string): ContinuousWatchEvent => ({
      version: 2,
      type: 'turn.started',
      eventId: id,
      watchId: 'watch-1',
      sessionId,
      timestamp: new Date().toISOString(),
      turnId: 'turn-1',
      turnIndex: 0,
    });

    buffer.push(createEvent('evt-1'));
    buffer.push(createEvent('evt-2'));
    const seqId = buffer.getCurrentSequenceId();
    buffer.push(createEvent('evt-3'));
    buffer.push(createEvent('evt-4'));

    const newEvents = buffer.getSince(seqId);
    expect(newEvents).toHaveLength(2);
    expect(newEvents[0].eventId).toBe('evt-3');
    expect(newEvents[1].eventId).toBe('evt-4');
  });

  it('should enforce max size', () => {
    const buffer = new SessionEventBuffer(sessionId, { maxSize: 3 });

    const createEvent = (id: string): ContinuousWatchEvent => ({
      version: 2,
      type: 'turn.started',
      eventId: id,
      watchId: 'watch-1',
      sessionId,
      timestamp: new Date().toISOString(),
      turnId: 'turn-1',
      turnIndex: 0,
    });

    buffer.push(createEvent('evt-1'));
    buffer.push(createEvent('evt-2'));
    buffer.push(createEvent('evt-3'));
    buffer.push(createEvent('evt-4')); // Should evict evt-1

    const stats = buffer.getStats();
    expect(stats.eventCount).toBe(3);

    const recent = buffer.getRecent(10);
    expect(recent[0].eventId).toBe('evt-2'); // evt-1 was evicted
  });

  it('should get recent events with high-water mark', () => {
    const createEvent = (id: string): ContinuousWatchEvent => ({
      version: 2,
      type: 'turn.started',
      eventId: id,
      watchId: 'watch-1',
      sessionId,
      timestamp: new Date().toISOString(),
      turnId: 'turn-1',
      turnIndex: 0,
    });

    for (let i = 1; i <= 10; i++) {
      buffer.push(createEvent(`evt-${i}`));
    }

    const recent = buffer.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].eventId).toBe('evt-8');
    expect(recent[2].eventId).toBe('evt-10');
  });

  it('should clear buffer', () => {
    buffer.push({
      version: 2,
      type: 'turn.started',
      eventId: 'evt-1',
      watchId: 'watch-1',
      sessionId,
      timestamp: new Date().toISOString(),
      turnId: 'turn-1',
      turnIndex: 0,
    });

    expect(buffer.getStats().eventCount).toBe(1);

    buffer.clear();
    expect(buffer.getStats().eventCount).toBe(0);
  });
});

describe('EventBufferManager', () => {
  let manager: EventBufferManager;

  beforeEach(() => {
    manager = new EventBufferManager();
  });

  it('should create and retrieve buffers', () => {
    const buffer1 = manager.getBuffer('session-1');
    const buffer2 = manager.getBuffer('session-1');
    const buffer3 = manager.getBuffer('session-2');

    expect(buffer1).toBe(buffer2); // Same session returns same buffer
    expect(buffer1).not.toBe(buffer3); // Different session returns different buffer
  });

  it('should remove buffers', () => {
    const buffer = manager.getBuffer('session-1');
    buffer.push({
      version: 2,
      type: 'turn.started',
      eventId: 'evt-1',
      watchId: 'watch-1',
      sessionId: 'session-1',
      timestamp: new Date().toISOString(),
      turnId: 'turn-1',
      turnIndex: 0,
    });

    expect(manager.getAllStats()).toHaveLength(1);

    manager.removeBuffer('session-1');
    expect(manager.getAllStats()).toHaveLength(0);
  });

  it('should clear all buffers', () => {
    manager.getBuffer('session-1');
    manager.getBuffer('session-2');

    expect(manager.getAllStats()).toHaveLength(2);

    manager.clearAll();
    expect(manager.getAllStats()).toHaveLength(0);
  });
});
