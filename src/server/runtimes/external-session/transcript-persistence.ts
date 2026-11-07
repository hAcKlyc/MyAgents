import type { MessageUsage, RuntimeTurnAnchor, SessionMessage } from '../../types/session';
import {
  appendSessionMessages,
  beginDshRootOperation,
  discardUnpersistedDshRootOperation,
  loadSessionTranscript,
  mutateSessionTranscript,
  updateSessionMetadata,
  getActiveSessionTranscript,
  type AppendSessionMessagesResult,
  type TranscriptWriteCursor,
} from '../../SessionStore';
import { resolveLastVisibleTurnPreview } from '../../utils/session-message-preview';
import type { ContextUsage } from '../../../shared/types/context-usage';
import type { PersistContentBlock } from './types';
import { ProductTranscriptContent } from '../../session-transcript/content';
import { transcriptMessages, toStoredTranscriptMessage } from '../../../shared/sessionTranscript';
import { getExternalLifecycleSessionId } from './lifecycle';

let allSessionMessages: SessionMessage[] = [];
let lastPersistedRuntimeUsageTotals: MessageUsage | null = null;
let transcriptSessionId = '';
let transcriptCursor: TranscriptWriteCursor | null = null;
let productContent: ProductTranscriptContent | undefined;

export function getExternalProductContent(): ProductTranscriptContent | undefined {
  const active = getActiveSessionTranscript(transcriptSessionId || getExternalLifecycleSessionId());
  if (!active) return undefined;
  if (productContent?.writer !== active.writer) productContent = new ProductTranscriptContent(active.writer);
  return productContent;
}

export function resetExternalTranscriptState(): void {
  allSessionMessages = [];
  lastPersistedRuntimeUsageTotals = null;
  transcriptSessionId = '';
  transcriptCursor = null;
  productContent = undefined;
}

export function getExternalSessionMessagesSnapshot(): SessionMessage[] {
  const product = getExternalProductContent();
  if (product) return transcriptMessages(product.writer.projection);
  return [...allSessionMessages];
}

export function getExternalTranscriptSessionId(): string {
  return transcriptSessionId;
}

export function forEachExternalSessionMessage(
  callback: (message: SessionMessage) => void,
): void {
  for (const message of getExternalSessionMessagesSnapshot()) {
    callback(message);
  }
}

export function setExternalSessionMessages(
  sessionId: string,
  messages: SessionMessage[],
  cursor: TranscriptWriteCursor,
): void {
  transcriptSessionId = sessionId;
  allSessionMessages = getExternalProductContent() ? [] : messages;
  transcriptCursor = cursor;
}

export function clearExternalSessionMessages(sessionId?: string): void {
  if (sessionId !== undefined) {
    transcriptSessionId = sessionId;
  }
  allSessionMessages = [];
  transcriptCursor = null;
}

export function pushExternalSessionMessage(message: SessionMessage): void {
  const product = getExternalProductContent();
  if (product && message.role === 'user') {
    product.admitUser(message);
    return;
  }
  allSessionMessages.push(message);
}

export function getExternalSessionMessageCount(): number {
  const product = getExternalProductContent();
  if (product) return product.writer.projection.messages.size;
  return allSessionMessages.length;
}

export function findExternalSessionMessageIndex(
  predicate: (message: SessionMessage) => boolean,
): number {
  return getExternalSessionMessagesSnapshot().findIndex(predicate);
}

export function getExternalSessionMessageAt(index: number): SessionMessage | undefined {
  const product = getExternalProductContent();
  if (product) {
    const message = [...product.writer.projection.messages.values()][index];
    return message ? toStoredTranscriptMessage(message) : undefined;
  }
  return allSessionMessages[index];
}

export function truncateExternalSessionMessages(length: number): void {
  allSessionMessages.length = length;
}

export function removeExternalSessionMessageById(messageId: string): boolean {
  for (let i = allSessionMessages.length - 1; i >= 0; i -= 1) {
    if (allSessionMessages[i]?.id === messageId) {
      allSessionMessages.splice(i, 1);
      return true;
    }
  }
  return false;
}

export function getLastPersistedRuntimeUsageTotals(): MessageUsage | null {
  return lastPersistedRuntimeUsageTotals;
}

export function setLastPersistedRuntimeUsageTotals(usage: MessageUsage | null): void {
  lastPersistedRuntimeUsageTotals = usage;
}

function isContentBlockJson(content: string): boolean {
  return content.startsWith('[') && content.includes('"type"');
}

export function getLastExternalAssistantTextFromTranscript(): string {
  const product = getExternalProductContent();
  if (product) {
    const messages = [...product.writer.projection.messages.values()].filter(message => message.role === 'assistant');
    const turnId = product.currentTurn?.id ?? messages.at(-1)?.turnId;
    return messages.filter(message => turnId ? message.turnId === turnId : message.id === messages.at(-1)?.id)
      .map(message => typeof message.content === 'string' ? message.content : message.content
        .filter(block => block.type === 'text').map(block => typeof block.text === 'string' ? block.text : '').join(''))
      .join('');
  }
  for (let i = allSessionMessages.length - 1; i >= 0; i--) {
    const msg = allSessionMessages[i];
    if (msg.role !== 'assistant') continue;
    const content = msg.content ?? '';
    if (isContentBlockJson(content)) {
      try {
        const blocks = JSON.parse(content) as PersistContentBlock[];
        return blocks
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('');
      } catch {
        // Fall through to plain text.
      }
    }
    return content;
  }
  return '';
}

function describeSaveSessionMessagesFailure(
  result: Extract<AppendSessionMessagesResult, { ok: false }>,
): string {
  switch (result.reason) {
    case 'unindexed-create-refused':
    case 'stale-cursor':
    case 'storage-consistency-error':
    case 'write-error':
      return result.error;
  }
}

function assertExternalSessionMessagesPersisted(
  result: AppendSessionMessagesResult,
  context: string,
): TranscriptWriteCursor {
  if (!result.ok) {
    throw new Error(`${context}: ${describeSaveSessionMessagesFailure(result)}`);
  }
  return result.cursor;
}

export async function persistExternalUserMessageAppend(
  sessionId: string,
  _userMessageId: string,
  failureContext: string,
  lastActiveAt?: string,
  metadataDisposition: 'update' | 'skip' = 'update',
  dshRootOperation?: {
    clientOperationId: string;
    runtimeSessionId: string;
    productImageSha256: readonly string[];
  },
): Promise<{ lastMessagePreview?: string }> {
  const active = getActiveSessionTranscript(sessionId);
  if (active) {
    transcriptSessionId = sessionId;
    const product = getExternalProductContent()!;
    // A first user can be staged before its metadata birth. Transfer that
    // admitted prefix once; V2 never installs the legacy history array.
    for (const message of allSessionMessages) if (message.role === 'user') product.admitUser(message);
    allSessionMessages = [];
    const user = active.writer.projection.messages.get(_userMessageId);
    if (dshRootOperation) {
      if (!user || user.role !== 'user') throw new Error(`${failureContext}: Missing DSH Product user`);
      const begun = await beginDshRootOperation({
        sessionId, cursor: (await loadSessionTranscript(sessionId)).cursor,
        ...dshRootOperation, userMessage: toStoredTranscriptMessage(user),
      });
      if (!begun.success) throw new Error(`${failureContext}: ${begun.error}`);
    }
    const { preview: lastMessagePreview } = resolveLastVisibleTurnPreview(user ? [toStoredTranscriptMessage(user)] : []);
    if (metadataDisposition !== 'skip') active.patchMetadata({ lastMessagePreview, ...(lastActiveAt ? { lastActiveAt } : {}) });
    return { lastMessagePreview };
  }
  const { preview: lastMessagePreview } = resolveLastVisibleTurnPreview(allSessionMessages);
  const cursor = await ensureExternalTranscriptCursor(sessionId);
  const tail = allSessionMessages.slice(cursor.persistedMessageCount);
  const rootUser = dshRootOperation
    ? tail.find(message => message.role === 'user' && message.id === _userMessageId)
    : undefined;
  if (dshRootOperation && (tail.length !== 1 || !rootUser)) {
    throw new Error(`${failureContext}: DSH admission requires one exact Product user tail`);
  }
  if (dshRootOperation && rootUser) {
    const begun = await beginDshRootOperation({
      sessionId,
      cursor,
      runtimeSessionId: dshRootOperation.runtimeSessionId,
      clientOperationId: dshRootOperation.clientOperationId,
      userMessage: rootUser,
      productImageSha256: dshRootOperation.productImageSha256,
    });
    if (!begun.success) throw new Error(`${failureContext}: ${begun.error}`);
  }
  const saveResult = await appendSessionMessages(sessionId, cursor, tail);
  try {
    transcriptCursor = assertExternalSessionMessagesPersisted(saveResult, failureContext);
  } catch (error) {
    if (dshRootOperation) {
      await discardUnpersistedDshRootOperation({
        sessionId,
        clientOperationId: dshRootOperation.clientOperationId,
        clientUserMessageId: _userMessageId,
      });
    }
    throw error;
  }

  if (metadataDisposition === 'skip') return { lastMessagePreview };
  try {
    await updateSessionMetadata(sessionId, {
      lastMessagePreview,
      ...(lastActiveAt ? { lastActiveAt } : {}),
    });
  } catch (error) {
    // The transcript is already durable and may already be entering the
    // runtime. A metadata-only failure must not roll back or duplicate it.
    console.warn('[external-session] failed to update user preview metadata:', error);
  }
  return { lastMessagePreview };
}

export async function removeAndPersistExternalSessionMessage(
  sessionId: string,
  messageId: string,
  failureContext: string,
): Promise<boolean> {
  const product = getExternalProductContent();
  if (product) {
    const exists = product.writer.projection.messages.has(messageId);
    if (exists) product.removeMessages([messageId]);
    return exists;
  }
  if (!allSessionMessages.some(message => message.id === messageId)) return false;
  const cursor = await ensureExternalTranscriptCursor(sessionId);
  const result = await mutateSessionTranscript(sessionId, cursor, {
    kind: 'external-rejected-message',
    messageId,
  });
  if (!result.ok) {
    if (result.reason === 'stale-cursor') await reloadExternalTranscript(sessionId);
    throw new Error(`${failureContext}: ${result.reason}: ${result.error}`);
  }
  transcriptCursor = result.cursor;
  removeExternalSessionMessageById(messageId);
  return true;
}


export async function retryUnadmittedDshTranscript(
  sessionId: string,
  userMessageId: string,
): Promise<{
  success: boolean;
  error?: string;
  content?: string;
  desktopQuery?: SessionMessage['desktopQuery'];
  attachments?: SessionMessage['attachments'];
}> {
  const messages = getExternalSessionMessagesSnapshot();
  const targetIndex = messages.findIndex(
    m => m.id === userMessageId && m.role === 'user',
  );
  if (targetIndex < 0) {
    return { success: false, error: 'Message not found' };
  }
  const target = messages[targetIndex];
  if (!target) {
    return { success: false, error: 'Message not found' };
  }
  const content = typeof target.content === 'string' ? target.content : '';
  const attachments = target.attachments;

  try {
    const cursor = await ensureExternalTranscriptCursor(sessionId);
    const result = await mutateSessionTranscript(sessionId, cursor, {
      kind: 'dsh-unadmitted-retry',
      targetMessageId: userMessageId,
      targetMessageCount: targetIndex,
    });
    if (!result.ok) {
      if (result.reason === 'stale-cursor') await reloadExternalTranscript(sessionId);
      const userFacingError = result.reason === 'stale-cursor'
        ? 'Conversation history changed while retrying; reopen the session before trying again.'
        : result.reason === 'malformed-transcript'
          ? 'Conversation history contains data that cannot be safely modified.'
          : `Failed to persist truncation: ${result.error}`;
      throw new Error(userFacingError);
    }
    transcriptCursor = result.cursor;
    if (!getExternalProductContent()) allSessionMessages.length = targetIndex;
  } catch (err) {
    console.error('[external-session] popLastUserMessageForRetry: failed to persist truncation:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to persist truncation',
    };
  }
  return { success: true, content, desktopQuery: target.desktopQuery, attachments };
}

export interface ExternalAssistantTurnPersistInput {
  sessionId: string | null;
  content: string | null;
  durationMs?: number;
  completedAt?: string;
  usage: MessageUsage | null | undefined;
  toolCount: number;
  contextUsage: ContextUsage | null;
  lastActiveAt?: string;
  runtimeTurnAnchor?: RuntimeTurnAnchor;
  completionState?: 'partial';
  terminalStatus?: 'complete' | 'stopped' | 'error';
}

export interface ExternalAssistantTurnPersistResult {
  ok: boolean;
  failureReason?: string;
  messageCount: number;
  appendedAssistant: boolean;
  assistantMessageId?: string;
}

export async function appendAndPersistExternalAssistantTurn(
  input: ExternalAssistantTurnPersistInput,
): Promise<ExternalAssistantTurnPersistResult> {
  const active = input.sessionId ? getActiveSessionTranscript(input.sessionId) : undefined;
  const product = active ? getExternalProductContent() : undefined;
  if (active && product) {
    const assistantMessageId = product.finishTurn(input.terminalStatus ?? 'complete', {
      completedAt: input.completedAt,
      durationMs: input.durationMs, usage: input.usage ?? undefined, toolCount: input.toolCount,
      runtimeTurnAnchor: input.runtimeTurnAnchor,
      completionState: input.completionState,
      terminalStatus: input.terminalStatus === 'complete' ? undefined : input.terminalStatus,
    }) ?? undefined;
    active.patchMetadata({
      runtimeUsageTotals: lastPersistedRuntimeUsageTotals ?? undefined,
      ...(input.contextUsage ? { lastContextUsage: input.contextUsage } : {}),
      ...(input.lastActiveAt ? { lastActiveAt: input.lastActiveAt } : {}),
    });
    return { ok: true, messageCount: active.writer.projection.messages.size, appendedAssistant: Boolean(assistantMessageId), assistantMessageId };
  }
  let appendedAssistant = false;
  let assistantMessageId: string | undefined;
  if (input.content) {
    assistantMessageId = `assistant-${Date.now()}`;
    allSessionMessages.push({
      id: assistantMessageId,
      role: 'assistant',
      content: input.content,
      timestamp: new Date().toISOString(),
      completedAt: input.completedAt,
      durationMs: input.durationMs,
      usage: input.usage || undefined,
      toolCount: input.toolCount || undefined,
      runtimeTurnAnchor: input.runtimeTurnAnchor,
      completionState: input.completionState,
      terminalStatus: input.terminalStatus === 'complete' ? undefined : input.terminalStatus,
    });
    appendedAssistant = true;
  }

  if (allSessionMessages.length === 0 || !input.sessionId) {
    return {
      ok: true,
      messageCount: allSessionMessages.length,
      appendedAssistant,
      ...(assistantMessageId ? { assistantMessageId } : {}),
    };
  }

  try {
    const cursor = await ensureExternalTranscriptCursor(input.sessionId);
    const saveResult = await appendSessionMessages(
      input.sessionId,
      cursor,
      allSessionMessages.slice(cursor.persistedMessageCount),
    );
    if (!saveResult.ok) {
      if (input.lastActiveAt) {
        try {
          await updateSessionMetadata(input.sessionId, { lastActiveAt: input.lastActiveAt });
        } catch (error) {
          console.error('[external-session] failed to persist terminal activity after transcript refusal:', error);
        }
      }
      return {
        ok: false,
        failureReason: describeSaveSessionMessagesFailure(saveResult),
        messageCount: allSessionMessages.length,
        appendedAssistant,
        ...(assistantMessageId ? { assistantMessageId } : {}),
      };
    }
    transcriptCursor = saveResult.cursor;

    const { preview: lastMessagePreview } =
      resolveLastVisibleTurnPreview(allSessionMessages);
    try {
      await updateSessionMetadata(input.sessionId, {
        lastMessagePreview,
        runtimeUsageTotals: lastPersistedRuntimeUsageTotals ?? undefined,
        ...(input.contextUsage ? { lastContextUsage: input.contextUsage } : {}),
        ...(input.lastActiveAt ? { lastActiveAt: input.lastActiveAt } : {}),
      });
    } catch (error) {
      console.warn('[external-session] assistant transcript committed but metadata update failed:', error);
    }
    return {
      ok: true,
      messageCount: allSessionMessages.length,
      appendedAssistant,
      ...(assistantMessageId ? { assistantMessageId } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      failureReason: err instanceof Error ? err.message : String(err),
      messageCount: allSessionMessages.length,
      appendedAssistant,
      ...(assistantMessageId ? { assistantMessageId } : {}),
    };
  }
}

async function reloadExternalTranscript(sessionId: string): Promise<TranscriptWriteCursor> {
  const snapshot = await loadSessionTranscript(sessionId);
  setExternalSessionMessages(sessionId, snapshot.messages, snapshot.cursor);
  return snapshot.cursor;
}

async function ensureExternalTranscriptCursor(sessionId: string): Promise<TranscriptWriteCursor> {
  if (getActiveSessionTranscript(sessionId)) return (await loadSessionTranscript(sessionId)).cursor;
  if (transcriptSessionId === sessionId && transcriptCursor) {
    if (allSessionMessages.length < transcriptCursor.persistedMessageCount) {
      const durableCount = transcriptCursor.persistedMessageCount;
      const liveCount = allSessionMessages.length;
      await reloadExternalTranscript(sessionId);
      throw new Error(
        `External transcript projection invariant failed: live ${liveCount} was shorter than durable cursor ${durableCount}; rehydrated from SessionStore`,
      );
    }
    return transcriptCursor;
  }
  const snapshot = await loadSessionTranscript(sessionId);
  const prefixMatches = snapshot.messages.every(
    (message, index) => allSessionMessages[index]?.id === message.id,
  );
  if (
    transcriptSessionId !== sessionId
    || allSessionMessages.length < snapshot.messages.length
    || !prefixMatches
  ) {
    allSessionMessages = snapshot.messages;
  }
  transcriptSessionId = sessionId;
  transcriptCursor = snapshot.cursor;
  return snapshot.cursor;
}
