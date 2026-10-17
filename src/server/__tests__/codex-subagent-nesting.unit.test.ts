// PRD 0.2.27 — Codex sub-agent (collab-agent) tool nesting: thread correlation.
//
// These cover the PURE decision logic that decides whether a Codex item's tool
// events nest under a spawn card (and which one). The stateful glue (handler
// stamping, external-session routing) is exercised by typecheck + manual runs;
// the brittle, easy-to-regress part is the thread→card resolution, tested here.

import { describe, expect, it, vi } from 'vitest';

import {
  resolveTopLevelSpawnCard,
  parseSubAgentThreadSource,
  recordSpawnAgentChildThreads,
  computeSubAgentScope,
  isChildThreadGatedMethod,
  resolveCollabAgentControlParents,
  subagentControlToolUseId,
  buildCollabAgentControlStartEvents,
  buildCollabAgentControlCompletedEvents,
  resolveCollabControlCompletionRoute,
  applyCodexSubAgentActivity,
  CodexRuntime,
  computeCodexItemEventRoute,
  dispatchCodexItemEvent,
  flushResolvableCodexSubAgentEvents,
  collectCodexSubAgentLifecycleEvents,
  buildCodexReasoningDeltaEvents,
  takeCodexReasoningStopEvents,
  mapCodexChildTurnTerminalStatus,
} from '../runtimes/codex';
import type { UnifiedEvent } from '../runtimes/types';

describe('resolveTopLevelSpawnCard', () => {
  it('returns null for the main thread (no card, no parent) → renders flat', () => {
    expect(resolveTopLevelSpawnCard('main', new Map(), new Map())).toBeNull();
  });

  it('returns null for an unknown thread (the higher-level route owns defer vs main)', () => {
    const cards = new Map([['child', 'cardA']]);
    expect(resolveTopLevelSpawnCard('stranger', cards, new Map())).toBeNull();
  });

  it('resolves a direct child to its spawn card', () => {
    const cards = new Map([['child', 'cardA']]);
    const parents = new Map([['child', 'main']]);
    expect(resolveTopLevelSpawnCard('child', cards, parents)).toBe('cardA');
  });

  it('attributes a grandchild tool to the TOP-LEVEL (first-level) spawn card', () => {
    // main → spawns A (cardA on main); A → spawns B (cardB on A). B runs a tool.
    // One-level UI: B's tool nests under cardA, not cardB.
    const cards = new Map([['A', 'cardA'], ['B', 'cardB']]);
    const parents = new Map([['A', 'main'], ['B', 'A']]);
    expect(resolveTopLevelSpawnCard('B', cards, parents)).toBe('cardA');
  });

  it('attributes a deep (3-level) descendant to the first-level card', () => {
    const cards = new Map([['A', 'cardA'], ['B', 'cardB'], ['C', 'cardC']]);
    const parents = new Map([['A', 'main'], ['B', 'A'], ['C', 'B']]);
    expect(resolveTopLevelSpawnCard('C', cards, parents)).toBe('cardA');
  });

  it('is cycle-safe (malformed parent chain does not hang)', () => {
    const cards = new Map([['X', 'cardX']]);
    const parents = new Map([['X', 'Y'], ['Y', 'X']]); // X→Y→X loop
    // X has a card; the highest-ancestor card seen wins; loop is bounded by visited.
    expect(resolveTopLevelSpawnCard('X', cards, parents)).toBe('cardX');
  });

  it('walks past intermediate threads that have no card', () => {
    // child has no card itself but its parent (a spawned thread) does.
    const cards = new Map([['A', 'cardA']]);
    const parents = new Map([['child', 'A'], ['A', 'main']]);
    expect(resolveTopLevelSpawnCard('child', cards, parents)).toBe('cardA');
  });
});

describe('parseSubAgentThreadSource', () => {
  it('extracts parent + nickname + role from a thread_spawn source (snake_case wire)', () => {
    const thread = {
      id: 'child-1',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: 'main',
            depth: 0,
            agent_nickname: 'henan-worker',
            agent_role: 'data-backfill',
          },
        },
      },
    };
    expect(parseSubAgentThreadSource(thread)).toEqual({
      parentThreadId: 'main',
      nickname: 'henan-worker',
      role: 'data-backfill',
    });
  });

  it('falls back to Thread-level agentNickname/agentRole when spawn names absent', () => {
    const thread = {
      id: 'child-2',
      agentNickname: 'fallback-nick',
      agentRole: 'fallback-role',
      source: { subagent: { thread_spawn: { parent_thread_id: 'main' } } },
    };
    expect(parseSubAgentThreadSource(thread)).toEqual({
      parentThreadId: 'main',
      nickname: 'fallback-nick',
      role: 'fallback-role',
    });
  });

  it('tolerates the legacy camelCase outer variant key (subAgent)', () => {
    // v2 app-server uses "subagent" (lowercase); the legacy root schema uses
    // "subAgent". Parser accepts both so a Codex version drift can't silently
    // kill correlation.
    const thread = {
      id: 'child-3',
      source: { subAgent: { thread_spawn: { parent_thread_id: 'main', agent_nickname: 'n', agent_role: 'r' } } },
    };
    expect(parseSubAgentThreadSource(thread)).toEqual({ parentThreadId: 'main', nickname: 'n', role: 'r' });
  });

  it('returns null for a non-subagent source (e.g. a user thread)', () => {
    expect(parseSubAgentThreadSource({ id: 't', source: 'cli' })).toBeNull();
  });

  it('returns null for review/compact string sub-agent sources (no thread_spawn)', () => {
    expect(parseSubAgentThreadSource({ id: 't', source: { subagent: 'review' } })).toBeNull();
  });

  it('returns null when parent_thread_id is missing', () => {
    expect(parseSubAgentThreadSource({ id: 't', source: { subagent: { thread_spawn: {} } } })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseSubAgentThreadSource(undefined)).toBeNull();
    expect(parseSubAgentThreadSource('x')).toBeNull();
  });
});

describe('recordSpawnAgentChildThreads', () => {
  it('maps each receiver thread to the spawn card for spawnAgent', () => {
    const proc = { subThreadToCard: new Map<string, string>() };
    recordSpawnAgentChildThreads(proc, 'spawnAgent', 'card-1', ['c1', 'c2']);
    expect(proc.subThreadToCard.get('c1')).toBe('card-1');
    expect(proc.subThreadToCard.get('c2')).toBe('card-1');
  });

  it('does NOT remap for wait/closeAgent/sendInput (they reference existing children)', () => {
    const proc = { subThreadToCard: new Map<string, string>([['c1', 'spawn-card']]) };
    recordSpawnAgentChildThreads(proc, 'wait', 'wait-card', ['c1']);
    recordSpawnAgentChildThreads(proc, 'closeAgent', 'close-card', ['c1']);
    recordSpawnAgentChildThreads(proc, 'sendInput', 'send-card', ['c1']);
    // still points at the original spawn card, not the wait/close/send card
    expect(proc.subThreadToCard.get('c1')).toBe('spawn-card');
  });

  it('is a no-op when receiverThreadIds is empty/missing (item/started before assignment)', () => {
    const proc = { subThreadToCard: new Map<string, string>() };
    recordSpawnAgentChildThreads(proc, 'spawnAgent', 'card-1', []);
    recordSpawnAgentChildThreads(proc, 'spawnAgent', 'card-1', undefined);
    expect(proc.subThreadToCard.size).toBe(0);
  });
});

describe('computeSubAgentScope', () => {
  const cards = new Map([['child', 'cardA']]);
  const parents = new Map([['child', 'main']]);
  const meta = new Map([['child', { nickname: 'nick', role: 'role' }]]);

  it('returns null for a main-thread item (the spawn card itself stays flat)', () => {
    expect(computeSubAgentScope('main', 'main', cards, parents, meta)).toBeNull();
  });

  it('returns null when threadId is undefined', () => {
    expect(computeSubAgentScope(undefined, 'main', cards, parents, meta)).toBeNull();
  });

  it('returns null for an unmapped thread (the item router defers it instead of flattening)', () => {
    expect(computeSubAgentScope('orphan', 'main', cards, parents, meta)).toBeNull();
  });

  it('does not resolve a descendant through an ancestor whose spawn link has not arrived yet', () => {
    expect(computeSubAgentScope(
      'grandchild',
      'main',
      new Map([['grandchild', 'nested-spawn']]),
      new Map([['grandchild', 'child']]),
      new Map(),
    )).toBeNull();
    expect(computeSubAgentScope(
      'grandchild',
      'main',
      new Map([['grandchild', 'nested-spawn']]),
      new Map([['grandchild', 'child'], ['child', 'main']]),
      new Map(),
    )).toBeNull();
  });

  it('returns the spawn card + nickname/role for a sub-agent thread item', () => {
    expect(computeSubAgentScope('child', 'main', cards, parents, meta)).toEqual({
      parentToolUseId: 'cardA',
      nickname: 'nick',
      role: 'role',
    });
  });

  it('returns scope with undefined nickname/role when meta is absent', () => {
    expect(computeSubAgentScope('child', 'main', cards, parents, new Map())).toEqual({
      parentToolUseId: 'cardA',
      nickname: undefined,
      role: undefined,
    });
  });
});

describe('computeCodexItemEventRoute', () => {
  const cards = new Map([['child', 'spawn-card']]);
  const parents = new Map([['child', 'main']]);

  it('keeps main-thread items on the main transcript', () => {
    expect(computeCodexItemEventRoute('main', 'main', cards, parents, new Map())).toEqual({ kind: 'main' });
  });

  it('scopes a correlated child item to its parent card', () => {
    expect(computeCodexItemEventRoute('child', 'main', cards, parents, new Map())).toEqual({
      kind: 'subagent',
      scope: { parentToolUseId: 'spawn-card', nickname: undefined, role: undefined },
    });
  });

  it('defers an uncorrelated foreign-thread item instead of rendering it flat', () => {
    expect(computeCodexItemEventRoute('unknown-child', 'main', cards, parents, new Map())).toEqual({ kind: 'defer' });
  });
});

describe('applyCodexSubAgentActivity (Codex 0.144.1 multi-agent v2)', () => {
  function state() {
    return {
      subThreadToCard: new Map<string, string>(),
      subThreadToParent: new Map<string, string>(),
      subThreadMeta: new Map<string, { nickname?: string; role?: string }>(),
    };
  }

  function parserState() {
    return {
      ...state(),
      threadId: 'main',
      agentMessageTextById: new Map<string, string>(),
      currentTurnId: 'root-turn',
      activeSteerTurnId: 'root-turn',
      deferredSubAgentEvents: new Map<string, UnifiedEvent[]>(),
      collabControlToolParents: new Map<string, string[]>(),
      activeSubAgentTurns: new Map<string, string | null>(),
      completedSubAgentTurnsBeforeActivity: new Set<string>(),
      subAgentThreadsAwaitingActivity: new Set<string>(),
      codexV2SubAgentActivityObserved: false,
      codexV2InteractionDeliveryByCallId: new Map<string, 'queue-only' | 'trigger-turn'>(),
      exactUsageByTurn: new Map(),
      subAgentActivitySeenBeforeTurnStart: new Set<string>(),
      subAgentLifecycleByThread: new Map(),
      emittedSubAgentLifecycleByCard: new Map(),
      openedReasoningTracesByItem: new Map(),
      subAgentInterruptsInFlight: new Map<string, Promise<void>>(),
      pendingMainTurnCompletion: null as UnifiedEvent[] | null,
      interruptPendingSubAgentTurns: false,
      releaseHeldMainTurnOnExit: false,
      exited: false,
      rpc: { call: vi.fn(async () => ({})) },
    };
  }

  it.each(['corrected', 'o', ''])('preserves a completed native text correction (%s) for the product transcript', finalText => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parse = (runtime as unknown as {
      parseNotification: (proc: typeof correlation, method: string, params: unknown, emit: (event: UnifiedEvent) => void) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);
    parse(correlation, 'item/agentMessage/delta', { threadId: 'main', itemId: 'item', delta: 'old' }, () => {});
    expect(parse(correlation, 'item/completed', { threadId: 'main', item: { id: 'item', type: 'agentMessage', text: finalText } }, () => {}))
      .toMatchObject({ kind: 'text_stop', traceId: 'main::item', nativeText: finalText });
  });

  it.each([
    { streamed: '', final: 'Choose a destination', tail: 'Choose a destination' },
    { streamed: 'Choose', final: 'Choose a destination', tail: ' a destination' },
    { streamed: 'Choose', final: 'Choose', tail: '' },
    { streamed: '', final: '', tail: '' },
  ])('preserves async questions at agentMessage completion ($streamed → $final)', ({ streamed, final, tail }) => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parse = (runtime as unknown as {
      parseNotification: (proc: typeof correlation, method: string, params: unknown, emit: (event: UnifiedEvent) => void) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);
    if (streamed) parse(correlation, 'item/agentMessage/delta', { threadId: 'main', itemId: 'question-item', delta: streamed }, () => {});
    const questions = [{ title: 'Where?', options: ['Beach', 'Mountains'] }];
    const result = parse(correlation, 'item/completed', { threadId: 'main', item: { id: 'question-item', type: 'agentMessage', text: final, delivery: 'async', questions } }, () => {});
    const events = Array.isArray(result) ? result : [result];
    expect(events).toEqual([
      ...(tail ? [{ kind: 'text_delta', text: tail, traceId: 'main::question-item' }] : []),
      { kind: 'text_stop', nativeText: final, traceId: 'main::question-item', asyncQuestions: { id: 'main::question-item', questions } },
    ]);
    expect(correlation.agentMessageTextById.size).toBe(0);
  });

  it('keeps Codex 0.162 partial answers and subsequent tools in the same native turn', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parse = (runtime as unknown as {
      parseNotification: (proc: typeof correlation, method: string, params: unknown, emit: (event: UnifiedEvent) => void) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);
    const emitted: UnifiedEvent[] = [];
    const notify = (method: string, params: Record<string, unknown>) => {
      const result = parse(correlation, method, { threadId: 'main', turnId: 'root-turn', ...params }, event => emitted.push(event));
      if (Array.isArray(result)) emitted.push(...result);
      else if (result) emitted.push(result);
    };

    notify('item/agentMessage/delta', { itemId: 'partial', delta: 'First result.' });
    notify('item/completed', { item: { id: 'partial', type: 'agentMessage', phase: 'partial_answer', text: 'First result.' } });
    expect(emitted).toContainEqual({ kind: 'text_stop', nativeText: 'First result.', traceId: 'main::partial' });
    expect(runtime.canSteerMessage(correlation as never)).toBe(true);

    notify('item/started', { item: { id: 'command', type: 'commandExecution', command: 'check', cwd: '/workspace' } });
    notify('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'check', aggregatedOutput: 'checked', exitCode: 0 } });
    expect(emitted).toContainEqual(expect.objectContaining({ kind: 'tool_result', toolUseId: 'command', content: 'checked' }));

    notify('item/agentMessage/delta', { itemId: 'final', delta: 'Final result.' });
    notify('item/completed', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Final result.' } });
    expect(emitted).toContainEqual({ kind: 'text_stop', nativeText: 'Final result.', traceId: 'main::final' });
    expect(emitted.filter(event => event.kind === 'turn_complete')).toEqual([]);
    expect(runtime.canSteerMessage(correlation as never)).toBe(true);

    notify('turn/completed', { turn: { id: 'root-turn', rootTurnId: 'root-turn', status: 'completed' } });
    expect(emitted.filter(event => event.kind === 'turn_complete')).toEqual([{ kind: 'turn_complete', status: 'completed' }]);
    expect(runtime.canSteerMessage(correlation as never)).toBe(false);
    expect(correlation.agentMessageTextById.size).toBe(0);
  });

  it('does not treat the Codex 0.162 additional_tools catalog as a subagent invocation', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const emit = vi.fn();
    const parse = (runtime as unknown as {
      parseNotification: (proc: typeof correlation, method: string, params: unknown, emit: (event: UnifiedEvent) => void) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    expect(parse(correlation, 'rawResponseItem/completed', {
      threadId: 'main', turnId: 'root-turn',
      item: { type: 'additional_tools', role: 'system', tools: [{ type: 'function', name: 'followup_task' }] },
    }, emit)).toBeNull();
    expect(emit).not.toHaveBeenCalled();
    expect(correlation.codexV2SubAgentActivityObserved).toBe(false);
    expect(correlation.codexV2InteractionDeliveryByCallId.size).toBe(0);
    expect(runtime.canSteerMessage(correlation as never)).toBe(true);

    expect(parse(correlation, 'rawResponseItem/completed', {
      threadId: 'main', turnId: 'root-turn',
      item: { type: 'function_call', call_id: 'followup-call', name: 'followup_task', arguments: '{}' },
    }, emit)).toBeNull();
    expect(correlation.codexV2SubAgentActivityObserved).toBe(true);
    expect(correlation.codexV2InteractionDeliveryByCallId.get('followup-call')).toBe('trigger-turn');
  });

  it.each([
    { version: 'legacy', metadata: {} },
    { version: '0.162.1', metadata: { model: 'gpt-6.1-sol', reasoningEffort: 'ultra' } },
  ])('correlates a $version started activity with its parent CollabAgent card', ({ metadata }) => {
    const correlation = state();
    const events = applyCodexSubAgentActivity(correlation, 'main', 'main', {
      type: 'subAgentActivity',
      id: 'spawn-call',
      kind: 'started',
      agentThreadId: 'child',
      agentPath: '/root/reviewer',
      ...metadata,
    });

    expect(correlation.subThreadToCard.get('child')).toBe('spawn-call');
    expect(correlation.subThreadToParent.get('child')).toBe('main');
    expect(events).toHaveLength(3);
    expect(events?.[0]).toMatchObject({
      kind: 'tool_use_start',
      toolUseId: 'spawn-call',
      toolName: 'CollabAgent',
      input: {
        tool: 'spawnAgent',
        activityKind: 'started',
        agentPath: '/root/reviewer',
        senderThreadId: 'main',
        receiverThreadIds: ['child'],
      },
    });
    expect(events?.every((event) => !('subAgent' in event) || event.subAgent === undefined)).toBe(true);
  });

  it('nests a descendant spawn under the existing top-level card', () => {
    const correlation = state();
    correlation.subThreadToCard.set('child', 'top-spawn');
    correlation.subThreadToParent.set('child', 'main');

    const events = applyCodexSubAgentActivity(correlation, 'child', 'main', {
      type: 'subAgentActivity',
      id: 'nested-spawn',
      kind: 'started',
      agentThreadId: 'grandchild',
      agentPath: '/root/reviewer/checker',
    });

    expect(correlation.subThreadToCard.get('grandchild')).toBe('nested-spawn');
    expect(correlation.subThreadToParent.get('grandchild')).toBe('child');
    expect(events?.every((event) => (
      'subAgent' in event && event.subAgent?.parentToolUseId === 'top-spawn'
    ))).toBe(true);
    expect(computeSubAgentScope(
      'grandchild',
      'main',
      correlation.subThreadToCard,
      correlation.subThreadToParent,
      correlation.subThreadMeta,
    )?.parentToolUseId).toBe('top-spawn');
  });

  it('uses a main-thread interaction as the new turn-local container for a resumed child', () => {
    const correlation = state();
    const events = applyCodexSubAgentActivity(correlation, 'main', 'main', {
      type: 'subAgentActivity',
      id: 'followup-call',
      kind: 'interacted',
      agentThreadId: 'resumed-child',
      agentPath: '/root/reviewer',
    });

    expect(correlation.subThreadToCard.get('resumed-child')).toBe('followup-call');
    expect(events?.[0]).toMatchObject({
      kind: 'tool_use_start',
      toolUseId: 'followup-call',
      toolName: 'CollabAgent',
      input: { tool: 'sendInput', activityKind: 'interacted' },
    });
    expect(events?.every((event) => !('subAgent' in event) || event.subAgent === undefined)).toBe(true);
  });

  it('keeps child-to-parent interactions inside the child\'s existing card', () => {
    const correlation = state();
    correlation.subThreadToCard.set('child', 'spawn-card');
    correlation.subThreadToParent.set('child', 'main');

    const events = applyCodexSubAgentActivity(correlation, 'child', 'main', {
      type: 'subAgentActivity',
      id: 'message-call',
      kind: 'interacted',
      agentThreadId: 'main',
      agentPath: '/root',
    });

    expect(events?.[0]).toMatchObject({
      kind: 'tool_use_start',
      toolUseId: 'message-call',
      input: { tool: 'sendInput', activityKind: 'interacted' },
      subAgent: { parentToolUseId: 'spawn-card' },
    });
  });

  it('records a child-to-child interaction even while the sender ancestor is unresolved', () => {
    const correlation = state();
    const events = applyCodexSubAgentActivity(correlation, 'child-a', 'main', {
      type: 'subAgentActivity',
      id: 'message-to-b',
      kind: 'interacted',
      agentThreadId: 'child-b',
      agentPath: '/root/a/b',
    });

    expect(correlation.subThreadToCard.get('child-b')).toBe('message-to-b');
    expect(correlation.subThreadToParent.get('child-b')).toBe('child-a');
    expect(events?.[0]).not.toHaveProperty('subAgent');

    applyCodexSubAgentActivity(correlation, 'main', 'main', {
      type: 'subAgentActivity',
      id: 'spawn-a',
      kind: 'started',
      agentThreadId: 'child-a',
      agentPath: '/root/a',
    });
    expect(computeSubAgentScope(
      'child-b',
      'main',
      correlation.subThreadToCard,
      correlation.subThreadToParent,
      correlation.subThreadMeta,
    )?.parentToolUseId).toBe('spawn-a');
  });

  it('preserves interrupt semantics instead of presenting it as agent shutdown', () => {
    const correlation = state();
    correlation.subThreadToCard.set('child', 'spawn-card');
    correlation.subThreadToParent.set('child', 'main');

    const events = applyCodexSubAgentActivity(correlation, 'main', 'main', {
      type: 'subAgentActivity',
      id: 'interrupt-call',
      kind: 'interrupted',
      agentThreadId: 'child',
      agentPath: '/root/reviewer',
    });

    expect(events?.[0]).toMatchObject({
      kind: 'tool_use_start',
      input: { tool: 'interruptAgent', activityKind: 'interrupted' },
      subAgent: { parentToolUseId: 'spawn-card' },
    });
  });

  it('rejects malformed activity items without mutating correlation state', () => {
    const correlation = state();
    expect(applyCodexSubAgentActivity(correlation, 'main', 'main', {
      type: 'subAgentActivity',
      id: 'broken',
      kind: 'started',
    })).toBeNull();
    expect(correlation.subThreadToCard.size).toBe(0);
  });

  it('is wired to the real item/completed notification parser', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    const events = parseNotification(correlation, 'item/completed', {
      threadId: 'main',
      turnId: 'turn-1',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-call',
        kind: 'started',
        agentThreadId: 'child',
        agentPath: '/root/reviewer',
      },
    }, () => {});

    expect(Array.isArray(events) ? events.map((event) => event.kind) : []).toEqual([
      'tool_use_start',
      'tool_use_stop',
      'tool_result',
    ]);
    expect(correlation.subThreadToCard.get('child')).toBe('spawn-call');
    expect(correlation.activeSubAgentTurns).toEqual(new Map([['child', null]]));
  });

  it('holds a successful main terminal until the spawned child turn completes', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.subThreadToCard.set('child', 'spawn-call');
    correlation.subThreadToParent.set('child', 'main');
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    expect(parseNotification(correlation, 'turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn' },
    }, () => {})).toBeNull();
    expect(correlation.activeSubAgentTurns).toEqual(new Map([['child', 'child-turn']]));
    expect(runtime.canSteerMessage?.(correlation as never)).toBe(true);

    expect(parseNotification(correlation, 'turn/completed', {
      threadId: 'main',
      turn: { id: 'root-turn', status: 'completed' },
    }, () => {})).toBeNull();
    expect(correlation.pendingMainTurnCompletion?.[0]).toMatchObject({ kind: 'turn_complete' });
    expect(correlation.currentTurnId).toBe('root-turn');
    expect(runtime.canSteerMessage?.(correlation as never)).toBe(false);
    expect(computeCodexItemEventRoute(
      'child',
      'main',
      correlation.subThreadToCard,
      correlation.subThreadToParent,
      correlation.subThreadMeta,
    ).kind).toBe('subagent');

    const terminal = parseNotification(correlation, 'turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed' },
    }, () => {});
    expect(Array.isArray(terminal) ? terminal : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'subagent_lifecycle', status: 'running' }),
      expect.objectContaining({ kind: 'subagent_lifecycle', status: 'completed' }),
      expect.objectContaining({ kind: 'turn_complete', status: 'completed' }),
      expect.objectContaining({ kind: 'agent_plan_update' }),
    ]));
    expect(correlation.subThreadToCard.size).toBe(0);
    expect(correlation.pendingMainTurnCompletion).toBeNull();
  });

  it('does not resurrect a child that completed before its started activity arrived', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    correlation.codexV2SubAgentActivityObserved = true;

    parseNotification(correlation, 'turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn' },
    }, () => {});
    parseNotification(correlation, 'turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed' },
    }, () => {});
    expect(correlation.completedSubAgentTurnsBeforeActivity).toEqual(new Set(['child']));

    parseNotification(correlation, 'item/completed', {
      threadId: 'main',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-call',
        kind: 'started',
        agentThreadId: 'child',
        agentPath: '/root/reviewer',
      },
    }, () => {});
    expect(correlation.activeSubAgentTurns.size).toBe(0);
    expect(correlation.completedSubAgentTurnsBeforeActivity.size).toBe(0);
  });

  it('preserves an exact child turn id when started activity arrives later', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    correlation.codexV2SubAgentActivityObserved = true;

    parseNotification(correlation, 'turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn-before-activity' },
    }, () => {});
    parseNotification(correlation, 'item/completed', {
      threadId: 'main',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-call',
        kind: 'started',
        agentThreadId: 'child',
        agentPath: '/root/reviewer',
      },
    }, () => {});

    expect(correlation.activeSubAgentTurns).toEqual(new Map([
      ['child', 'child-turn-before-activity'],
    ]));
  });

  it('interrupts exact active child turns when force-send targets a held root terminal', async () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.pendingMainTurnCompletion = [{ kind: 'turn_complete', status: 'completed' }];
    correlation.activeSubAgentTurns.set('child', 'child-turn');

    await runtime.interruptTurn(correlation as never);

    expect(correlation.rpc.call).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'child',
      turnId: 'child-turn',
    }, 3_000);
    expect(correlation.rpc.call).not.toHaveBeenCalledWith('turn/interrupt', expect.objectContaining({
      threadId: 'main',
    }), 3_000);
    expect(correlation.interruptPendingSubAgentTurns).toBe(true);
  });

  it('restarts the runtime when a held-root child interrupt cannot be confirmed', async () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.pendingMainTurnCompletion = [{ kind: 'turn_complete', status: 'interrupted' }];
    correlation.activeSubAgentTurns.set('child', 'child-turn');
    correlation.rpc.call.mockRejectedValueOnce(new Error('interrupt RPC timed out'));
    const stopSession = vi.spyOn(runtime, 'stopSession').mockResolvedValue();

    await runtime.interruptTurn(correlation as never);

    expect(stopSession).toHaveBeenCalledWith(correlation, 'failure');
    expect(correlation.releaseHeldMainTurnOnExit).toBe(true);
  });

  it('does not restart when child settlement wins an in-flight interrupt race', async () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.pendingMainTurnCompletion = [{ kind: 'turn_complete', status: 'completed' }];
    correlation.activeSubAgentTurns.set('child', 'child-turn');
    let rejectInterrupt!: (error: Error) => void;
    correlation.rpc.call.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectInterrupt = reject;
    }));
    const stopSession = vi.spyOn(runtime, 'stopSession').mockResolvedValue();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    const interrupt = runtime.interruptTurn(correlation as never);
    const terminal = parseNotification(correlation, 'turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed' },
    }, () => {});
    rejectInterrupt(new Error('already completed'));
    await interrupt;

    expect((Array.isArray(terminal) ? terminal : [terminal]).find(event => event?.kind === 'turn_complete')).toMatchObject({
      kind: 'turn_complete',
      status: 'completed',
    });
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('single-flights concurrent interrupts for the same child turn', async () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.pendingMainTurnCompletion = [{ kind: 'turn_complete', status: 'completed' }];
    correlation.activeSubAgentTurns.set('child', 'child-turn');
    let resolveInterrupt!: () => void;
    correlation.rpc.call.mockImplementationOnce(() => new Promise((resolve) => {
      resolveInterrupt = () => resolve({});
    }));

    const first = runtime.interruptTurn(correlation as never);
    const second = runtime.interruptTurn(correlation as never);
    expect(correlation.rpc.call).toHaveBeenCalledTimes(1);
    resolveInterrupt();
    await Promise.all([first, second]);
  });

  it('uses the restart fallback when a late child turn id cannot be interrupted', async () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.pendingMainTurnCompletion = [{ kind: 'turn_complete', status: 'interrupted' }];
    correlation.activeSubAgentTurns.set('child', null);
    correlation.interruptPendingSubAgentTurns = true;
    correlation.rpc.call.mockRejectedValueOnce(new Error('late interrupt rejected'));
    const stopSession = vi.spyOn(runtime, 'stopSession').mockResolvedValue();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    parseNotification(correlation, 'turn/started', {
      threadId: 'child',
      turn: { id: 'late-child-turn' },
    }, () => {});

    expect(correlation.rpc.call).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'child',
      turnId: 'late-child-turn',
    }, 3_000);
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledWith(correlation, 'failure'));
    expect(correlation.releaseHeldMainTurnOnExit).toBe(true);
  });

  it('releases a fallback-held root terminal exactly once at process exit', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.pendingMainTurnCompletion = [{ kind: 'turn_complete', status: 'interrupted' }];
    correlation.activeSubAgentTurns.set('child', 'child-turn');
    correlation.releaseHeldMainTurnOnExit = true;
    const takeHeld = (runtime as unknown as {
      takeHeldMainTurnForProcessExit: (proc: typeof correlation) => UnifiedEvent[] | null;
    }).takeHeldMainTurnForProcessExit.bind(runtime);

    expect(takeHeld(correlation)).toEqual([{ kind: 'turn_complete', status: 'interrupted' }]);
    expect(takeHeld(correlation)).toBeNull();
    expect(correlation.activeSubAgentTurns.size).toBe(0);
  });

  it('holds an interrupted root terminal and interrupts its still-running children', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.activeSubAgentTurns.set('child', 'child-turn');
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    expect(parseNotification(correlation, 'turn/completed', {
      threadId: 'main',
      turn: { id: 'root-turn', status: 'interrupted' },
    }, () => {})).toBeNull();
    expect(correlation.pendingMainTurnCompletion?.[0]).toMatchObject({
      kind: 'turn_complete',
      status: 'interrupted',
    });
    expect(correlation.rpc.call).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'child',
      turnId: 'child-turn',
    }, 3_000);
  });

  it('releases a held root terminal when the child closes without a turn terminal', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.subThreadToCard.set('child', 'spawn-call');
    correlation.subThreadToParent.set('child', 'main');
    correlation.activeSubAgentTurns.set('child', 'child-turn');
    correlation.pendingMainTurnCompletion = [{ kind: 'turn_complete', status: 'completed' }];
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    const terminal = parseNotification(correlation, 'thread/closed', {
      threadId: 'child',
    }, () => {});
    expect((Array.isArray(terminal) ? terminal : [terminal]).find(event => event?.kind === 'turn_complete')).toMatchObject({
      kind: 'turn_complete',
      status: 'completed',
    });
    expect(correlation.activeSubAgentTurns.size).toBe(0);
  });

  it('fences known-child output until its interacted activity is emitted', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.subThreadToCard.set('child', 'spawn-call');
    correlation.subThreadToParent.set('child', 'main');
    const emitted: UnifiedEvent[] = [];
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    correlation.codexV2SubAgentActivityObserved = true;

    parseNotification(correlation, 'turn/started', {
      threadId: 'child',
      turn: { id: 'interaction-turn' },
    }, () => {});
    dispatchCodexItemEvent(correlation, 'child', {
      kind: 'text_delta',
      text: 'response to the new interaction',
    }, (event) => emitted.push(event));
    expect(emitted).toEqual([]);

    const activityEvents = parseNotification(correlation, 'item/completed', {
      threadId: 'main',
      item: {
        type: 'subAgentActivity',
        id: 'interaction-call',
        kind: 'interacted',
        agentThreadId: 'child',
        agentPath: '/root/reviewer',
      },
    }, () => {});
    for (const event of Array.isArray(activityEvents) ? activityEvents : [activityEvents!]) {
      dispatchCodexItemEvent(correlation, 'main', event, (next) => emitted.push(next));
    }
    flushResolvableCodexSubAgentEvents(correlation, (event) => emitted.push(event));

    expect(emitted.map((event) => event.kind)).toEqual([
      'tool_use_start',
      'tool_use_stop',
      'tool_result',
      'text_delta',
    ]);
    expect(correlation.subAgentThreadsAwaitingActivity.size).toBe(0);
  });

  it('lets turn/started claim ownership after an earlier interacted activity', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.subThreadToCard.set('child', 'spawn-call');
    correlation.subThreadToParent.set('child', 'main');
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    parseNotification(correlation, 'item/completed', {
      threadId: 'main',
      item: {
        type: 'subAgentActivity',
        id: 'interaction-call',
        kind: 'interacted',
        agentThreadId: 'child',
        agentPath: '/root/reviewer',
      },
    }, () => {});
    expect(correlation.activeSubAgentTurns.size).toBe(0);
    expect(correlation.subAgentActivitySeenBeforeTurnStart).toEqual(new Set(['child']));

    parseNotification(correlation, 'turn/started', {
      threadId: 'child',
      turn: { id: 'late-interaction-turn' },
    }, () => {});
    expect(correlation.activeSubAgentTurns).toEqual(new Map([
      ['child', 'late-interaction-turn'],
    ]));
    expect(correlation.subAgentThreadsAwaitingActivity.size).toBe(0);
    expect(correlation.subAgentActivitySeenBeforeTurnStart.size).toBe(0);
  });

  it('ignores Codex 0.155 configuration updates without exposing raw data or changing subagent routing', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const emit = vi.fn();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    expect(parseNotification(correlation, 'rawResponseItem/completed', {
      threadId: 'main',
      turnId: 'root-turn',
      item: { type: 'configuration_update', reasoning: { effort: 'ultra' } },
    }, emit)).toBeNull();
    expect(emit).not.toHaveBeenCalled();
    expect(correlation.codexV2InteractionDeliveryByCallId.size).toBe(0);
    expect(correlation.codexV2SubAgentActivityObserved).toBe(false);
  });

  it('does not hold the root terminal for a raw-discriminated queue-only interaction', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.subThreadToCard.set('child', 'spawn-call');
    correlation.subThreadToParent.set('child', 'main');
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    parseNotification(correlation, 'rawResponseItem/completed', {
      threadId: 'main',
      turnId: 'root-turn',
      item: {
        type: 'function_call',
        name: 'send_message',
        call_id: 'queue-only-message',
        arguments: '{"target":"child","message":"note"}',
      },
    }, () => {});

    parseNotification(correlation, 'item/completed', {
      threadId: 'main',
      item: {
        type: 'subAgentActivity',
        id: 'queue-only-message',
        kind: 'interacted',
        agentThreadId: 'child',
        agentPath: '/root/reviewer',
      },
    }, () => {});
    const terminal = parseNotification(correlation, 'turn/completed', {
      threadId: 'main',
      turn: { id: 'root-turn', status: 'completed' },
    }, () => {});

    expect((Array.isArray(terminal) ? terminal : [terminal]).find(event => event?.kind === 'turn_complete')).toMatchObject({
      kind: 'turn_complete',
      status: 'completed',
    });
    expect(correlation.pendingMainTurnCompletion).toBeNull();
  });

  it('emits one exact main-turn usage delta from unique raw Responses completions', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    const first = {
      threadId: 'main',
      turnId: 'root-turn',
      responseId: 'response-1',
      usage: {
        totalTokens: 150,
        inputTokens: 100,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 10,
        outputTokens: 50,
        reasoningOutputTokens: 20,
      },
    };
    parseNotification(correlation, 'rawResponse/completed', first, () => {});
    parseNotification(correlation, 'rawResponse/completed', {
      threadId: 'main',
      turnId: 'root-turn',
      responseId: 'response-2',
      usage: {
        totalTokens: 110,
        inputTokens: 80,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 5,
        outputTokens: 30,
        reasoningOutputTokens: 10,
      },
    }, () => {});
    parseNotification(correlation, 'rawResponse/completed', first, () => {}); // replayed duplicate
    parseNotification(correlation, 'rawResponse/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      responseId: 'child-response',
      usage: { inputTokens: 999, outputTokens: 999 },
    }, () => {});

    const terminal = parseNotification(correlation, 'turn/completed', {
      threadId: 'main',
      turn: { id: 'root-turn', status: 'completed' },
    }, () => {});

    expect(terminal).toEqual([
      {
        kind: 'usage',
        inputTokens: 180,
        outputTokens: 80,
        cacheReadTokens: 60,
        cacheCreationTokens: 15,
        semantics: 'delta',
      },
      { kind: 'turn_complete', status: 'completed' },
      { kind: 'agent_plan_update', todos: [] },
    ]);
  });

  it('falls back to thread totals when any raw response omits provider usage', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    const runningTotal = parseNotification(correlation, 'thread/tokenUsage/updated', {
      threadId: 'main',
      turnId: 'root-turn',
      tokenUsage: {
        total: {
          inputTokens: 1_100,
          outputTokens: 110,
          cachedInputTokens: 900,
          cacheWriteInputTokens: 50,
        },
        last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 },
        modelContextWindow: 272_000,
      },
    }, () => {});
    expect(runningTotal).toEqual({
      kind: 'usage',
      inputTokens: 1_100,
      outputTokens: 110,
      semantics: 'running_total',
      contextOccupiedTokens: 100,
      runtimeContextWindow: 272_000,
    });

    parseNotification(correlation, 'rawResponse/completed', {
      threadId: 'main',
      turnId: 'root-turn',
      responseId: 'with-usage',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 0,
      },
    }, () => {});
    parseNotification(correlation, 'rawResponse/completed', {
      threadId: 'main',
      turnId: 'root-turn',
      responseId: 'missing-usage',
      usage: null,
    }, () => {});

    const terminal = parseNotification(correlation, 'turn/completed', {
      threadId: 'main',
      turn: { id: 'root-turn', status: 'completed' },
    }, () => {});
    expect(Array.isArray(terminal) ? terminal.map((event) => event.kind) : []).toEqual([
      'turn_complete',
      'agent_plan_update',
    ]);
  });

  it('reserves a child turn for raw-discriminated followup_task before turn/started', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    parseNotification(correlation, 'rawResponseItem/completed', {
      threadId: 'main',
      turnId: 'root-turn',
      item: {
        type: 'function_call',
        name: 'followup_task',
        call_id: 'followup-call',
        arguments: '{"target":"child","message":"continue"}',
      },
    }, () => {});
    parseNotification(correlation, 'item/completed', {
      threadId: 'main',
      item: {
        type: 'subAgentActivity',
        id: 'followup-call',
        kind: 'interacted',
        agentThreadId: 'child',
        agentPath: '/root/reviewer',
      },
    }, () => {});

    expect(correlation.activeSubAgentTurns).toEqual(new Map([['child', null]]));
    expect(parseNotification(correlation, 'turn/completed', {
      threadId: 'main',
      turn: { id: 'root-turn', status: 'completed' },
    }, () => {})).toBeNull();

    parseNotification(correlation, 'turn/started', {
      threadId: 'child',
      turn: { id: 'followup-turn' },
    }, () => {});
    const terminal = parseNotification(correlation, 'turn/completed', {
      threadId: 'child',
      turn: { id: 'followup-turn', status: 'completed' },
    }, () => {});

    expect((Array.isArray(terminal) ? terminal : [terminal]).find(event => event?.kind === 'turn_complete')).toMatchObject({
      kind: 'turn_complete',
      status: 'completed',
    });
  });

  it('rebinds a same-root completed child to the trigger-turn follow-up card', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.subThreadToCard.set('child', 'spawn-card');
    correlation.subThreadToParent.set('child', 'main');
    correlation.subAgentLifecycleByThread.set('child', {
      startedAt: 100,
      terminalStatus: 'completed',
      finishedAt: 200,
    });
    correlation.emittedSubAgentLifecycleByCard.set('spawn-card', 'completed');
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    parseNotification(correlation, 'rawResponseItem/completed', {
      threadId: 'main',
      item: {
        type: 'function_call',
        name: 'followup_task',
        call_id: 'followup-card',
      },
    }, () => {});
    const activity = parseNotification(correlation, 'item/completed', {
      threadId: 'main',
      item: {
        type: 'subAgentActivity',
        id: 'followup-card',
        kind: 'interacted',
        agentThreadId: 'child',
        agentPath: '/root/reviewer',
      },
    }, () => {});

    expect(correlation.subThreadToCard.get('child')).toBe('followup-card');
    expect(Array.isArray(activity) ? activity[0] : activity).toMatchObject({
      kind: 'tool_use_start',
      toolUseId: 'followup-card',
    });
    expect(Array.isArray(activity) ? activity[0] : activity).not.toHaveProperty('subAgent');
    expect(collectCodexSubAgentLifecycleEvents(correlation)).toEqual([]);

    parseNotification(correlation, 'turn/started', {
      threadId: 'child',
      turn: { id: 'followup-turn' },
    }, () => {});
    expect(collectCodexSubAgentLifecycleEvents(correlation)).toEqual([{
      kind: 'subagent_lifecycle',
      parentToolUseId: 'followup-card',
      status: 'running',
      observedAt: expect.any(Number),
    }]);

    parseNotification(correlation, 'turn/completed', {
      threadId: 'child',
      turn: { id: 'followup-turn', status: 'completed' },
    }, () => {});
    expect(collectCodexSubAgentLifecycleEvents(correlation)).toEqual([{
      kind: 'subagent_lifecycle',
      parentToolUseId: 'followup-card',
      status: 'completed',
      observedAt: expect.any(Number),
    }]);
    expect(correlation.emittedSubAgentLifecycleByCard.get('spawn-card')).toBe('completed');
  });

  it('restarts when an active child reaches the root terminal without its activity', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.codexV2SubAgentActivityObserved = true;
    const stopSession = vi.spyOn(runtime, 'stopSession').mockResolvedValue();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);
    parseNotification(correlation, 'turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn' },
    }, () => {});
    dispatchCodexItemEvent(correlation, 'child', {
      kind: 'text_delta',
      text: 'early child output',
    }, () => {});
    expect(parseNotification(correlation, 'turn/completed', {
      threadId: 'main',
      turn: { id: 'root-turn', status: 'completed' },
    }, () => {})).toBeNull();

    expect(stopSession).toHaveBeenCalledWith(correlation, 'failure');
    expect(correlation.releaseHeldMainTurnOnExit).toBe(true);
    expect(correlation.pendingMainTurnCompletion?.[0]).toMatchObject({
      kind: 'turn_complete',
      status: 'completed',
    });
  });

  it('releases a settled missing-activity terminal through the process-exit boundary', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.codexV2SubAgentActivityObserved = true;
    const stopSession = vi.spyOn(runtime, 'stopSession').mockResolvedValue();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    parseNotification(correlation, 'turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn' },
    }, () => {});
    dispatchCodexItemEvent(correlation, 'child', {
      kind: 'text_delta',
      text: 'must remain unowned',
    }, () => {});
    parseNotification(correlation, 'turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed' },
    }, () => {});

    expect(parseNotification(correlation, 'turn/completed', {
      threadId: 'main',
      turn: { id: 'root-turn', status: 'completed' },
    }, () => {})).toBeNull();

    expect(stopSession).toHaveBeenCalledWith(correlation, 'failure');
    const takeHeld = (runtime as unknown as {
      takeHeldMainTurnForProcessExit: (proc: typeof correlation) => UnifiedEvent[] | null;
    }).takeHeldMainTurnForProcessExit.bind(runtime);
    expect(takeHeld(correlation)?.[0]).toMatchObject({
      kind: 'turn_complete',
      status: 'completed',
    });
    expect(correlation.subAgentThreadsAwaitingActivity.size).toBe(0);
    expect(correlation.deferredSubAgentEvents.size).toBe(0);
  });

  it.each(['failed', 'interrupted'] as const)(
    'restarts when a root is %s and child activity correlation is missing',
    (status) => {
      const runtime = new CodexRuntime();
      const correlation = parserState();
      correlation.codexV2SubAgentActivityObserved = true;
      const stopSession = vi.spyOn(runtime, 'stopSession').mockResolvedValue();
      const parseNotification = (runtime as unknown as {
        parseNotification: (
          proc: typeof correlation,
          method: string,
          params: unknown,
          emit: (event: UnifiedEvent) => void,
        ) => UnifiedEvent | UnifiedEvent[] | null;
      }).parseNotification.bind(runtime);

      parseNotification(correlation, 'turn/started', {
        threadId: 'child',
        turn: { id: 'child-turn' },
      }, () => {});
      expect(parseNotification(correlation, 'turn/completed', {
        threadId: 'main',
        turn: { id: 'root-turn', status },
      }, () => {})).toBeNull();

      expect(stopSession).toHaveBeenCalledWith(correlation, 'failure');
      expect(correlation.releaseHeldMainTurnOnExit).toBe(true);
      expect(correlation.pendingMainTurnCompletion?.[0]).toMatchObject({
        kind: 'turn_complete',
        status,
      });
    },
  );

  it('keeps v1 child output live without waiting for a v2-only activity item', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    correlation.subThreadToCard.set('legacy-child', 'legacy-spawn');
    correlation.subThreadToParent.set('legacy-child', 'main');
    const emitted: UnifiedEvent[] = [];
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    parseNotification(correlation, 'turn/started', {
      threadId: 'legacy-child',
      turn: { id: 'legacy-child-turn' },
    }, () => {});
    dispatchCodexItemEvent(correlation, 'legacy-child', {
      kind: 'text_delta',
      text: 'legacy child output',
    }, (event) => emitted.push(event));

    expect(correlation.codexV2SubAgentActivityObserved).toBe(false);
    expect(correlation.subAgentThreadsAwaitingActivity.size).toBe(0);
    expect(emitted).toEqual([{
      kind: 'text_delta',
      text: 'legacy child output',
      subAgent: {
        parentToolUseId: 'legacy-spawn',
        nickname: undefined,
        role: undefined,
      },
    }]);
  });

  it('reserves a v1 spawn child before its turn starts so the root terminal waits', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    parseNotification(correlation, 'item/completed', {
      threadId: 'main',
      item: {
        type: 'collabAgentToolCall',
        id: 'legacy-spawn',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: ['legacy-child'],
      },
    }, () => {});
    expect(correlation.activeSubAgentTurns).toEqual(new Map([['legacy-child', null]]));
    expect(parseNotification(correlation, 'turn/completed', {
      threadId: 'main',
      turn: { id: 'root-turn', status: 'completed' },
    }, () => {})).toBeNull();

    parseNotification(correlation, 'turn/started', {
      threadId: 'legacy-child',
      turn: { id: 'legacy-child-turn' },
    }, () => {});
    const terminal = parseNotification(correlation, 'turn/completed', {
      threadId: 'legacy-child',
      turn: { id: 'legacy-child-turn', status: 'completed' },
    }, () => {});
    expect((Array.isArray(terminal) ? terminal : [terminal]).find(event => event?.kind === 'turn_complete')).toMatchObject({
      kind: 'turn_complete',
      status: 'completed',
    });
  });

  it('also reserves a v1 child when an older server reports receivers at item start', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    parseNotification(correlation, 'item/started', {
      threadId: 'main',
      item: {
        type: 'collabAgentToolCall',
        id: 'legacy-spawn',
        tool: 'spawnAgent',
        receiverThreadIds: ['legacy-child'],
      },
    }, () => {});

    expect(correlation.activeSubAgentTurns).toEqual(new Map([['legacy-child', null]]));
  });

  it('does not resurrect a v1 child that settled before its spawn item completed', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    parseNotification(correlation, 'turn/started', {
      threadId: 'legacy-child',
      turn: { id: 'legacy-child-turn' },
    }, () => {});
    parseNotification(correlation, 'turn/completed', {
      threadId: 'legacy-child',
      turn: { id: 'legacy-child-turn', status: 'completed' },
    }, () => {});
    expect(correlation.completedSubAgentTurnsBeforeActivity).toEqual(new Set(['legacy-child']));

    parseNotification(correlation, 'item/completed', {
      threadId: 'main',
      item: {
        type: 'collabAgentToolCall',
        id: 'legacy-spawn',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: ['legacy-child'],
      },
    }, () => {});
    expect(correlation.activeSubAgentTurns.size).toBe(0);
    expect(correlation.completedSubAgentTurnsBeforeActivity.size).toBe(0);
  });

  it('restarts at an undiscriminated interaction boundary instead of carrying it into the next turn', () => {
    const runtime = new CodexRuntime();
    const correlation = parserState();
    const stopSession = vi.spyOn(runtime, 'stopSession').mockResolvedValue();
    const parseNotification = (runtime as unknown as {
      parseNotification: (
        proc: typeof correlation,
        method: string,
        params: unknown,
        emit: (event: UnifiedEvent) => void,
      ) => UnifiedEvent | UnifiedEvent[] | null;
    }).parseNotification.bind(runtime);

    parseNotification(correlation, 'item/completed', {
      threadId: 'main',
      item: {
        type: 'subAgentActivity',
        id: 'undiscriminated-interaction',
        kind: 'interacted',
        agentThreadId: 'child',
        agentPath: '/root/reviewer',
      },
    }, () => {});
    const terminal = parseNotification(correlation, 'turn/completed', {
      threadId: 'main',
      turn: { id: 'root-turn', status: 'completed' },
    }, () => {});
    expect(terminal).toBeNull();
    expect(correlation.releaseHeldMainTurnOnExit).toBe(true);
    expect(correlation.pendingMainTurnCompletion?.[0]).toMatchObject({
      kind: 'turn_complete',
      status: 'completed',
    });
    expect(stopSession).toHaveBeenCalledWith(correlation, 'failure');
  });
});

describe('Codex sub-agent causal routing', () => {
  function routingState() {
    return {
      threadId: 'main',
      subThreadToCard: new Map<string, string>(),
      subThreadToParent: new Map<string, string>(),
      subThreadMeta: new Map<string, { nickname?: string; role?: string }>(),
      deferredSubAgentEvents: new Map<string, UnifiedEvent[]>(),
      subAgentThreadsAwaitingActivity: new Set<string>(),
    };
  }

  it('holds an early child delta until the v2 started activity creates its parent card', () => {
    const state = routingState();
    const emitted: UnifiedEvent[] = [];
    dispatchCodexItemEvent(state, 'child', {
      kind: 'text_delta',
      text: 'early child output',
      traceId: 'child-message',
    }, (event) => emitted.push(event));

    expect(emitted).toEqual([]);
    expect(state.deferredSubAgentEvents.get('child')).toHaveLength(1);

    const parentEvents = applyCodexSubAgentActivity(state, 'main', 'main', {
      type: 'subAgentActivity',
      id: 'spawn-call',
      kind: 'started',
      agentThreadId: 'child',
      agentPath: '/root/reviewer',
    });
    for (const event of parentEvents ?? []) {
      dispatchCodexItemEvent(state, 'main', event, (next) => emitted.push(next));
    }
    flushResolvableCodexSubAgentEvents(state, (event) => emitted.push(event));

    expect(emitted.slice(0, 3).map((event) => event.kind)).toEqual([
      'tool_use_start',
      'tool_use_stop',
      'tool_result',
    ]);
    expect(emitted[3]).toMatchObject({
      kind: 'text_delta',
      text: 'early child output',
      subAgent: { parentToolUseId: 'spawn-call' },
    });
    expect(state.deferredSubAgentEvents.size).toBe(0);
  });

  it('waits for an unresolved ancestor before releasing descendant activity and output', () => {
    const state = routingState();
    const emitted: UnifiedEvent[] = [];
    const nestedSpawnEvents = applyCodexSubAgentActivity(state, 'child', 'main', {
      type: 'subAgentActivity',
      id: 'nested-spawn',
      kind: 'started',
      agentThreadId: 'grandchild',
      agentPath: '/root/reviewer/checker',
    });
    for (const event of nestedSpawnEvents ?? []) {
      dispatchCodexItemEvent(state, 'child', event, (next) => emitted.push(next));
    }
    dispatchCodexItemEvent(state, 'grandchild', {
      kind: 'text_delta',
      text: 'grandchild output',
      traceId: 'grandchild-message',
    }, (event) => emitted.push(event));

    expect(emitted).toEqual([]);
    expect(state.deferredSubAgentEvents.size).toBe(2);

    const topSpawnEvents = applyCodexSubAgentActivity(state, 'main', 'main', {
      type: 'subAgentActivity',
      id: 'top-spawn',
      kind: 'started',
      agentThreadId: 'child',
      agentPath: '/root/reviewer',
    });
    for (const event of topSpawnEvents ?? []) {
      dispatchCodexItemEvent(state, 'main', event, (next) => emitted.push(next));
    }
    flushResolvableCodexSubAgentEvents(state, (event) => emitted.push(event));

    expect(emitted).toHaveLength(7);
    expect(emitted.slice(3).every((event) => (
      'subAgent' in event && event.subAgent?.parentToolUseId === 'top-spawn'
    ))).toBe(true);
    expect(emitted[6]).toMatchObject({ kind: 'text_delta', text: 'grandchild output' });
    expect(state.deferredSubAgentEvents.size).toBe(0);
  });

  it('flushes ancestor activity before descendant output even when the descendant arrived first', () => {
    const state = routingState();
    const emitted: UnifiedEvent[] = [];

    dispatchCodexItemEvent(state, 'grandchild', {
      kind: 'text_delta',
      text: 'grandchild arrived first',
      traceId: 'grandchild-message',
    }, (event) => emitted.push(event));
    const nestedSpawnEvents = applyCodexSubAgentActivity(state, 'child', 'main', {
      type: 'subAgentActivity',
      id: 'nested-spawn',
      kind: 'started',
      agentThreadId: 'grandchild',
      agentPath: '/root/reviewer/checker',
    });
    for (const event of nestedSpawnEvents ?? []) {
      dispatchCodexItemEvent(state, 'child', event, (next) => emitted.push(next));
    }
    const topSpawnEvents = applyCodexSubAgentActivity(state, 'main', 'main', {
      type: 'subAgentActivity',
      id: 'top-spawn',
      kind: 'started',
      agentThreadId: 'child',
      agentPath: '/root/reviewer',
    });
    for (const event of topSpawnEvents ?? []) {
      dispatchCodexItemEvent(state, 'main', event, (next) => emitted.push(next));
    }
    flushResolvableCodexSubAgentEvents(state, (event) => emitted.push(event));

    expect(emitted.slice(3, 6).map((event) => event.kind)).toEqual([
      'tool_use_start',
      'tool_use_stop',
      'tool_result',
    ]);
    expect(emitted[6]).toMatchObject({
      kind: 'text_delta',
      text: 'grandchild arrived first',
    });
  });

  it('keeps an early attachment update behind its deferred placeholder owner', () => {
    const state = routingState();
    const emitted: UnifiedEvent[] = [];
    const attachmentUpdate: UnifiedEvent = {
      kind: 'tool_attachment_update',
      toolUseId: 'child-tool',
      pendingId: 'pending-image',
      attachment: {
        kind: 'image',
        mimeType: 'image/png',
        refPath: '/api/attachment/tool/session/turn/image.png',
      },
    };

    dispatchCodexItemEvent(state, 'child', {
      kind: 'tool_use_start',
      toolUseId: 'child-tool',
      toolName: 'ImageTool',
    }, (event) => emitted.push(event));
    dispatchCodexItemEvent(state, 'child', {
      kind: 'tool_result',
      toolUseId: 'child-tool',
      content: 'saving image',
      attachments: [{
        kind: 'image',
        mimeType: 'image/png',
        refPath: '',
        pendingId: 'pending-image',
      }],
    }, (event) => emitted.push(event));
    dispatchCodexItemEvent(state, 'child', attachmentUpdate, (event) => emitted.push(event));
    expect(emitted).toEqual([]);

    applyCodexSubAgentActivity(state, 'main', 'main', {
      type: 'subAgentActivity',
      id: 'spawn-call',
      kind: 'started',
      agentThreadId: 'child',
      agentPath: '/root/reviewer',
    });
    flushResolvableCodexSubAgentEvents(state, (event) => emitted.push(event));
    expect(emitted.map((event) => event.kind)).toEqual([
      'tool_use_start',
      'tool_result',
      'tool_attachment_update',
    ]);
  });

  it('routes a settled attachment by tool id after turn-local thread maps are cleared', () => {
    const state = routingState();
    const emitted: UnifiedEvent[] = [];
    dispatchCodexItemEvent(state, 'child', {
      kind: 'tool_attachment_update',
      toolUseId: 'already-latched-child-tool',
      pendingId: 'pending-image',
      attachment: {
        kind: 'image',
        mimeType: 'image/png',
        refPath: '/api/attachment/tool/session/turn/image.png',
      },
    }, (event) => emitted.push(event));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: 'tool_attachment_update',
      toolUseId: 'already-latched-child-tool',
    });
    expect(state.deferredSubAgentEvents.size).toBe(0);
  });
});

describe('resolveCollabAgentControlParents', () => {
  it('maps main-thread wait/send/close receiver threads back to their spawn cards', () => {
    const cards = new Map([['child', 'spawn-card']]);
    const parents = new Map([['child', 'main']]);

    expect(resolveCollabAgentControlParents('wait', ['child'], cards, parents)).toEqual(['spawn-card']);
    expect(resolveCollabAgentControlParents('sendInput', ['child'], cards, parents)).toEqual(['spawn-card']);
    expect(resolveCollabAgentControlParents('closeAgent', ['child'], cards, parents)).toEqual(['spawn-card']);
  });

  it('deduplicates multiple receiver threads that resolve to the same top-level spawn card', () => {
    const cards = new Map([['child', 'spawn-card'], ['grandchild', 'nested-card']]);
    const parents = new Map([['child', 'main'], ['grandchild', 'child']]);

    expect(resolveCollabAgentControlParents('wait', ['child', 'grandchild'], cards, parents)).toEqual(['spawn-card']);
  });

  it('preserves order when one control action targets multiple spawn cards', () => {
    const cards = new Map([['a', 'spawn-a'], ['b', 'spawn-b']]);
    const parents = new Map([['a', 'main'], ['b', 'main']]);

    expect(resolveCollabAgentControlParents('wait', ['b', 'a'], cards, parents)).toEqual(['spawn-b', 'spawn-a']);
  });

  it('returns empty for spawnAgent and unknown receivers', () => {
    const cards = new Map([['child', 'spawn-card']]);
    const parents = new Map([['child', 'main']]);

    expect(resolveCollabAgentControlParents('spawnAgent', ['child'], cards, parents)).toEqual([]);
    expect(resolveCollabAgentControlParents('wait', ['missing'], cards, parents)).toEqual([]);
  });
});

describe('collab control event builders', () => {
  it('uses a stable per-parent synthetic id for nested control events', () => {
    expect(subagentControlToolUseId('wait-1', 'spawn-a')).toBe('wait-1::subagent-control::spawn-a');
    expect(subagentControlToolUseId('wait-1', 'spawn-a')).not.toBe(subagentControlToolUseId('wait-1', 'spawn-b'));
  });

  it('builds nested start events for resolved non-spawn control actions', () => {
    const events = buildCollabAgentControlStartEvents({
      id: 'wait-1',
      tool: 'wait',
      receiverThreadIds: ['child'],
    }, ['spawn-card']);

    expect(events).toEqual([{
      kind: 'tool_use_start',
      toolUseId: 'wait-1::subagent-control::spawn-card',
      toolName: 'CollabAgent',
      input: { tool: 'wait', receiverThreadIds: ['child'] },
      subAgent: { parentToolUseId: 'spawn-card' },
    }]);
  });

  it('builds nested completion events for resolved control actions', () => {
    const events = buildCollabAgentControlCompletedEvents({
      id: 'close-1',
      tool: 'closeAgent',
      receiverThreadIds: ['child'],
    }, ['spawn-card']);

    expect(events.map((event) => event.kind)).toEqual(['tool_use_start', 'tool_use_stop', 'tool_result']);
    expect(events.every((event) => 'subAgent' in event && event.subAgent?.parentToolUseId === 'spawn-card')).toBe(true);
    expect(events.every((event) => 'toolUseId' in event && event.toolUseId === 'close-1::subagent-control::spawn-card')).toBe(true);
  });

  it('omits duplicate start when the control action already started under a latched parent', () => {
    const route = resolveCollabControlCompletionRoute(['spawn-a', 'spawn-b'], ['spawn-a']);
    const events = buildCollabAgentControlCompletedEvents({
      id: 'wait-1',
      tool: 'wait',
      receiverThreadIds: ['a'],
    }, route.parentToolUseIds, { includeStart: route.includeStart });

    expect(route).toEqual({ parentToolUseIds: ['spawn-a', 'spawn-b'], includeStart: false });
    expect(events.map((event) => event.kind)).toEqual(['tool_use_stop', 'tool_result', 'tool_use_stop', 'tool_result']);
    expect(events.map((event) => 'toolUseId' in event ? event.toolUseId : null)).toEqual([
      'wait-1::subagent-control::spawn-a',
      'wait-1::subagent-control::spawn-a',
      'wait-1::subagent-control::spawn-b',
      'wait-1::subagent-control::spawn-b',
    ]);
  });

  it('includes start when a control action first resolves on completion', () => {
    const route = resolveCollabControlCompletionRoute(undefined, ['spawn-card']);
    const events = buildCollabAgentControlCompletedEvents({
      id: 'wait-1',
      tool: 'wait',
    }, route.parentToolUseIds, { includeStart: route.includeStart });

    expect(route).toEqual({ parentToolUseIds: ['spawn-card'], includeStart: true });
    expect(events.map((event) => event.kind)).toEqual(['tool_use_start', 'tool_use_stop', 'tool_result']);
  });

  it('marks failed collab control results as errors', () => {
    const events = buildCollabAgentControlCompletedEvents({
      id: 'wait-failed',
      tool: 'wait',
      status: 'failed',
    }, ['spawn-card']);

    const result = events.find((event) => event.kind === 'tool_result');
    expect(result).toMatchObject({
      kind: 'tool_result',
      isError: true,
      content: 'Tool: wait\nStatus: failed',
    });
  });

  it('falls back to one complete flat card when Codex never reports control receivers', () => {
    const events = buildCollabAgentControlCompletedEvents({
      id: 'wait-orphan',
      tool: 'wait',
    }, []);

    expect(events).toEqual([
      { kind: 'tool_use_start', toolUseId: 'wait-orphan', toolName: 'CollabAgent', input: { tool: 'wait' } },
      { kind: 'tool_use_stop', toolUseId: 'wait-orphan' },
      { kind: 'tool_result', toolUseId: 'wait-orphan', content: 'Tool: wait' },
    ]);
  });
});

describe('isChildThreadGatedMethod', () => {
  // Live-verified (Codex 0.135.0): spawned child threads emit their own
  // turn/started + turn/completed (isMain=false) over the same connection.
  // These lifecycle methods must be gated to the main thread; child item
  // notifications (the tools we nest) must NOT be gated.
  it('gates thread/turn lifecycle methods', () => {
    expect(isChildThreadGatedMethod('turn/started')).toBe(true);
    expect(isChildThreadGatedMethod('turn/completed')).toBe(true);
    expect(isChildThreadGatedMethod('turn/plan/updated')).toBe(true);
    expect(isChildThreadGatedMethod('thread/status/changed')).toBe(true);
    expect(isChildThreadGatedMethod('thread/closed')).toBe(true);
  });
  // PRD 0.2.32 cross-review (codex HIGH): a sub-agent child thread also emits
  // thread/tokenUsage/updated { threadId, turnId, tokenUsage }. Before the fix
  // it was NOT gated, so a child's usage flowed through as a `usage` event and
  // polluted the MAIN session's context indicator + persisted lastContextUsage.
  // It must now be gated like lifecycle so the foreign-thread guard drops it.
  it('gates thread/tokenUsage/updated (child usage must not drive main context)', () => {
    expect(isChildThreadGatedMethod('thread/tokenUsage/updated')).toBe(true);
    expect(isChildThreadGatedMethod('rawResponse/completed')).toBe(true);
  });
  it('does NOT gate item notifications (sub-agent tools must surface)', () => {
    expect(isChildThreadGatedMethod('item/started')).toBe(false);
    expect(isChildThreadGatedMethod('item/completed')).toBe(false);
    expect(isChildThreadGatedMethod('item/commandExecution/outputDelta')).toBe(false);
  });
});

describe('Codex child lifecycle projection', () => {
  function state() {
    return {
      threadId: 'main',
      subThreadToCard: new Map([['child', 'spawn-card']]),
      subThreadToParent: new Map([['child', 'main']]),
      subThreadMeta: new Map<string, { nickname?: string; role?: string }>(),
      activeSubAgentTurns: new Map<string, string | null>([['child', 'child-turn']]),
      subAgentLifecycleByThread: new Map<string, {
        startedAt: number;
        terminalStatus?: 'completed' | 'failed' | 'interrupted';
        finishedAt?: number;
      }>([['child', { startedAt: 100 }]]),
      emittedSubAgentLifecycleByCard: new Map(),
    };
  }

  it('emits one running event and freezes the real owner terminal time', () => {
    const projection = state();
    expect(collectCodexSubAgentLifecycleEvents(projection)).toEqual([{
      kind: 'subagent_lifecycle',
      parentToolUseId: 'spawn-card',
      status: 'running',
      observedAt: 100,
    }]);

    projection.activeSubAgentTurns.clear();
    projection.subAgentLifecycleByThread.set('child', {
      startedAt: 100,
      terminalStatus: 'completed',
      finishedAt: 240,
    });
    expect(collectCodexSubAgentLifecycleEvents(projection)).toEqual([{
      kind: 'subagent_lifecycle',
      parentToolUseId: 'spawn-card',
      status: 'completed',
      observedAt: 240,
    }]);
    expect(collectCodexSubAgentLifecycleEvents(projection)).toEqual([]);
  });

  it('does not turn a spawn reservation into execution evidence before child lifecycle arrives', () => {
    const projection = state();
    projection.subAgentLifecycleByThread.clear();

    expect(collectCodexSubAgentLifecycleEvents(projection)).toEqual([]);
  });

  it('holds the owner terminal until a descendant settles', () => {
    const projection = state();
    projection.subThreadToCard.set('grandchild', 'nested-card');
    projection.subThreadToParent.set('grandchild', 'child');
    projection.activeSubAgentTurns.set('grandchild', 'grandchild-turn');
    projection.subAgentLifecycleByThread.set('child', {
      startedAt: 100,
      terminalStatus: 'completed',
      finishedAt: 200,
    });
    projection.subAgentLifecycleByThread.set('grandchild', { startedAt: 120 });

    expect(collectCodexSubAgentLifecycleEvents(projection).map(event => (
      event.kind === 'subagent_lifecycle' ? event.status : null
    ))).toEqual(['running']);
    projection.activeSubAgentTurns.delete('child');
    expect(collectCodexSubAgentLifecycleEvents(projection)).toEqual([]);
    projection.activeSubAgentTurns.delete('grandchild');
    projection.subAgentLifecycleByThread.set('grandchild', {
      startedAt: 120,
      terminalStatus: 'failed',
      finishedAt: 220,
    });
    expect(collectCodexSubAgentLifecycleEvents(projection)).toEqual([{
      kind: 'subagent_lifecycle',
      parentToolUseId: 'spawn-card',
      status: 'completed',
      observedAt: 200,
    }]);
  });

  it('maps native child outcomes without treating an abnormal close as success', () => {
    expect(mapCodexChildTurnTerminalStatus({ status: 'completed' })).toBe('completed');
    expect(mapCodexChildTurnTerminalStatus({ status: 'cancelled' })).toBe('interrupted');
    expect(mapCodexChildTurnTerminalStatus({ status: 'failed' })).toBe('failed');
    expect(mapCodexChildTurnTerminalStatus({})).toBe('failed');
  });
});

describe('Codex reasoning trace identity', () => {
  it('opens each summary/content trace lazily and closes those exact ids once', () => {
    const state = { openedReasoningTracesByItem: new Map<string, Map<string, number>>() };
    const params = { threadId: 'child', itemId: 'reasoning-1' };
    expect(buildCodexReasoningDeltaEvents(state, params, {
      index: 0,
      suffix: 'summary:0',
      text: 'summary',
    })).toEqual([
      { kind: 'thinking_start', index: 0, traceId: 'child::reasoning-1::summary:0' },
      { kind: 'thinking_delta', index: 0, text: 'summary', traceId: 'child::reasoning-1::summary:0' },
    ]);
    expect(buildCodexReasoningDeltaEvents(state, params, {
      index: 1,
      suffix: 'content:1',
      text: 'detail',
    })).toHaveLength(2);
    expect(takeCodexReasoningStopEvents(state, params, 'reasoning-1')).toEqual([
      { kind: 'thinking_stop', index: 0, traceId: 'child::reasoning-1::summary:0' },
      { kind: 'thinking_stop', index: 1, traceId: 'child::reasoning-1::content:1' },
    ]);
    expect(takeCodexReasoningStopEvents(state, params, 'reasoning-1')).toEqual([]);
  });
});
