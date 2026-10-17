/**
 * Session Watch Protocol — Continuous Subscription
 *
 * Defines event types, states, and interfaces for continuous session watching.
 * Replaces the single-turn watch pattern with session-scoped subscriptions that
 * span multiple turns.
 */

/**
 * Execution status for a session or turn
 */
export type SessionExecutionStatus =
  | 'idle'
  | 'running'
  | 'waiting_user_action'
  | 'timeout'
  | 'error'
  | 'cancelled';

/**
 * Continuous watch event types
 */
export type WatchEventType =
  // Turn lifecycle
  | 'turn.started'
  | 'turn.progress'
  | 'turn.completed'
  | 'turn.timeout'
  | 'turn.error'
  // Session lifecycle
  | 'session.idle'
  | 'session.cancelled'
  // Connection
  | 'watch.registered'
  | 'watch.heartbeat';

/**
 * Base watch event structure
 */
export interface WatchEvent {
  version: 2; // version 1 = single-turn, version 2 = continuous
  type: WatchEventType;
  eventId: string;
  watchId: string;
  sessionId: string;
  timestamp: string; // ISO 8601
}

/**
 * Turn started event
 */
export interface TurnStartedEvent extends WatchEvent {
  type: 'turn.started';
  turnId: string;
  turnIndex: number;
}

/**
 * Turn progress event
 */
export interface TurnProgressEvent extends WatchEvent {
  type: 'turn.progress';
  turnId: string;
  step: string;
  percent?: number;
  message?: string;
}

/**
 * Turn completed event
 */
export interface TurnCompletedEvent extends WatchEvent {
  type: 'turn.completed';
  turnId: string;
  result: unknown;
  terminalStatus?: 'success' | 'partial';
}

/**
 * Turn timeout event
 */
export interface TurnTimeoutEvent extends WatchEvent {
  type: 'turn.timeout';
  turnId: string;
  elapsedMs: number;
  message: string;
}

/**
 * Turn error event
 */
export interface TurnErrorEvent extends WatchEvent {
  type: 'turn.error';
  turnId: string;
  error: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

/**
 * Session idle event (all turns complete)
 */
export interface SessionIdleEvent extends WatchEvent {
  type: 'session.idle';
  finalTurnId?: string;
  totalTurns: number;
}

/**
 * Session cancelled event
 */
export interface SessionCancelledEvent extends WatchEvent {
  type: 'session.cancelled';
  reason: 'user' | 'timeout' | 'error';
  message?: string;
}

/**
 * Watch registered confirmation
 */
export interface WatchRegisteredEvent extends WatchEvent {
  type: 'watch.registered';
  mode: 'continuous' | 'single-turn';
  turnId?: string; // for single-turn mode
}

/**
 * Heartbeat event (keep-alive)
 */
export interface WatchHeartbeatEvent extends WatchEvent {
  type: 'watch.heartbeat';
  uptime: number;
}

/**
 * Union of all watch events
 */
export type ContinuousWatchEvent =
  | TurnStartedEvent
  | TurnProgressEvent
  | TurnCompletedEvent
  | TurnTimeoutEvent
  | TurnErrorEvent
  | SessionIdleEvent
  | SessionCancelledEvent
  | WatchRegisteredEvent
  | WatchHeartbeatEvent;

/**
 * Watch registration request
 */
export interface WatchRegistrationRequest {
  watchId: string;
  watcherSessionId: string;
  watcherResumeWorkspacePath?: string;
  targetSessionId: string;
  mode: 'continuous' | 'single-turn';
  turnId?: string; // required for single-turn mode
  observerScope?: string;
  networkReturn?: unknown;
}

/**
 * Watch registration response
 */
export interface WatchRegistrationResponse {
  accepted: boolean;
  watchId?: string;
  mode?: 'continuous' | 'single-turn';
  reason?: string;
  targetStateAtRegistration?: string;
  delivery?: string;
}

/**
 * Event buffer configuration
 */
export interface EventBufferConfig {
  maxSize: number;
  retentionMs: number;
  highWaterMark: number;
}

/**
 * Subscriber interface for internal use
 */
export interface WatchSubscriber {
  watchId: string;
  sessionId: string;
  mode: 'continuous' | 'single-turn';
  turnId?: string;
  notify: (event: ContinuousWatchEvent) => Promise<void>;
  createdAt: Date;
  lastHeartbeat: Date;
}
