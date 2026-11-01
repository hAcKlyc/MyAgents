import { getActiveSessionTranscript, type TranscriptWriteCursor } from '../SessionStore';
import type { MessageWire } from './types';
import { ProductTranscriptContent } from '../session-transcript/content';
import { fromStoredTranscriptMessage, transcriptMessages } from '../../shared/sessionTranscript';
import { messageWireToSessionMessage, sessionMessageToMessageWire } from './message-codec';

const messages: MessageWire[] = [];
let messageSequence = 0;
let transcriptCursor: TranscriptWriteCursor | null = null;
const persistChainBySession = new Map<string, Promise<void>>();
const currentSessionUuids = new Set<string>();
const liveSessionUuids = new Set<string>();
let pendingReloadAnchor: string | undefined = undefined;
let productContent: ProductTranscriptContent | undefined;
let readProductSessionId: () => string = () => '';

/** The facade supplies its binding authority; content never imports SessionEngine. */
export function configureBuiltinTranscriptBinding(readSessionId: () => string): void {
  readProductSessionId = readSessionId;
}

export function getBuiltinProductContent(): ProductTranscriptContent | undefined {
  const active = getActiveSessionTranscript(readProductSessionId());
  if (!active) return undefined;
  if (productContent?.writer !== active.writer) productContent = new ProductTranscriptContent(active.writer);
  return productContent;
}

export const transcriptState = {
  messages,
  get messageSequence(): number {
    return messageSequence;
  },
  set messageSequence(value: number) {
    messageSequence = value;
  },
  get transcriptCursor(): TranscriptWriteCursor | null {
    return transcriptCursor;
  },
  set transcriptCursor(value: TranscriptWriteCursor | null) {
    transcriptCursor = value;
  },
  persistChainBySession,
  currentSessionUuids,
  liveSessionUuids,
  get pendingReloadAnchor(): string | undefined {
    return pendingReloadAnchor;
  },
  set pendingReloadAnchor(anchor: string | undefined) {
    pendingReloadAnchor = anchor;
  },
};

export function nextMessageSequence(): number {
  messageSequence += 1;
  return messageSequence;
}

export function allocateMessageId(): string {
  const id = String(messageSequence);
  messageSequence += 1;
  return id;
}

export function getMessageSequence(): number {
  return messageSequence;
}

export function setMessageSequence(value: number): void {
  messageSequence = value;
}

export function getMessages(): MessageWire[] {
  const product = getBuiltinProductContent();
  if (product) return transcriptMessages(product.writer.projection).map(sessionMessageToMessageWire);
  return messages;
}

export function getMessageCount(): number {
  return getBuiltinProductContent()?.writer.projection.messages.size ?? messages.length;
}

export function getMessageIdentities(): Pick<MessageWire, 'id' | 'role' | 'sdkUuid'>[] {
  const product = getBuiltinProductContent();
  return product ? [...product.writer.projection.messages.values()].map(({ id, role, sdkUuid }) => ({ id, role, sdkUuid })) : messages;
}

export function getLastAssistantMessageId(): string | null {
  const product = getBuiltinProductContent();
  if (product) {
    let lastId: string | null = null;
    for (const message of product.writer.projection.messages.values()) if (message.role === 'assistant') lastId = message.id;
    return lastId;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].id;
  }
  return null;
}

export function appendMessage(message: MessageWire): void {
  const product = getBuiltinProductContent();
  if (product) {
    const stored = messageWireToSessionMessage(message);
    if (message.role === 'user') product.admitUser(stored);
    else {
      const assistant = product.assistant(message.id);
      const content = fromStoredTranscriptMessage(stored).content;
      if (typeof content === 'string') {
        const target = product.block(`local:${message.id}`, 'text', { text: '', isComplete: true });
        product.confirmText(target, 'text', content);
      } else for (const block of content) {
        product.writer.observe({ kind: 'block-upsert', messageId: assistant.id, block });
      }
    }
    return;
  }
  messages.push(message);
}

export function bindSdkUuidToUserInput(inputUuid: string, sdkUuid: string): string | null {
  const product = getBuiltinProductContent();
  if (product) {
    const message = [...product.writer.projection.messages.values()]
      .find(candidate => candidate.role === 'user' && candidate.sdkInputUuid === inputUuid);
    if (!message || message.sdkUuid === sdkUuid) return null;
    product.writer.observe({ kind: 'message-update', messageId: message.id, details: { sdkUuid } });
    return message.id;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].sdkInputUuid === inputUuid) {
      if (messages[i].sdkUuid === sdkUuid) return null;
      messages[i].sdkUuid = sdkUuid;
      return messages[i].id;
    }
  }
  return null;
}

export function bindSdkUuidToMessage(message: MessageWire, sdkUuid: string): string {
  const product = getBuiltinProductContent();
  if (product) {
    product.writer.observe({ kind: 'message-update', messageId: message.id, details: { sdkUuid } });
    return message.id;
  }
  message.sdkUuid = sdkUuid;
  return message.id;
}

export function removeMessageAt(index: number): MessageWire[] {
  const product = getBuiltinProductContent();
  if (product) {
    const id = [...product.writer.projection.messages.keys()][index];
    if (!id) return [];
    const removed = getMessages().find(message => message.id === id)!;
    product.removeMessages([id]);
    return [removed];
  }
  return messages.splice(index, 1);
}

export function replaceMessages(nextMessages: MessageWire[]): void {
  messages.length = 0;
  if (getBuiltinProductContent()) return;
  messages.push(...nextMessages);
}

export function clearMessages(): void {
  messages.length = 0;
}

export function truncateMessages(length: number): void {
  const product = getBuiltinProductContent();
  if (product) {
    product.removeMessages([...product.writer.projection.messages.keys()].slice(Math.max(0, length)));
    return;
  }
  messages.length = Math.max(0, length);
}

export function getTranscriptCursor(): TranscriptWriteCursor | null {
  return transcriptCursor;
}

export function setTranscriptCursor(cursor: TranscriptWriteCursor): void {
  transcriptCursor = cursor;
}

export function invalidateTranscriptCursor(): void {
  transcriptCursor = null;
}

export function getPersistChain(sessionId: string): Promise<void> | undefined {
  return persistChainBySession.get(sessionId);
}

export function setPersistChain(sessionId: string, chain: Promise<void>): void {
  persistChainBySession.set(sessionId, chain);
}

export function deletePersistChain(sessionId: string): void {
  persistChainBySession.delete(sessionId);
}

export function clearPersistChains(): void {
  persistChainBySession.clear();
}

export function getCurrentSessionUuids(): Set<string> {
  return currentSessionUuids;
}

export function getLiveSessionUuids(): Set<string> {
  return liveSessionUuids;
}

export function clearCurrentSessionUuids(): void {
  currentSessionUuids.clear();
}

export function clearLiveSessionUuids(): void {
  liveSessionUuids.clear();
}

export function addCurrentSessionUuid(uuid: string | undefined): void {
  if (uuid) currentSessionUuids.add(uuid);
}

export function addLiveSessionUuid(uuid: string | undefined): void {
  if (uuid) liveSessionUuids.add(uuid);
}

export function deleteCurrentSessionUuid(uuid: string | undefined): void {
  if (uuid) currentSessionUuids.delete(uuid);
}

export function deleteLiveSessionUuid(uuid: string | undefined): void {
  if (uuid) liveSessionUuids.delete(uuid);
}

export function setPendingReloadAnchor(anchor: string | undefined): void {
  pendingReloadAnchor = anchor;
}

export function getPendingReloadAnchor(): string | undefined {
  return pendingReloadAnchor;
}

export function clearTranscriptState(): void {
  productContent = undefined;
  messages.length = 0;
  messageSequence = 0;
  transcriptCursor = null;
  currentSessionUuids.clear();
  liveSessionUuids.clear();
  pendingReloadAnchor = undefined;
}

export function snapshotTranscript() {
  return {
    messages: [...messages],
    messageSequence,
    transcriptCursor,
    currentSessionUuids: new Set(currentSessionUuids),
    liveSessionUuids: new Set(liveSessionUuids),
    pendingReloadAnchor,
    persistChainSessionIds: [...persistChainBySession.keys()],
  };
}

export function resetTranscriptForTest(): void {
  clearTranscriptState();
  persistChainBySession.clear();
}

/** Attach execution context to the exact admitted user row without replaying
 * admission or changing Session/turn identity. */
export function confirmBuiltinUserContent(messageId: string, content: string): void {
  const product = getBuiltinProductContent();
  if (product) {
    if (product.writer.projection.messages.get(messageId)?.role !== 'user') throw new Error('User message missing at channel admission');
    product.writer.observe({ kind: 'content-confirm', messageId, content });
    product.writer.requestCommit();
  } else {
    const message = messages.find(message => message.id === messageId && message.role === 'user');
    if (!message) throw new Error('User message missing at channel admission');
    message.content = content;
  }
}
