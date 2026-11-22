import type { AsyncQuestionSet } from '../../../shared/asyncUserQuestions';
import { buildFilePatchDisplayDescriptor } from '../../../shared/toolDisplay/filePatch';
import type { ToolAttachment } from '../../../shared/types/tool-attachment';
import {
  finalizeResidualSubagentCall,
  mergeSubagentLifecycleUpdate,
  type SubagentLifecycle,
  type SubagentLifecycleStatus,
} from '../../../shared/types/subagent-lifecycle';
import type { ExternalAssistantSnapshotState, PersistContentBlock, PersistSubagentCall } from './types';

let currentAssistantText = '';
let currentContentBlocks: PersistContentBlock[] = [];
let pendingTextBuffer = '';
let pendingThinkingText = '';
let pendingThinkingIndex = 0;
let pendingThinkingActive = false;
let pendingThinkingStartedAt = 0;

const pendingToolInputs = new Map<string, { name: string; inputJson: string }>();
const childToolToParent = new Map<string, string>();
const pendingSubagentCallsByParent = new Map<string, PersistSubagentCall[]>();
const pendingSubagentLifecyclesByParent = new Map<string, SubagentLifecycle>();
const subagentAttachmentParents = new Map<string, string>();
const pendingSubagentAttachmentUpdates = new Map<string, Array<{
  pendingId: string;
  attachment: ToolAttachment;
}>>();
const pendingTopLevelAttachmentUpdates = new Map<string, Array<{
  pendingId: string;
  attachment: ToolAttachment;
}>>();
const subagentTraceBuffers = new Map<string, string>();

export function resetExternalContentState(): void {
  currentAssistantText = '';
  currentContentBlocks = [];
  pendingTextBuffer = '';
  pendingThinkingText = '';
  pendingThinkingIndex = 0;
  pendingThinkingActive = false;
  pendingThinkingStartedAt = 0;
  pendingToolInputs.clear();
  childToolToParent.clear();
  pendingSubagentCallsByParent.clear();
  pendingSubagentLifecyclesByParent.clear();
  subagentAttachmentParents.clear();
  pendingSubagentAttachmentUpdates.clear();
  pendingTopLevelAttachmentUpdates.clear();
  subagentTraceBuffers.clear();
}

export function getExternalAssistantText(): string {
  return currentAssistantText;
}

export function appendExternalAssistantText(text: string): void {
  currentAssistantText += text;
}

export function getExternalContentBlocksRef(): PersistContentBlock[] {
  return currentContentBlocks;
}

export function pushExternalContentBlock(block: PersistContentBlock): void {
  currentContentBlocks.push(block);
}

export function getExternalContentBlockCount(): number {
  return currentContentBlocks.length;
}

export function getExternalContentBlockText(): string {
  return currentContentBlocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n\n')
    .trim();
}

export function isExternalCurrentContentBlocksRef(blocks: PersistContentBlock[]): boolean {
  return currentContentBlocks === blocks;
}

export function getExternalPendingTextBuffer(): string {
  return pendingTextBuffer;
}

export function appendExternalPendingText(text: string): void {
  pendingTextBuffer += text;
}

export function clearExternalPendingText(): void {
  pendingTextBuffer = '';
}

export function getExternalPendingThinkingText(): string {
  return pendingThinkingText;
}

export function appendExternalPendingThinkingText(text: string): void {
  pendingThinkingText += text;
}

export function resetExternalPendingThinking(input?: {
  index?: number;
  active?: boolean;
  startedAt?: number;
}): void {
  pendingThinkingText = '';
  pendingThinkingIndex = input?.index ?? 0;
  pendingThinkingActive = input?.active ?? false;
  pendingThinkingStartedAt = input?.startedAt ?? 0;
}

export function activateExternalPendingThinking(index: number, startedAt = Date.now()): void {
  pendingThinkingActive = true;
  pendingThinkingIndex = index;
  pendingThinkingStartedAt = startedAt;
}

export function isExternalPendingThinkingActive(): boolean {
  return pendingThinkingActive;
}

export function getExternalPendingThinkingIndex(): number {
  return pendingThinkingIndex;
}

export function getExternalPendingThinkingStartedAt(): number {
  return pendingThinkingStartedAt;
}

export function getExternalPendingToolInputs(): Map<string, { name: string; inputJson: string }> {
  return pendingToolInputs;
}

export function getExternalChildToolToParent(): Map<string, string> {
  return childToolToParent;
}

export function getExternalPendingSubagentCallsByParent(): Map<string, PersistSubagentCall[]> {
  return pendingSubagentCallsByParent;
}

export function getExternalPendingSubagentLifecyclesByParent(): Map<string, SubagentLifecycle> {
  return pendingSubagentLifecyclesByParent;
}

export function getExternalSubagentAttachmentParents(): Map<string, string> {
  return subagentAttachmentParents;
}

export function getExternalSubagentTraceBuffers(): Map<string, string> {
  return subagentTraceBuffers;
}

export function findExternalToolBlockById(toolUseId: string): PersistContentBlock | null {
  for (let i = currentContentBlocks.length - 1; i >= 0; i -= 1) {
    const block = currentContentBlocks[i];
    if (block.type === 'tool_use' && block.tool?.id === toolUseId) return block;
  }
  return null;
}

function mergeSubagentCall(
  calls: PersistSubagentCall[],
  call: { id: string; name: string; input: Record<string, unknown>; inputJson?: string },
): PersistSubagentCall {
  const existing = calls.find((candidate) => candidate.id === call.id);
  if (existing) {
    existing.name = call.name;
    existing.input = call.input;
    existing.inputJson = call.inputJson;
    return existing;
  }
  const created: PersistSubagentCall = { ...call, isLoading: true };
  calls.push(created);
  return created;
}

export function attachExternalPendingSubagentCalls(
  parentToolUseId: string,
  parentTool: NonNullable<PersistContentBlock['tool']>,
): void {
  const pending = pendingSubagentCallsByParent.get(parentToolUseId);
  if (!pending || pending.length === 0) return;
  if (!parentTool.subagentCalls) parentTool.subagentCalls = [];
  for (const call of pending) {
    const existing = parentTool.subagentCalls.find((candidate) => candidate.id === call.id);
    if (existing) Object.assign(existing, call);
    else parentTool.subagentCalls.push(call);
  }
  pendingSubagentCallsByParent.delete(parentToolUseId);
}

export function mergeSubagentLifecycle(
  current: SubagentLifecycle | undefined,
  status: SubagentLifecycleStatus,
  observedAt: number,
  details: Partial<Omit<SubagentLifecycle, 'status' | 'finishedAt'>> = {},
): SubagentLifecycle {
  const safeObservedAt = Number.isFinite(observedAt) && observedAt > 0 ? observedAt : Date.now();
  const sameActivation = current?.activation?.id === details.activation?.id;
  const startedAt = details.startedAt ?? (sameActivation ? current?.startedAt : undefined) ?? safeObservedAt;
  return mergeSubagentLifecycleUpdate(current, {
    ...(sameActivation ? current : {}),
    ...details,
    status,
    startedAt,
    ...(status === 'running' ? { finishedAt: undefined } : { finishedAt: Math.max(startedAt, safeObservedAt) }),
  });
}

export function attachExternalPendingSubagentLifecycle(
  parentToolUseId: string,
  parentTool: NonNullable<PersistContentBlock['tool']>,
): void {
  const pending = pendingSubagentLifecyclesByParent.get(parentToolUseId);
  if (!pending) return;
  parentTool.subagentLifecycle = parentTool.subagentLifecycle
    ? mergeSubagentLifecycle(
        parentTool.subagentLifecycle,
        pending.status,
        pending.status === 'running' ? pending.startedAt : pending.finishedAt ?? pending.startedAt,
        pending,
      )
    : { ...pending };
  // Lifecycle is a separate projection. Only tool_result owns the original
  // call's result, error and loading state, including an early lifecycle event.
  pendingSubagentLifecyclesByParent.delete(parentToolUseId);
}

type ExternalSubagentLifecycleUpdate = {
  handleRevision?: number;
  agentId?: string;
  taskId?: string;
  tree?: SubagentLifecycle['tree'];
  modelRoute?: SubagentLifecycle['modelRoute'];
  lastActivityAt?: number;
  activation?: SubagentLifecycle['activation'];
  handleState?: SubagentLifecycle['handleState'];
  startedAt?: number;
  parentToolUseId: string;
  status: SubagentLifecycleStatus;
  observedAt: number;
  agentType?: string;
  description?: string;
  mode?: 'foreground' | 'continuable';
  model?: string;
  result?: string;
  resultTruncated?: boolean;
  usage?: SubagentLifecycle['usage'];
};

export function getExternalSubagentLifecycleDetails(input: ExternalSubagentLifecycleUpdate) {
  return {
    ...(input.handleRevision === undefined ? {} : { handleRevision: input.handleRevision }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.tree === undefined ? {} : { tree: input.tree }),
    ...(input.modelRoute === undefined ? {} : { modelRoute: input.modelRoute }),
    ...(input.lastActivityAt === undefined ? {} : { lastActivityAt: input.lastActivityAt }),
    ...(input.activation === undefined ? {} : { activation: input.activation }),
    ...(input.handleState === undefined ? {} : { handleState: input.handleState }),
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    ...(input.agentType === undefined ? {} : { agentType: input.agentType }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.resultTruncated === undefined ? {} : { resultTruncated: input.resultTruncated }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  };
}

export function applyExternalSubagentLifecycle(input: ExternalSubagentLifecycleUpdate): SubagentLifecycle {
  const details = getExternalSubagentLifecycleDetails(input);
  const parent = findExternalToolBlockById(input.parentToolUseId);
  if (parent?.tool) {
    attachExternalPendingSubagentLifecycle(input.parentToolUseId, parent.tool);
    parent.tool.subagentLifecycle = mergeSubagentLifecycle(
      parent.tool.subagentLifecycle,
      input.status,
      input.observedAt,
      details,
    );
    return parent.tool.subagentLifecycle;
  }

  const merged = mergeSubagentLifecycle(
    pendingSubagentLifecyclesByParent.get(input.parentToolUseId),
    input.status,
    input.observedAt,
    details,
  );
  pendingSubagentLifecyclesByParent.set(input.parentToolUseId, merged);
  return merged;
}

export function finalizeExternalSubagentLifecyclesForTurn(input: {
  status: 'failed' | 'interrupted';
  observedAt: number;
}): Array<{ parentToolUseId: string; lifecycle: SubagentLifecycle }> {
  const updates: Array<{ parentToolUseId: string; lifecycle: SubagentLifecycle }> = [];
  for (const block of currentContentBlocks) {
    const tool = block.tool;
    if (block.type !== 'tool_use' || !tool?.subagentLifecycle) continue;
    if (tool.subagentLifecycle.activation && tool.subagentLifecycle.handleState !== 'closed') continue;
    if (tool.subagentLifecycle.status === 'running') {
      tool.subagentLifecycle = mergeSubagentLifecycle(
        tool.subagentLifecycle,
        input.status,
        input.observedAt,
      );
      updates.push({ parentToolUseId: tool.id, lifecycle: tool.subagentLifecycle });
    }
    if (tool.subagentCalls) {
      tool.subagentCalls = tool.subagentCalls.map(call => (
        finalizeResidualSubagentCall(call, input.status)
      ));
    }
  }
  for (const [parentToolUseId, calls] of pendingSubagentCallsByParent) {
    const lifecycle = pendingSubagentLifecyclesByParent.get(parentToolUseId);
    if (lifecycle?.activation && lifecycle.handleState !== 'closed') continue;
    pendingSubagentCallsByParent.set(
      parentToolUseId,
      calls.map(call => finalizeResidualSubagentCall(call, input.status)),
    );
  }
  for (const [parentToolUseId, lifecycle] of pendingSubagentLifecyclesByParent) {
    if (lifecycle.activation && lifecycle.handleState !== 'closed') continue;
    if (lifecycle.status !== 'running') continue;
    const terminal = mergeSubagentLifecycle(lifecycle, input.status, input.observedAt);
    pendingSubagentLifecyclesByParent.set(parentToolUseId, terminal);
    updates.push({ parentToolUseId, lifecycle: terminal });
  }
  return updates;
}

export function findExternalSubagentCall(
  parentToolUseId: string,
  toolUseId: string,
): PersistSubagentCall | null {
  const parent = findExternalToolBlockById(parentToolUseId);
  const persisted = parent?.tool?.subagentCalls?.find((candidate) => candidate.id === toolUseId);
  if (persisted) return persisted;
  return pendingSubagentCallsByParent.get(parentToolUseId)?.find((candidate) => candidate.id === toolUseId) ?? null;
}

export function upsertExternalSubagentCall(
  parentToolUseId: string,
  call: { id: string; name: string; input: Record<string, unknown>; inputJson?: string },
): PersistSubagentCall {
  const parent = findExternalToolBlockById(parentToolUseId);
  if (parent?.tool) {
    attachExternalPendingSubagentCalls(parentToolUseId, parent.tool);
    if (!parent.tool.subagentCalls) parent.tool.subagentCalls = [];
    return mergeSubagentCall(parent.tool.subagentCalls, call);
  }

  let pending = pendingSubagentCallsByParent.get(parentToolUseId);
  if (!pending) {
    pending = [];
    pendingSubagentCallsByParent.set(parentToolUseId, pending);
  }
  return mergeSubagentCall(pending, call);
}

export function startExternalSubagentToolUse(input: {
  parentToolUseId: string;
  toolUseId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
}): void {
  const hasInput = input.toolInput && Object.keys(input.toolInput).length > 0;
  const inputJson = hasInput ? JSON.stringify(input.toolInput, null, 2) : '';
  upsertExternalSubagentCall(input.parentToolUseId, {
    id: input.toolUseId,
    name: input.toolName,
    input: input.toolInput ?? {},
    inputJson,
  });
  childToolToParent.set(input.toolUseId, input.parentToolUseId);
  pendingToolInputs.set(input.toolUseId, { name: input.toolName, inputJson });
}

export function hasExternalChildToolParent(toolUseId: string): boolean {
  return childToolToParent.has(toolUseId);
}

export function getExternalChildToolParent(toolUseId: string): string | undefined {
  return childToolToParent.get(toolUseId);
}

export function startExternalSubagentTraceTool(input: {
  parentToolUseId: string;
  toolUseId: string;
  toolName: string;
}): boolean {
  if (childToolToParent.has(input.toolUseId)) return false;
  startExternalSubagentToolUse({
    parentToolUseId: input.parentToolUseId,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
  });
  subagentTraceBuffers.set(input.toolUseId, '');
  return true;
}

export function appendExternalSubagentTraceDelta(input: {
  parentToolUseId: string;
  toolUseId: string;
  delta: string;
}): void {
  subagentTraceBuffers.set(input.toolUseId, (subagentTraceBuffers.get(input.toolUseId) ?? '') + input.delta);
  const call = findExternalSubagentCall(input.parentToolUseId, input.toolUseId);
  if (call) {
    call.result = (call.result ?? '') + input.delta;
    call.isLoading = true;
  }
}

export function completeExternalSubagentTrace(input: {
  parentToolUseId: string;
  toolUseId: string;
}): { latchedParentToolUseId: string; content: string } | null {
  const latchedParentToolUseId = childToolToParent.get(input.toolUseId);
  if (!latchedParentToolUseId) return null;
  const content = subagentTraceBuffers.get(input.toolUseId)
    ?? findExternalSubagentCall(input.parentToolUseId, input.toolUseId)?.result
    ?? '';
  pendingToolInputs.delete(input.toolUseId);
  subagentTraceBuffers.delete(input.toolUseId);
  return { latchedParentToolUseId, content };
}

export function startExternalToolUseInput(input: {
  toolUseId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
}): void {
  pendingToolInputs.set(input.toolUseId, {
    name: input.toolName,
    inputJson: input.toolInput ? JSON.stringify(input.toolInput, null, 2) : '',
  });
}

export function startExternalProviderToolUse(input: {
  toolUseId: string;
  toolName: string;
  providerRouteId: string;
  providerBlockType: string;
  toolInput: Record<string, unknown>;
}): void {
  const inputJson = JSON.stringify(input.toolInput, null, 2);
  currentContentBlocks.push({
    type: 'server_tool_use',
    providerRouteId: input.providerRouteId,
    providerBlockType: input.providerBlockType,
    tool: {
      id: input.toolUseId,
      name: input.toolName,
      input: input.toolInput,
      inputJson,
      streamIndex: currentContentBlocks.length,
      isLoading: true,
    },
  });
}

export function applyExternalProviderToolResult(input: {
  toolUseId: string;
  providerRouteId: string;
  providerBlockType: string;
  content: string;
  isError: boolean;
  attachments?: ToolAttachment[];
}): boolean {
  for (let index = currentContentBlocks.length - 1; index >= 0; index -= 1) {
    const block = currentContentBlocks[index];
    if (block.type !== 'server_tool_use'
      || block.tool?.id !== input.toolUseId
      || block.providerRouteId !== input.providerRouteId) continue;
    block.resultProviderBlockType = input.providerBlockType;
    block.tool.result = input.content;
    block.tool.isError = input.isError;
    block.tool.isLoading = false;
    if (input.attachments) block.tool.attachments = input.attachments;
    return true;
  }
  return false;
}

export function finalizeExternalProviderToolsForTurn(): void {
  for (const block of currentContentBlocks) {
    if (block.type === 'server_tool_use' && block.tool?.isLoading) {
      block.tool.isLoading = false;
    }
  }
}

export function appendExternalToolInputDelta(
  toolUseId: string,
  delta: string,
): { parentToolUseId?: string; found: boolean } {
  const parentToolUseId = childToolToParent.get(toolUseId);
  const entry = pendingToolInputs.get(toolUseId);
  if (entry) {
    entry.inputJson += delta;
  }
  return { parentToolUseId, found: !!entry };
}

export function replaceExternalToolUseInput(
  toolUseId: string,
  input: Record<string, unknown>,
): string | null {
  const entry = pendingToolInputs.get(toolUseId);
  if (!entry) return null;
  entry.inputJson = JSON.stringify(input, null, 2);

  const parentToolUseId = childToolToParent.get(toolUseId);
  if (parentToolUseId) {
    const call = findExternalSubagentCall(parentToolUseId, toolUseId);
    if (call) {
      call.input = input;
      call.inputJson = entry.inputJson;
    }
  }
  return entry.name;
}

export function finalizeExternalSubagentToolInput(parentToolUseId: string, toolUseId: string): boolean {
  const entry = pendingToolInputs.get(toolUseId);
  if (!entry) return false;
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(entry.inputJson); } catch { /* keep empty */ }
  const call = findExternalSubagentCall(parentToolUseId, toolUseId);
  if (call) {
    call.input = parsed;
    call.inputJson = entry.inputJson;
  }
  pendingToolInputs.delete(toolUseId);
  return true;
}

export function finalizeExternalToolUseInput(toolUseId: string): boolean {
  const entry = pendingToolInputs.get(toolUseId);
  if (!entry) return false;
  let parsedInput: Record<string, unknown> = {};
  try { parsedInput = JSON.parse(entry.inputJson); } catch { /* keep empty */ }
  const block: PersistContentBlock = {
    type: 'tool_use',
    tool: {
      id: toolUseId,
      name: entry.name,
      input: parsedInput,
      inputJson: entry.inputJson,
      streamIndex: currentContentBlocks.length,
    },
  };
  if (block.tool) {
    const display = buildFilePatchDisplayDescriptor(block.tool);
    if (display) block.tool.display = display;
    attachExternalPendingSubagentCalls(toolUseId, block.tool);
    attachExternalPendingSubagentLifecycle(toolUseId, block.tool);
  }
  currentContentBlocks.push(block);
  pendingToolInputs.delete(toolUseId);
  return true;
}

export function applyExternalSubagentToolResult(input: {
  parentToolUseId: string;
  toolUseId: string;
  content: string;
  isError?: boolean;
  metadata?: NonNullable<PersistContentBlock['tool']>['resultMeta'];
  attachments?: ToolAttachment[];
}): void {
  const call = findExternalSubagentCall(input.parentToolUseId, input.toolUseId);
  const hasAttachments = !!(input.attachments && input.attachments.length > 0);
  if (call) {
    call.result = input.content;
    call.isError = input.isError ?? false;
    call.isLoading = false;
    if (input.metadata !== undefined) call.resultMeta = input.metadata;
    if (hasAttachments) {
      const attachments = input.attachments!;
      call.attachments = attachments;
      const pending = pendingSubagentAttachmentUpdates.get(input.toolUseId);
      if (pending) {
        for (const update of pending) {
          const idx = attachments.findIndex((attachment) => attachment.pendingId === update.pendingId);
          if (idx >= 0) attachments[idx] = update.attachment;
        }
        pendingSubagentAttachmentUpdates.delete(input.toolUseId);
      }
    } else {
      pendingSubagentAttachmentUpdates.delete(input.toolUseId);
    }
  }
  if (hasAttachments) subagentAttachmentParents.set(input.toolUseId, input.parentToolUseId);
  childToolToParent.delete(input.toolUseId);
}

export function applyExternalToolResultToContent(input: {
  toolUseId: string;
  content: string;
  isError?: boolean;
  metadata?: NonNullable<PersistContentBlock['tool']>['resultMeta'];
  attachments?: ToolAttachment[];
}): boolean {
  for (let i = currentContentBlocks.length - 1; i >= 0; i -= 1) {
    const block = currentContentBlocks[i];
    if (block.type === 'tool_use' && block.tool?.id === input.toolUseId) {
      block.tool.result = input.content;
      block.tool.isError = input.isError ?? false;
      block.tool.resultMeta = input.metadata;
      if (input.attachments && input.attachments.length > 0) {
        const attachments = input.attachments;
        block.tool.attachments = attachments;
        const pending = pendingTopLevelAttachmentUpdates.get(input.toolUseId);
        if (pending) {
          for (const update of pending) {
            const idx = attachments.findIndex((attachment) => attachment.pendingId === update.pendingId);
            if (idx >= 0) attachments[idx] = update.attachment;
          }
          pendingTopLevelAttachmentUpdates.delete(input.toolUseId);
        }
      } else {
        pendingTopLevelAttachmentUpdates.delete(input.toolUseId);
      }
      const display = buildFilePatchDisplayDescriptor(block.tool);
      if (display) block.tool.display = display;
      return true;
    }
  }
  return false;
}

export function appendExternalToolResultDeltaToContent(toolUseId: string, delta: string): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (parentToolUseId) {
    const call = findExternalSubagentCall(parentToolUseId, toolUseId);
    if (!call) return false;
    call.result = `${call.result ?? ''}${delta}`;
    call.isLoading = true;
    return true;
  }
  const block = findExternalToolBlockById(toolUseId);
  if (!block?.tool) return false;
  block.tool.result = `${block.tool.result ?? ''}${delta}`;
  return true;
}

export function replaceExternalToolResultPreview(
  toolUseId: string,
  result: string,
  metadata?: NonNullable<PersistContentBlock['tool']>['resultMeta'],
): void {
  const parentToolUseId = childToolToParent.get(toolUseId);
  const tool = parentToolUseId
    ? findExternalSubagentCall(parentToolUseId, toolUseId)
    : findExternalToolBlockById(toolUseId)?.tool;
  if (!tool) return;
  tool.result = result;
  tool.isLoading = true;
  if (metadata) tool.resultMeta = metadata;
}

export function getExternalSubagentAttachmentParent(toolUseId: string): string | undefined {
  return subagentAttachmentParents.get(toolUseId) ?? childToolToParent.get(toolUseId);
}

export function applyExternalSubagentAttachmentUpdate(input: {
  parentToolUseId: string;
  toolUseId: string;
  pendingId: string;
  attachment: ToolAttachment;
}): 'applied' | 'deferred' | 'missing' {
  const call = findExternalSubagentCall(input.parentToolUseId, input.toolUseId);
  if (!call) return 'missing';
  if (!call.attachments) {
    let pending = pendingSubagentAttachmentUpdates.get(input.toolUseId);
    if (!pending) {
      pending = [];
      pendingSubagentAttachmentUpdates.set(input.toolUseId, pending);
    }
    const existing = pending.find((update) => update.pendingId === input.pendingId);
    if (existing) existing.attachment = input.attachment;
    else pending.push({ pendingId: input.pendingId, attachment: input.attachment });
    return 'deferred';
  }
  const idx = call.attachments.findIndex((attachment) => attachment.pendingId === input.pendingId);
  if (idx < 0) return 'missing';
  call.attachments[idx] = input.attachment;
  return 'applied';
}

export function applyExternalToolAttachmentUpdate(input: {
  toolUseId: string;
  pendingId: string;
  attachment: ToolAttachment;
}): 'applied' | 'deferred' | 'missing' {
  for (let i = currentContentBlocks.length - 1; i >= 0; i -= 1) {
    const block = currentContentBlocks[i];
    if (block.type === 'tool_use' && block.tool?.id === input.toolUseId) {
      if (!block.tool.attachments) {
        let pending = pendingTopLevelAttachmentUpdates.get(input.toolUseId);
        if (!pending) {
          pending = [];
          pendingTopLevelAttachmentUpdates.set(input.toolUseId, pending);
        }
        const existing = pending.find((update) => update.pendingId === input.pendingId);
        if (existing) existing.attachment = input.attachment;
        else pending.push({ pendingId: input.pendingId, attachment: input.attachment });
        return 'deferred';
      }
      const idx = block.tool.attachments.findIndex((attachment) => attachment.pendingId === input.pendingId);
      if (idx >= 0) {
        block.tool.attachments[idx] = input.attachment;
        return 'applied';
      }
      return 'missing';
    }
  }
  return 'missing';
}

export function applyExternalReplayedToolResultToContent(input: {
  toolUseId: string;
  content: string;
  isError: boolean;
}): boolean {
  const block = currentContentBlocks.find(
    (candidate) => candidate.type === 'tool_use' && candidate.tool?.id === input.toolUseId,
  );
  if (!block?.tool) return false;
  block.tool.result = input.content.slice(0, 5000);
  block.tool.isError = input.isError;
  const display = buildFilePatchDisplayDescriptor(block.tool);
  if (display) block.tool.display = display;
  return true;
}

export interface ExternalInterruptedSubagentToolResult {
  parentToolUseId: string;
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export function flushExternalPendingToolInputsForTurn(): ExternalInterruptedSubagentToolResult[] {
  const interruptedSubagentResults: ExternalInterruptedSubagentToolResult[] = [];
  for (const [toolId, entry] of Array.from(pendingToolInputs.entries())) {
    const subagentParent = childToolToParent.get(toolId);
    if (subagentParent) {
      finalizeExternalSubagentToolInput(subagentParent, toolId);
      const content = subagentTraceBuffers.get(toolId)
        ?? findExternalSubagentCall(subagentParent, toolId)?.result
        ?? 'Interrupted';
      subagentTraceBuffers.delete(toolId);
      applyExternalSubagentToolResult({
        parentToolUseId: subagentParent,
        toolUseId: toolId,
        content,
        isError: content === 'Interrupted' ? true : undefined,
      });
      interruptedSubagentResults.push({
        parentToolUseId: subagentParent,
        toolUseId: toolId,
        content,
        isError: content === 'Interrupted' ? true : undefined,
      });
      continue;
    }

    let parsedInput: Record<string, unknown> = {};
    try { parsedInput = JSON.parse(entry.inputJson); } catch { /* keep empty */ }
    const block: PersistContentBlock = {
      type: 'tool_use',
      tool: {
        id: toolId,
        name: entry.name,
        input: parsedInput,
        inputJson: entry.inputJson,
        streamIndex: currentContentBlocks.length,
      },
    };
    if (block.tool) {
      const display = buildFilePatchDisplayDescriptor(block.tool);
      if (display) block.tool.display = display;
      attachExternalPendingSubagentCalls(toolId, block.tool);
      attachExternalPendingSubagentLifecycle(toolId, block.tool);
    }
    currentContentBlocks.push(block);
    pendingToolInputs.delete(toolId);
  }
  return interruptedSubagentResults;
}

export function buildExternalPendingThinkingBlock(isComplete: boolean): PersistContentBlock | null {
  if (!pendingThinkingActive) return null;
  return {
    type: 'thinking',
    thinking: pendingThinkingText,
    thinkingStartedAt: pendingThinkingStartedAt || undefined,
    thinkingDurationMs: isComplete && pendingThinkingStartedAt
      ? Date.now() - pendingThinkingStartedAt
      : undefined,
    thinkingStreamIndex: pendingThinkingIndex,
    isComplete,
  };
}

export function flushExternalPendingTextBlock(asyncQuestions?: AsyncQuestionSet): boolean {
  if (!pendingTextBuffer && !asyncQuestions) return false;
  currentContentBlocks.push({ type: 'text', text: pendingTextBuffer, isComplete: true, ...(asyncQuestions ? { asyncQuestions } : {}) });
  pendingTextBuffer = '';
  return true;
}

export function flushExternalPendingThinkingBlock(forceComplete: boolean): boolean {
  const thinkingBlock = buildExternalPendingThinkingBlock(forceComplete);
  if (!thinkingBlock) return false;
  currentContentBlocks.push(thinkingBlock);
  resetExternalPendingThinking();
  return true;
}

function clonePersistContentBlock(block: PersistContentBlock): PersistContentBlock {
  return {
    ...block,
    tool: block.tool
      ? {
          ...block.tool,
          input: { ...block.tool.input },
          attachments: block.tool.attachments ? block.tool.attachments.map((attachment) => ({ ...attachment })) : undefined,
          subagentCalls: block.tool.subagentCalls ? block.tool.subagentCalls.map((call) => ({ ...call })) : undefined,
          subagentLifecycle: block.tool.subagentLifecycle ? { ...block.tool.subagentLifecycle } : undefined,
        }
      : undefined,
  };
}

function attachPendingSubagentCallsToSnapshot(
  parentToolUseId: string,
  parentTool: NonNullable<PersistContentBlock['tool']>,
  pendingCallsByParent: ReadonlyMap<string, readonly PersistSubagentCall[]>,
): void {
  const pending = pendingCallsByParent.get(parentToolUseId);
  if (!pending || pending.length === 0) return;
  if (!parentTool.subagentCalls) parentTool.subagentCalls = [];
  for (const call of pending) {
    const existing = parentTool.subagentCalls.find((candidate) => candidate.id === call.id);
    if (existing) Object.assign(existing, call);
    else parentTool.subagentCalls.push({ ...call });
  }
}

function attachPendingSubagentLifecycleToSnapshot(
  parentToolUseId: string,
  parentTool: NonNullable<PersistContentBlock['tool']>,
  pendingLifecyclesByParent: ReadonlyMap<string, SubagentLifecycle> | undefined,
): void {
  const pending = pendingLifecyclesByParent?.get(parentToolUseId);
  if (pending) parentTool.subagentLifecycle = { ...pending };
}

export function buildExternalAssistantSnapshotContent(state: ExternalAssistantSnapshotState): string | null {
  const blocks: PersistContentBlock[] = state.contentBlocks.map((block) => {
    const cloned = clonePersistContentBlock(block);
    if (cloned.tool) {
      attachPendingSubagentCallsToSnapshot(cloned.tool.id, cloned.tool, state.pendingSubagentCallsByParent);
      attachPendingSubagentLifecycleToSnapshot(
        cloned.tool.id,
        cloned.tool,
        state.pendingSubagentLifecyclesByParent,
      );
    }
    return cloned;
  });

  if (state.pendingTextBuffer) {
    blocks.push({ type: 'text', text: state.pendingTextBuffer });
  }

  if (state.pendingThinkingBlock) {
    blocks.push(clonePersistContentBlock(state.pendingThinkingBlock));
  }

  for (const [toolId, entry] of state.pendingToolInputs) {
    if (state.childToolToParent.has(toolId)) continue;
    let parsedInput: Record<string, unknown> = {};
    try { parsedInput = JSON.parse(entry.inputJson); } catch { /* keep empty */ }
    const block: PersistContentBlock = {
      type: 'tool_use',
      tool: {
        id: toolId,
        name: entry.name,
        input: parsedInput,
        inputJson: entry.inputJson,
        isLoading: true,
        streamIndex: blocks.length,
      },
    };
    if (block.tool) {
      const display = buildFilePatchDisplayDescriptor(block.tool);
      if (display) block.tool.display = display;
      attachPendingSubagentCallsToSnapshot(toolId, block.tool, state.pendingSubagentCallsByParent);
      attachPendingSubagentLifecycleToSnapshot(
        toolId,
        block.tool,
        state.pendingSubagentLifecyclesByParent,
      );
    }
    blocks.push(block);
  }

  if (blocks.length > 0) {
    return JSON.stringify(blocks);
  }

  if (state.currentAssistantText.trim()) {
    return state.currentAssistantText;
  }

  return null;
}

export function buildCurrentExternalAssistantSnapshotContent(): string | null {
  return buildExternalAssistantSnapshotContent({
    contentBlocks: currentContentBlocks,
    pendingTextBuffer,
    pendingThinkingBlock: buildExternalPendingThinkingBlock(false),
    pendingToolInputs,
    childToolToParent,
    pendingSubagentCallsByParent,
    pendingSubagentLifecyclesByParent,
    currentAssistantText,
  });
}

export interface ExternalTurnContentSnapshot {
  readonly blocks: readonly PersistContentBlock[];
  readonly assistantText: string;
}

export function captureExternalTurnContentSnapshot(): ExternalTurnContentSnapshot {
  return {
    blocks: currentContentBlocks,
    assistantText: currentAssistantText,
  };
}

export function isExternalTurnContentSnapshotCurrent(snapshot: ExternalTurnContentSnapshot): boolean {
  return currentContentBlocks === snapshot.blocks;
}

export function getExternalTurnContentSnapshotToolCount(snapshot: ExternalTurnContentSnapshot): number {
  return snapshot.blocks.filter((block) => block.type === 'tool_use').length;
}

export function getExternalTurnContentSnapshotText(snapshot: ExternalTurnContentSnapshot): string {
  if (snapshot.blocks.length > 0) {
    const blockText = snapshot.blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('\n\n')
      .trim();
    if (blockText) return blockText;
  }
  return snapshot.assistantText.trim();
}

export function getExternalTurnContentSnapshotPersistedContent(snapshot: ExternalTurnContentSnapshot): string | null {
  if (snapshot.blocks.length > 0) return JSON.stringify(snapshot.blocks);
  if (snapshot.assistantText.trim()) return snapshot.assistantText;
  return null;
}
