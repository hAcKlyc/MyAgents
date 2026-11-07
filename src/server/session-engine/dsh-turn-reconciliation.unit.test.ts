import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  DshNativeHistory,
  DshTurnLookup,
  DshVerifiedHistoryEvent,
} from '../integrated-runtimes/dsh/mutations';
import {
  buildDshTurnProjectionSnapshot,
} from './dsh-turn-reconciliation';

const runtimeSessionId = 'runtime-session-ordinary-recovery';

function event(sequence: number, eventType: string, data: unknown): DshVerifiedHistoryEvent {
  return {
    sequence,
    eventType,
    eventSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    data,
  };
}

function durableEventId(sequence: number): string {
  const sessionHash = createHash('sha256').update(runtimeSessionId).digest('hex').slice(0, 24);
  return `dsh-event-${sessionHash}-${sequence}`;
}

function succeededHistory(usage: unknown = {
  inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2,
}): {
  history: DshNativeHistory;
  lookups: ReadonlyMap<string, DshTurnLookup>;
} {
  const terminal = {
    kind: 'succeeded',
    assistantEventId: durableEventId(6),
    ...(usage === 'omitted' ? {} : { usage }),
  };
  const events = [
    event(0, 'myagents/operation/accepted', {
      clientOperationId: 'operation-1',
      clientUserMessageId: 'user-1',
      productTurnId: 'product-turn-1',
      acceptedAt: 1_000,
    }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'myagents/operation/claimed', {
      clientOperationId: 'operation-1',
      messageId: 'native-user-1',
      dshTurn: 1,
    }),
    event(3, 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'native-assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        content: [
          { type: 'reasoning', text: 'check the workspace' },
          { type: 'tool-call', id: 'call-1', name: 'Read', arguments: '{"file_path":"/tmp/a"}' },
        ],
      },
      usage: { inputTokens: 5, outputTokens: 3 },
    }),
    event(4, 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'Read',
      arguments: '{"file_path":"/tmp/a"}',
    }),
    event(5, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'native-tool-result-1',
        role: 'tool',
        source: { kind: 'tool' },
        toolCallId: 'call-1',
        isError: false,
        content: [{ type: 'text', text: 'file body' }],
      },
    }),
    event(6, 'assistant/message', {
      turn: 1,
      step: 2,
      message: {
        id: 'native-assistant-2',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        content: [{ type: 'text', text: 'Done.' }],
      },
      usage: { inputTokens: 6, outputTokens: 4 },
    }),
    event(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(8, 'myagents/operation/terminal', {
      clientOperationId: 'operation-1',
      productTurnId: 'product-turn-1',
      terminal,
      finalDshTurn: 1,
      terminalAt: 2_000,
    }),
  ];
  return {
    history: {
      runtimeSessionId,
      inheritedEventCount: 0,
      durableSequence: events.length,
      events,
      mutationBoundaries: [],
      transcriptPostcondition: 'a'.repeat(64),
    },
    lookups: new Map([[
      'operation-1',
      {
        clientOperationId: 'operation-1',
        admission: {
          clientOperationId: 'operation-1',
          turnId: 'product-turn-1',
          admittedAt: new Date(1_000).toISOString(),
        },
        terminal,
      },
    ]]),
  };
}

describe('DSH ordinary turn reconciliation', () => {

  it('keeps inherited terminals as history without querying or rebuilding target operations', () => {
    const fixture = succeededHistory();
    const history = { ...fixture.history, runtimeSessionId: 'independent-fork', inheritedEventCount: fixture.history.events.length };
    const snapshot = buildDshTurnProjectionSnapshot(history, new Map());
    expect(snapshot.assistantTurns).toEqual([]);
    expect(snapshot.unsettledTurns).toEqual([]);
    expect(snapshot.rootOperations).toEqual([expect.objectContaining({ inherited: true, terminal: true, productTurnId: 'product-turn-1' })]);
    expect(() => buildDshTurnProjectionSnapshot({ ...history, inheritedEventCount: 0 }, new Map()))
      .toThrow('DSH accepted operation is absent from turn/get');
    expect(() => buildDshTurnProjectionSnapshot({ ...history, inheritedEventCount: history.events.length - 1 }, new Map()))
      .toThrow('DSH inherited terminal exceeds its native prefix');
  });
  it('does not turn a usage-only lookup difference into a conflicting operation outcome', () => {
    const fixture = succeededHistory('omitted');
    const lookup = fixture.lookups.get('operation-1')!;
    const lookups = new Map([['operation-1', {
      ...lookup, terminal: { ...lookup.terminal, usage: { inputTokens: 11, outputTokens: 7 } },
    }]]);
    const snapshot = buildDshTurnProjectionSnapshot(fixture.history, lookups);
    expect(snapshot.assistantTurns).toHaveLength(1);
    expect(snapshot.assistantTurns[0]!.assistantMessage.usage).toBeUndefined();
  });

  it.each(['missing-first', 'missing-last', 'overflow'])(
    'keeps both replies without presenting a partial or overflowing total: %s', scenario => {
      const first = succeededHistory(scenario === 'missing-first' ? 'omitted'
        : { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 });
      const next = succeededHistory(scenario === 'missing-last' ? 'omitted'
        : { inputTokens: 1, outputTokens: 1 });
      const lookup = next.lookups.get('operation-1')!;
      const terminal = { ...lookup.terminal!, assistantEventId: durableEventId(15) };
      const events = next.history.events.map(candidate => {
        const data = { ...(candidate.data as Record<string, unknown>) };
        if (data.clientOperationId) data.clientOperationId = 'operation-2';
        if (data.clientUserMessageId) data.clientUserMessageId = 'user-2';
        if (data.productTurnId) data.productTurnId = 'product-turn-2';
        if (data.turn) data.turn = 2;
        if (data.dshTurn) { data.dshTurn = 2; data.messageId = 'native-user-2'; }
        if (data.finalDshTurn) { data.finalDshTurn = 2; data.terminal = terminal; }
        return event(candidate.sequence + 9, candidate.eventType, data);
      });
      const history = { ...first.history, events: [...first.history.events, ...events], durableSequence: 18 };
      const lookups = new Map([...first.lookups, ['operation-2', {
        ...lookup, clientOperationId: 'operation-2', terminal,
        admission: { ...lookup.admission!, clientOperationId: 'operation-2', turnId: 'product-turn-2' },
      }] as const]);
      const snapshot = buildDshTurnProjectionSnapshot(history, lookups);
      expect(snapshot.assistantTurns).toHaveLength(2);
      expect(snapshot.runtimeUsageTotals).toBeUndefined();
      expect(snapshot.unsettledTurns).toEqual([]);
    },
  );

  it.each(['omitted', null, 'unavailable', {}, { inputTokens: -1, outputTokens: 2 }])(
    'recovers the successful answer when optional usage is unavailable: %j', usage => {
      const fixture = succeededHistory(usage);
      const snapshot = buildDshTurnProjectionSnapshot(fixture.history, fixture.lookups);
      expect(snapshot.assistantTurns).toHaveLength(1);
      expect(snapshot.assistantTurns[0]!.assistantMessage.content).toContain('Done.');
      expect(snapshot.assistantTurns[0]!.assistantMessage.usage).toBeUndefined();
      expect(snapshot.runtimeUsageTotals).toBeUndefined();
      expect(snapshot.rootOperations[0]?.terminal).toBe(true);
      expect(snapshot.unsettledTurns).toEqual([]);
    },
  );

  it('accepts different realtime inputs claimed in one turn and excludes collaboration and cancelled input', () => {
    const fixture = succeededHistory();
    const events = [...fixture.history.events.slice(0, 6),
      event(6, 'myagents/operation/message', { clientOperationId: 'operation-1', messageId: 'user-2', clientMessageId: 'user-2', kind: 'follow_up', state: 'queued', inputFingerprint: 'a'.repeat(64) }),
      event(7, 'myagents/operation/claimed', { clientOperationId: 'operation-1', messageId: 'user-2', dshTurn: 1 }),
      event(8, 'myagents/operation/message', { clientOperationId: 'operation-1', messageId: 'report', clientMessageId: 'report', kind: 'follow_up', state: 'queued', inputFingerprint: 'a'.repeat(64), contextMessage: true }),
      event(9, 'myagents/operation/claimed', { clientOperationId: 'operation-1', messageId: 'report', dshTurn: 1 }),
      event(10, 'myagents/operation/message', { clientOperationId: 'operation-1', messageId: 'cancelled-user', clientMessageId: 'cancelled-user', kind: 'follow_up', state: 'queued', inputFingerprint: 'a'.repeat(64) }),
      event(11, 'myagents/operation/message', { clientOperationId: 'operation-1', messageId: 'cancelled-user', clientMessageId: 'cancelled-user', kind: 'follow_up', state: 'cancelled' }),
      ...fixture.history.events.slice(6).map(candidate => ({ ...candidate, sequence: candidate.sequence + 6 })),
    ];
    const terminal = { ...fixture.lookups.get('operation-1')!.terminal!, assistantEventId: durableEventId(12) };
    events[14] = event(14, 'myagents/operation/terminal', { ...(events[14]!.data as object), terminal });
    const history = { ...fixture.history, events, durableSequence: events.length };
    const lookups = new Map([['operation-1', { ...fixture.lookups.get('operation-1')!, terminal }]]);
    expect(buildDshTurnProjectionSnapshot(history, lookups).rootOperations[0]?.consumedUserMessageIds).toEqual(['user-2']);
    const duplicate = events.map(candidate => candidate.sequence === 9
      ? event(9, 'myagents/operation/claimed', { clientOperationId: 'operation-1', messageId: 'user-2', dshTurn: 1 }) : candidate);
    expect(() => buildDshTurnProjectionSnapshot({ ...history, events: duplicate }, lookups)).toThrow('repeats one message claim');
    const cancelled = events.map(candidate => candidate.sequence === 9
      ? event(9, 'myagents/operation/claimed', { clientOperationId: 'operation-1', messageId: 'cancelled-user', dshTurn: 1 }) : candidate);
    expect(() => buildDshTurnProjectionSnapshot({ ...history, events: cancelled }, lookups)).toThrow('contradicts its native receipt');
  });

  it('recovers a collaboration assistant with a native operation anchor and no invented user', () => {
    const fixture = succeededHistory();
    const history = { ...fixture.history, events: fixture.history.events.map(event => event.eventType === 'myagents/operation/accepted'
      ? { ...event, data: { ...(event.data as object), rootContextMessage: true } } : event) };
    const lookups = new Map([...fixture.lookups].map(([id, value]) => [id, { ...value, admission: { ...value.admission!, origin: 'collaboration' as const } }]));
    const snapshot = buildDshTurnProjectionSnapshot(history, lookups);
    expect(snapshot.rootOperations[0]).toMatchObject({ origin: 'collaboration' });
    expect(snapshot.assistantTurns[0]?.assistantMessage.runtimeTurnAnchor).toEqual({ turnId: 'product-turn-1', origin: 'collaboration', clientOperationId: 'operation-1' });
    expect(() => buildDshTurnProjectionSnapshot(history, fixture.lookups)).toThrow('admission differs');
  });

  it('derives one stable Product assistant from matching session/read and turn/get truth', () => {
    const fixture = succeededHistory();
    const snapshot = buildDshTurnProjectionSnapshot(fixture.history, fixture.lookups);

    expect(snapshot.cursor).toEqual({
      schemaVersion: 1,
      runtimeSessionId,
      durableSequence: 9,
      transcriptPostcondition: 'a'.repeat(64),
    });
    expect(snapshot.runtimeUsageTotals).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
    });
    expect(snapshot.assistantTurns).toHaveLength(1);
    const recovered = snapshot.assistantTurns[0]!.assistantMessage;
    expect(recovered.id).toMatch(/^assistant-dsh-[a-f0-9]{32}$/u);
    expect(recovered.completedAt).toBe(new Date(2_000).toISOString());
    expect(recovered.runtimeTurnAnchor).toEqual({
      turnId: 'product-turn-1',
      rootUserMessageId: 'user-1',
    });
    expect(recovered.usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      model: 'deepseek-v4-flash',
    });
    expect(JSON.parse(recovered.content)).toEqual([
      {
        type: 'thinking',
        thinking: 'check the workspace',
        thinkingStreamIndex: 0,
        isComplete: true,
      },
      {
        type: 'tool_use',
        tool: {
          id: 'call-1',
          name: 'Read',
          input: { file_path: '/tmp/a' },
          inputJson: '{\n  "file_path": "/tmp/a"\n}',
          result: 'file body',
          isError: false,
          streamIndex: 1,
        },
      },
      { type: 'text', text: 'Done.' },
    ]);
  });

  it('keeps one Product tool completion when DSH prunes its model-visible result', () => {
    const fixture = succeededHistory();
    const original = fixture.history.events[5]!;
    const replacement = structuredClone(original.data) as { message: { content: unknown[] } };
    replacement.message.content = [{ type: 'text', text: 'Pruned result' }];
    const events = [
      ...fixture.history.events.slice(0, 7),
      event(7, 'tool/result', replacement),
      ...fixture.history.events.slice(7).map(candidate => ({ ...candidate, sequence: candidate.sequence + 1 })),
    ];
    const history = { ...fixture.history, durableSequence: events.length, events };
    const snapshot = buildDshTurnProjectionSnapshot(history, fixture.lookups);
    const content = JSON.parse(snapshot.assistantTurns[0]!.assistantMessage.content) as Array<{ tool?: { result?: string } }>;
    expect(content.find(block => block.tool)?.tool?.result).toBe('file body');

    replacement.message.content = [{ type: 'text', text: 'Pruned result' }];
    const changedIdentity = structuredClone(replacement) as typeof replacement & { step: number };
    changedIdentity.step = 9;
    const invalid = { ...history, events: events.map(candidate => candidate.sequence === 7
      ? event(7, 'tool/result', changedIdentity) : candidate) };
    expect(() => buildDshTurnProjectionSnapshot(invalid, fixture.lookups))
      .toThrow('DSH repeated tool-result changed its durable identity');
  });

  it.each([
    { result: undefined, failed: undefined },
    { result: [{ title: 'Public reference', url: 'https://example.com/' }], failed: false },
    { result: { type: 'web_search_tool_result_error', error_code: 'unavailable' }, failed: true },
    { result: "Provider supplied an unfamiliar search format", failed: false },
  ])('preserves Provider-owned calls and result evidence during cold reconstruction: $failed', ({ result, failed }) => {
    const fixture = succeededHistory();
    const source = fixture.history.events[6]!;
    const data = structuredClone(source.data) as { message: { content: unknown[] } };
    data.message.content.unshift({
      type: 'provider-tool-call', id: 'search-1', name: 'renamed_search', input: { query: 'public fixture' },
      providerType: 'server_tool_use',
    });
    if (result !== undefined) data.message.content.push({
      type: 'provider-tool-result', toolCallId: 'search-1', providerType: 'tool_result', content: result,
    });
    const history = { ...fixture.history, events: fixture.history.events.map(item => item === source ? event(6, source.eventType, data) : item) };
    const snapshot = buildDshTurnProjectionSnapshot(history, fixture.lookups);
    const message = snapshot.assistantTurns[0]!.assistantMessage;
    const content = JSON.parse(message.content) as Array<{ type: string; tool?: { result?: string; isError?: boolean; name: string } }>;
    const provider = content.find(block => block.type === 'server_tool_use');
    expect(provider?.tool?.name).toBe('renamed_search');
    expect(provider?.tool?.isError).toBe(failed);
    if (result === undefined || typeof result === 'string') expect(provider?.tool?.result).toBe(result);
    else expect(JSON.parse(provider?.tool?.result ?? 'null')).toEqual(result);
    expect(message.toolCount).toBe(1);
  });

  it('does not manufacture an assistant for a failed terminal', () => {
    const fixture = succeededHistory();
    const failed = { kind: 'failed', code: 'provider_error', message: 'failed', retryable: true };
    const events = fixture.history.events.map(candidate => candidate.eventType === 'myagents/operation/terminal'
      ? event(candidate.sequence, candidate.eventType, {
          clientOperationId: 'operation-1',
          productTurnId: 'product-turn-1',
          terminal: failed,
          finalDshTurn: 1,
          terminalAt: 2_000,
        })
      : candidate);
    const snapshot = buildDshTurnProjectionSnapshot(
      { ...fixture.history, events },
      new Map([['operation-1', {
        ...fixture.lookups.get('operation-1')!,
        terminal: failed,
      }]]),
    );
    expect(snapshot.assistantTurns).toEqual([]);
    expect(snapshot.runtimeUsageTotals).toBeUndefined();
    expect(snapshot.rootOperations).toEqual([{
      clientOperationId: 'operation-1',
      clientUserMessageId: 'user-1',
      productTurnId: 'product-turn-1',
      terminal: true,
      partialTerminalStatus: 'error',
    }]);
  });

  it('classifies an aborted terminal as a stopped partial owner without manufacturing content', () => {
    const fixture = succeededHistory();
    const aborted = { kind: 'aborted', reason: 'user' };
    const events = fixture.history.events.map(candidate => candidate.eventType === 'myagents/operation/terminal'
      ? event(candidate.sequence, candidate.eventType, {
          clientOperationId: 'operation-1',
          productTurnId: 'product-turn-1',
          terminal: aborted,
          finalDshTurn: 1,
          terminalAt: 2_000,
        })
      : candidate);
    const snapshot = buildDshTurnProjectionSnapshot(
      { ...fixture.history, events },
      new Map([['operation-1', {
        ...fixture.lookups.get('operation-1')!,
        terminal: aborted,
      }]]),
    );
    expect(snapshot.assistantTurns).toEqual([]);
    expect(snapshot.rootOperations[0]).toMatchObject({
      terminal: true,
      partialTerminalStatus: 'stopped',
    });
  });

  it('fails closed when turn/get disagrees with the durable terminal', () => {
    const fixture = succeededHistory();
    const lookup = fixture.lookups.get('operation-1')!;
    expect(() => buildDshTurnProjectionSnapshot(
      fixture.history,
      new Map([['operation-1', {
        ...lookup,
        terminal: { ...lookup.terminal, assistantEventId: durableEventId(3) },
      }]]),
    )).toThrow(/turn\/get terminal differs/u);
  });

  it('preserves the exact owner of a resumed admitted turn that remains non-terminal', () => {
    const fixture = succeededHistory();
    const history = {
      ...fixture.history,
      durableSequence: 8,
      events: fixture.history.events.filter(event => event.eventType !== 'myagents/operation/terminal'),
    };
    const admission = fixture.lookups.get('operation-1')!.admission!;
    const snapshot = buildDshTurnProjectionSnapshot(
      history,
      new Map([['operation-1', { clientOperationId: 'operation-1', admission }]]),
    );
    expect(snapshot.unsettledTurns).toEqual([{
      clientOperationId: 'operation-1',
      clientUserMessageId: 'user-1',
      productTurnId: 'product-turn-1',
    }]);

  });
});
