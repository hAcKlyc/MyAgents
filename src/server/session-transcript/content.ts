import type { ExecutionTiming } from '../../shared/executionTiming';
import { randomUUID } from 'node:crypto';
import { buildFilePatchDisplayDescriptor, type FilePatchToolLike } from '../../shared/toolDisplay/filePatch';
import {
  fromStoredTranscriptMessage,
  getTranscriptText,
  type TranscriptBlock,
  type TranscriptMessage,
  type TranscriptMessageDetails,
  type TranscriptObject,
  type TranscriptTextTarget,
  type TranscriptTurn,
} from '../../shared/sessionTranscript';
import type { SessionMessage } from '../types/session';
import type { TranscriptWriter } from './writer';
import { appendTextParts, transcriptMessageOperations } from './operations';

export type ProductBlockTarget = { messageId: string; blockId: string; subagentToolId?: string };

/** Product content identities, owned by the adapter which receives native events.
 * All content lives in the SessionStore projection. These maps hold only IDs;
 * an asynchronous result captures this instance and its original target.
 */
export class ProductTranscriptContent {
  private assistantId: string | null = null;
  private turnId: string | null = null;
  private readonly blocks = new Map<string, ProductBlockTarget>();
  private readonly tools = new Map<string, ProductBlockTarget>();
  private readonly pendingAttachments = new Map<string, Map<string, TranscriptObject>>();

  constructor(readonly writer: TranscriptWriter) {
    writer.subscribeOperations(operation => {
      if (operation.kind === 'messages-remove') this.forgetMessages(operation.messageIds);
    });
    for (const message of writer.projection.messages.values()) {
      if (typeof message.content === 'string') continue;
      for (const block of message.content) {
        const tool = record(block.tool);
        if (typeof tool?.id !== 'string') continue;
        const target = { messageId: message.id, blockId: block.id };
        this.tools.set(tool.id, target);
        if (Array.isArray(tool.subagentCalls)) {
          for (const entry of tool.subagentCalls) {
            const call = record(entry);
            if (typeof call?.id === 'string') this.tools.set(call.id, { ...target, subagentToolId: call.id });
          }
        }
      }
    }
  }

  get currentTurn(): TranscriptTurn | undefined {
    return this.turnId ? this.writer.projection.turns.get(this.turnId) : undefined;
  }

  /** A completed/restored turn is not the start of current execution. */
  get executionStartedAt(): string | undefined {
    const turn = this.currentTurn;
    return turn?.status === 'running' ? turn.startedAt : undefined;
  }

  get currentAssistantId(): string | null { return this.assistantId; }

  admitUser(message: SessionMessage, turnId?: string): void {
    if (this.writer.projection.messages.has(message.id)) return;
    if (!this.currentTurn || this.currentTurn.status !== 'running' || (turnId && turnId !== this.turnId)) {
      this.turnId = turnId ?? message.id;
      this.writer.observe({ kind: 'turn-update', turn: {
        id: this.turnId, rootUserMessageId: message.id, startedAt: message.timestamp, status: 'running',
      } });
    }
    if (this.assistantId && this.writer.projection.messages.get(this.assistantId)?.transcriptState === 'streaming') this.writer.observe({ kind: 'message-update', messageId: this.assistantId, details: { transcriptState: 'complete' } });
    this.assistantId = null;
    this.blocks.clear();
    for (const operation of transcriptMessageOperations({
      ...fromStoredTranscriptMessage(message), turnId: this.turnId!, transcriptState: 'complete',
    })) this.writer.observe(operation);
    this.writer.requestCommit();
  }

  /** Native recovery and collaboration enter through the same presentation owner.
   * A collaboration turn has no invented Product user message. */
  adoptRuntimeTurn(runtimeTurnId: string, rootUserMessageId?: string): void {
    const user = rootUserMessageId ? this.writer.projection.messages.get(rootUserMessageId) : undefined;
    if (this.currentTurn?.status === 'running' && this.currentTurn.rootUserMessageId === rootUserMessageId) return;
    this.turnId = user?.turnId ?? rootUserMessageId ?? runtimeTurnId;
    this.assistantId = null;
    this.blocks.clear();
    this.writer.observe({ kind: 'turn-update', turn: {
      id: this.turnId, ...(rootUserMessageId ? { rootUserMessageId } : { origin: 'collaboration' as const }),
      startedAt: new Date().toISOString(), status: 'running',
    } });
  }

  assistant(preferredId?: string): TranscriptMessage {
    const existing = this.assistantId ? this.writer.projection.messages.get(this.assistantId) : undefined;
    if (existing) return existing;
    this.assistantId = preferredId ?? `assistant-${randomUUID()}`;
    const message: TranscriptMessage = {
      id: this.assistantId, role: 'assistant', content: [], timestamp: new Date().toISOString(),
      ...(this.turnId ? { turnId: this.turnId } : {}), transcriptState: 'streaming',
    };
    this.writer.observe({ kind: 'message-create', message });
    return message;
  }

  /** Product-only output must not reuse or replace the current native assistant. */
  appendDiagnostic(text: string): void {
    for (const operation of transcriptMessageOperations({
      id: `diagnostic-${randomUUID()}`, role: 'assistant', content: text,
      timestamp: new Date().toISOString(), messageKind: 'diagnostic', transcriptState: 'complete',
      ...(this.turnId ? { turnId: this.turnId } : {}),
    })) this.writer.observe(operation);
  }

  block(key: string, type: string, details: TranscriptObject = {}): ProductBlockTarget {
    const prior = this.blocks.get(key);
    if (prior && this.readBlock(prior)) return prior;
    const message = this.assistant();
    const target = { messageId: message.id, blockId: randomUUID() };
    this.writer.observe({ kind: 'block-upsert', messageId: target.messageId,
      block: { ...((type === 'text' || type === 'thinking') ? { executionTiming: observedStart() } : {}), ...details, id: target.blockId, type } });
    this.blocks.set(key, target);
    return target;
  }

  readBlock(target: ProductBlockTarget): TranscriptBlock | undefined {
    const content = this.writer.projection.messages.get(target.messageId)?.content;
    return Array.isArray(content) ? content.find(block => block.id === target.blockId) : undefined;
  }

  readTool(target: ProductBlockTarget): TranscriptObject | undefined {
    const tool = record(this.readBlock(target)?.tool);
    if (!target.subagentToolId) return tool;
    return Array.isArray(tool?.subagentCalls)
      ? tool.subagentCalls.map(record).find(call => call?.id === target.subagentToolId) : undefined;
  }

  updateBlock(target: ProductBlockTarget, details: TranscriptObject, boundary = false): void {
    const block = this.readBlock(target);
    if (!block) return;
    if ((block.type === 'text' || block.type === 'thinking') && details.isComplete === true && !block.isComplete) {
      details = withActivityTiming(block, details, true);
    }
    this.writer.observe({ kind: 'block-update', ...target, target: 'block', details }, boundary);
  }

  updateTool(target: ProductBlockTarget, details: TranscriptObject, boundary = false): void {
    const tool = this.readTool(target);
    if (!tool) return;
    if (details.isLoading === false && tool.isLoading !== false) details = withActivityTiming(tool, details, true);
    if (details.inputComplete === true || details.isLoading === false) {
      const display = buildFilePatchDisplayDescriptor({ ...tool, ...details } as FilePatchToolLike);
      if (display) details = { ...details, display: display as unknown as TranscriptObject };
    }
    this.writer.observe({ kind: 'block-update', ...target, target: 'tool', details }, boundary);
  }

  append(target: ProductBlockTarget, field: TranscriptTextTarget['field'], text: string): void {
    if (!text || !this.readBlock(target)) return;
    const operationTarget = { ...target, field };
    const offset = getTranscriptText(this.writer.projection, operationTarget).length;
    for (const operation of appendTextParts(operationTarget, text, offset)) this.writer.observe(operation);
    const owner = field === 'text' || field === 'thinking' ? this.readBlock(target) : this.readTool(target);
    if (owner?.executionTiming) {
      const details = withActivityTiming(owner, {}, false);
      if (!details.executionTiming) return;
      if (field === 'text' || field === 'thinking') this.updateBlock(target, details);
      else this.updateTool(target, details);
    }
  }

  confirmText(target: ProductBlockTarget, field: TranscriptTextTarget['field'], text: string): void {
    if (!this.readBlock(target)) return;
    const previous = getTranscriptText(this.writer.projection, { ...target, field });
    if (text === previous) return;
    if (text.startsWith(previous)) this.append(target, field, text.slice(previous.length));
    else {
      if (field === 'text' || field === 'thinking') this.updateBlock(target, { [field]: '' });
      else this.updateTool(target, { [field]: '' });
      this.append(target, field, text);
    }
  }

  tool(toolId: string): ProductBlockTarget | undefined {
    const target = this.tools.get(toolId);
    return target && this.readTool(target) ? target : undefined;
  }

  startTool(toolId: string, name: string, details: TranscriptObject = {}, parentToolId?: string, type = 'tool_use'): ProductBlockTarget | undefined {
    const prior = this.tool(toolId);
    if (prior) return prior;
    if (parentToolId) {
      const parent = this.tool(parentToolId);
      if (!parent || parent.subagentToolId) return undefined;
      const target = { ...parent, subagentToolId: toolId };
      this.writer.observe({ kind: 'subagent-upsert', messageId: parent.messageId, blockId: parent.blockId,
        call: { executionTiming: observedStart(), ...details, id: toolId, name, input: {}, inputJson: '', isLoading: true } });
      this.tools.set(toolId, target);
      return target;
    }
    const target = this.block(`tool:${toolId}`, type, {
      tool: { executionTiming: observedStart(), ...details, id: toolId, name, input: {}, inputJson: '', isLoading: true },
    });
    this.tools.set(toolId, target);
    return target;
  }

  confirmInput(target: ProductBlockTarget, input: TranscriptObject): void {
    // The complete JSON and incomplete streamed JSON share one field. The
    // renderer/legacy wire projection derives parsed input from it on reads.
    this.confirmText(target, 'inputJson', JSON.stringify(input));
    this.updateTool(target, { inputComplete: true }, true);
  }

  confirmAttachments(target: ProductBlockTarget, attachments: TranscriptObject[]): TranscriptObject[] {
    const key = attachmentKey(target);
    const pending = this.pendingAttachments.get(key);
    const merged = attachments.map(attachment => typeof attachment.pendingId === 'string'
      ? pending?.get(attachment.pendingId) ?? attachment : attachment);
    this.pendingAttachments.delete(key);
    this.updateTool(target, { attachments: merged });
    return merged;
  }

  updateAttachment(target: ProductBlockTarget, pendingId: string, attachment: TranscriptObject): boolean {
    const tool = this.readTool(target);
    if (!tool) return false;
    if (Array.isArray(tool.attachments)) {
      if (tool.attachments.some(item => record(item)?.pendingId === pendingId)) {
        this.updateTool(target, { attachments: tool.attachments.map(item =>
          record(item)?.pendingId === pendingId ? attachment : item) });
        return true;
      }
      return false;
    }
    // Completion may precede the result that introduces its placeholder. This
    // is pending job metadata, discarded when that original result arrives.
    const key = attachmentKey(target);
    let pending = this.pendingAttachments.get(key);
    if (!pending) { pending = new Map(); this.pendingAttachments.set(key, pending); }
    pending.set(pendingId, structuredClone(attachment));
    return false;
  }

  finishTurn(status: Exclude<TranscriptTurn['status'], 'running'>, details: Partial<TranscriptMessageDetails> = {}): string | null {
    const turn = this.currentTurn;
    if (!turn) return this.assistantId;
    if (turn.status !== 'running') return this.assistantId;
    const messageId = this.assistantId;
    const message = messageId ? this.writer.projection.messages.get(messageId) : undefined;
    if (message && Array.isArray(message.content)) for (const block of message.content) {
      if ((block.type === 'text' || block.type === 'thinking') && !block.isComplete) {
        this.updateBlock({ messageId: message.id, blockId: block.id }, { isComplete: true,
          ...(block.type === 'thinking' && typeof block.thinkingStartedAt === 'number'
            ? { thinkingDurationMs: Math.max(0, Date.now() - block.thinkingStartedAt) } : {}),
        });
      }
    }
    if (messageId) this.writer.observe({ kind: 'message-update', messageId,
      details: { ...details, transcriptState: status === 'complete' ? 'complete' : 'interrupted' } });
    this.writer.observe({ kind: 'turn-update', turn: {
      ...turn, status, ...(details.usage ? { usage: details.usage } : {}),
      ...(details.durationMs !== undefined ? { durationMs: details.durationMs } : {}),
    } }, true);
    return messageId;
  }

  removeMessages(messageIds: string[]): void {
    if (messageIds.length) this.writer.observe({ kind: 'messages-remove', messageIds }, true);
  }

  private forgetMessages(messageIds: string[]): void {
    if (this.turnId && !this.writer.projection.turns.has(this.turnId)) this.turnId = null;
    if (this.assistantId && messageIds.includes(this.assistantId)) this.assistantId = null;
    for (const [key, target] of this.blocks) if (messageIds.includes(target.messageId)) this.blocks.delete(key);
    for (const [key, target] of this.tools) if (messageIds.includes(target.messageId)) this.tools.delete(key);
    for (const key of this.pendingAttachments.keys()) if (messageIds.some(id => key.startsWith(`${id}/`))) this.pendingAttachments.delete(key);
  }

  removeSubagents(messageId: string, blockId: string, toolIds: string[]): void {
    this.writer.observe({ kind: 'subagents-remove', messageId, blockId, toolIds }, true);
    for (const id of toolIds) {
      const target = this.tools.get(id);
      if (target) this.pendingAttachments.delete(attachmentKey(target));
      this.tools.delete(id);
    }
  }

  removeBlocks(messageId: string, blockIds: string[]): void {
    this.writer.observe({ kind: 'blocks-remove', messageId, blockIds }, true);
    const removed = new Set(blockIds);
    for (const [key, target] of this.blocks) if (target.messageId === messageId && removed.has(target.blockId)) this.blocks.delete(key);
    for (const [key, target] of this.tools) if (target.messageId === messageId && removed.has(target.blockId)) this.tools.delete(key);
    for (const key of this.pendingAttachments.keys()) if (blockIds.some(id => key.startsWith(`${messageId}/${id}/`))) this.pendingAttachments.delete(key);
  }
}

function attachmentKey(target: ProductBlockTarget): string {
  return `${target.messageId}/${target.blockId}/${target.subagentToolId ?? ''}`;
}

function record(value: unknown): TranscriptObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as TranscriptObject : undefined;
}

/** Called only while consuming execution events. Cold restore folds persisted
 * operations directly and deliberately does not acquire a new clock value. */
function observedStart(): ExecutionTiming {
  const now = Date.now();
  return { startedAt: now, lastActivityAt: now, source: 'observed' };
}

function withActivityTiming(owner: TranscriptObject, details: TranscriptObject, terminal: boolean): TranscriptObject {
  const timing = record(owner.executionTiming);
  // An old block receiving a late update still has no known start time.
  if (!timing || typeof timing.startedAt !== 'number' || !Number.isFinite(timing.startedAt)) return details;
  if (typeof timing.finishedAt === 'number') return details;
  const previous = typeof timing.lastActivityAt === 'number' ? timing.lastActivityAt : timing.startedAt;
  const now = Math.max(timing.startedAt, previous, Date.now());
  // Persist an actual event observation at most once per epoch second. This
  // keeps intermediate activity within <1s of the last event and lets adjacent
  // text appends continue using the writer's existing queue coalescing. Start
  // and terminal observations always retain their exact millisecond values.
  if (!terminal && Math.floor(now / 1_000) <= Math.floor(previous / 1_000)) return details;
  return { ...details, executionTiming: { ...timing, lastActivityAt: now, ...(terminal ? { finishedAt: now } : {}) } };
}
