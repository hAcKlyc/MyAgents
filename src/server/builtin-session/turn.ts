import type { ImEventType } from '../utils/im-event-bus';
import type {
  BuiltinTurnStartContext,
  BuiltinTurnUsage,
  MessageQueueItem,
  TurnProviderAnalytics,
} from './types';
import { UNKNOWN_SESSION_ORIGIN, type SessionOrigin } from '../../shared/session-origin';
import type {
  SessionCompletionStatus,
  SessionCompletionTerminal,
} from '../../shared/sessionCompletion';
import type { TurnIdentity, TurnTerminalOutcome } from '../session-core/turn-queue';
import type { AssistantChannelDelivery } from '../session-core/channel-delivery';

type ImEmitter = (type: ImEventType, data?: unknown) => void;

function emptyUsage(): BuiltinTurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelUsage: undefined,
  };
}

let currentTurnUsage = emptyUsage();
const currentModelUsage = new Map<string, import('../types/session').MessageUsage>();
let latestMainAssistantUsage: import('../types/session').MessageUsage | null = null;
let currentTurnStartTime: number | null = null;
let currentPlanFileMinMtimeMs: number | null = null;
let currentTurnToolCount = 0;
let currentTurnHasOutput = false;
let currentTurnHadAssistantMessageError = false;
let currentTurnLastAssistantMessageError: string | null = null;
let currentTurnAnalyticsSource: import('../types/session').TurnAnalyticsSource | null = null;
let currentTurnAnalyticsOrigin: SessionOrigin | null = null;
let currentTurnProviderAnalytics: TurnProviderAnalytics | null = null;
let currentTurnCompactResult: 'success' | 'failed' | null = null;
let currentTurnSawCompactBoundary = false;
let currentTurnAssistantMessagePresent = false;
let turnHadSubstantiveActivity = false;
const currentTurnInboxMetas: import('../inbox/types').InboxTurnMeta[] = [];
const currentTurnTextBlocks: string[] = [];
export type PendingOutputOwner = {
  queueId: string;
  sourceItem?: MessageQueueItem;
  requestId: string | null;
  assistantChannelDelivery: AssistantChannelDelivery;
  channelSessionId: string;
  assistantChannelTextBlocks: Array<string | (() => string | undefined)>;
};

// One owner per user message yielded to SDK stdin. A null requestId is
// intentional: it preserves output ownership for Desktop/cron/other non-IM
// turns so a later realtime IM yield cannot lend its identity backward.
const pendingOutputOwners: PendingOutputOwner[] = [];
let currentTurnImTerminalEmitted = false;
let currentTurnSourceItem: MessageQueueItem | null = null;
let lastSessionCompletionTerminal: SessionCompletionTerminal | null = null;
let terminalObserverBarrier: Promise<void> = Promise.resolve();

function notifyTurnItemTerminal(
  item: Pick<MessageQueueItem, 'onTerminal'>,
  outcome: TurnTerminalOutcome,
): Promise<void> {
  const observer = item.onTerminal;
  if (!observer) return Promise.resolve();
  item.onTerminal = undefined;
  try {
    return Promise.resolve(observer(outcome)).catch((observerError) => {
      console.error('[agent] turn terminal observer failed:', observerError);
    });
  } catch (observerError) {
    console.error('[agent] turn terminal observer failed:', observerError);
    return Promise.resolve();
  }
}

export function notifyQueuedTurnStopped(
  item: Pick<MessageQueueItem, 'onTerminal'>,
  error = 'Queue item was cancelled before dispatch',
): Promise<void> {
  return notifyTurnItemTerminal(item, {
    status: 'stopped',
    text: '',
    assistantMessagePresent: false,
    error,
  });
}

export const turnState = {
  get currentTurnUsage(): BuiltinTurnUsage {
    return currentTurnUsage;
  },
  set currentTurnUsage(usage: BuiltinTurnUsage) {
    currentTurnUsage = usage;
  },
  get latestMainAssistantUsage(): import('../types/session').MessageUsage | null {
    return latestMainAssistantUsage;
  },
  set latestMainAssistantUsage(usage: import('../types/session').MessageUsage | null) {
    latestMainAssistantUsage = usage;
  },
  get currentTurnStartTime(): number | null {
    return currentTurnStartTime;
  },
  set currentTurnStartTime(value: number | null) {
    currentTurnStartTime = value;
  },
  get currentPlanFileMinMtimeMs(): number | null {
    return currentPlanFileMinMtimeMs;
  },
  set currentPlanFileMinMtimeMs(value: number | null) {
    currentPlanFileMinMtimeMs = value;
  },
  get currentTurnToolCount(): number {
    return currentTurnToolCount;
  },
  set currentTurnToolCount(value: number) {
    currentTurnToolCount = value;
  },
  get currentTurnHasOutput(): boolean {
    return currentTurnHasOutput;
  },
  set currentTurnHasOutput(value: boolean) {
    currentTurnHasOutput = value;
  },
  get currentTurnHadAssistantMessageError(): boolean {
    return currentTurnHadAssistantMessageError;
  },
  set currentTurnHadAssistantMessageError(value: boolean) {
    currentTurnHadAssistantMessageError = value;
  },
  get currentTurnLastAssistantMessageError(): string | null {
    return currentTurnLastAssistantMessageError;
  },
  set currentTurnLastAssistantMessageError(value: string | null) {
    currentTurnLastAssistantMessageError = value;
  },
  get currentTurnAnalyticsSource(): import('../types/session').TurnAnalyticsSource | null {
    return currentTurnAnalyticsSource;
  },
  set currentTurnAnalyticsSource(source: import('../types/session').TurnAnalyticsSource | null) {
    currentTurnAnalyticsSource = source;
  },
  get currentTurnAnalyticsOrigin(): SessionOrigin | null {
    return currentTurnAnalyticsOrigin;
  },
  set currentTurnAnalyticsOrigin(origin: SessionOrigin | null) {
    currentTurnAnalyticsOrigin = origin;
  },
  get currentTurnProviderAnalytics(): TurnProviderAnalytics | null {
    return currentTurnProviderAnalytics;
  },
  set currentTurnProviderAnalytics(analytics: TurnProviderAnalytics | null) {
    currentTurnProviderAnalytics = analytics;
  },
  get currentTurnCompactResult(): 'success' | 'failed' | null {
    return currentTurnCompactResult;
  },
  set currentTurnCompactResult(value: 'success' | 'failed' | null) {
    currentTurnCompactResult = value;
  },
  get currentTurnSawCompactBoundary(): boolean {
    return currentTurnSawCompactBoundary;
  },
  set currentTurnSawCompactBoundary(value: boolean) {
    currentTurnSawCompactBoundary = value;
  },
  get currentTurnAssistantMessagePresent(): boolean {
    return currentTurnAssistantMessagePresent;
  },
  set currentTurnAssistantMessagePresent(value: boolean) {
    currentTurnAssistantMessagePresent = value;
  },
  get turnHadSubstantiveActivity(): boolean {
    return turnHadSubstantiveActivity;
  },
  set turnHadSubstantiveActivity(value: boolean) {
    turnHadSubstantiveActivity = value;
  },
  currentTurnTextBlocks,
  pendingOutputOwners,
  get currentTurnImTerminalEmitted(): boolean {
    return currentTurnImTerminalEmitted;
  },
  set currentTurnImTerminalEmitted(value: boolean) {
    currentTurnImTerminalEmitted = value;
  },
  get currentTurnSourceItem(): MessageQueueItem | null {
    return currentTurnSourceItem;
  },
  set currentTurnSourceItem(value: MessageQueueItem | null) {
    currentTurnSourceItem = value;
  },
};

export function beginTurn(context: BuiltinTurnStartContext): void {
  currentTurnStartTime = context.startedAt;
  setCurrentTurnInboxMeta(context.inboxMeta);
  currentTurnProviderAnalytics = context.providerAnalytics ?? null;
}

export function resetTurnUsage(): void {
  currentTurnUsage = emptyUsage();
  currentModelUsage.clear();
  latestMainAssistantUsage = null;
  currentTurnStartTime = null;
  currentPlanFileMinMtimeMs = null;
  currentTurnToolCount = 0;
  currentTurnHasOutput = false;
  currentTurnHadAssistantMessageError = false;
  currentTurnLastAssistantMessageError = null;
  currentTurnAnalyticsSource = null;
  currentTurnAnalyticsOrigin = null;
  currentTurnProviderAnalytics = null;
  currentTurnCompactResult = null;
  currentTurnSawCompactBoundary = false;
  currentTurnAssistantMessagePresent = false;
  turnHadSubstantiveActivity = false;
  currentTurnImTerminalEmitted = false;
  currentTurnTextBlocks.length = 0;
  currentTurnSourceItem = null;
  lastSessionCompletionTerminal = null;
}

export function getCurrentTurnUsage(): BuiltinTurnUsage {
  return currentTurnUsage;
}

export function replaceCurrentTurnUsage(next: BuiltinTurnUsage): void {
  currentTurnUsage = next;
}

/** Keep a best-available total until the SDK result replaces it with the canonical turn usage. */
export function accumulateCurrentTurnUsage(next: import('../types/session').MessageUsage): void {
  currentTurnUsage = {
    ...currentTurnUsage,
    inputTokens: currentTurnUsage.inputTokens + next.inputTokens,
    outputTokens: currentTurnUsage.outputTokens + next.outputTokens,
    cacheReadTokens: currentTurnUsage.cacheReadTokens + (next.cacheReadTokens ?? 0),
    cacheCreationTokens: currentTurnUsage.cacheCreationTokens + (next.cacheCreationTokens ?? 0),
  };
}

/** Model-message usage is cumulative across sibling content frames. V2 replaces
 * that response's contribution; the final SDK result still owns the turn total.
 */
export function updateCurrentTurnModelUsage(id: string, next: Partial<import('../types/session').MessageUsage>): void {
  const previous = currentModelUsage.get(id) ?? { inputTokens: 0, outputTokens: 0 };
  const merged = { ...previous, ...next,
    inputTokens: Math.max(previous.inputTokens, next.inputTokens ?? 0),
    outputTokens: Math.max(previous.outputTokens, next.outputTokens ?? 0),
    cacheReadTokens: Math.max(previous.cacheReadTokens ?? 0, next.cacheReadTokens ?? 0),
    cacheCreationTokens: Math.max(previous.cacheCreationTokens ?? 0, next.cacheCreationTokens ?? 0),
  };
  currentModelUsage.set(id, merged);
  accumulateCurrentTurnUsage({
    inputTokens: merged.inputTokens - previous.inputTokens,
    outputTokens: merged.outputTokens - previous.outputTokens,
    cacheReadTokens: (merged.cacheReadTokens ?? 0) - (previous.cacheReadTokens ?? 0),
    cacheCreationTokens: (merged.cacheCreationTokens ?? 0) - (previous.cacheCreationTokens ?? 0),
  });
}

export function getLatestMainAssistantUsage(): import('../types/session').MessageUsage | null {
  return latestMainAssistantUsage;
}

export function setLatestMainAssistantUsage(usage: import('../types/session').MessageUsage | null): void {
  latestMainAssistantUsage = usage;
}

export function getCurrentTurnStartTime(): number | null {
  return currentTurnStartTime;
}

export function setCurrentTurnStartTime(value: number | null): void {
  currentTurnStartTime = value;
}

export function getCurrentPlanFileMinMtimeMs(): number | null {
  return currentPlanFileMinMtimeMs;
}

export function setCurrentPlanFileMinMtimeMs(value: number | null): void {
  currentPlanFileMinMtimeMs = value;
}

export function getCurrentTurnToolCount(): number {
  return currentTurnToolCount;
}

export function setCurrentTurnToolCount(value: number): void {
  currentTurnToolCount = value;
}

export function incrementCurrentTurnToolCount(): number {
  currentTurnToolCount += 1;
  return currentTurnToolCount;
}

export function hasCurrentTurnOutput(): boolean {
  return currentTurnHasOutput;
}

export function markCurrentTurnHasOutput(): void {
  currentTurnHasOutput = true;
}

export function setCurrentTurnHasOutput(value: boolean): void {
  currentTurnHasOutput = value;
}

export function markAssistantMessageError(error: string): void {
  currentTurnHadAssistantMessageError = true;
  currentTurnLastAssistantMessageError = error;
}

export function hadAssistantMessageError(): boolean {
  return currentTurnHadAssistantMessageError;
}

export function getLastAssistantMessageError(): string | null {
  return currentTurnLastAssistantMessageError;
}

export function clearAssistantMessageError(): void {
  currentTurnHadAssistantMessageError = false;
  currentTurnLastAssistantMessageError = null;
}

export function getCurrentTurnAnalyticsSource(): import('../types/session').TurnAnalyticsSource | null {
  return currentTurnAnalyticsSource;
}

export function setCurrentTurnAnalyticsSource(source: import('../types/session').TurnAnalyticsSource | null): void {
  currentTurnAnalyticsSource = source;
}

export function getCurrentTurnAnalyticsOrigin(): SessionOrigin | null {
  return currentTurnAnalyticsOrigin;
}

export function setCurrentTurnAnalyticsOrigin(origin: SessionOrigin | null): void {
  currentTurnAnalyticsOrigin = origin;
}

export function getCurrentTurnProviderAnalytics(): TurnProviderAnalytics | null {
  return currentTurnProviderAnalytics;
}

export function setCurrentTurnProviderAnalytics(analytics: TurnProviderAnalytics | null): void {
  currentTurnProviderAnalytics = analytics;
}

export function getCurrentTurnCompactResult(): 'success' | 'failed' | null {
  return currentTurnCompactResult;
}

export function setCurrentTurnCompactResult(value: 'success' | 'failed' | null): void {
  currentTurnCompactResult = value;
}

export function sawCompactBoundary(): boolean {
  return currentTurnSawCompactBoundary;
}

export function setSawCompactBoundary(value: boolean): void {
  currentTurnSawCompactBoundary = value;
}

export function isAssistantMessagePresent(): boolean {
  return currentTurnAssistantMessagePresent;
}

export function setAssistantMessagePresent(value: boolean): void {
  currentTurnAssistantMessagePresent = value;
}

export function hasSubstantiveActivity(): boolean {
  return turnHadSubstantiveActivity;
}

export function setSubstantiveActivity(value: boolean): void {
  turnHadSubstantiveActivity = value;
}

export function setCurrentTurnInboxMeta(meta: import('../inbox/types').InboxTurnMeta | undefined): void {
  currentTurnInboxMetas.length = 0;
  appendCurrentTurnInboxMeta(meta);
}

export function appendCurrentTurnInboxMeta(meta: import('../inbox/types').InboxTurnMeta | undefined): void {
  if (meta && !currentTurnInboxMetas.some(item => item.originalMessageId === meta.originalMessageId
    && item.fromSessionId === meta.fromSessionId)) currentTurnInboxMetas.push(meta);
}

export function takeCurrentTurnInboxMetas(): import('../inbox/types').InboxTurnMeta[] {
  return currentTurnInboxMetas.splice(0);
}

/** Only a native consumption receipt can associate a queued Inbox with a turn. */
export function consumePendingInboxInput(queueId: string, joinsCurrentTurn: boolean): void {
  const index = pendingOutputOwners.findIndex(owner => owner.queueId === queueId);
  const item = pendingOutputOwners[index]?.sourceItem;
  if (item?.inputSource !== 'inbox') return;
  if (joinsCurrentTurn && index > 0) {
    // The SDK folded this input into the current turn, so it has no separate result owner.
    pendingOutputOwners.splice(index, 1);
    appendCurrentTurnInboxMeta(item.inboxMeta);
  } else {
    setCurrentTurnSourceItem(item);
    setCurrentTurnInboxMeta(item.inboxMeta);
  }
}

export function appendCurrentTurnTextBlock(chunk: string): void {
  currentTurnTextBlocks.push(chunk);
}

export function getCurrentTurnText(): string {
  return currentTurnTextBlocks.join('').trim();
}

export function clearCurrentTurnTextBlocks(): void {
  currentTurnTextBlocks.length = 0;
}

export function pushPendingOutputOwner(input: {
  queueId: string;
  sourceItem?: MessageQueueItem;
  requestId: string | null | undefined;
  assistantChannelDelivery: AssistantChannelDelivery;
  channelSessionId: string;
}): void {
  pendingOutputOwners.push({
    ...input,
    requestId: input.requestId ?? null,
    assistantChannelTextBlocks: [],
  });
}

export function admitPendingOutputOwnerForYield(
  input: Parameters<typeof pushPendingOutputOwner>[0],
  isTransientProviderRetry: boolean,
): void {
  if (isTransientProviderRetry) return;
  pushPendingOutputOwner(input);
}

export function popPendingOutputOwner(): PendingOutputOwner | null {
  return pendingOutputOwners.shift() ?? null;
}

export function peekPendingOutputOwner(): PendingOutputOwner | null {
  return pendingOutputOwners[0] ?? null;
}

export function getPendingOutputOwnerByQueueId(queueId: string): PendingOutputOwner | undefined {
  return pendingOutputOwners.find(owner => owner.queueId === queueId);
}

export function hasPendingOutputOwnerByQueueId(queueId: string | null | undefined): boolean {
  return Boolean(queueId && pendingOutputOwners.some(owner => owner.queueId === queueId));
}

export function stageCurrentOutputOwnerAssistantChannelBlock(text: string | (() => string | undefined)): boolean {
  const owner = pendingOutputOwners[0];
  if (!owner || owner.assistantChannelDelivery !== 'session-binding' || !text) return false;
  owner.assistantChannelTextBlocks.push(text);
  return true;
}

/** A provider-text retry continues the same logical SDK yield owner. */
export function clearCurrentOutputOwnerAssistantChannelBlocks(): void {
  const owner = pendingOutputOwners[0];
  if (owner) owner.assistantChannelTextBlocks.length = 0;
}

export function removePendingOutputOwnerByQueueId(queueId: string | null | undefined): boolean {
  if (!queueId) return false;
  const idx = pendingOutputOwners.findIndex(owner => owner.queueId === queueId);
  if (idx < 0) return false;
  pendingOutputOwners.splice(idx, 1);
  return true;
}

export function clearPendingOutputOwners(): string[] {
  const drained = pendingOutputOwners
    .map(owner => owner.requestId)
    .filter((requestId): requestId is string => requestId !== null);
  pendingOutputOwners.length = 0;
  currentTurnImTerminalEmitted = false;
  return drained;
}

/** IM request ids still present in the output-owner FIFO (null slots omitted). */
export function getPendingImRequestIds(): readonly string[] {
  return pendingOutputOwners
    .map(owner => owner.requestId)
    .filter((requestId): requestId is string => requestId !== null);
}

export function hasCurrentTurnImTerminalEmitted(): boolean {
  return currentTurnImTerminalEmitted;
}

export function setCurrentTurnImTerminalEmitted(value: boolean): void {
  currentTurnImTerminalEmitted = value;
}

export function completeCurrentImRequest(emit: ImEmitter, data?: unknown): void {
  const requestId = popPendingOutputOwner()?.requestId;
  if (!requestId || currentTurnImTerminalEmitted) return;
  currentTurnImTerminalEmitted = true;
  emit('complete', { requestId, ...(typeof data === 'object' && data ? data : {}) });
}

export function failCurrentImRequest(emit: ImEmitter, data?: unknown): void {
  const requestId = popPendingOutputOwner()?.requestId;
  if (!requestId || currentTurnImTerminalEmitted) return;
  currentTurnImTerminalEmitted = true;
  emit('error', { requestId, ...(typeof data === 'object' && data ? data : {}) });
}

export function snapshotCurrentTurnTerminalOutcome(
  status: TurnTerminalOutcome['status'],
  details: { error?: string; code?: string; durationMs?: number } = {},
): TurnTerminalOutcome {
  return {
    status,
    text: getCurrentTurnText(),
    assistantMessagePresent: currentTurnAssistantMessagePresent,
    ...(details.durationMs !== undefined
      ? { durationMs: Math.max(0, details.durationMs) }
      : currentTurnStartTime !== null
        ? { durationMs: Math.max(0, Date.now() - currentTurnStartTime) }
      : {}),
    usage: {
      inputTokens: currentTurnUsage.inputTokens,
      outputTokens: currentTurnUsage.outputTokens,
    },
    ...(details.error ? { error: details.error } : {}),
    ...(details.code ? { code: details.code } : {}),
  };
}

export function notifyCurrentTurnTerminalOutcome(
  outcome: TurnTerminalOutcome,
  finalization: Promise<unknown> = Promise.resolve(),
): void {
  const item = currentTurnSourceItem;
  const finalized = finalization
    .catch((error) => {
      console.error('[agent] turn finalization failed before terminal observer:', error);
    });
  terminalObserverBarrier = Promise.all([terminalObserverBarrier, finalized])
    .then(() => item?.onTerminal ? notifyTurnItemTerminal(item, outcome) : undefined);
}

export function notifyCurrentTurnTerminal(
  status: TurnTerminalOutcome['status'],
  details: { error?: string; durationMs?: number } = {},
  finalization: Promise<unknown> = Promise.resolve(),
): void {
  notifyCurrentTurnTerminalOutcome(
    snapshotCurrentTurnTerminalOutcome(status, details),
    finalization,
  );
}

export function waitForCurrentTurnTerminalObserver(): Promise<void> {
  return terminalObserverBarrier;
}

export function getCurrentTurnSourceItem(): MessageQueueItem | null {
  return currentTurnSourceItem;
}

export function setCurrentTurnSourceItem(item: MessageQueueItem | null): void {
  currentTurnSourceItem = item;
}

export function getCurrentTurnIdentity(): TurnIdentity | null {
  const item = currentTurnSourceItem;
  return item?.turnOwner ? { queueId: item.id, owner: item.turnOwner } : null;
}

/** Exact accepted runtime queue identity, including ownerless maintenance turns. */
export function getCurrentTurnQueueId(): string | null {
  return currentTurnSourceItem?.id ?? null;
}

export function recordCurrentTurnCompletionTerminal(params: {
  sessionId: string;
  workspacePath: string;
  status: SessionCompletionStatus;
}): SessionCompletionTerminal | null {
  const item = currentTurnSourceItem;
  if (!item || !params.sessionId || !params.workspacePath) return null;
  lastSessionCompletionTerminal = {
    sessionId: params.sessionId,
    workspacePath: params.workspacePath,
    turnId: item.id,
    ...(item.turnOwner ? { turnOwner: item.turnOwner } : {}),
    origin: item.activityFacts?.origin ?? currentTurnAnalyticsOrigin ?? UNKNOWN_SESSION_ORIGIN,
    status: params.status,
  };
  return lastSessionCompletionTerminal;
}

export function getLastSessionCompletionTerminal(): SessionCompletionTerminal | null {
  return lastSessionCompletionTerminal;
}

export function terminalCleanup(): {
  inboxMetas: import('../inbox/types').InboxTurnMeta[];
  replyText: string;
} {
  const inboxMetas = takeCurrentTurnInboxMetas();
  const replyText = getCurrentTurnText();
  clearCurrentTurnTextBlocks();
  currentTurnImTerminalEmitted = false;
  return { inboxMetas, replyText };
}

export function snapshotTurn() {
  return {
    currentTurnUsage,
    latestMainAssistantUsage,
    currentTurnStartTime,
    currentPlanFileMinMtimeMs,
    currentTurnToolCount,
    currentTurnHasOutput,
    currentTurnHadAssistantMessageError,
    currentTurnLastAssistantMessageError,
    currentTurnAnalyticsSource,
    currentTurnAnalyticsOrigin,
    currentTurnProviderAnalytics,
    currentTurnCompactResult,
    currentTurnSawCompactBoundary,
    currentTurnAssistantMessagePresent,
    turnHadSubstantiveActivity,
    currentTurnInboxMetas: [...currentTurnInboxMetas],
    currentTurnTextBlocks: [...currentTurnTextBlocks],
    pendingOutputOwners: pendingOutputOwners.map(owner => ({
      ...owner,
      assistantChannelTextBlocks: [...owner.assistantChannelTextBlocks],
    })),
    currentTurnImTerminalEmitted,
    currentTurnSourceItem,
  };
}

export function resetTurnForTest(): void {
  currentTurnUsage = emptyUsage();
  currentModelUsage.clear();
  latestMainAssistantUsage = null;
  currentTurnStartTime = null;
  currentPlanFileMinMtimeMs = null;
  currentTurnToolCount = 0;
  currentTurnHasOutput = false;
  currentTurnHadAssistantMessageError = false;
  currentTurnLastAssistantMessageError = null;
  currentTurnAnalyticsSource = null;
  currentTurnAnalyticsOrigin = null;
  currentTurnProviderAnalytics = null;
  currentTurnCompactResult = null;
  currentTurnSawCompactBoundary = false;
  currentTurnAssistantMessagePresent = false;
  turnHadSubstantiveActivity = false;
  currentTurnInboxMetas.length = 0;
  currentTurnTextBlocks.length = 0;
  pendingOutputOwners.length = 0;
  currentTurnImTerminalEmitted = false;
  currentTurnSourceItem = null;
  lastSessionCompletionTerminal = null;
  terminalObserverBarrier = Promise.resolve();
}
