import { TurnFinalizationGate } from '../external-turn-finalization';
import { decideSessionCompleteErrorAction } from '../external-abort-policy';
import type { ExternalTurnUsage } from './types';
import type { AgentPlanTodo, UnifiedEvent } from '../types';
import type { ContextUsage } from '../../../shared/types/context-usage';
import type { RuntimeTurnAnchor } from '../../types/session';
import type {
  TurnIdentity,
  TurnOwner,
  TurnTerminalOutcome,
  TurnTerminalObserver,
} from '../../session-core/turn-queue';
import type { SessionActivityTurnFacts } from '../../session-core/session-activity-policy';
import { UNKNOWN_SESSION_ORIGIN } from '../../../shared/session-origin';
import type {
  SessionCompletionStatus,
  SessionCompletionTerminal,
} from '../../../shared/sessionCompletion';
import {
  reconcileRealtimeAssistantChannelDelivery,
  type AssistantChannelDelivery,
  type TurnChannelDelivery,
} from '../../session-core/channel-delivery';

let turnCompleted = false;
let lastTurnSucceeded = false;
let currentTurnStartTime = 0;
let currentTurnUsage: ExternalTurnUsage | null = null;
let currentTurnContextUsage: ContextUsage | null = null;
let currentTurnPlan: readonly AgentPlanTodo[] = [];
let currentRuntimeTurnAnchor: RuntimeTurnAnchor | null = null;
let currentTurnEstimatedInputTokens = 0;
let turnSequence = 0;
let activeTurnSequence = 0;
let terminalTurnSequence = 0;
let turnTerminalGeneration = 0;
let turnPromotionGeneration = 0;
let activeTurnPromotion: ExternalTurnPromotionToken | null = null;
let terminalObserverBarrier: Promise<void> = Promise.resolve();
let currentTurnActivityFacts: SessionActivityTurnFacts | null = null;
let lastSessionCompletionTerminal: SessionCompletionTerminal | null = null;
type ExternalTurnChannelDeliveryState = {
  mode?: import('../../../shared/channelContext').ChannelDeliveryMode;
  assistantDisposition: AssistantChannelDelivery;
  pendingAssistantDeliveries: Array<() => Promise<void>>;
};
let channelSnapshot: import('../../session-core/channel-context').ChannelTurnSnapshot | null = null;
export function getExternalChannelSnapshot() { return channelSnapshot; }
export function setExternalChannelSnapshot(snapshot: typeof channelSnapshot) { channelSnapshot = snapshot; }
let channelDeliveryTail: Promise<void> = Promise.resolve();
let currentTurnChannelDeliveryState: ExternalTurnChannelDeliveryState = {
  assistantDisposition: 'none',
  pendingAssistantDeliveries: [],
};
let currentTurnBinding: {
  queueId: string;
  owner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
} | null = null;

const turnFinalization = new TurnFinalizationGate();

export type ExternalUserChannelAdmission =
  | { kind: 'skip' }
  | {
    kind: 'deliver-session-bound-user';
    waitForPersistence: Promise<boolean>;
    deliverUser: () => Promise<void>;
  };

function appendExternalUserChannelDelivery(
  admission: Extract<ExternalUserChannelAdmission, { kind: 'deliver-session-bound-user' }>,
): void {
  channelDeliveryTail = channelDeliveryTail
    .then(async () => {
      const persisted = await admission.waitForPersistence;
      if (!persisted) return;
      await admission.deliverUser();
    })
    .catch((error) => {
      console.warn('[external-session] user channel delivery failed:', error);
    });
}

/** Begin a new turn's explicit channel-delivery lifecycle. */
export function admitExternalTurnChannelDelivery(
  delivery: TurnChannelDelivery,
  userAdmission: ExternalUserChannelAdmission,
): void {
  currentTurnChannelDeliveryState = {
    assistantDisposition: delivery.assistant,
    mode: delivery.mode,
    pendingAssistantDeliveries: [],
  };
  if (delivery.mode !== 'tool_only' && userAdmission.kind === 'deliver-session-bound-user') {
    appendExternalUserChannelDelivery(userAdmission);
  }
}

/** Join a runtime-accepted realtime message to the active turn without letting
 * a Desktop note displace ReplyRouter/outbox ownership of the combined answer. */
export function admitExternalRealtimeChannelDelivery(
  delivery: TurnChannelDelivery,
  userAdmission: ExternalUserChannelAdmission,
): void {
  const priorState = currentTurnChannelDeliveryState;
  currentTurnChannelDeliveryState = {
    mode: priorState.mode,
    assistantDisposition: reconcileRealtimeAssistantChannelDelivery(
      priorState.assistantDisposition,
      delivery.assistant,
    ),
    pendingAssistantDeliveries: priorState.pendingAssistantDeliveries,
  };
  if (priorState.mode !== 'tool_only' && userAdmission.kind === 'deliver-session-bound-user') {
    appendExternalUserChannelDelivery(userAdmission);
  }
}

/** Stage one completed assistant block until the terminal owner proves success. */
export function stageExternalAssistantChannelDelivery(
  deliverAssistant: () => Promise<void>,
): boolean {
  const state = currentTurnChannelDeliveryState;
  if (state.mode === 'tool_only' || state.assistantDisposition !== 'session-binding') {
    return false;
  }
  state.pendingAssistantDeliveries.push(deliverAssistant);
  return true;
}

export type ExternalAssistantChannelDeliveryBatch = Readonly<{
  assistantDisposition: AssistantChannelDelivery;
  pendingAssistantDeliveries: ReadonlyArray<() => Promise<void>>;
  settle: (deliver: boolean) => void;
}>;

/** Detach the terminalizing turn's delivery batch before any finalization await. */
export function captureExternalAssistantChannelDelivery(): ExternalAssistantChannelDeliveryBatch {
  const captured = currentTurnChannelDeliveryState;
  currentTurnChannelDeliveryState = {
    assistantDisposition: 'none',
    pendingAssistantDeliveries: [],
  };
  let settleDecision!: (deliver: boolean) => void;
  const deliveryDecision = new Promise<boolean>((resolve) => { settleDecision = resolve; });
  let settled = false;
  const settle = (deliver: boolean) => {
    if (settled) return;
    settled = true;
    settleDecision(deliver);
  };
  if (captured.mode !== 'tool_only' && captured.assistantDisposition === 'session-binding') {
    // Reserve this turn's assistant positions before any persistence await.
    // A concurrently admitted next turn therefore joins after this batch even
    // though durability decides later whether these positions emit or skip.
    for (const deliverAssistant of captured.pendingAssistantDeliveries) {
      channelDeliveryTail = channelDeliveryTail
        .then(async () => {
          if (!await deliveryDecision) return;
          await deliverAssistant();
        })
        .catch((error) => {
          console.warn('[external-session] assistant channel delivery failed:', error);
        });
    }
  }
  return { ...captured, settle };
}

/** Commit a captured batch only after the runtime's success terminal is durable. */
export function commitExternalAssistantChannelDelivery(
  batch: ExternalAssistantChannelDeliveryBatch,
): boolean {
  if (batch.assistantDisposition !== 'session-binding') return false;
  batch.settle(true);
  return batch.pendingAssistantDeliveries.length > 0;
}

/** Release a reserved batch without emitting after failure, stop, or persist failure. */
export function discardExternalAssistantChannelDelivery(
  batch: ExternalAssistantChannelDeliveryBatch,
): void {
  batch.settle(false);
}

export type ExternalTurnOutcome = Readonly<{
  generation: number;
  success: boolean;
  text: string;
  error?: string;
  durationMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}>;

function notifyBoundTurn(
  outcome: TurnTerminalOutcome,
  finalization: Promise<unknown>,
): void {
  const binding = currentTurnBinding;
  const channel = channelSnapshot?.scope.channels.find(value => value.channelId === channelSnapshot?.scope.defaultTarget?.channelId);
  if (channel) outcome = { ...outcome, channelDeliveryMode: channel.mode };
  currentTurnBinding = null;
  const finalized = finalization
    .catch((error) => {
      console.error('[external-session] turn finalization failed before terminal observer:', error);
    });
  terminalObserverBarrier = Promise.all([terminalObserverBarrier, finalized])
    .then(async () => {
      if (!binding?.onTerminal) return;
      try {
        await binding.onTerminal(outcome);
      } catch (error) {
        console.error('[external-session] turn terminal observer failed:', error);
      }
    })
    .catch((error) => {
      console.error('[external-session] turn terminal observer failed:', error);
    });
}

export function waitForExternalTurnTerminalObserver(): Promise<void> {
  return terminalObserverBarrier;
}

export function notifyExternalTurnOutcome(
  generation: number,
  outcome: Omit<ExternalTurnOutcome, 'generation'>,
  finalization: Promise<unknown> = Promise.resolve(),
): void {
  if (generation <= 0 || !isExternalTurnGenerationCurrent(generation)) return;
  notifyBoundTurn({
    status: outcome.success ? 'complete' : 'error',
    text: outcome.text,
    assistantMessagePresent: outcome.text.trim().length > 0,
    ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
    ...(outcome.usage ? { usage: outcome.usage } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  }, finalization);
}

export function notifyExternalTurnStopped(
  text: string,
  metrics: Pick<ExternalTurnOutcome, 'durationMs' | 'usage'> = {},
  finalization: Promise<unknown> = Promise.resolve(),
): void {
  notifyBoundTurn({
    status: 'stopped',
    text,
    assistantMessagePresent: text.trim().length > 0,
    error: 'Execution stopped',
    ...metrics,
  }, finalization);
}

export function bindExternalTurn(
  queueId: string,
  owner?: TurnOwner,
  onTerminal?: TurnTerminalObserver,
): void {
  currentTurnBinding = { queueId, owner, onTerminal };
}

export function getExternalCurrentTurnIdentity(): TurnIdentity | null {
  const binding = currentTurnBinding;
  if (binding?.owner) return { queueId: binding.queueId, owner: binding.owner };
  const promotion = activeTurnPromotion;
  return promotion?.queueId && promotion.owner
    ? { queueId: promotion.queueId, owner: promotion.owner }
    : null;
}

/** All execution turns have a queue identity; Task/Goal owner is optional. */
export function getExternalExecutionTurnId(): string | null {
  return currentTurnBinding?.queueId ?? activeTurnPromotion?.queueId ?? null;
}

export function clearExternalTurnBinding(queueId: string): void {
  if (currentTurnBinding?.queueId === queueId) currentTurnBinding = null;
}

export function isExternalTurnCurrent(queueId: string): boolean {
  return currentTurnBinding?.queueId === queueId;
}

export function resetExternalTurnLifecycleState(): void {
  channelSnapshot = null;
  turnCompleted = false;
  lastTurnSucceeded = false;
  currentTurnStartTime = 0;
  currentTurnPlan = [];
  currentTurnUsage = null;
  currentTurnContextUsage = null;
  currentRuntimeTurnAnchor = null;
  currentTurnEstimatedInputTokens = 0;
  activeTurnSequence = 0;
  turnPromotionGeneration += 1;
  activeTurnPromotion?.abort();
  activeTurnPromotion?.settle({ status: 'not-dispatched' });
  activeTurnPromotion = null;
  currentTurnBinding = null;
  currentTurnActivityFacts = null;
  lastSessionCompletionTerminal = null;
  currentTurnChannelDeliveryState = {
    assistantDisposition: 'none',
    pendingAssistantDeliveries: [],
  };
  channelDeliveryTail = Promise.resolve();
  terminalObserverBarrier = Promise.resolve();
}

export function setExternalTurnActivityFacts(facts: SessionActivityTurnFacts): void {
  currentTurnActivityFacts = facts;
  lastSessionCompletionTerminal = null;
}

export function getExternalTurnActivityFacts(): SessionActivityTurnFacts | null {
  return currentTurnActivityFacts;
}

export function recordExternalSessionCompletionTerminal(params: {
  sessionId: string;
  workspacePath: string;
  status: SessionCompletionStatus;
}): SessionCompletionTerminal | null {
  const binding = currentTurnBinding;
  if (!binding || !params.sessionId || !params.workspacePath) return null;
  lastSessionCompletionTerminal = {
    sessionId: params.sessionId,
    workspacePath: params.workspacePath,
    turnId: binding.queueId,
    ...(binding.owner ? { turnOwner: binding.owner } : {}),
    origin: currentTurnActivityFacts?.origin ?? UNKNOWN_SESSION_ORIGIN,
    status: params.status,
  };
  return lastSessionCompletionTerminal;
}

export function getExternalSessionCompletionTerminal(): SessionCompletionTerminal | null {
  return lastSessionCompletionTerminal;
}

export function clearExternalTurnActivityFacts(facts?: SessionActivityTurnFacts | null): void {
  if (!facts || currentTurnActivityFacts === facts) currentTurnActivityFacts = null;
}

export type ExternalTurnPromotionToken = {
  readonly generation: number;
  readonly queueId?: string;
  readonly owner?: TurnOwner;
  readonly cancelDispatch?: () => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly settled: Promise<ExternalTurnPromotionSettlement>;
  readonly settle: (settlement: ExternalTurnPromotionSettlement) => boolean;
  preserveQueueOnCancel: boolean;
};

export type ExternalTurnPromotionSettlement = {
  status: 'not-dispatched' | 'dispatched' | 'terminated' | 'termination-unconfirmed';
};

export function beginExternalTurnPromotion(input?: {
  queueId?: string;
  owner?: TurnOwner;
  cancelDispatch?: () => void;
}): ExternalTurnPromotionToken | null {
  if (activeTurnPromotion) return null;
  const controller = new AbortController();
  let settled = false;
  let resolveSettlement!: (settlement: ExternalTurnPromotionSettlement) => void;
  const settlement = new Promise<ExternalTurnPromotionSettlement>((resolve) => {
    resolveSettlement = resolve;
  });
  const token = {
    generation: ++turnPromotionGeneration,
    ...input,
    signal: controller.signal,
    abort: () => controller.abort(),
    settled: settlement,
    settle: (outcome: ExternalTurnPromotionSettlement) => {
      if (settled) return false;
      settled = true;
      resolveSettlement(outcome);
      return true;
    },
    preserveQueueOnCancel: false,
  };
  activeTurnPromotion = token;
  return token;
}

export function isExternalTurnPromotionCurrent(token: ExternalTurnPromotionToken): boolean {
  return activeTurnPromotion?.generation === token.generation;
}

export function finishExternalTurnPromotion(
  token: ExternalTurnPromotionToken,
  settlement: ExternalTurnPromotionSettlement = { status: 'not-dispatched' },
): void {
  if (!token.settle(settlement)) return;
  if (isExternalTurnPromotionCurrent(token)) activeTurnPromotion = null;
  if (
    (settlement.status === 'not-dispatched' || settlement.status === 'terminated')
    && !token.signal.aborted
    && token.queueId
    && currentTurnBinding?.queueId === token.queueId
  ) {
    currentTurnBinding = null;
  }
}

export function cancelExternalTurnPromotion(
  options?: { preserveQueue?: boolean },
): ExternalTurnPromotionToken | null {
  if (!activeTurnPromotion) return null;
  const canceled = activeTurnPromotion;
  canceled.preserveQueueOnCancel = options?.preserveQueue === true;
  canceled.cancelDispatch?.();
  canceled.abort();
  turnPromotionGeneration += 1;
  activeTurnPromotion = null;
  return canceled;
}

export function cancelExternalTurnPromotionByQueueId(
  queueId: string,
  options?: { preserveQueue?: boolean },
): ExternalTurnPromotionToken | null {
  if (activeTurnPromotion?.queueId !== queueId) return null;
  return cancelExternalTurnPromotion(options);
}

export function cancelExternalTurnPromotionByOwner(
  owner: TurnOwner,
  options?: { preserveQueue?: boolean },
): ExternalTurnPromotionToken | null {
  const promotedOwner = activeTurnPromotion?.owner;
  if (promotedOwner?.kind !== owner.kind || promotedOwner.id !== owner.id) return null;
  return cancelExternalTurnPromotion(options);
}

export function isExternalTurnPromotionInFlight(): boolean {
  return activeTurnPromotion !== null;
}

export function resetExternalTurnAccumulators(): void {
  currentTurnPlan = [];
  currentTurnUsage = null;
  currentTurnContextUsage = null;
  currentRuntimeTurnAnchor = null;
  currentTurnEstimatedInputTokens = 0;
  currentTurnChannelDeliveryState = {
    assistantDisposition: 'none',
    pendingAssistantDeliveries: [],
  };
}

export function getExternalCurrentTurnPlan(): readonly AgentPlanTodo[] {
  return currentTurnPlan;
}

export function setExternalCurrentTurnPlan(plan: readonly AgentPlanTodo[]): void {
  currentTurnPlan = plan;
}

export function setExternalRuntimeTurnAnchor(anchor: RuntimeTurnAnchor): void {
  currentRuntimeTurnAnchor = anchor;
}

export function getExternalRuntimeTurnAnchor(): RuntimeTurnAnchor | null {
  return currentRuntimeTurnAnchor;
}

export function setExternalTurnCompleted(value: boolean): void {
  turnCompleted = value;
}

export function isExternalTurnCompleted(): boolean {
  return turnCompleted;
}

export function setExternalLastTurnSucceeded(value: boolean): void {
  lastTurnSucceeded = value;
}

export function didExternalLastTurnSucceed(): boolean {
  return lastTurnSucceeded;
}

export function setExternalTurnStartTime(value: number): void {
  if (value > 0 && currentTurnStartTime === 0) {
    activeTurnSequence = ++turnSequence;
  }
  currentTurnStartTime = value;
}

export function markExternalTurnStarted(now = Date.now()): void {
  activeTurnSequence = ++turnSequence;
  currentTurnStartTime = now;
}

function recordExternalTurnTerminal(): void {
  if (activeTurnSequence === 0 || terminalTurnSequence === activeTurnSequence) return;
  terminalTurnSequence = activeTurnSequence;
  turnTerminalGeneration += 1;
}

export function getExternalTurnTerminalGeneration(): number {
  return turnTerminalGeneration;
}

export function isExternalTurnGenerationCurrent(generation: number): boolean {
  return generation === turnTerminalGeneration
    && activeTurnSequence !== 0
    && activeTurnSequence === terminalTurnSequence;
}

export function clearExternalTurnStartTime(): void {
  currentTurnStartTime = 0;
}

export function getExternalTurnStartTime(): number {
  return currentTurnStartTime;
}

export function setExternalCurrentTurnUsage(usage: ExternalTurnUsage | null): void {
  currentTurnUsage = usage;
}

export function getExternalCurrentTurnUsage(): ExternalTurnUsage | null {
  return currentTurnUsage;
}

export function updateExternalCurrentTurnUsageModel(model: string): void {
  if (currentTurnUsage) {
    currentTurnUsage.model = model;
  }
}

export function setExternalCurrentTurnContextUsage(usage: ContextUsage | null): void {
  currentTurnContextUsage = usage;
}

export function getExternalCurrentTurnContextUsage(): ContextUsage | null {
  return currentTurnContextUsage;
}

export function setExternalCurrentTurnEstimatedInputTokens(tokens: number): void {
  currentTurnEstimatedInputTokens = tokens;
}

export function getExternalCurrentTurnEstimatedInputTokens(): number {
  return currentTurnEstimatedInputTokens;
}

export function isExternalTurnFinalizationInFlight(): boolean {
  return turnFinalization.inFlight;
}

export function trackExternalTurnFinalization(promise: Promise<unknown>): void {
  turnFinalization.track(promise);
}

export function waitExternalTurnFinalization(timeoutMs: number): Promise<boolean> {
  return turnFinalization.settled(timeoutMs);
}

export type ExternalTurnFailureCleanup = 'defer-to-stop' | 'stopped' | 'error';

export type ExternalTurnCompletePlan =
  | { kind: 'persist-success' }
  | { kind: 'defer-to-stop'; message: string }
  | { kind: 'failure'; cleanup: 'stopped' | 'error'; message: string };

export type ExternalSessionCompletePlan =
  | { kind: 'ignore-prewarm-exit'; subtype: string }
  | { kind: 'success'; shouldFinalize: boolean }
  | { kind: 'ignore-idle'; message: string }
  | { kind: 'suppress-user-stop'; message: string }
  | { kind: 'failure'; message: string };

export function isSuccessfulExternalTurnCompletion(
  event: Pick<Extract<UnifiedEvent, { kind: 'turn_complete' }>, 'status'>,
): boolean {
  return !event.status
    || event.status === 'completed'
    || event.status === 'success'
    || event.status === 'succeeded';
}

function isInterruptedExternalTurnStatus(status: string | undefined): boolean {
  return status === 'interrupted' || status === 'cancelled' || status === 'canceled';
}

export function classifyExternalTurnFailureCleanup(
  event: Pick<Extract<UnifiedEvent, { kind: 'turn_complete' }>, 'status'>,
  intentionalStopInProgress: boolean,
  forceTransferInProgress = false,
): ExternalTurnFailureCleanup {
  if (intentionalStopInProgress) return 'defer-to-stop';
  if (forceTransferInProgress) return 'stopped';
  if (isInterruptedExternalTurnStatus(event.status)) return 'stopped';
  return 'error';
}

export function externalTurnFailureMessage(event: Extract<UnifiedEvent, { kind: 'turn_complete' }>): string {
  return event.error
    || event.result
    || (event.status ? `External runtime turn ended with status ${event.status}` : 'External runtime turn failed');
}

export function markExternalTurnComplete(
  event: Extract<UnifiedEvent, { kind: 'turn_complete' }>,
  input: { intentionalStopInProgress: boolean; forceTransferInProgress?: boolean },
): ExternalTurnCompletePlan {
  recordExternalTurnTerminal();
  turnCompleted = true;
  const turnSucceeded = isSuccessfulExternalTurnCompletion(event);
  lastTurnSucceeded = turnSucceeded;
  if (turnSucceeded) return { kind: 'persist-success' };

  const message = externalTurnFailureMessage(event);
  const cleanup = classifyExternalTurnFailureCleanup(
    event,
    input.intentionalStopInProgress,
    input.forceTransferInProgress,
  );
  if (cleanup === 'defer-to-stop') {
    return { kind: 'defer-to-stop', message };
  }
  return { kind: 'failure', cleanup, message };
}

export function markExternalSessionComplete(
  event: Extract<UnifiedEvent, { kind: 'session_complete' }>,
  input: {
    hasAssistantText: boolean;
    isUserRequestedStop: () => boolean;
  },
): ExternalSessionCompletePlan {
  if (!turnCompleted && currentTurnStartTime === 0) {
    return { kind: 'ignore-prewarm-exit', subtype: event.subtype };
  }

  recordExternalTurnTerminal();

  if (event.subtype === 'success') {
    if (!turnCompleted) {
      lastTurnSucceeded = true;
      return { kind: 'success', shouldFinalize: true };
    }
    return { kind: 'success', shouldFinalize: false };
  }

  const message = event.result || 'Session ended with error';
  const errorAction = decideSessionCompleteErrorAction({
    turnCompleted,
    hasAssistantText: input.hasAssistantText,
    userRequestedStop: input.isUserRequestedStop(),
    finalizationInFlight: turnFinalization.inFlight,
  });

  if (errorAction === 'ignore-idle') {
    return { kind: 'ignore-idle', message };
  }
  if (errorAction === 'suppress-user-stop') {
    return { kind: 'suppress-user-stop', message };
  }
  return { kind: 'failure', message };
}
