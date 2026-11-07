import {
  appendSessionMessages,
  getActiveSessionTranscript,
  commitBuiltinConversationRewind,
  loadSessionTranscript,
  mutateSessionTranscript,
  updateSessionMetadata,
  type TranscriptMutationIntent,
  type TranscriptWriteCursor,
} from '../SessionStore';
import type { SessionMessage } from '../types/session';
import { resolveLastVisibleTurnPreview } from '../utils/session-message-preview';
import { deriveReloadResumeAnchor } from '../utils/rewind-anchor';
import { findTurnUsageStampIndex } from '../utils/sdk-turn-outcome';
import { seedBridgeThoughtSignatures } from '../bridge-cache';
import type { BuiltinTurnUsage } from './types';
import {
  addCurrentSessionUuid,
  deletePersistChain,
  getMessages,
  getBuiltinProductContent,
  invalidateTranscriptCursor,
  removeMessageAt,
  replaceMessages,
  setTranscriptCursor,
  setMessageSequence,
  setPendingReloadAnchor,
  transcriptState,
} from './transcript';

import { messageWireToSessionMessage, sessionMessageToMessageWire } from './message-codec';
export { PLAYWRIGHT_RESULT_SENTINEL, stripPlaywrightResults, messageWireToSessionMessage, sessionMessageToMessageWire } from './message-codec';

export type ScheduleTranscriptPersistOptions = {
  sessionId: string;
  getCurrentSessionId: () => string;
  targetMessageCount?: number;
  lastActiveAt?: string;
  metadataDisposition?: 'update' | 'skip';
};

export function scheduleTranscriptPersist(options: ScheduleTranscriptPersistOptions): Promise<void> {
  if (getActiveSessionTranscript(options.sessionId)) return persistTranscriptNow(options);
  const key = options.sessionId;
  const targetMessageCount = options.targetMessageCount ?? transcriptState.messages.length;
  const prev = transcriptState.persistChainBySession.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => {
    if (key !== options.getCurrentSessionId()) {
      console.warn(`[agent-session] skipping stale queued persist: scheduled for ${key}, current session is ${options.getCurrentSessionId()}`);
      return;
    }
    return persistTranscriptNow({
      sessionId: key,
      targetMessageCount,
      lastActiveAt: options.lastActiveAt,
      metadataDisposition: options.metadataDisposition,
    });
  });
  transcriptState.persistChainBySession.set(key, next);
  void next.finally(() => {
    if (transcriptState.persistChainBySession.get(key) === next) {
      deletePersistChain(key);
    }
  }).catch(() => undefined);
  return next;
}

export async function persistTranscriptNow(options: {
  sessionId: string;
  targetMessageCount?: number;
  lastActiveAt?: string;
  metadataDisposition?: 'update' | 'skip';
}): Promise<void> {
  const active = getActiveSessionTranscript(options.sessionId);
  if (active) {
    const product = getBuiltinProductContent();
    if (!product || product.writer !== active.writer) return;
    // Lazy creation can happen after the admitted user surface was staged.
    // Transfer that surface once; subsequent content is already canonical.
    for (const message of transcriptState.messages) {
      if (message.role === 'user') product.admitUser(messageWireToSessionMessage(message));
    }
    transcriptState.messages.length = 0;
    if (options.metadataDisposition !== 'skip' && options.lastActiveAt) {
      active.patchMetadata({ lastActiveAt: options.lastActiveAt });
    }
    active.writer.requestCommit();
    return;
  }
  const targetMessageCount = options.targetMessageCount ?? transcriptState.messages.length;
  const hadCursor = transcriptState.transcriptCursor !== null;
  const cursor = await ensureTranscriptCursor(options.sessionId);
  const boundedTargetCount = Math.min(targetMessageCount, transcriptState.messages.length);
  if (cursor.persistedMessageCount > boundedTargetCount) {
    if (hadCursor) {
      invalidateTranscriptCursor();
      await ensureTranscriptCursor(options.sessionId, true);
    }
    throw new Error(
      `[agent-session] transcript projection invariant failed for ${options.sessionId}: live target ${boundedTargetCount} is shorter than durable cursor ${cursor.persistedMessageCount}; rehydrated from SessionStore`,
    );
  }
  if (cursor.persistedMessageCount >= boundedTargetCount) {
    if (options.lastActiveAt && options.metadataDisposition !== 'skip') {
      try {
        await updateSessionMetadata(options.sessionId, { lastActiveAt: options.lastActiveAt });
      } catch (error) {
        console.error('[agent-session] failed to persist transcript metadata:', error);
      }
    }
    return;
  }

  const tail = transcriptState.messages.slice(cursor.persistedMessageCount, boundedTargetCount);
  const tailMapped = tail.map(messageWireToSessionMessage);
  const result = await appendSessionMessages(options.sessionId, cursor, tailMapped);
  if (!result.ok) {
    if ('cursor' in result) {
      setTranscriptCursor(result.cursor);
    } else {
      invalidateTranscriptCursor();
      await ensureTranscriptCursor(options.sessionId, true);
    }
    throw new Error(`[agent-session] failed to append transcript for ${options.sessionId}: ${result.reason}: ${result.error}`);
  }
  setTranscriptCursor(result.cursor);

  if (options.metadataDisposition === 'skip') return;
  const { preview: lastMessagePreview } =
    resolveLastVisibleTurnPreview(
      transcriptState.messages.slice(0, result.cursor.persistedMessageCount).map(messageWireToSessionMessage),
    );
  try {
    await updateSessionMetadata(options.sessionId, {
      ...(options.lastActiveAt ? { lastActiveAt: options.lastActiveAt } : {}),
      lastMessagePreview,
    });
  } catch (error) {
    console.error('[agent-session] failed to persist transcript metadata:', error);
  }
}

export function loadTranscriptFromSessionMessages(
  storedMessages: SessionMessage[],
  cursor: TranscriptWriteCursor,
): void {
  replaceMessages(storedMessages.map(sessionMessageToMessageWire));
  setTranscriptCursor(cursor);
  if (storedMessages.length > 0) {
    const numericIds = storedMessages.map(message => /^\d+$/u.test(message.id) ? Number(message.id) : -1);
    setMessageSequence(numericIds.reduce((max, id) => Math.max(max, id), -1) + 1);
  }

  for (const msg of getMessages()) {
    if (msg.sdkUuid) {
      addCurrentSessionUuid(msg.sdkUuid);
    }
  }

  setPendingReloadAnchor(deriveReloadResumeAnchor(getMessages(), transcriptState.currentSessionUuids));
  seedThoughtSignatureCacheFromTranscript();
}

export function stampTurnUsageOnPendingAssistant(options: {
  usage: BuiltinTurnUsage;
  toolCount: number;
  durationMs?: number;
  providerId?: string;
  completedAt?: string;
}): void {
  const product = getBuiltinProductContent();
  if (product) {
    const priorUsage = product.currentAssistantId ? product.writer.projection.messages.get(product.currentAssistantId)?.usage : undefined;
    const usage = {
      inputTokens: options.usage.inputTokens,
      outputTokens: options.usage.outputTokens,
      cacheReadTokens: options.usage.cacheReadTokens || undefined,
      cacheCreationTokens: options.usage.cacheCreationTokens || undefined,
      providerId: options.providerId ?? priorUsage?.providerId, model: options.usage.model, modelUsage: options.usage.modelUsage,
      sdkCumulativeModelUsage: options.usage.sdkCumulativeModelUsage,
    };
    if (product.currentAssistantId) product.writer.observe({ kind: 'message-update',
      messageId: product.currentAssistantId,
      details: { usage, toolCount: options.toolCount, durationMs: options.durationMs },
    });
    const turn = product.currentTurn;
    if (turn) product.writer.observe({ kind: 'turn-update', turn: { ...turn, usage,
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    } });
    return;
  }
  const usageStampIndex = findTurnUsageStampIndex(
    transcriptState.messages,
    transcriptState.transcriptCursor?.persistedMessageCount ?? 0,
  );
  if (usageStampIndex < 0) return;
  const completedAssistant = transcriptState.messages[usageStampIndex];
  completedAssistant.usage = {
    inputTokens: options.usage.inputTokens,
    outputTokens: options.usage.outputTokens,
    cacheReadTokens: options.usage.cacheReadTokens || undefined,
    cacheCreationTokens: options.usage.cacheCreationTokens || undefined,
    providerId: options.providerId,
    model: options.usage.model,
    modelUsage: options.usage.modelUsage,
    sdkCumulativeModelUsage: options.usage.sdkCumulativeModelUsage,
  };
  completedAssistant.toolCount = options.toolCount;
  completedAssistant.durationMs = options.durationMs;
  if (options.completedAt) completedAssistant.completedAt = options.completedAt;
}

export function resetTranscriptPersistenceForSession(sessionId: string): void {
  invalidateTranscriptCursor();
  deletePersistChain(sessionId);
}

export async function truncateTranscriptPersistenceForRewind(
  sessionId: string,
  targetMessageId: string,
  targetMessageCount: number,
  replacement?: {
    sourceSdkSessionId: string | null;
    replacementSdkSessionId: string;
    resumeSessionAt?: string;
  },
): Promise<void> {
  if (replacement) {
    const cursor = await ensureTranscriptCursor(sessionId);
    const result = await commitBuiltinConversationRewind({
      sessionId,
      cursor,
      targetMessageId,
      targetMessageCount,
      ...replacement,
    });
    if (!result.success) {
      if (result.error.includes('stale-cursor')) {
        invalidateTranscriptCursor();
        await ensureTranscriptCursor(sessionId, true);
      }
      throw new Error(
        `[agent-session] failed builtin rewind for ${sessionId}: ${result.reason}: ${result.error}`,
      );
    }
    setTranscriptCursor(result.cursor);
    return;
  }

  await commitTranscriptMutation(sessionId, {
    kind: 'builtin-rewind',
    targetMessageId,
    targetMessageCount,
  });
}

export async function applyTranscriptRetractionToPersistence(
  sessionId: string,
  removedMessageIds: ReadonlySet<string>,
  request:
    | { kind: 'sdk-retraction'; sdkUuids: readonly string[]; streamingTailMessageId?: string }
    | { kind: 'builtin-admission-rollback' | 'builtin-transient-retry' },
): Promise<void> {
  const product = getBuiltinProductContent();
  if (product && getActiveSessionTranscript(sessionId)?.writer === product.writer) {
    product.removeMessages([...removedMessageIds]);
    return;
  }
  const ids = [...removedMessageIds];
  const intent: TranscriptMutationIntent = request.kind === 'sdk-retraction'
    ? request
    : { kind: request.kind, messageId: ids[0] ?? '' };
  await commitTranscriptMutation(sessionId, intent);
  for (let i = transcriptState.messages.length - 1; i >= 0; i--) {
    if (!removedMessageIds.has(transcriptState.messages[i].id)) continue;
    removeMessageAt(i);
  }
}

async function ensureTranscriptCursor(
  sessionId: string,
  forceReload = false,
): Promise<TranscriptWriteCursor> {
  if (getActiveSessionTranscript(sessionId)) {
    const snapshot = await loadSessionTranscript(sessionId);
    setTranscriptCursor(snapshot.cursor);
    return snapshot.cursor;
  }
  if (!forceReload && transcriptState.transcriptCursor) {
    return transcriptState.transcriptCursor;
  }
  const snapshot = await loadSessionTranscript(sessionId);
  const durablePrefixMatches = snapshot.messages.every(
    (message, index) => transcriptState.messages[index]?.id === message.id,
  );
  if (transcriptState.messages.length < snapshot.messages.length || !durablePrefixMatches) {
    replaceMessages(snapshot.messages.map(sessionMessageToMessageWire));
  }
  setTranscriptCursor(snapshot.cursor);
  return snapshot.cursor;
}

async function commitTranscriptMutation(
  sessionId: string,
  intent: TranscriptMutationIntent,
): Promise<void> {
  const cursor = await ensureTranscriptCursor(sessionId);
  const result = await mutateSessionTranscript(sessionId, cursor, intent);
  if (!result.ok) {
    if (result.reason === 'stale-cursor') {
      invalidateTranscriptCursor();
      await ensureTranscriptCursor(sessionId, true);
    }
    throw new Error(`[agent-session] failed transcript mutation for ${sessionId}: ${result.reason}: ${result.error}`);
  }
  setTranscriptCursor(result.cursor);
}

function seedThoughtSignatureCacheFromTranscript(): void {
  const thoughtSigEntries: Array<{ id: string; thought_signature: string }> = [];
  for (const msg of getMessages()) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.tool?.thought_signature) {
          thoughtSigEntries.push({ id: block.tool.id, thought_signature: block.tool.thought_signature });
        }
      }
    }
  }
  if (thoughtSigEntries.length > 0) {
    seedBridgeThoughtSignatures(thoughtSigEntries);
  }
}
