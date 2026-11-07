import { createHash } from 'node:crypto';

import type {
  DshNativeHistory,
  DshTurnLookup,
  DshVerifiedHistoryEvent,
  DshMutationController,
} from '../integrated-runtimes/dsh/mutations';
import type { DshRpcObject } from '../integrated-runtimes/dsh/protocol-types';
import type { SubagentLifecycle } from '../../shared/types/subagent-lifecycle';
import { isProtocolIdentifier, projectDshToolInput, projectWorkHistory, providerContentFailed, providerIdentity } from '../integrated-runtimes/dsh/history-content';
import { reconcileDshTurnProjections } from '../SessionStore';
import { readDshUsage, tokenCount } from '../integrated-runtimes/dsh/telemetry';
import type {
  DshProjectionCursor,
  MessageUsage,
  SessionMessage,
} from '../types/session';

type ProductContentBlock =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{
      type: 'thinking';
      thinking: string;
      thinkingStreamIndex: number;
      isComplete: true;
    }>
  | Readonly<{
      type: 'tool_use' | 'server_tool_use';
      tool: {
        id: string;
        name: string;
        input: Record<string, unknown>;
        inputJson: string;
        result?: string;
        isError?: boolean;
        providerRouteId?: string;
        providerBlockType?: string;
        subagentLifecycle?: SubagentLifecycle;
        streamIndex: number;
      };
    }>;

type AcceptedOperation = Readonly<{
  origin?: 'collaboration';
  sequence: number;
  clientOperationId: string;
  clientUserMessageId: string;
  productTurnId: string;
  acceptedAt: number;
}>;

type TerminalOperation = Readonly<{
  sequence: number;
  clientOperationId: string;
  productTurnId: string;
  terminalAt: number;
  finalDshTurn?: number;
  terminal: DshRpcObject;
}>;

export type DshUnsettledTurn = Readonly<{
  origin?: 'collaboration';
  clientOperationId: string;
  clientUserMessageId: string;
  productTurnId: string;
}>;

export type DshRecoveredTurnProjection = Readonly<{
  clientOperationId: string;
  assistantMessage: SessionMessage;
}>;

export type DshNativeRootOperation = DshUnsettledTurn & Readonly<{
  inherited?: true;
  terminal: boolean;
  consumedUserMessageIds?: readonly string[];
  partialTerminalStatus?: 'stopped' | 'error';
}>;

export type DshTurnProjectionSnapshot = Readonly<{
  cursor: DshProjectionCursor;
  assistantTurns: readonly DshRecoveredTurnProjection[];
  rootOperations: readonly DshNativeRootOperation[];
  unsettledTurns: readonly DshUnsettledTurn[];
  inputReceipts: readonly DshInputReceipt[];
  runtimeUsageTotals?: MessageUsage;
}>;

export type DshInputReceipt = Readonly<{
  clientOperationId: string;
  clientUserMessageId: string;
  inputFingerprint: string;
  sequence: number;
  state: 'pending' | 'consumed' | 'cancelled';
}>;

export type DshTurnReconciliationResult = Readonly<{
  transcriptChanged: boolean;
  reconciledOperations: number;
  settledTurnIds: readonly string[];
  activeTurn?: DshUnsettledTurn;
}>;

class DshHistoryAdvancedError extends Error {}

function object(value: unknown, description: string): DshRpcObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as DshRpcObject;
}

function string(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function safeInteger(value: unknown, description: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${description} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function epochTimestamp(value: unknown, description: string): number {
  const timestamp = safeInteger(value, description);
  if (timestamp > 8_640_000_000_000_000) {
    throw new Error(`${description} exceeds the canonical Date range`);
  }
  return timestamp;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error('DSH reconciliation value contains a non-canonical number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = object(value, 'DSH reconciliation value');
  return `{${Object.keys(row)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(',')}}`;
}

function durableSessionEventId(runtimeSessionId: string, sequence: number): string {
  const sessionHash = createHash('sha256').update(runtimeSessionId).digest('hex').slice(0, 24);
  return `dsh-event-${sessionHash}-${sequence}`;
}

function deterministicAssistantId(runtimeSessionId: string, clientOperationId: string): string {
  const digest = createHash('sha256')
    .update(runtimeSessionId)
    .update('\0')
    .update(clientOperationId)
    .digest('hex')
    .slice(0, 32);
  return `assistant-dsh-${digest}`;
}

function parseAccepted(event: DshVerifiedHistoryEvent): AcceptedOperation {
  const row = object(event.data, 'DSH operation acceptance');
  return Object.freeze({
    sequence: event.sequence,
    ...(row.rootContextMessage === true ? { origin: 'collaboration' as const } : {}),
    clientOperationId: string(row.clientOperationId, 'DSH accepted operation id'),
    clientUserMessageId: string(row.clientUserMessageId, 'DSH accepted user message id'),
    productTurnId: string(row.productTurnId, 'DSH accepted Product turn id'),
    acceptedAt: epochTimestamp(row.acceptedAt, 'DSH operation acceptedAt'),
  });
}

function parseTerminal(event: DshVerifiedHistoryEvent): TerminalOperation {
  const row = object(event.data, 'DSH operation terminal event');
  return Object.freeze({
    sequence: event.sequence,
    clientOperationId: string(row.clientOperationId, 'DSH terminal operation id'),
    productTurnId: string(row.productTurnId, 'DSH terminal Product turn id'),
    terminalAt: epochTimestamp(row.terminalAt, 'DSH operation terminalAt'),
    ...(row.finalDshTurn === undefined
      ? {}
      : { finalDshTurn: safeInteger(row.finalDshTurn, 'DSH terminal final turn', 1) }),
    terminal: object(row.terminal, 'DSH operation terminal'),
  });
}

function terminalOutcome(terminal: DshRpcObject): DshRpcObject {
  // Metering is display data; admission, outcome and assistant ownership remain authoritative.
  const outcome = { ...terminal };
  delete outcome.usage;
  return outcome;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string, description: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (result.has(identity)) throw new Error(`${description} identity is duplicated`);
    result.set(identity, value);
  }
  return result;
}

function parseUsage(value: unknown, model?: string): MessageUsage | undefined {
  const usage = readDshUsage(value);
  if (!usage) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: cacheCreationTokens } = usage;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens ? { cacheCreationTokens } : {}),
    ...(model ? { model } : {}),
  };
}

function addUsage(total: MessageUsage | undefined, value: MessageUsage): MessageUsage | undefined {
  const result = {
    inputTokens: (total?.inputTokens ?? 0) + value.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + value.outputTokens,
    ...((total?.cacheReadTokens ?? 0) + (value.cacheReadTokens ?? 0) > 0
      ? { cacheReadTokens: (total?.cacheReadTokens ?? 0) + (value.cacheReadTokens ?? 0) }
      : {}),
    ...((total?.cacheCreationTokens ?? 0) + (value.cacheCreationTokens ?? 0) > 0
      ? { cacheCreationTokens: (total?.cacheCreationTokens ?? 0) + (value.cacheCreationTokens ?? 0) }
      : {}),
  };
  return Object.values(result).every(value => tokenCount(value) !== undefined) ? result : undefined;
}

function parseToolInput(rawArguments: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    return projectDshToolInput(parsed);
  } catch {
    return { rawArguments };
  }
}

function turnNumber(event: DshVerifiedHistoryEvent, description: string): number {
  return safeInteger(object(event.data, description).turn, `${description} turn`, 1);
}

function projectOperationContent(
  history: DshNativeHistory,
  terminal: TerminalOperation,
  claimedTurns: readonly number[],
): Readonly<{ content: string; toolCount: number; model?: string }> {
  if (terminal.finalDshTurn === undefined || !claimedTurns.includes(terminal.finalDshTurn)) {
    throw new Error('Successful DSH operation lacks its exact final claimed turn');
  }
  const boundaries = new Map<number, { start: number; end: number }>();
  for (const turn of claimedTurns) {
    const starts = history.events.filter(event => event.eventType === 'turn/start'
      && turnNumber(event, 'DSH turn start') === turn);
    const ends = history.events.filter(event => event.eventType === 'turn/end'
      && turnNumber(event, 'DSH turn end') === turn);
    if (starts.length !== 1 || ends.length !== 1 || starts[0]!.sequence >= ends[0]!.sequence) {
      throw new Error('DSH claimed turn lacks one exact durable boundary');
    }
    boundaries.set(turn, { start: starts[0]!.sequence, end: ends[0]!.sequence });
  }

  const owned = (event: DshVerifiedHistoryEvent): boolean => {
    if (!['assistant/message', 'tool/call', 'tool/result'].includes(event.eventType)) return false;
    const turn = turnNumber(event, `DSH ${event.eventType}`);
    const boundary = boundaries.get(turn);
    return boundary !== undefined && event.sequence > boundary.start && event.sequence < boundary.end;
  };
  const events = history.events.filter(owned);
  const content: ProductContentBlock[] = [];
  const tools = new Map<string, Extract<ProductContentBlock, { tool: unknown }>['tool']>();
  const providerTools = new Map<string, Extract<ProductContentBlock, { tool: unknown }>['tool']>();
  const durableToolCalls = new Set<string>();
  const durableToolResults = new Map<string, unknown>();
  let finalModel: string | undefined;

  for (const event of events) {
    const data = object(event.data, `DSH ${event.eventType}`);
    if (event.eventType === 'assistant/message') {
      safeInteger(data.step, 'DSH assistant step', 1);
      const message = object(data.message, 'DSH assistant message');
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        throw new Error('DSH assistant event has an incompatible message');
      }
      const source = object(message.source, 'DSH assistant source');
      const model = string(source.model, 'DSH assistant model');
      string(source.provider, 'DSH assistant provider');
      finalModel = model;
      for (const candidate of message.content) {
        const block = object(candidate, 'DSH assistant content block');
        const type = string(block.type, 'DSH assistant content block type');
        if (type === 'text') {
          const text = typeof block.text === 'string' ? block.text : undefined;
          if (text === undefined) throw new Error('DSH text block lacks text');
          if (text.length > 0) content.push(Object.freeze({ type: 'text', text }));
          continue;
        }
        if (type === 'reasoning') {
          const thinking = typeof block.text === 'string' ? block.text : undefined;
          if (thinking === undefined) throw new Error('DSH reasoning block lacks text');
          if (thinking.length > 0) {
            content.push(Object.freeze({
              type: 'thinking',
              thinking,
              thinkingStreamIndex: content.length,
              isComplete: true,
            }));
          }
          continue;
        }
        if (type === 'tool-call') {
          const id = string(block.id, 'DSH assistant tool-call id');
          if (tools.has(id)) throw new Error('DSH assistant tool-call identity is duplicated');
          const name = string(block.name, 'DSH assistant tool name');
          const rawArguments = typeof block.arguments === 'string' ? block.arguments : undefined;
          if (rawArguments === undefined) throw new Error('DSH assistant tool-call lacks raw arguments');
          const input = parseToolInput(rawArguments);
          const tool = {
            id,
            name,
            input,
            inputJson: JSON.stringify(input, null, 2),
            streamIndex: content.length,
          };
          tools.set(id, tool);
          content.push(Object.freeze({ type: 'tool_use', tool }));
          continue;
        }
        if (type === 'provider-tool-call') {
          const id = providerIdentity(string(block.id, 'DSH Provider call id'), 'provider-call');
          if (providerTools.has(id)) throw new Error('DSH Provider call identity is duplicated');
          const input = object(block.input, 'DSH Provider call input');
          const name = string(block.name, 'DSH Provider tool name');
          const tool = {
            id,
            name: isProtocolIdentifier(name) ? name : 'Tool',
            input,
            inputJson: JSON.stringify(input, null, 2),
            providerRouteId: providerIdentity(string(source.provider, 'DSH Provider route'), 'provider'),
            providerBlockType: string(block.providerType, 'DSH Provider block type'),
            streamIndex: content.length,
          };
          providerTools.set(id, tool);
          content.push(Object.freeze({ type: 'server_tool_use', tool }));
          continue;
        }
        if (type === 'provider-tool-result') {
          const id = providerIdentity(string(block.toolCallId, 'DSH Provider result call id'), 'provider-call');
          const tool = providerTools.get(id);
          if (!tool || tool.result !== undefined) throw new Error('DSH Provider result lacks one unsettled call');
          tool.result = typeof block.content === 'string' ? block.content
            : block.content === undefined ? '(no output)' : canonicalJson(block.content);
          tool.isError = block.isError === true || providerContentFailed(block.content);
          tool.providerBlockType = string(block.providerType, 'DSH Provider result block type');
          continue;
        }
        throw new Error(`Unsupported DSH assistant content block during recovery: ${type}`);
      }
      continue;
    }
    if (event.eventType === 'tool/call') {
      const callId = string(data.callId, 'DSH tool-call id');
      const tool = tools.get(callId);
      if (!tool || durableToolCalls.has(callId)) {
        throw new Error('DSH durable tool-call does not match one assistant tool block');
      }
      const name = string(data.name, 'DSH durable tool name');
      const rawArguments = typeof data.arguments === 'string' ? data.arguments : undefined;
      if (rawArguments === undefined
        || tool.name !== name
        || canonicalJson(tool.input) !== canonicalJson(parseToolInput(rawArguments))) {
        throw new Error('DSH durable tool-call changed its assistant-declared input');
      }
      durableToolCalls.add(callId);
      continue;
    }
    const message = object(data.message, 'DSH tool-result message');
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      throw new Error('DSH tool-result message is incompatible');
    }
    const callId = string(message.toolCallId, 'DSH tool-result call id');
    const tool = tools.get(callId);
    if (!tool) {
      throw new Error('DSH tool-result does not match one unsettled assistant tool block');
    }
    const stableData = { ...data, message: { ...message, content: null } };
    if (tool.result !== undefined) {
      // DSH's result pruner appends a content-only surface replacement. The
      // original result remains the product-visible completion.
      if (canonicalJson(durableToolResults.get(callId)) !== canonicalJson(stableData)) {
        throw new Error('DSH repeated tool-result changed its durable identity');
      }
      continue;
    }
    durableToolResults.set(callId, stableData);
    tool.result = message.content.map(candidate => {
      const block = object(candidate, 'DSH tool result content');
      return block.type === 'text' && typeof block.text === 'string' ? block.text : canonicalJson(block);
    }).join('\n');
    tool.isError = data.error !== undefined || message.isError === true;
  }
  if ([...tools.entries()].some(([id, tool]) => !durableToolCalls.has(id) || tool.result === undefined)) {
    throw new Error('DSH assistant tool block lacks a settled durable call/result pair');
  }
  for (const [callId, tool] of tools) {
    const lifecycle = projectWorkHistory(history, callId);
    if (lifecycle !== undefined) tool.subagentLifecycle = lifecycle;
  }

  const assistantEventId = string(terminal.terminal.assistantEventId, 'DSH terminal assistant event id');
  const finalAssistant = events.find(event => (
    event.eventType === 'assistant/message'
    && event.sequence >= 0
    && durableSessionEventId(history.runtimeSessionId, event.sequence) === assistantEventId
  ));
  if (!finalAssistant
    || turnNumber(finalAssistant, 'DSH terminal assistant') !== terminal.finalDshTurn) {
    throw new Error('DSH successful terminal lacks its exact durable assistant anchor');
  }
  if (content.length === 0) throw new Error('DSH successful operation projects no Product content');
  return Object.freeze({
    content: JSON.stringify(content),
    toolCount: tools.size,
    ...(finalModel ? { model: finalModel } : {}),
  });
}

/**
 * Verify one fixed DSH native history head against independent turn/get facts,
 * then derive only the idempotent Product assistant rows that native truth owns.
 */
export function buildDshTurnProjectionSnapshot(
  history: DshNativeHistory,
  lookups: ReadonlyMap<string, DshTurnLookup>,
): DshTurnProjectionSnapshot {
  const accepted = history.events
    .filter(event => event.eventType === 'myagents/operation/accepted')
    .map(parseAccepted);
  const acceptedById = uniqueBy(accepted, value => value.clientOperationId, 'DSH accepted operation');
  uniqueBy(accepted, value => value.productTurnId, 'DSH Product turn');
  uniqueBy(accepted, value => value.clientUserMessageId, 'DSH root user message');

  const terminals = history.events
    .filter(event => event.eventType === 'myagents/operation/terminal')
    .map(parseTerminal);
  const terminalById = uniqueBy(terminals, value => value.clientOperationId, 'DSH terminal operation');
  const claimedByOperation = new Map<string, number[]>();
  const claimedTurnOwners = new Map<number, string>();
  const claimedMessageIds = new Set<string>();
  const consumedUsers = new Map<string, string[]>();
  const identifiedInputs = new Map<string, { operationId: string; userId: string; inputFingerprint: string; sequence: number; cancelled: boolean }>();
  for (const event of history.events.filter(candidate => candidate.eventType === 'myagents/operation/message')) {
    const row = object(event.data, 'DSH operation input');
    if (row.contextMessage === true || row.kind !== 'follow_up') continue;
    const messageId = string(row.messageId, 'DSH input message id');
    const operationId = string(row.clientOperationId, 'DSH input operation id');
    const userId = string(row.clientMessageId, 'DSH input user id');
    const owner = acceptedById.get(operationId);
    const prior = identifiedInputs.get(messageId);
    if (!owner || owner.sequence >= event.sequence || messageId !== userId
      || (row.state !== 'queued' && row.state !== 'cancelled')) throw new Error('DSH identified input lacks its native owner');
    if (row.state === 'queued') {
      if (prior) throw new Error('DSH identified input is duplicated');
      const inputFingerprint = string(row.inputFingerprint, 'DSH identified input fingerprint');
      if (!/^[a-f0-9]{64}$/u.test(inputFingerprint)) throw new Error('DSH identified input fingerprint is invalid');
      identifiedInputs.set(messageId, { operationId, userId, inputFingerprint, sequence: event.sequence, cancelled: false });
    } else {
      if (!prior || prior.operationId !== operationId || prior.userId !== userId || prior.cancelled) throw new Error('DSH input cancellation changed its owner');
      prior.cancelled = true;
    }
  }
  for (const event of history.events.filter(candidate => candidate.eventType === 'myagents/operation/claimed')) {
    const row = object(event.data, 'DSH operation claim');
    const operationId = string(row.clientOperationId, 'DSH claimed operation id');
    if (!acceptedById.has(operationId)) throw new Error('DSH operation claim lacks an accepted owner');
    const turn = safeInteger(row.dshTurn, 'DSH claimed native turn', 1);
    const messageId = string(row.messageId, 'DSH claimed message id');
    if (claimedMessageIds.has(messageId)) throw new Error('DSH operation repeats one message claim');
    claimedMessageIds.add(messageId);
    const input = identifiedInputs.get(messageId);
    if (input) {
      if (input.operationId !== operationId || input.sequence >= event.sequence || input.cancelled) throw new Error('DSH consumed input contradicts its native receipt');
      const users = consumedUsers.get(operationId) ?? [];
      users.push(input.userId); consumedUsers.set(operationId, users);
    }
    const priorOwner = claimedTurnOwners.get(turn);
    if (priorOwner && priorOwner !== operationId) throw new Error('DSH native turn has multiple Product owners');
    const claims = claimedByOperation.get(operationId) ?? [];
    if (claims.length > 0 && claims[claims.length - 1]! > turn) {
      throw new Error('DSH operation native turn claims are non-monotonic');
    }
    if (claims.at(-1) !== turn) claims.push(turn);
    claimedByOperation.set(operationId, claims);
    claimedTurnOwners.set(turn, operationId);
  }

  const assistantTurns: DshRecoveredTurnProjection[] = [];
  const rootOperations: DshNativeRootOperation[] = [];
  const unsettledTurns: DshUnsettledTurn[] = [];
  let runtimeUsageTotals: MessageUsage | undefined;
  let usageComplete = true;
  for (const operation of [...accepted].sort((left, right) => left.sequence - right.sequence)) {
    const inherited = operation.sequence < history.inheritedEventCount;
    const lookup = inherited ? undefined : lookups.get(operation.clientOperationId);
    if (!inherited && !lookup?.admission) throw new Error('DSH accepted operation is absent from turn/get');
    const expectedAdmittedAt = new Date(operation.acceptedAt).toISOString();
    if (!inherited && lookup?.admission && (
      lookup.clientOperationId !== operation.clientOperationId
      || lookup.admission.clientOperationId !== operation.clientOperationId
      || lookup.admission.turnId !== operation.productTurnId
      || lookup.admission.admittedAt !== expectedAdmittedAt
      || (lookup.admission.origin === 'collaboration') !== (operation.origin === 'collaboration')
    )) {
      throw new Error('DSH turn/get admission differs from durable Session truth');
    }
    const terminal = terminalById.get(operation.clientOperationId);
    const terminalKind = terminal === undefined
      ? undefined
      : string(terminal.terminal.kind, 'DSH terminal kind');
    rootOperations.push(Object.freeze({
      ...(inherited ? { inherited: true as const } : {}),
      ...(operation.origin === undefined ? {} : { origin: operation.origin }),
      clientOperationId: operation.clientOperationId,
      clientUserMessageId: operation.clientUserMessageId,
      productTurnId: operation.productTurnId,
      terminal: terminal !== undefined,
      ...(consumedUsers.has(operation.clientOperationId) ? { consumedUserMessageIds: Object.freeze(consumedUsers.get(operation.clientOperationId)!) } : {}),
      ...(terminalKind === undefined || terminalKind === 'succeeded'
        ? {}
        : { partialTerminalStatus: terminalKind === 'aborted' ? 'stopped' as const : 'error' as const }),
    }));
    if (!terminal) {
      if (inherited) throw new Error('DSH inherited operation lacks its settled terminal');
      if (lookup?.terminal) throw new DshHistoryAdvancedError('DSH history advanced after session/read');
      unsettledTurns.push(Object.freeze({
        ...(operation.origin === undefined ? {} : { origin: operation.origin }),
        clientOperationId: operation.clientOperationId,
        clientUserMessageId: operation.clientUserMessageId,
        productTurnId: operation.productTurnId,
      }));
      continue;
    }
    if (inherited && terminal.sequence >= history.inheritedEventCount) throw new Error('DSH inherited terminal exceeds its native prefix');
    if (terminal.sequence <= operation.sequence || terminal.terminalAt < operation.acceptedAt) {
      throw new Error('DSH terminal precedes its accepted operation');
    }
    if (terminal.productTurnId !== operation.productTurnId) {
      throw new Error('DSH terminal changed its Product turn identity');
    }
    if (!inherited && (!lookup?.terminal || canonicalJson(terminalOutcome(lookup.terminal)) !== canonicalJson(terminalOutcome(terminal.terminal)))) {
      throw new Error('DSH turn/get terminal differs from durable Session truth');
    }
    if (terminalKind === undefined) throw new Error('DSH terminal kind is absent');
    const kind = terminalKind;
    if ([
      'failed',
      'aborted',
      'context_exhausted',
      'max_output_tokens',
      'max_turns',
      'max_budget',
      'transport_lost',
    ].includes(kind)) continue;
    if (kind !== 'succeeded') throw new Error(`Unsupported DSH terminal kind: ${kind}`);
    const claimedTurns = claimedByOperation.get(operation.clientOperationId) ?? [];
    if (terminal.finalDshTurn !== claimedTurns[claimedTurns.length - 1]) {
      throw new Error('DSH successful terminal does not own its last claimed native turn');
    }
    if (inherited) {
      // Product fork/rewind already preserves these rows under their source identities.
      // Only target-owned operations are recovered or queried from live turn/get.
      const usage = parseUsage(terminal.terminal.usage);
      if (usageComplete) {
        runtimeUsageTotals = usage === undefined ? undefined : addUsage(runtimeUsageTotals, usage);
        usageComplete = runtimeUsageTotals !== undefined;
      }
      continue;
    }
    const projected = projectOperationContent(
      history,
      terminal,
      claimedTurns,
    );
    const usage = parseUsage(terminal.terminal.usage, projected.model);
    if (usageComplete) {
      runtimeUsageTotals = usage === undefined ? undefined : addUsage(runtimeUsageTotals, usage);
      usageComplete = runtimeUsageTotals !== undefined;
    }
    const assistantMessage: SessionMessage = {
      id: deterministicAssistantId(history.runtimeSessionId, operation.clientOperationId),
      role: 'assistant',
      content: projected.content,
      timestamp: new Date(terminal.terminalAt).toISOString(),
      completedAt: new Date(terminal.terminalAt).toISOString(),
      durationMs: Math.max(0, terminal.terminalAt - operation.acceptedAt),
      ...(usage === undefined ? {} : { usage }),
      ...(projected.toolCount > 0 ? { toolCount: projected.toolCount } : {}),
      runtimeTurnAnchor: {
        turnId: operation.productTurnId,
        ...(operation.origin === 'collaboration'
          ? { origin: 'collaboration' as const, clientOperationId: operation.clientOperationId }
          : { rootUserMessageId: operation.clientUserMessageId }),
      },
    };
    assistantTurns.push(Object.freeze({
      clientOperationId: operation.clientOperationId,
      assistantMessage,
    }));
  }
  for (const terminal of terminals) {
    if (!acceptedById.has(terminal.clientOperationId)) {
      throw new Error('DSH terminal operation lacks an accepted owner');
    }
  }
  if (unsettledTurns.length > 1) {
    throw new Error('DSH resume exposes more than one non-terminal root operation');
  }
  return Object.freeze({
    cursor: Object.freeze({
      schemaVersion: 1,
      runtimeSessionId: history.runtimeSessionId,
      durableSequence: history.durableSequence,
      transcriptPostcondition: history.transcriptPostcondition,
    }),
    assistantTurns: Object.freeze(assistantTurns),
    rootOperations: Object.freeze(rootOperations),
    unsettledTurns: Object.freeze(unsettledTurns),
    inputReceipts: Object.freeze([...identifiedInputs.entries()].map(([messageId, input]): DshInputReceipt => Object.freeze({
      clientOperationId: input.operationId, clientUserMessageId: input.userId, inputFingerprint: input.inputFingerprint,
      sequence: input.sequence, state: input.cancelled ? 'cancelled' : claimedMessageIds.has(messageId) ? 'consumed' : 'pending',
    }))),
    ...(runtimeUsageTotals ? { runtimeUsageTotals: Object.freeze(runtimeUsageTotals) } : {}),
  });
}

async function readVerifiedProjection(
  controller: DshMutationController,
  signal?: AbortSignal,
): Promise<DshTurnProjectionSnapshot> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const history = await controller.readHistory(signal);
    const operationIds = history.events
      .filter(event => event.sequence >= history.inheritedEventCount && event.eventType === 'myagents/operation/accepted')
      .map(event => string(
        object(event.data, 'DSH operation acceptance').clientOperationId,
        'DSH accepted operation id',
      ));
    const lookups = new Map<string, DshTurnLookup>();
    for (const operationId of operationIds) {
      lookups.set(operationId, await controller.getTurn(operationId, signal));
    }
    try {
      return buildDshTurnProjectionSnapshot(history, lookups);
    } catch (error) {
      if (!(error instanceof DshHistoryAdvancedError) || attempt > 0) throw error;
    }
  }
  throw new Error('DSH turn reconciliation did not reach a stable durable head');
}

export async function reconcileDshTurnsAtStartup(input: {
  productSessionId: string;
  runtimeSessionId: string;
  controller: DshMutationController;
  signal?: AbortSignal;
}): Promise<DshTurnReconciliationResult> {
  const snapshot = await readVerifiedProjection(input.controller, input.signal);
  if (snapshot.cursor.runtimeSessionId !== input.runtimeSessionId) {
    throw new Error('DSH turn reconciliation changed Runtime Session identity');
  }
  const activeTurn = snapshot.unsettledTurns[0];
  const result = await reconcileDshTurnProjections({
    sessionId: input.productSessionId,
    runtimeSessionId: input.runtimeSessionId,
    cursor: snapshot.cursor,
    assistantMessages: snapshot.assistantTurns.map(turn => turn.assistantMessage),
    nativeRootOperations: snapshot.rootOperations,
    nativeInputReceipts: snapshot.inputReceipts,
    ...(activeTurn ? {
      unsettledTurn: {
        ...(activeTurn.origin === undefined ? {} : { origin: activeTurn.origin }),
        clientOperationId: activeTurn.clientOperationId,
        productTurnId: activeTurn.productTurnId,
        clientUserMessageId: activeTurn.clientUserMessageId,
      },
    } : {}),
    runtimeUsageTotals: snapshot.runtimeUsageTotals,
  });
  if (!result.success) throw new Error(`DSH Product turn reconciliation failed: ${result.error}`);
  return Object.freeze({
    transcriptChanged: result.value.transcriptChanged,
    reconciledOperations: snapshot.assistantTurns.length,
    settledTurnIds: Object.freeze(snapshot.rootOperations.filter(operation => operation.terminal).map(operation => operation.productTurnId)),
    ...(activeTurn ? { activeTurn } : {}),
  });
}
