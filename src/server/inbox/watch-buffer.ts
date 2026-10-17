/**
 * Event Buffer — High-Water Mark & Reconnection Support
 *
 * Manages event buffering for continuous watch subscriptions. Handles:
 * - Bounded event retention (prevent memory leak)
 * - High-water mark replay (reconnection recovery)
 * - Event expiration
 */

import type { ContinuousWatchEvent, EventBufferConfig } from '../../shared/session-watch-protocol';

interface BufferedEvent {
  event: ContinuousWatchEvent;
  sequenceId: number;
  timestamp: Date;
}

const DEFAULT_CONFIG: EventBufferConfig = {
  maxSize: 1000, // max events per session
  retentionMs: 5 * 60 * 1000, // 5 minutes
  highWaterMark: 100, // replay last 100 events on reconnect
};

/**
 * Event buffer for a single session
 */
class SessionEventBuffer {
  private events: BufferedEvent[] = [];
  private nextSequenceId = 1;
  private sessionId: string;
  private config: EventBufferConfig;

  constructor(sessionId: string, config?: Partial<EventBufferConfig>) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add event to buffer
   */
  push(event: ContinuousWatchEvent): void {
    const buffered: BufferedEvent = {
      event,
      sequenceId: this.nextSequenceId++,
      timestamp: new Date(),
    };

    this.events.push(buffered);

    // Enforce max size
    if (this.events.length > this.config.maxSize) {
      this.events.shift();
    }

    // Clean expired events
    this.cleanExpired();
  }

  /**
   * Get events since a sequence ID (for reconnection)
   */
  getSince(sequenceId: number): ContinuousWatchEvent[] {
    return this.events
      .filter(e => e.sequenceId > sequenceId)
      .map(e => e.event);
  }

  /**
   * Get recent events (high-water mark replay)
   */
  getRecent(count?: number): ContinuousWatchEvent[] {
    const limit = count ?? this.config.highWaterMark;
    return this.events
      .slice(-limit)
      .map(e => e.event);
  }

  /**
   * Get current sequence ID
   */
  getCurrentSequenceId(): number {
    return this.nextSequenceId - 1;
  }

  /**
   * Clean expired events
   */
  private cleanExpired(): void {
    const now = Date.now();
    const cutoff = now - this.config.retentionMs;
    this.events = this.events.filter(e => e.timestamp.getTime() > cutoff);
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.events = [];
  }

  /**
   * Get buffer stats
   */
  getStats() {
    return {
      sessionId: this.sessionId,
      eventCount: this.events.length,
      currentSequenceId: this.getCurrentSequenceId(),
      oldestEvent: this.events[0]?.timestamp,
      newestEvent: this.events[this.events.length - 1]?.timestamp,
    };
  }
}

/**
 * Global event buffer manager
 */
class EventBufferManager {
  private buffers = new Map<string, SessionEventBuffer>();
  private config: EventBufferConfig;

  constructor(config?: Partial<EventBufferConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get or create buffer for session
   */
  getBuffer(sessionId: string): SessionEventBuffer {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = new SessionEventBuffer(sessionId, this.config);
      this.buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  /**
   * Remove buffer for session
   */
  removeBuffer(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  /**
   * Clear all buffers
   */
  clearAll(): void {
    this.buffers.clear();
  }

  /**
   * Get stats for all buffers
   */
  getAllStats() {
    return Array.from(this.buffers.values()).map(b => b.getStats());
  }
}

// Global singleton
const eventBufferManager = new EventBufferManager();

export { eventBufferManager, SessionEventBuffer, EventBufferManager };
export type { BufferedEvent };
