import { createHash } from 'node:crypto';

import type { DshHostMethodName, DshRpcObject } from './protocol-types';

type MutationMethod = Extract<
  DshHostMethodName,
  `session/${'delete' | 'fork' | 'rewind'}/${string}` | 'session/read' | 'turn/get'
>;

export interface DshMutationTransport {
  request(
    method: MutationMethod,
    params: DshRpcObject,
    options?: { signal?: AbortSignal },
  ): Promise<DshRpcObject>;
}

export type DshMutationState =
  | 'prepared'
  | 'committed'
  | 'rolled_back'
  | 'aborted'
  | 'purged'
  | 'recovery_required';

export type DshMutationResult = Readonly<{
  token: string;
  state: DshMutationState;
  receipt?: Readonly<DshRpcObject>;
}>;

export type DshStableMutationBoundary = Readonly<{
  stableBoundaryId: string;
  sequence: number;
  turn: number;
  transcriptPostcondition: string;
}>;

export type DshGenesisMutationBoundary = Readonly<{
  stableBoundaryId: string;
  sequence: number;
  transcriptPostcondition: string;
}>;

export type DshMutationBoundaryTarget = DshStableMutationBoundary | DshGenesisMutationBoundary;

export type DshVerifiedHistoryEvent = Readonly<{
  sequence: number;
  eventType: string;
  eventSha256: string;
  data: unknown;
}>;

export type DshNativeHistory = Readonly<{
  inheritedEventCount: number;
  runtimeSessionId: string;
  durableSequence: number;
  events: readonly DshVerifiedHistoryEvent[];
  genesisBoundary?: DshGenesisMutationBoundary;
  mutationBoundaries: readonly DshStableMutationBoundary[];
  transcriptPostcondition: string;
}>;

export type DshTurnLookup = Readonly<{
  clientOperationId: string;
  admission?: Readonly<{
    origin?: 'collaboration';
    clientOperationId: string;
    turnId: string;
    admittedAt: string;
  }>;
  terminal?: Readonly<DshRpcObject>;
}>;

const MUTATION_STATES = new Set<DshMutationState>([
  'prepared',
  'committed',
  'rolled_back',
  'aborted',
  'purged',
  'recovery_required',
]);

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

function sha256(value: unknown, description: string): string {
  const digest = string(value, description);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${description} must be a SHA-256 digest`);
  return digest;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error('DSH history contains a non-canonical JSON number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = object(value, 'DSH history value');
  return `{${Object.keys(row)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(',')}}`;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

type PendingChunk = {
  sequence: number;
  eventType: string;
  eventSha256: string;
  chunkCount: number;
  totalBytes: number;
  buffers: Buffer[];
  nextChunkIndex: number;
  nextOffset: number;
};

class DshHistoryAssembler {
  private inheritedEventCount: number | undefined;
  private runtimeSessionId: string | undefined;
  private historyFormat: string | undefined;
  private durableHead: DshRpcObject | undefined;
  private expectedCursor: string | undefined;
  private nextSequence = 0;
  private pending: PendingChunk | undefined;
  private complete = false;
  private boundaries: readonly DshStableMutationBoundary[] | undefined;
  private genesisBoundary: DshGenesisMutationBoundary | undefined;
  private transcriptPostcondition: string | undefined;
  private readonly events: DshVerifiedHistoryEvent[] = [];

  accept(pageValue: DshRpcObject, requestCursor?: string): void {
    if (this.complete || requestCursor !== this.expectedCursor) {
      throw new Error('DSH session/read page escaped its cursor chain');
    }
    const runtimeSessionId = string(pageValue.runtimeSessionId, 'DSH history Runtime Session id');
    const historyFormat = string(pageValue.historyFormat, 'DSH history format');
    if (historyFormat !== 'dsh-session-events-v2') throw new Error('DSH history format is incompatible');
    const durableHead = object(pageValue.durableHead, 'DSH durable history head');
    const durableSequence = safeInteger(durableHead.sequence, 'DSH durable history sequence');
    const inheritedEventCount = safeInteger(pageValue.inheritedEventCount, 'DSH inherited event count');
    if (inheritedEventCount > durableSequence) throw new Error('DSH inherited prefix exceeds its durable head');
    if (this.runtimeSessionId === undefined) {
      this.runtimeSessionId = runtimeSessionId;
      this.inheritedEventCount = inheritedEventCount;
      this.historyFormat = historyFormat;
      this.durableHead = structuredClone(durableHead);
    } else if (
      runtimeSessionId !== this.runtimeSessionId
      || inheritedEventCount !== this.inheritedEventCount
      || historyFormat !== this.historyFormat
      || !sameJson(durableHead, this.durableHead)
    ) {
      throw new Error('DSH session/read identity or durable head changed mid-chain');
    }

    if (pageValue.mutationBoundaries !== undefined) {
      if (!Array.isArray(pageValue.mutationBoundaries)) {
        throw new Error('DSH mutation boundaries must be an array');
      }
      const parsed = pageValue.mutationBoundaries.map((candidate, index) => {
        const row = object(candidate, `DSH mutation boundary ${index}`);
        return Object.freeze({
          stableBoundaryId: string(row.stableBoundaryId, 'DSH stable boundary id'),
          sequence: safeInteger(row.sequence, 'DSH stable boundary sequence', 1),
          turn: safeInteger(row.turn, 'DSH stable boundary turn', 1),
          transcriptPostcondition: sha256(
            row.transcriptPostcondition,
            'DSH boundary transcript postcondition',
          ),
        });
      });
      if (this.boundaries && !sameJson(parsed, this.boundaries)) {
        throw new Error('DSH mutation boundary inventory changed mid-chain');
      }
      this.boundaries = Object.freeze(parsed);
    }
    if (pageValue.genesisBoundary !== undefined) {
      const row = object(pageValue.genesisBoundary, 'DSH genesis mutation boundary');
      const parsed = Object.freeze({
        stableBoundaryId: string(row.stableBoundaryId, 'DSH genesis stable boundary id'),
        sequence: safeInteger(row.sequence, 'DSH genesis boundary sequence'),
        transcriptPostcondition: sha256(
          row.transcriptPostcondition,
          'DSH genesis transcript postcondition',
        ),
      });
      if (this.genesisBoundary && !sameJson(parsed, this.genesisBoundary)) {
        throw new Error('DSH genesis mutation boundary changed mid-chain');
      }
      this.genesisBoundary = parsed;
    }
    if (pageValue.transcriptPostcondition !== undefined) {
      const postcondition = sha256(
        pageValue.transcriptPostcondition,
        'DSH transcript postcondition',
      );
      if (this.transcriptPostcondition && postcondition !== this.transcriptPostcondition) {
        throw new Error('DSH transcript postcondition changed mid-chain');
      }
      this.transcriptPostcondition = postcondition;
    }

    if (!Array.isArray(pageValue.records)) throw new Error('DSH history records must be an array');
    if (pageValue.nextCursor !== undefined && pageValue.records.length === 0) {
      throw new Error('DSH session/read continuation made no progress');
    }
    for (const record of pageValue.records) this.acceptRecord(object(record, 'DSH history record'));

    const nextCursor = pageValue.nextCursor === undefined
      ? undefined
      : string(pageValue.nextCursor, 'DSH history cursor');
    if (nextCursor !== undefined && nextCursor === requestCursor) {
      throw new Error('DSH session/read repeated its cursor');
    }
    this.expectedCursor = nextCursor;
    if (nextCursor === undefined) {
      if (this.pending) throw new Error('DSH history ended inside a chunked event');
      if (safeInteger(this.durableHead?.sequence, 'DSH durable history sequence') !== this.nextSequence) {
        throw new Error('DSH history ended before its durable head');
      }
      if (!this.transcriptPostcondition) {
        throw new Error('DSH history lacks its transcript postcondition');
      }
      this.complete = true;
    }
  }

  get nextCursor(): string | undefined {
    return this.expectedCursor;
  }

  finish(): DshNativeHistory {
    if (!this.complete || !this.runtimeSessionId || !this.durableHead || !this.transcriptPostcondition) {
      throw new Error('DSH session/read cursor chain is incomplete');
    }
    const boundaries = this.boundaries ?? [];
    const seenTurns = new Set<number>();
    let priorSequence = 0;
    for (const boundary of boundaries) {
      if (boundary.sequence > safeInteger(this.durableHead.sequence, 'DSH durable history sequence')
        || boundary.sequence < priorSequence || seenTurns.has(boundary.turn)) {
        throw new Error('DSH mutation boundary inventory is inconsistent with durable history');
      }
      priorSequence = boundary.sequence;
      seenTurns.add(boundary.turn);
    }
    return Object.freeze({
      runtimeSessionId: this.runtimeSessionId,
      inheritedEventCount: safeInteger(this.inheritedEventCount, 'DSH inherited event count'),
      durableSequence: safeInteger(this.durableHead.sequence, 'DSH durable history sequence'),
      events: Object.freeze([...this.events]),
      ...(this.genesisBoundary === undefined ? {} : { genesisBoundary: this.genesisBoundary }),
      mutationBoundaries: Object.freeze([...boundaries]),
      transcriptPostcondition: this.transcriptPostcondition,
    });
  }

  private acceptRecord(record: DshRpcObject): void {
    const sequence = safeInteger(record.sequence, 'DSH history record sequence');
    if (sequence !== this.nextSequence) throw new Error('DSH history event sequence is not contiguous');
    const kind = string(record.kind, 'DSH history record kind');
    const eventType = string(record.eventType, 'DSH history event type');
    const eventSha256 = sha256(record.eventSha256, 'DSH history event digest');
    if (kind === 'event') {
      if (this.pending) throw new Error('DSH whole event interrupted a chunk sequence');
      const bytes = canonicalBytes(record.data);
      if (digest(bytes) !== eventSha256) throw new Error('DSH history event digest mismatch');
      this.events.push(Object.freeze({ sequence, eventType, eventSha256, data: record.data }));
      this.nextSequence += 1;
      return;
    }
    if (kind !== 'event_chunk') throw new Error(`Unsupported DSH history record kind: ${kind}`);
    const chunkIndex = safeInteger(record.chunkIndex, 'DSH history chunk index');
    const chunkCount = safeInteger(record.chunkCount, 'DSH history chunk count', 1);
    const offsetBytes = safeInteger(record.offsetBytes, 'DSH history chunk offset');
    const totalBytes = safeInteger(record.totalBytes, 'DSH history chunk total', 1);
    const encoded = string(record.dataBase64, 'DSH history chunk data');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.toString('base64') !== encoded) {
      throw new Error('DSH history chunk is not canonical Base64');
    }
    const pending = this.pending ?? {
      sequence,
      eventType,
      eventSha256,
      chunkCount,
      totalBytes,
      buffers: [],
      nextChunkIndex: 0,
      nextOffset: 0,
    };
    if (
      pending.sequence !== sequence
      || pending.eventType !== eventType
      || pending.eventSha256 !== eventSha256
      || pending.chunkCount !== chunkCount
      || pending.totalBytes !== totalBytes
      || pending.nextChunkIndex !== chunkIndex
      || pending.nextOffset !== offsetBytes
      || offsetBytes + bytes.length > totalBytes
    ) {
      throw new Error('DSH history chunks are not one exact contiguous event');
    }
    pending.buffers.push(bytes);
    pending.nextChunkIndex += 1;
    pending.nextOffset += bytes.length;
    if (pending.nextOffset === totalBytes) {
      if (pending.nextChunkIndex !== chunkCount) throw new Error('DSH history chunk count mismatch');
      const joined = Buffer.concat(pending.buffers, totalBytes);
      if (digest(joined) !== eventSha256) throw new Error('DSH chunked history event digest mismatch');
      let data: unknown;
      try {
        data = JSON.parse(joined.toString('utf8')) as unknown;
      } catch {
        throw new Error('DSH chunked history event is not JSON');
      }
      if (!canonicalBytes(data).equals(joined)) {
        throw new Error('DSH chunked history event is not canonical JSON');
      }
      this.events.push(Object.freeze({ sequence, eventType, eventSha256, data }));
      this.pending = undefined;
      this.nextSequence += 1;
      return;
    }
    if (pending.nextOffset > totalBytes || pending.nextChunkIndex >= chunkCount) {
      throw new Error('DSH history chunks exceed their declared event boundary');
    }
    this.pending = pending;
  }
}

function mutationResult(value: DshRpcObject, expectedToken?: string): DshMutationResult {
  const token = string(value.token, 'DSH mutation token');
  if (expectedToken && token !== expectedToken) throw new Error('DSH mutation token changed');
  const state = string(value.state, 'DSH mutation state') as DshMutationState;
  if (!MUTATION_STATES.has(state)) throw new Error(`Unsupported DSH mutation state: ${state}`);
  return Object.freeze({
    token,
    state,
    ...(value.receipt === undefined
      ? {}
      : { receipt: Object.freeze(structuredClone(object(value.receipt, 'DSH mutation receipt'))) }),
  });
}

export function stableBoundaryForRuntimeTurn(
  history: DshNativeHistory,
  runtimeTurnId: string,
): DshStableMutationBoundary {
  const accepted = history.events.filter(event => event.eventType === 'myagents/operation/accepted')
    .map(event => object(event.data, 'DSH operation acceptance'))
    .filter(event => event.productTurnId === runtimeTurnId);
  if (accepted.length !== 1) {
    throw new Error('DSH Runtime turn does not resolve to one durable operation acceptance');
  }
  const clientOperationId = string(accepted[0]?.clientOperationId, 'DSH accepted operation id');
  const claimedTurns = history.events.filter(event => event.eventType === 'myagents/operation/claimed')
    .map(event => object(event.data, 'DSH operation claim'))
    .filter(event => event.clientOperationId === clientOperationId)
    .map(event => safeInteger(event.dshTurn, 'DSH claimed turn', 1));
  if (claimedTurns.length === 0) throw new Error('DSH Runtime turn has no durable claimed turn');
  const terminalCount = history.events.filter(event => {
    if (event.eventType !== 'myagents/operation/terminal') return false;
    return object(event.data, 'DSH operation terminal').clientOperationId === clientOperationId;
  }).length;
  if (terminalCount !== 1) throw new Error('DSH Runtime turn is not durably terminal');
  const terminalTurn = Math.max(...claimedTurns);
  const boundaries = history.mutationBoundaries.filter(boundary => boundary.turn === terminalTurn);
  if (boundaries.length !== 1) {
    throw new Error('DSH Runtime turn does not resolve to one stable mutation boundary');
  }
  return boundaries[0]!;
}

export function rewindBoundaryBeforeRuntimeTurn(
  history: DshNativeHistory,
  runtimeTurnId: string | null,
): DshMutationBoundaryTarget {
  if (runtimeTurnId !== null) return stableBoundaryForRuntimeTurn(history, runtimeTurnId);
  if (!history.genesisBoundary) {
    throw new Error('DSH durable history has no stable genesis mutation boundary');
  }
  return history.genesisBoundary;
}

export class DshMutationController {
  constructor(
    private readonly transport: DshMutationTransport,
    private readonly expectedRuntimeSessionId: string,
  ) {}

  async readHistory(signal?: AbortSignal): Promise<DshNativeHistory> {
    for (let attempt = 0; ; attempt += 1) {
      const assembler = new DshHistoryAssembler();
      let cursor: string | undefined;
      for (let pageIndex = 0; ; pageIndex += 1) {
        signal?.throwIfAborted();
        if (pageIndex >= 1_024) throw new Error('DSH history exceeded its page bound');
        let page: DshRpcObject;
        try {
          page = await this.transport.request(
            'session/read', cursor === undefined ? {} : { cursor }, signal ? { signal } : undefined,
          );
        } catch (error) {
          signal?.throwIfAborted();
          // The loaded public ProtocolError crosses a module boundary; use its explicit fields.
          if (attempt < 2 && error instanceof Error
            && 'retryable' in error && error.retryable === true && 'code' in error
            && (error.code === 'cursor_stale' || error.code === 'session_read_unstable')) break;
          throw error;
        }
        assembler.accept(page, cursor);
        cursor = assembler.nextCursor;
        if (cursor !== undefined) continue;
        const history = assembler.finish();
        if (history.runtimeSessionId !== this.expectedRuntimeSessionId) {
          throw new Error('DSH durable history belongs to a different Runtime Session');
        }
        return history;
      }
    }
  }

  async getTurn(clientOperationId: string, signal?: AbortSignal): Promise<DshTurnLookup> {
    const expectedId = string(clientOperationId, 'DSH client operation id');
    const value = await this.transport.request(
      'turn/get',
      { clientOperationId: expectedId },
      signal ? { signal } : undefined,
    );
    if (string(value.clientOperationId, 'DSH turn lookup operation id') !== expectedId) {
      throw new Error('DSH turn lookup changed its client operation identity');
    }
    let admission: DshTurnLookup['admission'];
    if (value.admission !== undefined) {
      const row = object(value.admission, 'DSH turn admission');
      if (string(row.clientOperationId, 'DSH turn admission operation id') !== expectedId) {
        throw new Error('DSH turn admission changed its client operation identity');
      }
      const admittedAt = string(row.admittedAt, 'DSH turn admission timestamp');
      if (!Number.isFinite(Date.parse(admittedAt))) {
        throw new Error('DSH turn admission timestamp is invalid');
      }
      if (row.origin !== undefined && row.origin !== 'user' && row.origin !== 'collaboration') throw new Error('DSH turn admission origin is invalid');
      admission = Object.freeze({
        ...(row.origin === 'collaboration' ? { origin: 'collaboration' as const } : {}),
        clientOperationId: expectedId,
        turnId: string(row.turnId, 'DSH admitted turn id'),
        admittedAt,
      });
    }
    const terminal = value.terminal === undefined
      ? undefined
      : Object.freeze(structuredClone(object(value.terminal, 'DSH turn terminal')));
    return Object.freeze({
      clientOperationId: expectedId,
      ...(admission ? { admission } : {}),
      ...(terminal ? { terminal } : {}),
    });
  }

  async prepareFork(input: Readonly<{
    clientMutationId: string;
    sourceRuntimeTurnId: string;
    targetRuntimeHome: string;
    targetPersistenceRef: string;
    targetWorkspaceIdentity: string;
    targetRuntimeSessionId: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ mutation: DshMutationResult; boundary: DshStableMutationBoundary }>> {
    const history = await this.readHistory(input.signal);
    const boundary = stableBoundaryForRuntimeTurn(history, input.sourceRuntimeTurnId);
    const result = mutationResult(await this.transport.request('session/fork/prepare', {
      clientMutationId: input.clientMutationId,
      sourceStableBoundaryId: boundary.stableBoundaryId,
      targetRuntimeHome: input.targetRuntimeHome,
      targetPersistenceRef: input.targetPersistenceRef,
      targetWorkspaceIdentity: input.targetWorkspaceIdentity,
      targetRuntimeSessionId: input.targetRuntimeSessionId,
    }, input.signal ? { signal: input.signal } : undefined));
    return Object.freeze({ mutation: result, boundary });
  }

  prepareRewind(input: Readonly<{
    clientMutationId: string;
    target: DshMutationBoundaryTarget;
    sourceTranscriptPostcondition: string;
    signal?: AbortSignal;
  }>): Promise<DshMutationResult> {
    return this.prepare('session/rewind/prepare', {
      clientMutationId: input.clientMutationId,
      targetStableBoundaryId: input.target.stableBoundaryId,
      sourceTranscriptPostcondition: sha256(
        input.sourceTranscriptPostcondition,
        'DSH source transcript postcondition',
      ),
      targetTranscriptPostcondition: input.target.transcriptPostcondition,
    }, input.signal);
  }

  prepareDelete(clientMutationId: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.prepare('session/delete/prepare', { clientMutationId }, signal);
  }

  prepareStoredDelete(clientMutationId: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.prepare('session/delete/prepare', { clientMutationId, runtimeSessionId: this.expectedRuntimeSessionId }, signal);
  }

  commitFork(clientMutationId: string, token: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.settle('session/fork/commit', clientMutationId, token, signal);
  }

  abortFork(clientMutationId: string, token: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.settle('session/fork/abort', clientMutationId, token, signal);
  }

  forkStatus(token: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.status('session/fork/status', token, signal);
  }

  commitRewind(clientMutationId: string, token: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.settle('session/rewind/commit', clientMutationId, token, signal);
  }

  rollbackRewind(clientMutationId: string, token: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.settle('session/rewind/rollback', clientMutationId, token, signal);
  }

  rewindStatus(token: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.status('session/rewind/status', token, signal);
  }

  commitDelete(clientMutationId: string, token: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.settle('session/delete/commit', clientMutationId, token, signal);
  }

  purgeDelete(clientMutationId: string, token: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.settle('session/delete/purge', clientMutationId, token, signal);
  }

  rollbackDelete(clientMutationId: string, token: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.settle('session/delete/rollback', clientMutationId, token, signal);
  }

  deleteStatus(token: string, signal?: AbortSignal): Promise<DshMutationResult> {
    return this.status('session/delete/status', token, signal);
  }

  private async prepare(
    method: Extract<MutationMethod, `${string}/prepare`>,
    params: DshRpcObject,
    signal?: AbortSignal,
  ): Promise<DshMutationResult> {
    return mutationResult(await this.transport.request(method, params, signal ? { signal } : undefined));
  }

  private async settle(
    method: Extract<MutationMethod, `${string}/${'commit' | 'abort' | 'rollback' | 'purge'}`>,
    clientMutationId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<DshMutationResult> {
    const expectedToken = string(token, 'DSH mutation token');
    return mutationResult(await this.transport.request(method, {
      clientMutationId: string(clientMutationId, 'DSH client mutation id'),
      token: expectedToken,
    }, signal ? { signal } : undefined), expectedToken);
  }

  private async status(
    method: Extract<MutationMethod, `${string}/status`>,
    token: string,
    signal?: AbortSignal,
  ): Promise<DshMutationResult> {
    const expectedToken = string(token, 'DSH mutation token');
    return mutationResult(await this.transport.request(
      method,
      { token: expectedToken },
      signal ? { signal } : undefined,
    ), expectedToken);
  }
}
