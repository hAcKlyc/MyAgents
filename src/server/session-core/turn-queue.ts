import {
  normalizeChatQueueResponseMode,
  type ChatQueueResponseMode,
} from '../../shared/config-types';

export type QueueAdmissionAction =
  | 'direct'
  | 'realtime-inflight'
  | 'realtime-buffer'
  | 'turn-boundary';

export type RealtimeHandoff = 'sdk-inflight' | 'local-queue';

export type QueueLocation = 'message' | 'pending-mid-turn' | 'turn-boundary' | 'in-flight';

export type DesktopDeliveryMode = 'realtime' | 'turn';

export type QueueCancelResult =
  | { status: 'cancelled'; cancelledText: string }
  | { status: 'not_found' | 'not_cancelled' | 'unavailable' | 'error' };

export type DispatchGuardResult = {
  accepted: boolean;
  error?: string;
  code?: string;
  /** Synchronous lease check immediately before admission side effects commit. */
  validateAtCommit?: () => DispatchGuardResult;
  /** Durable claim rollback that must settle before rejection is published. */
  rollbackBeforeReject?: Promise<void>;
};

export type DispatchGuard = (() => Promise<DispatchGuardResult>) & {
  cancel?: () => void | Promise<void>;
};

export type TurnOwner = {
  kind: 'goal' | 'task';
  id: string;
};

export type TurnIdentity = {
  queueId: string;
  owner: TurnOwner;
};

export type TurnTerminalOutcome = {
  status: 'complete' | 'stopped' | 'error';
  text: string;
  assistantMessagePresent: boolean;
  error?: string;
  /** Stable runtime failure classification; schedulers must not parse display text. */
  code?: string;
  durationMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
};

export type TurnTerminalObserver = (outcome: TurnTerminalOutcome) => void | Promise<void>;

export function shouldApplyChatQueueResponseMode(
  fromDesktopChatSend: boolean | undefined,
): boolean {
  return fromDesktopChatSend === true;
}

export function resolveChatQueueResponseMode(
  rawValue: unknown,
  fromDesktopChatSend: boolean | undefined,
): ChatQueueResponseMode {
  if (!shouldApplyChatQueueResponseMode(fromDesktopChatSend)) return 'realtime';
  return normalizeChatQueueResponseMode(rawValue);
}

export function decideQueueAdmission(params: {
  mode: ChatQueueResponseMode;
  busy: boolean;
  hasInFlight: boolean;
  hasScopedTurnBoundaryQueued?: boolean;
}): QueueAdmissionAction {
  if (!params.busy) return 'direct';
  if (params.hasScopedTurnBoundaryQueued) return 'turn-boundary';
  if (params.mode === 'turn') return 'turn-boundary';
  return params.hasInFlight ? 'realtime-buffer' : 'realtime-inflight';
}

export function decideRealtimeHandoff(hasMessageResolver: boolean): RealtimeHandoff {
  return hasMessageResolver ? 'sdk-inflight' : 'local-queue';
}

export function findQueueLocation(params: {
  messageIndex: number;
  pendingMidTurnIndex: number;
  turnBoundaryIndex: number;
  inFlight: boolean;
}): { location: QueueLocation; index: number } | null {
  if (params.messageIndex >= 0) return { location: 'message', index: params.messageIndex };
  if (params.pendingMidTurnIndex >= 0) return { location: 'pending-mid-turn', index: params.pendingMidTurnIndex };
  if (params.turnBoundaryIndex >= 0) return { location: 'turn-boundary', index: params.turnBoundaryIndex };
  if (params.inFlight) return { location: 'in-flight', index: -1 };
  return null;
}

export function shouldStartTurnBoundaryItem(params: {
  hasTurnInFlight: boolean;
  hasCompetingAdmissionTicket: boolean;
  hasInFlightToCli: boolean;
  hasPendingMidTurn: boolean;
  allowRealtimePending?: boolean;
  hasMessageQueue: boolean;
  promotedItemInFlight: boolean;
  shouldAbortSession: boolean;
  reason: 'complete' | 'stopped' | 'error' | 'recovery';
  hasQuerySession: boolean;
  hasResetInProgress: boolean;
  hasRewindInProgress: boolean;
}): boolean {
  return !(
    params.hasTurnInFlight
    || params.hasCompetingAdmissionTicket
    || params.hasInFlightToCli
    || (params.hasPendingMidTurn && !params.allowRealtimePending)
    || params.hasMessageQueue
    || params.promotedItemInFlight
    || (params.shouldAbortSession && (params.reason !== 'recovery' || params.hasQuerySession))
    || params.hasResetInProgress
    || params.hasRewindInProgress
  );
}

export function moveQueueIndexToFront<T>(queue: T[], index: number): boolean {
  if (index < 0 || index >= queue.length) return false;
  if (index > 0) {
    const [item] = queue.splice(index, 1);
    queue.unshift(item);
  }
  return true;
}

export function shouldClearAdmissionTicketOnAbort(params: {
  ticketQueueId?: string | null;
  committingQueueId?: string | null;
}): boolean {
  return Boolean(params.ticketQueueId && params.ticketQueueId !== params.committingQueueId);
}
