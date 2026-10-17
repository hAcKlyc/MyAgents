import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDshBinding } from '../../shared/integrated-runtimes/identity';
import { createSessionMetadata as createV2Metadata, type SessionMessage } from '../types/session';

// Existing users keep their legacy transcript format across the 0.4.18 upgrade.
const createSessionMetadata: typeof createV2Metadata = (...args) => ({ ...createV2Metadata(...args), transcriptFormat: undefined });
import { snapshotForForkedSession } from '../utils/session-snapshot';

type SessionStoreModule = typeof import('../SessionStore');
type DshMutationRecoveryModule = typeof import('../session-engine/dsh-mutation-recovery');
type DshTurnReconciliationModule = typeof import('../session-engine/dsh-turn-reconciliation');

let home: string;
let originalHome: string | undefined;
let store: SessionStoreModule;
let recovery: DshMutationRecoveryModule;
let turnReconciliation: DshTurnReconciliationModule;

function messages(): SessionMessage[] {
  return [
    { id: 'user-1', role: 'user', content: 'one', timestamp: '2026-08-30T00:00:00.000Z' },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'first',
      timestamp: '2026-08-30T00:00:01.000Z',
      runtimeTurnAnchor: { turnId: 'turn-1', rootUserMessageId: 'user-1' },
    },
    { id: 'user-2', role: 'user', content: 'two', timestamp: '2026-08-30T00:00:02.000Z' },
    {
      id: 'assistant-2',
      role: 'assistant',
      content: 'second',
      timestamp: '2026-08-30T00:00:03.000Z',
      runtimeTurnAnchor: { turnId: 'turn-2', rootUserMessageId: 'user-2' },
    },
  ];
}

async function createDshSession(id: string): Promise<void> {
  const metadata = createSessionMetadata('/tmp/dsh-workspace', {
    id,
    runtimeBinding: createDshBinding('darwin-arm64'),
    runtimeSessionId: `runtime-${id}`,
    configSnapshotAt: '2026-08-30T00:00:00.000Z',
  });
  await store.saveSessionMetadata(metadata);
  const transcript = await store.loadSessionTranscript(id);
  const appended = await store.appendSessionMessages(id, transcript.cursor, messages());
  expect(appended.ok).toBe(true);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'myagents-dsh-mutation-'));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  vi.resetModules();
  store = await import('../SessionStore');
  recovery = await import('../session-engine/dsh-mutation-recovery');
  turnReconciliation = await import('../session-engine/dsh-turn-reconciliation');
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('DSH Product mutation journal', () => {
  it('reports non-mutation Runtime recovery without inventing a Product journal mismatch', async () => {
    const sessionId = 'dsh-product-state-recovery';
    await createDshSession(sessionId);
    await expect(recovery.recoverPendingDshMutation({
      productSessionId: sessionId,
      runtimeSessionId: `runtime-${sessionId}`,
      binding: {
        state: 'recovery_required',
        reason: 'persisted_product_state_invalid',
        retryable: false,
        unsettledMutations: [],
      },
      controller: {} as never,
    })).rejects.toThrow('DSH Session recovery required: persisted_product_state_invalid');
  });

  it('requires a matching Product journal only for an unsettled Runtime mutation', async () => {
    const sessionId = 'dsh-unmatched-runtime-rewind';
    await createDshSession(sessionId);
    await expect(recovery.recoverPendingDshMutation({
      productSessionId: sessionId,
      runtimeSessionId: `runtime-${sessionId}`,
      binding: {
        state: 'recovery_required',
        reason: 'persisted_mutation_unsettled',
        retryable: true,
        unsettledMutations: ['rewind'],
      },
      controller: {} as never,
    })).rejects.toThrow('DSH has unsettled rewind recovery but Product has no matching mutation journal');
  });

  it.each([true, false])('recovers and reopens a Runtime-terminal turn (usage available: %s)', async usageAvailable => {
    const sessionId = `dsh-turn-crash-window-${usageAvailable}`;
    const runtimeSessionId = `runtime-${sessionId}`;
    const metadata = createSessionMetadata('/tmp/dsh-workspace', {
      id: sessionId,
      runtimeBinding: createDshBinding('darwin-arm64'),
      runtimeSessionId,
      configSnapshotAt: '2026-08-30T00:00:00.000Z',
    });
    await store.saveSessionMetadata(metadata);
    const transcript = await store.loadSessionTranscript(sessionId);
    await expect(store.appendSessionMessages(sessionId, transcript.cursor, [{
      id: 'user-crash-window',
      role: 'user',
      content: 'persist me after restart',
      timestamp: '2026-08-30T00:00:00.000Z',
    }])).resolves.toMatchObject({ ok: true });

    const sessionHash = createHash('sha256').update(runtimeSessionId).digest('hex').slice(0, 24);
    const terminal = {
      kind: 'succeeded',
      assistantEventId: `dsh-event-${sessionHash}-3`,
      ...(usageAvailable ? { usage: {
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 6,
        costUsd: null,
        turnId: 'product-turn-crash-window',
        normalizedAs: 'turn_total',
        contextOccupiedTokens: null,
        runtimeContextWindow: 131_072,
        modelProfileRevision: 'model-profile-v1',
      } } : {}),
    };
    const events = [
      {
        sequence: 0,
        eventType: 'myagents/operation/accepted',
        eventSha256: 'd'.repeat(64),
        data: {
          clientOperationId: 'operation-crash-window',
          clientUserMessageId: 'user-crash-window',
          productTurnId: 'product-turn-crash-window',
          acceptedAt: 1_777_507_200_000,
        },
      },
      { sequence: 1, eventType: 'turn/start', eventSha256: 'd'.repeat(64), data: { turn: 1 } },
      {
        sequence: 2,
        eventType: 'myagents/operation/claimed',
        eventSha256: 'd'.repeat(64),
        data: { clientOperationId: 'operation-crash-window', messageId: 'native-user', dshTurn: 1 },
      },
      {
        sequence: 3,
        eventType: 'assistant/message',
        eventSha256: 'd'.repeat(64),
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'native-assistant',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            content: [{ type: 'text', text: 'durable recovered answer' }],
          },
          usage: { inputTokens: 4, outputTokens: 2 },
        },
      },
      {
        sequence: 4,
        eventType: 'turn/end',
        eventSha256: 'd'.repeat(64),
        data: { turn: 1, reason: { kind: 'completed' } },
      },
      {
        sequence: 5,
        eventType: 'myagents/operation/terminal',
        eventSha256: 'd'.repeat(64),
        data: {
          clientOperationId: 'operation-crash-window',
          productTurnId: 'product-turn-crash-window',
          terminal,
          finalDshTurn: 1,
          terminalAt: 1_777_507_201_000,
        },
      },
    ];
    const readHistory = vi.fn(async () => ({
      runtimeSessionId,
      inheritedEventCount: 0,
      durableSequence: events.length,
      events,
      mutationBoundaries: [],
      transcriptPostcondition: 'e'.repeat(64),
    }));
    const getTurn = vi.fn(async () => ({
      clientOperationId: 'operation-crash-window',
      admission: {
        clientOperationId: 'operation-crash-window',
        turnId: 'product-turn-crash-window',
        admittedAt: new Date(1_777_507_200_000).toISOString(),
      },
      terminal,
    }));

    await expect(turnReconciliation.reconcileDshTurnsAtStartup({
      productSessionId: sessionId,
      runtimeSessionId,
      controller: { readHistory, getTurn } as never,
    })).resolves.toEqual({ transcriptChanged: true, reconciledOperations: 1, settledTurnIds: ['product-turn-crash-window'] });
    expect(readHistory).toHaveBeenCalledTimes(1);
    expect(getTurn).toHaveBeenCalledWith('operation-crash-window', undefined);
    expect((await store.getSessionData(sessionId))?.messages).toEqual([
      expect.objectContaining({ id: 'user-crash-window' }),
      expect.objectContaining({
        role: 'assistant',
        runtimeTurnAnchor: {
          turnId: 'product-turn-crash-window',
          rootUserMessageId: 'user-crash-window',
        },
      }),
    ]);
    const assistant = (await store.getSessionData(sessionId))?.messages[1];
    expect(assistant?.content).toContain('durable recovered answer');
    if (!usageAvailable) expect(assistant?.usage).toBeUndefined();
    await expect(turnReconciliation.reconcileDshTurnsAtStartup({
      productSessionId: sessionId,
      runtimeSessionId,
      controller: { readHistory, getTurn } as never,
    })).resolves.toEqual({ transcriptChanged: false, reconciledOperations: 1, settledTurnIds: ['product-turn-crash-window'] });
    expect((await store.getSessionData(sessionId))?.messages).toHaveLength(2);
    const inheritedMessages = (await store.getSessionData(sessionId))?.messages;
    const inheritedGet = vi.fn(async () => { throw new Error('Inherited history has no target operation'); });
    await expect(turnReconciliation.reconcileDshTurnsAtStartup({
      productSessionId: sessionId, runtimeSessionId,
      controller: { readHistory: async () => ({ ...(await readHistory()), inheritedEventCount: events.length }), getTurn: inheritedGet } as never,
    })).resolves.toEqual({ transcriptChanged: false, reconciledOperations: 0, settledTurnIds: ['product-turn-crash-window'] });
    expect(inheritedGet).not.toHaveBeenCalled();
    expect((await store.getSessionData(sessionId))?.messages).toEqual(inheritedMessages);
  });

  it('preserves the exact Product owner while a resumed DSH turn remains active', async () => {
    const sessionId = 'dsh-active-turn-takeover';
    const runtimeSessionId = `runtime-${sessionId}`;
    const metadata = createSessionMetadata('/tmp/dsh-workspace', {
      id: sessionId,
      runtimeBinding: createDshBinding('darwin-arm64'),
      runtimeSessionId,
      configSnapshotAt: '2026-08-30T00:00:00.000Z',
    });
    await store.saveSessionMetadata(metadata);
    const transcript = await store.loadSessionTranscript(sessionId);
    await expect(store.appendSessionMessages(sessionId, transcript.cursor, [{
      id: 'user-active-owner',
      role: 'user',
      content: 'continue this turn after restart',
      timestamp: '2026-08-30T00:00:00.000Z',
    }])).resolves.toMatchObject({ ok: true });

    const events = [
      {
        sequence: 0,
        eventType: 'myagents/operation/accepted',
        eventSha256: 'a'.repeat(64),
        data: {
          clientOperationId: 'operation-active-owner',
          clientUserMessageId: 'user-active-owner',
          productTurnId: 'product-turn-active-owner',
          acceptedAt: 1_777_507_200_000,
        },
      },
      { sequence: 1, eventType: 'turn/start', eventSha256: 'b'.repeat(64), data: { turn: 1 } },
      {
        sequence: 2,
        eventType: 'myagents/operation/claimed',
        eventSha256: 'c'.repeat(64),
        data: {
          clientOperationId: 'operation-active-owner',
          messageId: 'native-user-active-owner',
          dshTurn: 1,
        },
      },
    ];
    const readHistory = vi.fn(async () => ({
      runtimeSessionId,
      inheritedEventCount: 0,
      durableSequence: events.length,
      events,
      mutationBoundaries: [],
      transcriptPostcondition: 'f'.repeat(64),
    }));
    const getTurn = vi.fn(async () => ({
      clientOperationId: 'operation-active-owner',
      admission: {
        clientOperationId: 'operation-active-owner',
        turnId: 'product-turn-active-owner',
        admittedAt: new Date(1_777_507_200_000).toISOString(),
      },
    }));

    await expect(turnReconciliation.reconcileDshTurnsAtStartup({
      productSessionId: sessionId,
      runtimeSessionId,
      controller: { readHistory, getTurn } as never,
    })).resolves.toEqual({
      transcriptChanged: false,
      reconciledOperations: 0,
      settledTurnIds: [],
      activeTurn: {
        clientOperationId: 'operation-active-owner',
        clientUserMessageId: 'user-active-owner',
        productTurnId: 'product-turn-active-owner',
      },
    });
    expect(getTurn).toHaveBeenCalledWith('operation-active-owner', undefined);
    expect((await store.getSessionData(sessionId))?.messages).toEqual([
      expect.objectContaining({ id: 'user-active-owner', role: 'user' }),
    ]);
    expect(store.getSessionMetadata(sessionId)).toMatchObject({
      dshProjectionCursor: {
        schemaVersion: 1,
        runtimeSessionId,
        durableSequence: 3,
        transcriptPostcondition: 'f'.repeat(64),
      },
    });
  });

  it('retains an exact Product admission until native DSH terminal settlement', async () => {
    const sessionId = 'dsh-root-operation-journal';
    const runtimeSessionId = `runtime-${sessionId}`;
    await store.saveSessionMetadata(createSessionMetadata('/tmp/dsh-workspace', {
      id: sessionId,
      runtimeBinding: createDshBinding('darwin-arm64'),
      runtimeSessionId,
      configSnapshotAt: '2026-08-30T00:00:00.000Z',
    }));
    const transcript = await store.loadSessionTranscript(sessionId);
    const user: SessionMessage = {
      id: 'user-journal-owner',
      role: 'user',
      content: 'replay this exact input',
      timestamp: '2026-08-30T00:00:00.000Z',
    };

    await expect(store.beginDshRootOperation({
      sessionId,
      cursor: transcript.cursor,
      runtimeSessionId,
      clientOperationId: 'operation-journal-owner',
      userMessage: user,
      productImageSha256: [],
    })).resolves.toMatchObject({ success: true });
    await expect(store.discardUnpersistedDshRootOperation({
      sessionId,
      clientOperationId: 'operation-journal-owner',
      clientUserMessageId: user.id,
    })).resolves.toEqual({ success: true, value: { discarded: true } });

    await expect(store.beginDshRootOperation({
      sessionId,
      cursor: transcript.cursor,
      runtimeSessionId,
      clientOperationId: 'operation-journal-owner',
      userMessage: user,
      productImageSha256: [],
    })).resolves.toMatchObject({ success: true });
    await expect(store.appendSessionMessages(sessionId, transcript.cursor, [user]))
      .resolves.toMatchObject({ ok: true });

    const emptyHistory = vi.fn(async () => ({
      runtimeSessionId,
      inheritedEventCount: 0,
      durableSequence: 0,
      events: [],
      mutationBoundaries: [],
      transcriptPostcondition: '1'.repeat(64),
    }));
    await expect(turnReconciliation.reconcileDshTurnsAtStartup({
      productSessionId: sessionId,
      runtimeSessionId,
      controller: { readHistory: emptyHistory, getTurn: vi.fn() } as never,
    })).resolves.toEqual({ transcriptChanged: false, reconciledOperations: 0, settledTurnIds: [] });
    expect(store.getSessionMetadata(sessionId)?.pendingDshRootOperation).toMatchObject({
      clientOperationId: 'operation-journal-owner',
      clientUserMessageId: user.id,
      sourceRuntimeSessionId: runtimeSessionId,
    });

    const terminal = {
      kind: 'failed',
      code: 'provider_error',
      message: 'native terminal is authoritative',
      retryable: true,
    };
    const events = [
      {
        sequence: 0,
        eventType: 'myagents/operation/accepted',
        eventSha256: '2'.repeat(64),
        data: {
          clientOperationId: 'operation-journal-owner',
          clientUserMessageId: user.id,
          productTurnId: 'product-turn-journal-owner',
          acceptedAt: 1_777_507_200_000,
        },
      },
      {
        sequence: 1,
        eventType: 'myagents/operation/terminal',
        eventSha256: '3'.repeat(64),
        data: {
          clientOperationId: 'operation-journal-owner',
          productTurnId: 'product-turn-journal-owner',
          terminal,
          terminalAt: 1_777_507_201_000,
        },
      },
    ];
    await expect(turnReconciliation.reconcileDshTurnsAtStartup({
      productSessionId: sessionId,
      runtimeSessionId,
      controller: {
        readHistory: vi.fn(async () => ({
          runtimeSessionId,
          inheritedEventCount: 0,
          durableSequence: events.length,
          events,
          mutationBoundaries: [],
          transcriptPostcondition: '4'.repeat(64),
        })),
        getTurn: vi.fn(async () => ({
          clientOperationId: 'operation-journal-owner',
          admission: {
            clientOperationId: 'operation-journal-owner',
            turnId: 'product-turn-journal-owner',
            admittedAt: new Date(1_777_507_200_000).toISOString(),
          },
          terminal,
        })),
      } as never,
    })).resolves.toEqual({ transcriptChanged: false, reconciledOperations: 0, settledTurnIds: ['product-turn-journal-owner'] });
    expect(store.getSessionMetadata(sessionId)?.pendingDshRootOperation).toBeUndefined();
  });

  it('reconciles autonomous collaboration before a pending user without manufacturing a user row', async () => {
    const sessionId = 'dsh-collaboration-reconciliation';
    const runtimeSessionId = `runtime-${sessionId}`;
    await store.saveSessionMetadata(createSessionMetadata('/tmp/dsh-workspace', { id: sessionId,
      runtimeBinding: createDshBinding('darwin-arm64'), runtimeSessionId, configSnapshotAt: '2026-08-30T00:00:00.000Z' }));
    const transcript = await store.loadSessionTranscript(sessionId);
    await store.appendSessionMessages(sessionId, transcript.cursor, [{ id: 'pending-user', role: 'user', content: 'next request', timestamp: '2026-08-30T00:00:00.000Z',
      runtimeOperationAnchor: { runtime: 'dsh', runtimeSessionId, clientOperationId: 'pending-operation' } }]);
    const cursor = { schemaVersion: 1 as const, runtimeSessionId, durableSequence: 20, transcriptPostcondition: 'c'.repeat(64) };
    const assistant: SessionMessage = { id: 'auto-assistant', role: 'assistant', content: 'background result processed', timestamp: '2026-08-30T00:00:01.000Z',
      runtimeTurnAnchor: { turnId: 'auto-turn', clientOperationId: 'auto-operation', origin: 'collaboration' } };
    const native = { clientOperationId: 'auto-operation', clientUserMessageId: 'work-report', productTurnId: 'auto-turn', origin: 'collaboration' as const, terminal: true };
    const params = { sessionId, runtimeSessionId, cursor, assistantMessages: [assistant], nativeRootOperations: [native] };
    await expect(store.reconcileDshTurnProjections(params)).resolves.toMatchObject({ success: true, value: { transcriptChanged: true } });
    await expect(store.reconcileDshTurnProjections(params)).resolves.toMatchObject({ success: true, value: { transcriptChanged: false } });
    expect((await store.loadSessionTranscript(sessionId)).messages.map(message => [message.role, message.id])).toEqual([
      ['assistant', 'auto-assistant'], ['user', 'pending-user'],
    ]);
    await expect(store.reconcileDshTurnProjections({ ...params, nativeRootOperations: [{ ...native, origin: undefined }] })).resolves.toMatchObject({ success: false });
  });

  it.each(['before-append', 'after-append', 'cancelled'] as const)('reconciles a durable realtime input intent across process loss (%s)', async crashWindow => {
    const sessionId = `dsh-input-journal-${crashWindow}`;
    const runtimeSessionId = `runtime-${sessionId}`;
    await store.saveSessionMetadata(createSessionMetadata('/tmp/dsh-workspace', { id: sessionId,
      runtimeBinding: createDshBinding('darwin-arm64'), runtimeSessionId, configSnapshotAt: '2026-08-30T00:00:00.000Z' }));
    const transcript = await store.loadSessionTranscript(sessionId);
    await store.appendSessionMessages(sessionId, transcript.cursor, [{ id: 'root', role: 'user', content: 'begin', timestamp: '2026-08-30T00:00:00.000Z' }]);
    const userMessage: SessionMessage = { id: 'input', role: 'user', content: 'intervene', timestamp: '2026-08-30T00:00:00.100Z',
      runtimeOperationAnchor: { runtime: 'dsh', runtimeSessionId, clientOperationId: 'operation' } };
    const intent = { sessionId, runtimeSessionId, clientOperationId: 'operation', queueId: 'queue', userMessage,
      productImageSha256: [], runtimeInputFingerprint: 'a'.repeat(64) };
    const beforeIntent = store.getSessionMetadata(sessionId)!;
    await expect(store.beginDshInput(intent)).resolves.toMatchObject({ success: true });
    await expect(store.beginDshInput(intent)).resolves.toMatchObject({ success: true });
    await expect(store.beginDshInput({ ...intent, userMessage: { ...userMessage, content: 'changed retry' } })).resolves.toMatchObject({ success: false });
    expect(store.getSessionMetadata(sessionId)?.pendingDshInputs).toHaveLength(1);
    await store.saveSessionMetadata({ ...beforeIntent, title: 'Concurrent title update' });
    expect(store.getSessionMetadata(sessionId)?.pendingDshInputs).toHaveLength(1);
    const pendingSnapshot = store.getSessionMetadata(sessionId)!;
    await expect(store.updateSessionMetadata(sessionId, { runtimeSessionId: 'wrong-runtime' })).resolves.toBeNull();
    await expect(store.saveSessionMetadata({ ...pendingSnapshot, runtimeSessionId: 'wrong-runtime' })).rejects.toThrow('prevent changing Runtime');
    expect((await store.loadSessionTranscript(sessionId)).messages.map(message => message.id)).toEqual(['root']);
    if (crashWindow === 'after-append') {
      const current = await store.loadSessionTranscript(sessionId);
      await store.appendSessionMessages(sessionId, current.cursor, [userMessage]);
    }
    if (crashWindow === 'cancelled') {
      await expect(store.settleDshInput({ sessionId, clientOperationId: 'operation', clientUserMessageId: 'input', state: 'cancel_requested' })).resolves.toMatchObject({ success: true });
      expect(store.getSessionMetadata(sessionId)?.pendingDshInputs?.[0]?.state).toBe('cancel_requested');
    }
    const receipt = { clientOperationId: 'operation', clientUserMessageId: 'input', inputFingerprint: 'a'.repeat(64), sequence: 5,
      state: crashWindow === 'cancelled' ? 'cancelled' as const : 'consumed' as const };
    const params = { sessionId, runtimeSessionId,
      cursor: { schemaVersion: 1 as const, runtimeSessionId, durableSequence: 10, transcriptPostcondition: 'b'.repeat(64) },
      assistantMessages: [], nativeRootOperations: [{ clientOperationId: 'operation', clientUserMessageId: 'root', productTurnId: 'turn', terminal: false,
        consumedUserMessageIds: crashWindow === 'cancelled' ? [] : ['input'] }], nativeInputReceipts: [receipt] };
    await expect(store.reconcileDshTurnProjections({ ...params, nativeInputReceipts: [{ ...receipt, inputFingerprint: 'f'.repeat(64) }] })).resolves.toMatchObject({ success: false });
    expect(store.getSessionMetadata(sessionId)?.pendingDshInputs).toHaveLength(1);
    await expect(store.reconcileDshTurnProjections(params)).resolves.toMatchObject({ success: true });
    await expect(store.reconcileDshTurnProjections(params)).resolves.toMatchObject({ success: true, value: { transcriptChanged: false } });
    expect(store.getSessionMetadata(sessionId)?.pendingDshInputs).toBeUndefined();
    await store.saveSessionMetadata(pendingSnapshot);
    expect(store.getSessionMetadata(sessionId)?.pendingDshInputs).toBeUndefined();
    expect((await store.loadSessionTranscript(sessionId)).messages.map(message => message.id)).toEqual(crashWindow === 'cancelled' ? ['root'] : ['root', 'input']);
  });

  it.each(['user', 'collaboration'] as const)('recovers the assistant after exactly its consumed realtime users (%s)', async origin => {
    const sessionId = `dsh-realtime-${origin}`;
    const runtimeSessionId = `runtime-${sessionId}`;
    await store.saveSessionMetadata(createSessionMetadata('/tmp/dsh-workspace', { id: sessionId,
      runtimeBinding: createDshBinding('darwin-arm64'), runtimeSessionId, configSnapshotAt: '2026-08-30T00:00:00.000Z' }));
    const transcript = await store.loadSessionTranscript(sessionId);
    const user = (id: string): SessionMessage => ({ id, role: 'user', content: id, timestamp: '2026-08-30T00:00:00.000Z',
      runtimeOperationAnchor: { runtime: 'dsh', runtimeSessionId, clientOperationId: id === 'pending' ? 'next-operation' : 'operation' } });
    await store.appendSessionMessages(sessionId, transcript.cursor, [
      ...(origin === 'user' ? [user('root')] : []), user('realtime-1'), user('realtime-2'), user('pending'),
    ]);
    const native = { clientOperationId: 'operation', clientUserMessageId: 'root', productTurnId: 'turn', terminal: true,
      ...(origin === 'collaboration' ? { origin } : {}), consumedUserMessageIds: ['realtime-1', 'realtime-2'] };
    const assistant: SessionMessage = { id: 'recovered', role: 'assistant', content: 'answer', timestamp: '2026-08-30T00:00:01.000Z',
      runtimeTurnAnchor: origin === 'collaboration' ? { turnId: 'turn', origin, clientOperationId: 'operation' } : { turnId: 'turn', rootUserMessageId: 'root' } };
    const params = { sessionId, runtimeSessionId, cursor: { schemaVersion: 1 as const, runtimeSessionId, durableSequence: 20, transcriptPostcondition: 'a'.repeat(64) },
      assistantMessages: [assistant], nativeRootOperations: [native] };
    await expect(store.reconcileDshTurnProjections(params)).resolves.toMatchObject({ success: true, value: { transcriptChanged: true } });
    await expect(store.reconcileDshTurnProjections(params)).resolves.toMatchObject({ success: true, value: { transcriptChanged: false } });
    const ids = (await store.loadSessionTranscript(sessionId)).messages.map(message => message.id);
    expect(ids).toEqual([...(origin === 'user' ? ['root'] : []), 'realtime-1', 'realtime-2', 'recovered', 'pending']);
    await expect(store.reconcileDshTurnProjections({ ...params, nativeRootOperations: [{ ...native, consumedUserMessageIds: ['pending'] }] })).resolves.toMatchObject({ success: false });
    expect((await store.loadSessionTranscript(sessionId)).messages.map(message => message.id)).toEqual(ids);
  });

  it('publishes a missing terminal assistant exactly once with its verified native cursor', async () => {
    const sessionId = 'dsh-turn-reconciliation';
    const metadata = createSessionMetadata('/tmp/dsh-workspace', {
      id: sessionId,
      runtimeBinding: createDshBinding('darwin-arm64'),
      runtimeSessionId: `runtime-${sessionId}`,
      configSnapshotAt: '2026-08-30T00:00:00.000Z',
    });
    await store.saveSessionMetadata(metadata);
    const transcript = await store.loadSessionTranscript(sessionId);
    await expect(store.appendSessionMessages(sessionId, transcript.cursor, [{
      id: 'user-recovered',
      role: 'user',
      content: 'recover this turn',
      timestamp: '2026-08-30T00:00:00.000Z',
    }])).resolves.toMatchObject({ ok: true });
    const cursor = {
      schemaVersion: 1 as const,
      runtimeSessionId: `runtime-${sessionId}`,
      durableSequence: 12,
      transcriptPostcondition: 'c'.repeat(64),
    };
    const assistant: SessionMessage = {
      id: 'assistant-dsh-stable',
      role: 'assistant',
      content: JSON.stringify([{ type: 'text', text: 'recovered answer' }]),
      timestamp: '2026-08-30T00:00:01.000Z',
      usage: { inputTokens: 8, outputTokens: 2 },
      runtimeTurnAnchor: {
        turnId: 'product-turn-recovered',
        rootUserMessageId: 'user-recovered',
      },
    };

    await expect(store.reconcileDshTurnProjections({
      sessionId,
      runtimeSessionId: `runtime-${sessionId}`,
      cursor,
      assistantMessages: [assistant],
      nativeRootOperations: [{ clientOperationId: 'operation-recovered', clientUserMessageId: 'user-recovered', productTurnId: 'product-turn-recovered', terminal: true }],
      runtimeUsageTotals: { inputTokens: 8, outputTokens: 2 },
    })).resolves.toEqual({
      success: true,
      value: { transcriptChanged: true, cursor },
    });
    await expect(store.reconcileDshTurnProjections({
      sessionId,
      runtimeSessionId: `runtime-${sessionId}`,
      cursor,
      assistantMessages: [assistant],
      nativeRootOperations: [{ clientOperationId: 'operation-recovered', clientUserMessageId: 'user-recovered', productTurnId: 'product-turn-recovered', terminal: true }],
      runtimeUsageTotals: { inputTokens: 8, outputTokens: 2 },
    })).resolves.toEqual({
      success: true,
      value: { transcriptChanged: false, cursor },
    });

    expect((await store.getSessionData(sessionId))?.messages).toEqual([
      expect.objectContaining({ id: 'user-recovered' }),
      expect.objectContaining({
        id: 'assistant-dsh-stable',
        runtimeTurnAnchor: {
          turnId: 'product-turn-recovered',
          rootUserMessageId: 'user-recovered',
        },
      }),
    ]);
    expect(store.getSessionMetadata(sessionId)).toMatchObject({
      dshProjectionCursor: cursor,
      runtimeUsageTotals: { inputTokens: 8, outputTokens: 2 },
      stats: { messageCount: 1, totalInputTokens: 8, totalOutputTokens: 2 },
    });
  });

  it('repairs an anchored historical assistant from authoritative DSH content', async () => {
    const sessionId = 'dsh-turn-projection-repair';
    const metadata = createSessionMetadata('/tmp/dsh-workspace', {
      id: sessionId,
      runtimeBinding: createDshBinding('darwin-arm64'),
      runtimeSessionId: `runtime-${sessionId}`,
      configSnapshotAt: '2026-08-30T00:00:00.000Z',
    });
    await store.saveSessionMetadata(metadata);
    const transcript = await store.loadSessionTranscript(sessionId);
    await expect(store.appendSessionMessages(sessionId, transcript.cursor, [
      {
        id: 'user-stale-projection',
        role: 'user',
        content: 'inspect then answer',
        timestamp: '2026-08-30T00:00:00.000Z',
      },
      {
        id: 'assistant-live-id',
        role: 'assistant',
        content: JSON.stringify([
          { type: 'tool_use', tool: { id: 'call-1', name: 'Read', input: {}, inputJson: '{}', streamIndex: 0 } },
          { type: 'text', text: 'Done.' },
          { type: 'thinking', thinking: 'all reasoning incorrectly merged at the end', thinkingStreamIndex: 2, isComplete: true },
        ]),
        timestamp: '2026-08-30T00:00:02.000Z',
        durationMs: 400_000,
        runtimeTurnAnchor: {
          turnId: 'product-turn-repair',
          rootUserMessageId: 'user-stale-projection',
        },
      },
    ])).resolves.toMatchObject({ ok: true });

    const repairedContent = JSON.stringify([
      { type: 'thinking', thinking: 'inspect first', thinkingStreamIndex: 0, isComplete: true },
      { type: 'tool_use', tool: { id: 'call-1', name: 'Read', input: {}, inputJson: '{}', result: 'ok', streamIndex: 1 } },
      { type: 'text', text: 'Done.' },
    ]);
    const cursor = {
      schemaVersion: 1 as const,
      runtimeSessionId: `runtime-${sessionId}`,
      durableSequence: 20,
      transcriptPostcondition: 'd'.repeat(64),
    };
    await expect(store.reconcileDshTurnProjections({
      sessionId,
      runtimeSessionId: `runtime-${sessionId}`,
      cursor,
      assistantMessages: [{
        id: 'assistant-dsh-deterministic',
        role: 'assistant',
        content: repairedContent,
        timestamp: '2026-08-30T00:00:03.000Z',
        durationMs: 3_000,
        usage: { inputTokens: 10, outputTokens: 4 },
        toolCount: 1,
        runtimeTurnAnchor: {
          turnId: 'product-turn-repair',
          rootUserMessageId: 'user-stale-projection',
        },
      }],
      nativeRootOperations: [{ clientOperationId: 'operation-repair', clientUserMessageId: 'user-stale-projection', productTurnId: 'product-turn-repair', terminal: true }],
      runtimeUsageTotals: { inputTokens: 10, outputTokens: 4 },
    })).resolves.toEqual({
      success: true,
      value: { transcriptChanged: true, cursor },
    });

    expect((await store.getSessionData(sessionId))?.messages[1]).toEqual(expect.objectContaining({
      id: 'assistant-live-id',
      content: repairedContent,
      durationMs: 3_000,
      toolCount: 1,
    }));
  });

  it('retains an exact historical partial assistant owned by a non-success native terminal', async () => {
    const sessionId = 'dsh-partial-terminal-reconciliation';
    const runtimeSessionId = `runtime-${sessionId}`;
    const metadata = createSessionMetadata('/tmp/dsh-workspace', {
      id: sessionId,
      runtimeBinding: createDshBinding('darwin-arm64'),
      runtimeSessionId,
      configSnapshotAt: '2026-08-30T00:00:00.000Z',
    });
    await store.saveSessionMetadata(metadata);
    const transcript = await store.loadSessionTranscript(sessionId);
    const content = JSON.stringify([{ type: 'text', text: 'partial native output' }]);
    await expect(store.appendSessionMessages(sessionId, transcript.cursor, [
      {
        id: 'user-partial-terminal',
        role: 'user',
        content: 'run until interrupted',
        timestamp: '2026-08-30T00:00:00.000Z',
      },
      {
        id: 'assistant-partial-terminal',
        role: 'assistant',
        content,
        timestamp: '2026-08-30T00:00:01.000Z',
        completionState: 'partial',
        terminalStatus: 'stopped',
        runtimeTurnAnchor: {
          turnId: 'product-turn-partial-terminal',
          rootUserMessageId: 'user-partial-terminal',
        },
      },
    ])).resolves.toMatchObject({ ok: true });
    const cursor = {
      schemaVersion: 1 as const,
      runtimeSessionId,
      inheritedEventCount: 0,
      durableSequence: 21,
      transcriptPostcondition: 'e'.repeat(64),
    };
    const reconciliation = {
      sessionId,
      runtimeSessionId,
      cursor,
      assistantMessages: [],
      nativeRootOperations: [{
        clientOperationId: 'operation-partial-terminal',
        clientUserMessageId: 'user-partial-terminal',
        productTurnId: 'product-turn-partial-terminal',
        terminal: true,
        partialTerminalStatus: 'error' as const,
      }],
    };

    await expect(store.reconcileDshTurnProjections(reconciliation)).resolves.toEqual({
      success: true,
      value: { transcriptChanged: true, cursor },
    });
    await expect(store.reconcileDshTurnProjections(reconciliation)).resolves.toEqual({
      success: true,
      value: { transcriptChanged: false, cursor },
    });
    expect((await store.getSessionData(sessionId))?.messages[1]).toEqual(expect.objectContaining({
      id: 'assistant-partial-terminal',
      content,
      completionState: 'partial',
      terminalStatus: 'error',
      runtimeTurnAnchor: {
        turnId: 'product-turn-partial-terminal',
        rootUserMessageId: 'user-partial-terminal',
      },
    }));
  });

  it('keeps a fork hidden until Runtime and Product commit identities match', async () => {
    const sourceId = 'dsh-fork-source';
    const targetId = 'dsh-fork-target';
    await createDshSession(sourceId);

    const begun = await store.beginDshForkMutation({
      sourceSessionId: sourceId,
      sourceAssistantMessageId: 'assistant-1',
      clientMutationId: 'fork-mutation-1',
      targetProductSessionId: targetId,
      targetRuntimeSessionId: 'runtime-fork-target',
      targetRuntimeHome: '/tmp/dsh-fork-runtime-home',
      targetPersistenceRef: 'product-fork-target',
      targetWorkspaceIdentity: 'workspace-1',
    });
    expect(begun).toEqual(expect.objectContaining({ success: true }));
    if (!begun.success) return;
    expect(begun.value.targetMessages.map(message => message.id)).toEqual(['user-1', 'assistant-1']);

    await expect(store.recordPreparedDshFork({
      sourceSessionId: sourceId,
      clientMutationId: 'fork-mutation-1',
      token: 'fork-token-1',
      sourceStableBoundaryId: 'boundary-1',
    })).resolves.toMatchObject({ success: true });

    const target = createSessionMetadata('/tmp/dsh-workspace', snapshotForForkedSession(begun.value.source));
    target.id = targetId;
    target.runtimeSessionId = 'runtime-fork-target';
    target.materializationState = 'prepared';
    target.materializationSourceSessionId = sourceId;
    await expect(store.stageDshForkProduct({
      sourceSessionId: sourceId,
      clientMutationId: 'fork-mutation-1',
      targetMetadata: target,
      targetMessages: begun.value.targetMessages,
    })).resolves.toMatchObject({ success: true });
    expect(store.isHistoryVisibleSession(store.getSessionMetadata(targetId)!)).toBe(false);

    await expect(store.commitDshForkProduct({
      sourceSessionId: sourceId,
      clientMutationId: 'fork-mutation-1',
      token: 'fork-token-1',
    })).resolves.toMatchObject({ success: true });
    expect(store.getSessionMetadata(sourceId)?.pendingDshMutation).toBeUndefined();
    expect(store.isHistoryVisibleSession(store.getSessionMetadata(targetId)!)).toBe(true);
    expect((await store.getSessionData(targetId))?.messages.map(message => message.id)).toEqual(['user-1', 'assistant-1']);
  });

  it('finishes Product rewind after a crash between JSONL replacement and index publication', async () => {
    const sessionId = 'dsh-rewind-source';
    await createDshSession(sessionId);
    const begun = await store.beginDshRewindMutation({
      sessionId,
      targetUserMessageId: 'user-2',
      clientMutationId: 'rewind-mutation-1',
    });
    expect(begun).toEqual(expect.objectContaining({ success: true }));
    if (!begun.success) return;
    expect(begun.value.intent.targetRuntimeTurnId).toBe('turn-1');

    await expect(store.recordPreparedDshRewind({
      sessionId,
      clientMutationId: 'rewind-mutation-1',
      token: 'rewind-token-1',
      targetStableBoundaryId: 'boundary-1',
      sourceTranscriptPostcondition: 'a'.repeat(64),
      targetTranscriptPostcondition: 'b'.repeat(64),
    })).resolves.toMatchObject({ success: true });

    const transcriptPath = join(home, '.myagents', 'sessions', `${sessionId}.jsonl`);
    writeFileSync(
      transcriptPath,
      `${begun.value.targetMessages.map(message => JSON.stringify(message)).join('\n')}\n`,
      'utf8',
    );
    expect(JSON.parse(readFileSync(join(home, '.myagents', 'sessions.json'), 'utf8')))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sessionId, pendingDshMutation: expect.any(Object) }),
      ]));

    await expect(store.commitDshRewindProduct({
      sessionId,
      clientMutationId: 'rewind-mutation-1',
      token: 'rewind-token-1',
    })).resolves.toMatchObject({ success: true });
    expect(store.getSessionMetadata(sessionId)?.pendingDshMutation).toBeUndefined();
    expect((await store.getSessionData(sessionId))?.messages.map(message => message.id)).toEqual(['user-1', 'assistant-1']);
  });

  it('records the first Product user rewind against Runtime genesis', async () => {
    const sessionId = 'dsh-genesis-rewind-source';
    await createDshSession(sessionId);
    const begun = await store.beginDshRewindMutation({
      sessionId,
      targetUserMessageId: 'user-1',
      clientMutationId: 'genesis-rewind-mutation-1',
    });
    expect(begun).toEqual(expect.objectContaining({ success: true }));
    if (!begun.success) return;
    expect(begun.value.intent.targetRuntimeTurnId).toBeNull();
    expect(begun.value.targetMessages).toEqual([]);
  });

  it('replays exact fork prepare when the Runtime token was lost before Product fsync', async () => {
    const sourceId = 'dsh-fork-recovery-source';
    const targetId = 'dsh-fork-recovery-target';
    await createDshSession(sourceId);
    await expect(store.beginDshForkMutation({
      sourceSessionId: sourceId,
      sourceAssistantMessageId: 'assistant-1',
      clientMutationId: 'fork-recovery-1',
      targetProductSessionId: targetId,
      targetRuntimeSessionId: 'runtime-recovery-target',
      targetRuntimeHome: '/tmp/dsh-fork-recovery-home',
      targetPersistenceRef: 'product-recovery-target',
      targetWorkspaceIdentity: 'workspace-1',
    })).resolves.toMatchObject({ success: true });

    const prepareFork = vi.fn(async () => ({
      mutation: { token: 'fork-recovery-token', state: 'prepared' as const },
      boundary: {
        stableBoundaryId: 'boundary-1',
        sequence: 2,
        turn: 1,
        transcriptPostcondition: 'a'.repeat(64),
      },
    }));
    const commitFork = vi.fn(async () => ({
      token: 'fork-recovery-token',
      state: 'committed' as const,
    }));
    const controller = { prepareFork, commitFork };

    await expect(recovery.recoverPendingDshMutation({
      productSessionId: sourceId,
      runtimeSessionId: `runtime-${sourceId}`,
      binding: { state: 'recovery_required', unsettledMutations: ['fork'] },
      controller: controller as never,
    })).resolves.toEqual({ recovered: true, productDeleted: false });
    expect(prepareFork).toHaveBeenCalledWith(expect.objectContaining({
      clientMutationId: 'fork-recovery-1',
      targetRuntimeSessionId: 'runtime-recovery-target',
    }));
    expect(commitFork).toHaveBeenCalledWith('fork-recovery-1', 'fork-recovery-token');
    expect(store.getSessionMetadata(sourceId)?.pendingDshMutation).toBeUndefined();
    expect(store.isHistoryVisibleSession(store.getSessionMetadata(targetId)!)).toBe(true);
  });

  it('recovers a persisted fork abort decision without publishing a target', async () => {
    const sourceId = 'dsh-fork-abort-source';
    const targetId = 'dsh-fork-abort-target';
    await createDshSession(sourceId);
    await expect(store.beginDshForkMutation({
      sourceSessionId: sourceId,
      sourceAssistantMessageId: 'assistant-1',
      clientMutationId: 'fork-abort-1',
      targetProductSessionId: targetId,
      targetRuntimeSessionId: 'runtime-abort-target',
      targetRuntimeHome: '/tmp/dsh-fork-abort-home',
      targetPersistenceRef: 'product-abort-target',
      targetWorkspaceIdentity: 'workspace-1',
    })).resolves.toMatchObject({ success: true });
    await expect(store.recordPreparedDshFork({
      sourceSessionId: sourceId,
      clientMutationId: 'fork-abort-1',
      token: 'fork-abort-token',
      sourceStableBoundaryId: 'boundary-1',
    })).resolves.toMatchObject({ success: true });
    await expect(store.requestDshForkAbort({
      sourceSessionId: sourceId,
      clientMutationId: 'fork-abort-1',
      token: 'fork-abort-token',
    })).resolves.toMatchObject({ success: true });

    const forkStatus = vi.fn(async () => ({
      token: 'fork-abort-token',
      state: 'prepared' as const,
    }));
    const abortFork = vi.fn(async () => ({
      token: 'fork-abort-token',
      state: 'aborted' as const,
    }));
    await expect(recovery.recoverPendingDshMutation({
      productSessionId: sourceId,
      runtimeSessionId: `runtime-${sourceId}`,
      binding: { state: 'recovery_required', unsettledMutations: ['fork'] },
      controller: { forkStatus, abortFork } as never,
    })).resolves.toEqual({ recovered: true, productDeleted: false });

    expect(abortFork).toHaveBeenCalledWith('fork-abort-1', 'fork-abort-token');
    expect(store.getSessionMetadata(sourceId)?.pendingDshMutation).toBeUndefined();
    expect(store.getSessionMetadata(targetId)).toBeNull();
  });

  it.each(['prepared', 'purged'] as const)('recovers delete from %s through physical purge and Product removal', async initialState => {
    const sessionId = 'dsh-delete-recovery-source';
    await createDshSession(sessionId);
    await expect(store.beginDshDeleteMutation({
      sessionId,
      clientMutationId: 'delete-recovery-1',
    })).resolves.toMatchObject({ success: true });

    const prepareDelete = vi.fn(async () => ({
      token: 'delete-recovery-token',
      state: initialState,
    }));
    const commitDelete = vi.fn(async () => ({
      token: 'delete-recovery-token',
      state: 'committed' as const,
    }));
    const purgeDelete = vi.fn(async () => ({
      token: 'delete-recovery-token',
      state: 'purged' as const,
    }));

    await expect(recovery.recoverPendingDshMutation({
      productSessionId: sessionId,
      runtimeSessionId: `runtime-${sessionId}`,
      binding: { state: 'recovery_required', unsettledMutations: ['delete'] },
      controller: { prepareDelete, commitDelete, purgeDelete } as never,
    })).resolves.toEqual({ recovered: true, productDeleted: true });
    expect(prepareDelete).toHaveBeenCalledWith('delete-recovery-1');
    if (initialState === 'prepared') expect(commitDelete).toHaveBeenCalledWith('delete-recovery-1', 'delete-recovery-token');
    else expect(commitDelete).not.toHaveBeenCalled();
    expect(purgeDelete).toHaveBeenCalledWith('delete-recovery-1', 'delete-recovery-token');
    expect(store.getSessionMetadata(sessionId)).toBeNull();
  });
});
