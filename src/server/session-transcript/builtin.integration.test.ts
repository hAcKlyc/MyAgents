import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_CHANNEL_DELIVERY } from '../session-core/channel-delivery';
import type { TurnTerminalOutcome } from '../session-core/turn-queue';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

const state = vi.hoisted(() => ({ home: '', failProductIo: false, publicationGate: null as Promise<void> | null, publicationBlocked: false, queryExitGate: null as Promise<void> | null, queryInputEnded: 0, backgroundTask: false, backgroundTaskGate: null as Promise<void> | null, independentInputPump: false, sdkInputs: [] as unknown[], resultMode: 'success' as 'success' | 'error', rejectedResumeAt: null as string | null, sdkCumulativeBase: null as { input: number; output: number } | null, compactAtTurn: null as number | null, resetAtTurn: null as number | null, sdkCommands: [] as unknown[], interruptCloses: false, throwAfterInputEnd: false, beforeTurn: vi.fn(), query: vi.fn(), sdkRead: vi.fn(), sdkFork: vi.fn(), sdkDelete: vi.fn(), rewindFiles: vi.fn(), beforeResult: vi.fn(), events: [] as [string, unknown][], queuedFollowup: false, exitWithoutResult: false, toolFrames: false, childFrames: false, media: vi.fn() }));
vi.mock('os', async original => ({ ...await original<typeof import('os')>(), homedir: () => state.home }));
vi.mock('../utils/fs-utils', async original => {
  const actual = await original<typeof import('../utils/fs-utils')>();
  return { ...actual, ensureDirSync: (...args: Parameters<typeof actual.ensureDirSync>) => {
    if (state.failProductIo && String(args[0]).endsWith(join('.myagents', 'sessions'))) {
      throw Object.assign(new Error('product directory denied'), { code: 'EACCES' });
    }
    return actual.ensureDirSync(...args);
  } };
});
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    if (state.publicationGate && String(args[0]).endsWith(join('.myagents', 'sessions-v2'))) {
      state.publicationBlocked = true;
      await state.publicationGate;
    }
    if (state.failProductIo && String(args[0]).endsWith(join('.myagents', 'sessions-v2'))) {
      return Promise.reject(Object.assign(new Error('product directory denied'), { code: 'EACCES' }));
    }
    return actual.mkdir(...args);
  } };
});
vi.mock('../utils/managed-proxy-binding', async original => {
  const actual = await original<typeof import('../utils/managed-proxy-binding')>();
  return { ...actual, prepareProviderBinding: async (...args: Parameters<typeof actual.prepareProviderBinding>) => {
    const prepared = await actual.prepareProviderBinding(...args);
    return { ...prepared, beforeTurn: async () => { await state.beforeTurn(); await prepared.beforeTurn(); } };
  } };
});
vi.mock('@anthropic-ai/claude-agent-sdk', async original => ({
  ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(), query: (...args: unknown[]) => state.query(...args),
  getSessionMessages: (...args: unknown[]) => state.sdkRead(...args),
  forkSession: (...args: unknown[]) => state.sdkFork(...args),
  deleteSession: (...args: unknown[]) => state.sdkDelete(...args),
}));
vi.mock('../runtimes/builtin-media-attachments', () => ({ buildBuiltinMediaAttachments: (...args: unknown[]) => state.media(...args) }));
vi.mock('../sse', async original => ({
  ...await original<typeof import('../sse')>(),
  broadcast: (event: string, data: unknown) => { state.events.push([event, data]); },
  broadcastLive: (event: string, data: unknown) => { state.events.push([event, data]); },
}));

let agent: typeof import('../agent-session');
let store: typeof import('../SessionStore');
let releaseWrite: (() => void) | undefined;
let notificationReceipts = false;

function fakeQuery(args: { prompt: AsyncIterable<unknown>; options: { sessionId?: string; resume?: string; resumeSessionAt?: string } }) {
  const prompt = args.prompt[Symbol.asyncIterator]();
  const pullInput = () => prompt.next().then(next => {
    if (!next.done) state.sdkInputs.push(next.value);
    return next;
  });
  let prefetchedInput = state.independentInputPump ? pullInput() : null;
  let close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const pending: unknown[] = [];
  let turn = 0;
  let rejectedResume = false;
  let backgroundTaskPending = false;
  const sessionId = args.options.sessionId ?? args.options.resume;
  if (!sessionId) throw new Error('SDK test transport requires a new or resumed Session identity');
  const iterator = {
    async next(): Promise<IteratorResult<unknown>> {
      if (args.options.resumeSessionAt === state.rejectedResumeAt) {
        if (rejectedResume) return { done: true, value: undefined };
        rejectedResume = true;
        return { done: false, value: {
          type: 'result', subtype: 'error_during_execution', is_error: true,
          result: `No message found with message.uuid of: ${state.rejectedResumeAt}`,
          errors: [`No message found with message.uuid of: ${state.rejectedResumeAt}`],
          terminal_reason: 'error', session_id: sessionId, uuid: randomUUID(),
          duration_ms: 1, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [],
        } };
      }
      if (pending.length) {
        const value = pending.shift();
        if ((value as { type?: string })?.type === 'result') {
          const consumeFollowup = await state.beforeResult(value);
          if (consumeFollowup === true && prefetchedInput) {
            const input = await prefetchedInput;
            if (input.done) throw new Error('Synthetic queued input ended before consumption');
            prefetchedInput = pullInput();
            pending.unshift(value);
            const message = input.value as { uuid: string; message: unknown };
            return { done: false, value: { type: 'user', isReplay: true, uuid: message.uuid,
              session_id: sessionId, parent_tool_use_id: null, message: message.message } };
          }
        }
        return { done: false, value };
      }
      if (backgroundTaskPending) {
        const outcome = await Promise.race([
          Promise.resolve(state.backgroundTaskGate).then(() => 'complete' as const),
          closed.then(() => 'closed' as const),
        ]);
        if (outcome === 'closed') return { done: true, value: undefined };
        backgroundTaskPending = false;
        return { done: false, value: {
          type: 'system', subtype: 'task_notification', task_id: `background-${turn}`,
          status: 'completed', summary: 'done', output_file: '',
        } };
      }
      if (state.exitWithoutResult && turn > 0) return { done: true, value: undefined };
      const followup = state.queuedFollowup && turn === 1;
      if (followup) {
        const queue = await import('../builtin-session/queue');
        queue.setInFlightQueueItem('queued-followup', { messageText: 'queued question', channelDelivery: NO_CHANNEL_DELIVERY });
        queue.queueState.awaitingAssistantStartAckQueueId = 'queued-followup';
      }
      const next = followup ? { done: false, value: undefined }
        : await Promise.race([prefetchedInput ?? pullInput(), closed.then(() => ({ done: true as const, value: undefined }))]);
      if (next.done) {
        state.queryInputEnded++;
        await state.queryExitGate;
        if (state.throwAfterInputEnd) throw new Error('synthetic query exit failure');
        return { done: true, value: undefined };
      }
      if (state.independentInputPump) prefetchedInput = pullInput();
      turn++;
      const responseId = `response-${turn}`;
      const envelope = { session_id: sessionId, parent_tool_use_id: null };
      const stream = (event: unknown) => ({ ...envelope, type: 'stream_event', uuid: randomUUID(), event });
      const assistant = (content: unknown[], uuid: string) => ({ ...envelope, type: 'assistant', uuid,
        message: { id: responseId, role: 'assistant', model: 'test-model', content, usage: { input_tokens: 4, output_tokens: 5 } },
      });
      pending.push(
        { type: 'system', subtype: 'init', session_id: sessionId, uuid: randomUUID(), model: 'test-model', tools: [], mcp_servers: [] },
        stream({ type: 'message_start', message: { id: responseId } }),
        stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `answer ${turn}` } }),
        assistant([{ type: 'text', text: `answer ${turn}` }], `text-frame-${turn}`),
        stream({ type: 'content_block_stop', index: 0 }),
        assistant([{ type: 'text', text: ' full-only tail' }], `tail-frame-${turn}`),
        { type: 'result', subtype: 'success', is_error: false, result: `answer ${turn} full-only tail`,
          session_id: sessionId, uuid: randomUUID(), duration_ms: 1, duration_api_ms: 1, num_turns: 1,
          total_cost_usd: 0, usage: { input_tokens: 4, output_tokens: 5 }, permission_denials: [],
          ...(state.sdkCumulativeBase === null ? {} : { modelUsage: { 'test-model': {
            inputTokens: state.sdkCumulativeBase.input + turn * 4,
            outputTokens: state.sdkCumulativeBase.output + turn * 5,
          } } }),
        },
      );
      if (state.compactAtTurn === turn) {
        pending.splice(1);
        pending.push(
          { ...envelope, type: 'system', subtype: 'compact_boundary', uuid: randomUUID() },
          { ...envelope, type: 'result', subtype: 'success', is_error: false, result: '',
            uuid: randomUUID(), terminal_reason: 'completed', duration_ms: 1, duration_api_ms: 1,
            num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 4, output_tokens: 0 }, permission_denials: [],
            modelUsage: { 'test-model': {
              inputTokens: (state.sdkCumulativeBase?.input ?? 0) + turn * 4,
              outputTokens: (state.sdkCumulativeBase?.output ?? 0) + (turn - 1) * 5,
            } },
          },
        );
      }
      if (state.resetAtTurn === turn) {
        pending.splice(1);
        pending.push(
          { ...envelope, type: 'conversation_reset', new_conversation_id: randomUUID(), uuid: randomUUID(), trigger: 'clear' },
          { ...envelope, type: 'result', subtype: 'success', is_error: false, result: '',
            uuid: randomUUID(), terminal_reason: 'completed', duration_ms: 1, duration_api_ms: 1,
            num_turns: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [],
            modelUsage: {},
          },
        );
      }
      if (state.resultMode === 'error') {
        Object.assign(pending[pending.length - 1] as object, {
          subtype: 'error_during_execution',
          is_error: true,
          result: 'synthetic provider failure',
          errors: ['synthetic provider failure'],
          terminal_reason: 'error_during_execution',
        });
      }
      if (state.toolFrames) {
        pending.splice(1, 0,
          assistant([{ type: 'tool_use', id: `tool-${turn}`, name: 'Read', input: { file_path: '/synthetic' } }], `tool-frame-${turn}`),
          { ...envelope, type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${turn}`, content: 'tool result' }] } },
        );
      }
      if (state.childFrames) {
        const childEnvelope = { ...envelope, parent_tool_use_id: `parent-${turn}` };
        const childStream = (event: unknown) => ({ ...childEnvelope, type: 'stream_event', uuid: randomUUID(), event });
        const childFull = { ...childEnvelope, type: 'assistant', uuid: `child-frame-${turn}`, message: {
          id: `child-response-${turn}`, role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'child corrected' }],
          usage: { input_tokens: 1, output_tokens: 2 },
        } };
        pending.splice(1, 0,
          assistant([{ type: 'tool_use', id: `parent-${turn}`, name: 'Task', input: { prompt: 'child' } }], `parent-frame-${turn}`),
          childStream({ type: 'message_start', message: { id: `child-response-${turn}` } }),
          childStream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          childStream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child partial' } }),
          childFull, childFull,
          childStream({ type: 'content_block_stop', index: 0 }),
        );
      }
      if (state.backgroundTask) {
        pending.splice(pending.length - 1, 0, {
          type: 'system', subtype: 'task_started', task_id: `background-${turn}`,
          tool_use_id: `background-tool-${turn}`, description: 'background test task', task_type: 'agent',
        });
        backgroundTaskPending = true;
      }
      if (state.exitWithoutResult) pending.pop();
      if (notificationReceipts) {
        // Receipts can precede output, or arrive after output but before its
        // real result. Neither may settle the product turn or clear usage.
        const receipt = () => ({ type: 'result', subtype: 'success', is_error: false,
          origin: { kind: 'task-notification' }, num_turns: 0, result: '',
          session_id: sessionId, uuid: randomUUID(), usage: { output_tokens: 0 }, modelUsage: {} });
        pending.unshift(receipt());
        pending.splice(pending.length - 1, 0, receipt());
      }
      return { done: false, value: pending.shift() };
    },
    [Symbol.asyncIterator]() { return this; },
    initializationResult: async () => ({ commands: state.sdkCommands }),
    interrupt: async () => { if (state.interruptCloses) close(); },
    close,
    rewindFiles: state.rewindFiles,
    mcpServerStatus: async () => [],
    setModel: async () => undefined,
    setPermissionMode: async () => undefined,
    setMcpServers: async () => undefined,
  };
  return iterator;
}

beforeEach(async () => {
  notificationReceipts = false;
  state.home = await mkdtemp(join(tmpdir(), 'myagents-builtin-v2-'));
  state.events.length = 0;
  state.failProductIo = false;
  state.publicationGate = null;
  state.publicationBlocked = false;
  state.queryExitGate = null;
  state.queryInputEnded = 0;
  state.backgroundTask = false;
  state.backgroundTaskGate = null;
  state.independentInputPump = false;
  state.sdkInputs.length = 0;
  state.resultMode = 'success';
  state.rejectedResumeAt = null;
  state.sdkCumulativeBase = null;
  state.compactAtTurn = null;
  state.resetAtTurn = null;
  state.sdkCommands = [];
  state.interruptCloses = false;
  state.throwAfterInputEnd = false;
  state.queuedFollowup = false;
  state.exitWithoutResult = false;
  state.toolFrames = false;
  state.childFrames = false;
  state.beforeResult.mockReset();
  state.beforeTurn.mockReset().mockResolvedValue(undefined);
  state.media.mockReset().mockResolvedValue([]);
  state.query.mockReset().mockImplementation(fakeQuery);
  state.sdkRead.mockReset().mockResolvedValue([]);
  state.sdkFork.mockReset();
  state.rewindFiles.mockReset().mockResolvedValue({ canRewind: true });
  state.sdkDelete.mockReset().mockResolvedValue(undefined);
  releaseWrite = undefined;
  vi.resetModules();
  store = await import('../SessionStore');
  agent = await import('../agent-session');
  // The fake Query does not write a real Claude transcript. Unless a test
  // overrides sdkRead to model branching/missing history, mirror the Product
  // rows as the synthetic native current chain.
  state.sdkRead.mockImplementation(async () => agent.getMessages()
    .filter(message => Boolean(message.sdkUuid))
    .map(message => ({ type: message.role, uuid: message.sdkUuid })));
});

afterEach(async () => {
  state.failProductIo = false;
  releaseWrite?.();
  vi.restoreAllMocks();
  const lifecycle = await import('../builtin-session/lifecycle');
  lifecycle.setPreWarmDisabled(true);
  lifecycle.clearPreWarmTimer();
  await agent.resetSession();
  await store.drainSessionTranscripts();
  await rm(state.home, { recursive: true, force: true });
});

describe('builtin V2 execution independent of product storage', () => {
  it.each(['dsh', 'claude-code', 'codex'] as const)('does not start SDK prewarm or publish a %s transcript after a stray builtin reload', async runtime => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace, { recursive: true });
    vi.stubEnv('MYAGENTS_RUNTIME', runtime);
    try {
      await agent.initializeAgent(workspace);
      const metadata = await store.createSession(workspace, { id: agent.getSessionId(), runtime });
      const active = store.getActiveSessionTranscript(metadata.id)!;
      const { TranscriptPresentation } = await import('./presentation');
      const { ProductTranscriptContent } = await import('./content');
      const publish = vi.fn();
      const presentation = new TranscriptPresentation(new ProductTranscriptContent(active.writer), publish);

      // SDK config helpers used to attach a second publisher to the shared
      // Product writer even though another Runtime owns execution/presentation.
      agent.publishBuiltinTranscriptSaveStatus(active.writer.status);
      state.events.length = 0;
      presentation.record('chat:message-chunk', 'A single delta');
      expect(publish.mock.calls.filter(([op]) => op.kind === 'text-append')).toHaveLength(1);
      expect(state.events.filter(([event]) => event === 'chat:transcript-operation')).toHaveLength(0);

      agent.setMcpServers([]);
      agent.setAgents({});
      agent.forceReloadActiveSession('agents');
      const lifecycle = await import('../builtin-session/lifecycle');
      expect(lifecycle.getPreWarmTimer()).toBeNull();
      expect(state.query).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['normal', 'delayed', 'failed'] as const)('desktop reset waits for %s disk publication before exposing success', async mode => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace, { recursive: true });
    await agent.initializeAgent(workspace, null, undefined, { preWarmDisabled: true });
    agent.setSessionModel('configured-model');
    agent.setSessionProviderEnv({ providerId: 'configured-provider', baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-not-a-secret' });
    const { createBuiltinSessionEngine } = await import('../session-engine/builtin-adapter');
    if (mode === 'failed') state.failProductIo = true;
    if (mode === 'delayed') state.publicationGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    let settled = false;
    const reset = createBuiltinSessionEngine().resetForNewDesktopSession(workspace).finally(() => { settled = true; });
    if (mode === 'failed') {
      await expect(reset).rejects.toThrow('could not be published');
      return;
    }
    if (mode === 'delayed') {
      await vi.waitFor(() => expect(state.publicationBlocked).toBe(true));
      expect(settled).toBe(false);
      releaseWrite!();
    }
    const result = await reset;
    expect(result.success).toBe(true);
    const disk = JSON.parse(await readFile(join(state.home, '.myagents', 'sessions.json'), 'utf8'));
    expect(disk).toContainEqual(expect.objectContaining({ id: result.sessionId, agentDir: workspace, model: 'configured-model', providerId: 'configured-provider', configSnapshotAt: expect.any(String) }));
    expect(agent.getMessages()).toHaveLength(0);
  });

  it.each(['complete', 'stopped'] as const)('consumes builtin Inbox C/D during A before manual B, with %s terminal', async ending => {
    const workspace = join(state.home, 'workspace'); await mkdir(workspace);
    vi.spyOn(await import('../utils/admin-config'), 'loadConfig').mockReturnValue({ chatQueueResponseMode: 'turn' });
    const sessionId = (await store.createSession(workspace, { runtime: 'builtin' })).id;
    await agent.initializeAgent(workspace, null, sessionId, { preWarmDisabled: true });
    const engine = (await import('../session-engine/builtin-adapter')).createBuiltinSessionEngine();
    const delivery = vi.spyOn(await import('../inbox/watch-deliver'), 'deliverSessionWatchEvents').mockResolvedValue(undefined);
    state.independentInputPump = true;
    let release!: () => void;
    releaseWrite = () => release();
    const ready = new Promise<void>(resolve => { release = resolve; });
    let replays = 0;
    state.beforeResult.mockImplementation(async value => {
      if (replays < 2) { await ready; replays++; return true; }
      if (replays === 2) {
        replays++;
        if (ending === 'stopped') value.terminal_reason = 'aborted_streaming';
      }
      return false;
    });
    const a = await engine.sendDesktopMessage({ text: 'A', images: [], sessionId, workspacePath: workspace, scenario: { type: 'desktop' } });
    await a.dispatchAcceptance;
    await vi.waitFor(() => expect(state.beforeResult).toHaveBeenCalledOnce());
    const b = await engine.sendDesktopMessage({ text: 'B', images: [], sessionId, workspacePath: workspace, scenario: { type: 'desktop' } });
    expect(b.deliveryMode).toBe('turn');
    for (const id of ['C', 'D']) await engine.enqueueInboxMessage({ text: id, sessionId, workspacePath: workspace,
      inboxMeta: { fromSessionId: `caller-${id}`, fromLabel: id, originalMessageId: id, originalSnippet: id, replyBack: true } });
    release();
    await b.dispatchAcceptance;
    await expect(engine.waitIdle(2_000, 10)).resolves.toBe(true);
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledWith(sessionId,
      expect.objectContaining({ terminalStatus: ending, requestEventIds: ['C', 'D'], text: expect.stringContaining('answer 1') }),
      expect.arrayContaining([expect.objectContaining({ originalMessageId: 'C' }), expect.objectContaining({ originalMessageId: 'D' })])));
    expect(state.sdkInputs.map(input => (input as { message: { content: { text?: string }[] } }).message.content.find(block => block.text)?.text)).toEqual(['A', 'C', 'D', 'B']);
    expect(delivery.mock.calls.find(call => call[1].text.includes('answer 2'))?.[2]).toEqual([]);
  });

  it.each(['v1', 'v2'] as const)('keeps %s identity across real builtin IM, Inbox and injected-turn adapters', async format => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const sessionId = randomUUID();
    if (format === 'v1') await store.saveSessionMetadata({ id: sessionId, agentDir: workspace, title: 'legacy',
      createdAt: 't', lastActiveAt: 't', runtime: 'builtin' });
    state.failProductIo = format === 'v2';
    state.toolFrames = true;
    await agent.initializeAgent(workspace, null, sessionId, { preWarmDisabled: true });
    const engine = (await import('../session-engine/builtin-adapter')).createBuiltinSessionEngine();
    const im = await engine.enqueueImMessage({ message: 'IM', requestId: 'first-im', sessionId, workspacePath: workspace,
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' }, metadataBirthPending: format === 'v2' });
    expect(im.success).toBe(true);
    await expect(engine.waitIdle(2_000, 10)).resolves.toBe(true);
    const inbox = await engine.enqueueInboxMessage({ text: 'Inbox', sessionId, workspacePath: workspace,
      scenario: { type: 'desktop' }, allowLazySessionMaterialization: true });
    expect(inbox.error).toBeUndefined();
    await expect(engine.waitIdle(2_000, 10)).resolves.toBe(true);
    for (const prompt of ['Task', 'Goal', 'Heartbeat']) {
      expect(await engine.runInjectedTurn({ prompt, sessionId, workspacePath: workspace,
        scenario: { type: 'cron', taskId: prompt, intervalMinutes: 15, aiCanExit: false },
        assistantChannelDelivery: 'caller-owned', timeoutMs: 2_000, pollMs: 10 })).toMatchObject({ success: true });
    }
    expect(agent.getSessionId()).toBe(sessionId);
    expect(store.getSessionMetadata(sessionId)?.transcriptFormat).toBe(format === 'v2' ? 2 : undefined);
    expect((await store.getSessionData(sessionId))?.messages.filter(row => row.role === 'assistant')).toHaveLength(5);
    if (format === 'v2') {
      const active = store.getActiveSessionTranscript(sessionId)!;
      expect(await active.writer.flush(50)).toBe(false);
      state.failProductIo = false;
      expect(await active.writer.flush()).toBe(true);
    } else expect(store.getActiveSessionTranscript(sessionId)).toBeUndefined();
  });

  it('keeps an existing V1 identity on the legacy path when an Inbox-style request allows missing metadata', async () => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const id = randomUUID();
    await store.saveSessionMetadata({ id, agentDir: workspace, title: 'legacy', createdAt: 't', lastActiveAt: 't', runtime: 'builtin' });
    await agent.initializeAgent(workspace, null, id, { preWarmDisabled: true });
    let finish!: (outcome: TurnTerminalOutcome) => void;
    const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
    const admission = await agent.enqueueUserMessage('Inbox query', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { channelDelivery: NO_CHANNEL_DELIVERY, allowLazySessionMaterialization: true, onTerminal: finish });
    expect(admission.error).toBeUndefined();
    await expect(terminal).resolves.toMatchObject({ status: 'complete' });
    expect(store.getSessionMetadata(id)?.transcriptFormat).toBeUndefined();
    expect(store.getActiveSessionTranscript(id)).toBeUndefined();
    expect((await store.getSessionData(id))?.messages.map(row => row.role)).toEqual(['user', 'assistant']);
  });

  it('refuses a known invalid history before touching SDK file checkpoints', async () => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
    await agent.enqueueUserMessage('question', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
    await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 1 full-only tail'));
    await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
    const rows = agent.getMessages();
    store.getActiveSessionTranscript(metadata.id)!.writer.rejectIncompleteSource();
    expect(await agent.rewindSession(rows[0].id)).toMatchObject({ success: false, error: 'Conversation history contains data that cannot be safely rewound.' });
    expect(state.rewindFiles).not.toHaveBeenCalled();
    expect(agent.getMessages().map(row => row.id)).toEqual(rows.map(row => row.id));
  });

  it('does not treat absence from the SDK single-chain projection as an invalid rewind boundary', async () => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    const rows = [
      { id: 'u1', role: 'user' as const, content: 'first', timestamp: 't', sdkUuid: 'native-u1' },
      { id: 'a1', role: 'assistant' as const, content: 'orphaned answer', timestamp: 't', sdkUuid: 'native-orphan-a1' },
      { id: 'u2', role: 'user' as const, content: 'second', timestamp: 't', sdkUuid: 'native-u2' },
      { id: 'a2', role: 'assistant' as const, content: 'current answer', timestamp: 't', sdkUuid: 'native-current-a2' },
    ];
    const snapshot = await store.loadSessionTranscript(metadata.id);
    expect(await store.appendSessionMessages(metadata.id, snapshot.cursor, rows)).toMatchObject({ ok: true });
    state.sdkRead.mockResolvedValue([
      { type: 'user', uuid: 'native-u1' },
      { type: 'assistant', uuid: 'native-current-a2' },
    ]);
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });

    const result = await agent.rewindSession('u2');

    expect(result).toMatchObject({ success: true });
    expect(state.rewindFiles).not.toHaveBeenCalled();
    expect(agent.getMessages().map(row => row.id)).toEqual(['u1', 'a1']);
    expect(store.getSessionMetadata(metadata.id)?.sdkResumeSessionAt).toBe('native-orphan-a1');
  });

  it('lets native Query adjudicate a persisted boundary absent from the SDK projection', async () => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    const snapshot = await store.loadSessionTranscript(metadata.id);
    expect(await store.appendSessionMessages(metadata.id, snapshot.cursor, [
      { id: 'u1', role: 'user', content: 'first', timestamp: 't', sdkUuid: 'native-u1' },
      { id: 'a1', role: 'assistant', content: 'orphaned answer', timestamp: 't', sdkUuid: 'native-orphan-a1' },
    ])).toMatchObject({ ok: true });
    await store.updateSessionMetadata(metadata.id, {
      sdkSessionId: metadata.id,
      sdkResumeSessionAt: 'native-orphan-a1',
      unifiedSession: false,
    });
    state.sdkRead.mockResolvedValue([
      { type: 'user', uuid: 'native-u1' },
      { type: 'assistant', uuid: 'native-current-a2' },
    ]);
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });

    await agent.enqueueUserMessage('continue', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });

    await vi.waitFor(() => expect(state.query).toHaveBeenCalled());
    expect(state.query.mock.calls.at(-1)?.[0].options.resumeSessionAt).toBe('native-orphan-a1');
    await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
    expect(store.getSessionMetadata(metadata.id)?.sdkResumeSessionAt).toBeUndefined();
    expect(state.events.some(([name]) => name === 'chat:message-error')).toBe(false);
  });

  it('does not silently drop a persisted boundary when a legacy Product Session has no native identity', async () => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const legacySessionId = 'legacy-non-uuid-session';
    await store.saveSessionMetadata({
      id: legacySessionId,
      agentDir: workspace,
      title: 'legacy',
      createdAt: 't',
      lastActiveAt: 't',
      runtime: 'builtin',
      sdkResumeSessionAt: 'native-boundary',
    });
    const snapshot = await store.loadSessionTranscript(legacySessionId);
    expect(await store.appendSessionMessages(legacySessionId, snapshot.cursor, [
      { id: 'u1', role: 'user', content: 'first', timestamp: 't', sdkUuid: 'native-u1' },
      { id: 'a1', role: 'assistant', content: 'answer', timestamp: 't', sdkUuid: 'native-boundary' },
    ])).toMatchObject({ ok: true });
    await agent.initializeAgent(workspace, null, legacySessionId, { preWarmDisabled: true });

    await agent.enqueueUserMessage('continue', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });

    await vi.waitFor(() => expect(state.events).toContainEqual([
      'chat:message-error',
      expect.stringContaining('no native session identity'),
    ]));
    expect(state.query).not.toHaveBeenCalled();
    expect(store.getSessionMetadata(legacySessionId)?.sdkResumeSessionAt).toBe('native-boundary');
  });

  it('does not silently drop a cold-reload boundary when a legacy Product Session has no native identity', async () => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const legacySessionId = 'legacy-cold-reload-session';
    await store.saveSessionMetadata({
      id: legacySessionId,
      agentDir: workspace,
      title: 'legacy',
      createdAt: 't',
      lastActiveAt: 't',
      runtime: 'builtin',
    });
    const snapshot = await store.loadSessionTranscript(legacySessionId);
    expect(await store.appendSessionMessages(legacySessionId, snapshot.cursor, [
      { id: 'u1', role: 'user', content: 'first', timestamp: 't', sdkUuid: 'native-u1' },
      { id: 'a1', role: 'assistant', content: 'answer', timestamp: 't', sdkUuid: 'native-boundary' },
    ])).toMatchObject({ ok: true });
    await agent.initializeAgent(workspace, null, legacySessionId, { preWarmDisabled: true });

    await agent.enqueueUserMessage('continue', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });

    await vi.waitFor(() => expect(state.events).toContainEqual([
      'chat:message-error',
      expect.stringContaining('no native session identity'),
    ]));
    expect(state.query).not.toHaveBeenCalled();
  });

  it.each([false, true])('executes first/next query with product EACCES before birth (provider boundary=%s)', async providerBoundary => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    state.failProductIo = true;
    await agent.initializeAgent(workspace, null, undefined, { preWarmDisabled: true });
    for (const prompt of ['first', 'next']) {
      let finish!: (outcome: TurnTerminalOutcome) => void;
      const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
      const admission = await agent.enqueueUserMessage(prompt, [], undefined, undefined, providerBoundary
        ? { providerId: 'synthetic-provider', baseUrl: 'https://example.invalid', apiKey: 'synthetic-test-key' } : undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: finish });
      expect(admission.error).toBeUndefined();
      await expect(terminal).resolves.toMatchObject({ status: 'complete' });
    }
    const active = store.getActiveSessionTranscript(agent.getSessionId())!;
    expect(active.writer.projection.messages.size).toBe(4);
    expect(await active.writer.flush(100)).toBe(false);
    expect(active.writer.status.state).not.toBe('healthy');
  });

  it('starts a frozen V2 fork without waiting for optional provider route repair', async () => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    // Existing fork snapshots can carry a pinned provider/model without the
    // newer concrete route. Execution resolves it before its metadata repair.
    const metadata = await store.createSession(workspace, {
      runtime: 'builtin', model: 'claude-sonnet-4-6', providerId: 'anthropic-sub',
      configSnapshotAt: new Date().toISOString(),
    });
    const active = store.getActiveSessionTranscript(metadata.id)!;
    vi.spyOn(active.file, 'append').mockImplementation(() => new Promise<void>(resolve => { releaseWrite = resolve; }));
    expect(await active.writer.flush(20)).toBe(false);
    const config = await import('../utils/admin-config');
    expect(config.resolveWorkspaceConfig(workspace, metadata, { includeMcp: false }).providerRoute)
      .toMatchObject({ providerId: 'anthropic-sub', model: 'claude-sonnet-4-6' });
    const repair = vi.spyOn(store, 'updateSessionMetadata');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = (async () => {
        await agent.initializeAgent(workspace, null, metadata.id);
        let finish!: (outcome: TurnTerminalOutcome) => void;
        const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
        const admission = await agent.enqueueUserMessage('continue fork', [], undefined, undefined, undefined, undefined,
          undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: finish });
        expect(admission.error).toBeUndefined();
        return terminal;
      })();
      await expect(Promise.race([completed, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('AI waited for optional product route repair')), 1_000);
      })])).resolves.toMatchObject({ status: 'complete' });
      expect(repair).toHaveBeenCalledWith(metadata.id, expect.objectContaining({ providerRoute: expect.any(Object) }), expect.any(Function));
      expect(await active.writer.flush(20)).toBe(false);
    } finally { clearTimeout(timeout); }
  });

  it('preserves acknowledged queue order and exact materialized fork/rewind boundaries', async () => {
    state.queuedFollowup = true;
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
    await agent.enqueueUserMessage('first question', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
    await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 2 full-only tail'));
    const rows = agent.getMessages();
    expect(rows.map(row => row.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(rows[1].sdkUuid).toBe('tail-frame-1');
    expect(rows[3].sdkUuid).toBe('tail-frame-2');
    expect(JSON.stringify(rows[1].content)).not.toContain('response-2');
    expect(rows[2]).toMatchObject({ content: 'queued question', sdkUuid: undefined });
    const active = store.getActiveSessionTranscript(metadata.id)!;
    expect(await active.writer.flush()).toBe(true);
    expect((await active.file.read()).projection.messages.get(rows[1].id)?.sdkUuid).toBe('tail-frame-1');
    await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
    const newSid = randomUUID();
    const sdkRows = rows.filter(row => row.sdkUuid).map(row => ({ type: row.role, uuid: row.sdkUuid! }));
    const sourcePrefix = sdkRows.slice(0, sdkRows.findIndex(row => row.uuid === 'tail-frame-1') + 1);
    state.sdkRead.mockImplementation(async (id: string) => id === newSid
      ? sourcePrefix.map(row => ({ ...row, uuid: `fork-${row.uuid}` })) : sdkRows);
    state.sdkFork.mockResolvedValue({ sessionId: newSid });
    active.patchMetadata({ configSnapshotAt: 'frozen', reasoningEffort: 'high', enabledPluginIds: ['synthetic-plugin'], enabledOfficialToolIds: ['image-understanding'] });
    const targetId = randomUUID();
    const forked = await agent.forkSession(rows[1].id, targetId);
    expect(forked.newSessionId).toBe(targetId);
    expect(await agent.forkSession(rows[1].id, targetId)).toMatchObject({ success: true, newSessionId: targetId });
    expect(state.sdkFork).toHaveBeenCalledOnce();
    expect(forked.success).toBe(true);
    const target = (await store.getSessionData(forked.newSessionId!))!;
    expect(target.messages.map(row => row.role)).toEqual(['user', 'assistant']);
    expect(state.sdkFork).toHaveBeenCalledWith(metadata.id, expect.objectContaining({ upToMessageId: 'tail-frame-1' }));
    expect(target.messages[1].sdkUuid).toBe('fork-tail-frame-1');
    expect(target.forkFrom).toBeUndefined();
    expect(target).toMatchObject({ reasoningEffort: 'high', enabledPluginIds: ['synthetic-plugin'], enabledOfficialToolIds: ['image-understanding'] });
    state.queuedFollowup = false;
    expect(await agent.rewindSession(rows[2].id)).toMatchObject({ success: true });
    expect(agent.getMessages().map(row => row.id)).toEqual(rows.slice(0, 2).map(row => row.id));
    await agent.enqueueUserMessage('after rewind', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
    await vi.waitFor(() => {
      expect(agent.isSessionBusy()).toBe(false);
      expect(agent.getMessages().at(-1)?.role).toBe('assistant');
    });
    expect(state.query).toHaveBeenCalledTimes(2);
    expect(state.query.mock.calls[1][0].options.resumeSessionAt).toBe('tail-frame-1');
    expect(await active.writer.flush()).toBe(true);
    expect([...((await active.file.read()).projection.messages.keys())]).toEqual(agent.getMessages().map(row => row.id));
  });

  it('keeps partial/full child content under its parent while the root reuses the same stream index', async () => {
    state.childFrames = true;
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
    let finish!: (outcome: TurnTerminalOutcome) => void;
    const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
    await agent.enqueueUserMessage('question', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: finish });
    await expect(terminal).resolves.toMatchObject({ status: 'complete' });
    const blocks = agent.getMessages().flatMap(message => typeof message.content === 'string' ? [] : message.content);
    expect(blocks.filter(block => block.type === 'text').map(block => block.text)).toEqual(['answer 1', ' full-only tail']);
    expect(blocks.find(block => block.tool?.id === 'parent-1')?.tool?.subagentCalls).toMatchObject([
      { name: 'AgentMessage', result: 'child corrected', isLoading: false },
    ]);
    expect(blocks.find(block => block.tool?.id === 'parent-1')?.tool?.result).toBeUndefined();
    const active = store.getActiveSessionTranscript(metadata.id)!;
    expect(await active.writer.flush()).toBe(true);
    expect((await active.file.read()).projection.messages).toEqual(active.writer.projection.messages);
  });

  it('publishes full-only tools and completes subsequent turns while attachment archiving is hung', async () => {
    state.toolFrames = true;
    state.media.mockImplementation(() => new Promise(resolve => { releaseWrite = () => resolve([]); }));
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
    for (let turn = 1; turn <= 2; turn++) {
      let finish!: (outcome: TurnTerminalOutcome) => void;
      const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
      await agent.enqueueUserMessage(`question ${turn}`, [], undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined,
        { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: finish });
      await expect(terminal).resolves.toMatchObject({ status: 'complete' });
      expect(state.events).toContainEqual(['chat:tool-use-start', expect.objectContaining({ id: `tool-${turn}`, name: 'Read' })]);
      expect(state.events).toContainEqual(['chat:content-block-stop', expect.objectContaining({ toolId: `tool-${turn}`, input: { file_path: '/synthetic' } })]);
      expect(agent.getMessages().flatMap(message => typeof message.content === 'string' ? [] : message.content)).toContainEqual(expect.objectContaining({ tool: expect.objectContaining({ id: `tool-${turn}`, result: 'tool result' }) }));
    }
    expect(state.media).toHaveBeenCalledTimes(2);
  });

  it('settles an unexpected native exit without waiting for history IO', async () => {
    state.exitWithoutResult = true;
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    const active = store.getActiveSessionTranscript(metadata.id)!;
    vi.spyOn(active.file, 'append').mockRejectedValue(new Error('disk full'));
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
    let resolveTerminal!: (outcome: TurnTerminalOutcome) => void;
    const terminal = new Promise<TurnTerminalOutcome>(resolve => { resolveTerminal = resolve; });
    await agent.enqueueUserMessage('question', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: outcome => { resolveTerminal(outcome); } });
    await expect(terminal).resolves.toMatchObject({ status: 'error', error: 'AI runtime ended before completing this turn' });
    expect([...active.writer.projection.turns.values()]).toMatchObject([{ status: 'error', usage: { inputTokens: 4, outputTokens: 5 } }]);
    expect(agent.getMessages()[1].content).toMatchObject([
      { text: 'answer 1' }, { text: ' full-only tail' },
    ]);
    expect(agent.getMessages()[2]).toMatchObject({ messageKind: 'diagnostic',
      content: 'Error: AI runtime ended before completing this turn' });
  });

  it.each(['hung', 'full'] as const)('completes current and subsequent native turns with %s history IO', async failure => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    const active = store.getActiveSessionTranscript(metadata.id)!;
    if (failure === 'hung') vi.spyOn(active.file, 'append').mockImplementation(() => new Promise<void>(resolve => { releaseWrite = resolve; }));
    else vi.spyOn(active.file, 'append').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    expect(await active.writer.flush(20)).toBe(false);
    expect(active.file.append).toHaveBeenCalled();
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
    for (let turn = 1; turn <= 2; turn++) {
      let resolveTerminal!: (outcome: TurnTerminalOutcome) => void;
      const terminal = new Promise<TurnTerminalOutcome>(resolve => { resolveTerminal = resolve; });
      const result = await agent.enqueueUserMessage(`question ${turn}`, [], undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined,
        { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: outcome => { resolveTerminal(outcome); } });
      expect(result.error).toBeUndefined();
      const outcome = await Promise.race([terminal, new Promise<never>((_, reject) => {
        const timeout = setTimeout(() => reject(new Error('native turn waited for product storage')), 2_000);
        void terminal.finally(() => clearTimeout(timeout));
      })]);
      expect(outcome).toMatchObject({ status: 'complete' });
      expect(agent.getLastBuiltinAssistantText()).toBe(`answer ${turn} full-only tail`);
      expect(store.getSessionMetadata(metadata.id)).toMatchObject({ stats: { messageCount: turn, totalInputTokens: 4 * turn, totalOutputTokens: 5 * turn }, lastMessagePreview: `question ${turn}` });
    }
    expect(agent.getMessages().map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect([...active.writer.projection.turns.values()].map(turn => turn.status)).toEqual(['complete', 'complete']);
    expect(state.events.some(([event]) => event === 'chat:agent-error')).toBe(false);
  });
});

  it('materializes a fork of an unstarted legacy lazy branch from its real source', async () => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const source = await store.createSession(workspace, { runtime: 'builtin' });
    const { createSessionMetadata } = await import('../types/session');
    await mkdir(join(state.home, '.myagents'), { recursive: true });
    const branch = createSessionMetadata(workspace, { runtime: 'builtin', forkFrom: { sourceSessionId: source.id, messageUuid: 'native-a' } });
    await store.publishForkSession(branch, [
      { id: 'u', role: 'user', content: 'question', timestamp: 't', sdkUuid: 'native-u' },
      { id: 'a', role: 'assistant', content: 'answer', timestamp: 't', sdkUuid: 'native-a' },
    ], source.id);
    await agent.initializeAgent(workspace, null, branch.id, { preWarmDisabled: true });
    const newNative = randomUUID();
    state.sdkFork.mockResolvedValue({ sessionId: newNative });
    state.sdkRead.mockImplementation(async (id: string) => id === branch.id ? [] : [
      { type: 'user', uuid: id === newNative ? 'copy-u' : 'native-u' },
      { type: 'assistant', uuid: id === newNative ? 'copy-a' : 'native-a' },
    ]);
    const forked = await agent.forkSession('a');
    expect(forked.success).toBe(true);
    const target = store.getSessionMetadata(forked.newSessionId!)!;
    expect(target.forkFrom).toBeUndefined();
    expect(target.sdkSessionId).toBe(newNative);
    expect(state.sdkFork).toHaveBeenCalledWith(source.id, expect.objectContaining({ upToMessageId: 'native-a' }));
  });

  it('rewinds an unstarted legacy lazy branch using its real native source chain', async () => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const source = await store.createSession(workspace, { runtime: 'builtin' });
    const { createSessionMetadata } = await import('../types/session');
    await mkdir(join(state.home, '.myagents'), { recursive: true });
    const branch = createSessionMetadata(workspace, {
      runtime: 'builtin',
      forkFrom: { sourceSessionId: source.id, messageUuid: 'native-a2' },
    });
    await store.publishForkSession(branch, [
      { id: 'u1', role: 'user', content: 'first', timestamp: 't', sdkUuid: 'native-u1' },
      { id: 'a1', role: 'assistant', content: 'first answer', timestamp: 't', sdkUuid: 'native-a1' },
      { id: 'u2', role: 'user', content: 'second', timestamp: 't', sdkUuid: 'native-u2' },
      { id: 'a2', role: 'assistant', content: 'second answer', timestamp: 't', sdkUuid: 'native-a2' },
    ], source.id);
    await agent.initializeAgent(workspace, null, branch.id, { preWarmDisabled: true });
    state.sdkRead.mockImplementation(async (id: string) => id === branch.id ? [] : [
      { type: 'user', uuid: 'native-u1' },
      { type: 'assistant', uuid: 'native-a1' },
      { type: 'user', uuid: 'native-u2' },
      { type: 'assistant', uuid: 'native-a2' },
    ]);

    expect(await agent.rewindSession('u2')).toMatchObject({ success: true });

    expect(agent.getMessages().map(message => message.id)).toEqual(['u1', 'a1']);
    expect(store.getSessionMetadata(branch.id)).toMatchObject({
      forkFrom: { sourceSessionId: source.id, messageUuid: 'native-a2' },
      sdkResumeSessionAt: 'native-a1',
    });
  });

it('preserves completed file restoration when later transcript persistence fails', async () => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const metadata = await store.createSession(workspace, { runtime: 'builtin' });
  await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
  await agent.enqueueUserMessage('question', [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 1 full-only tail'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  const transcript = await import('../builtin-session/transcript');
  const user = agent.getMessages()[0];
  transcript.bindSdkUuidToMessage(user, 'native-user');
  transcript.addCurrentSessionUuid('native-user');
  expect(await store.getActiveSessionTranscript(metadata.id)!.writer.flush()).toBe(true);
  const persistence = await import('../builtin-session/transcript-persistence');
  vi.spyOn(persistence, 'truncateTranscriptPersistenceForRewind').mockRejectedValue(new Error('injected persistence failure'));
  state.rewindFiles.mockResolvedValue({ canRewind: true, filesChanged: ['synthetic-file'] });
  const response = await agent.rewindSession(user.id);
  expect(state.rewindFiles).toHaveBeenCalledWith('native-user');
  expect(response.success).toBe(false);
  expect(response.fileRewindStatus).toBe('complete');
  expect(response.error).toContain('injected persistence failure');
});

it.each(['v1', 'v2'])('retries %s through the backend mutation owner and ordinary send admission', async format => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = format === 'v2' ? await store.createSession(workspace, { runtime: 'builtin' })
    : { id: randomUUID(), agentDir: workspace, title: 'legacy', createdAt: 't', lastActiveAt: 't', runtime: 'builtin' as const };
  if (format === 'v1') await store.saveSessionMetadata(meta);
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  const engine = (await import('../session-engine/builtin-adapter')).createBuiltinSessionEngine();
  const sent = await engine.sendDesktopMessage({ sessionId: meta.id, workspacePath: workspace, scenario: { type: 'desktop' }, text: 'original question' });
  expect(sent.success).toBe(true);
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toContain('answer 1'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  const original = agent.getMessages().slice();
  const user = original[0];
  expect(await engine.retryUserMessage(user.id)).toMatchObject({ success: true, retryQueued: true, conversationCommitted: true });
  if (format === 'v1') expect(state.events).toContainEqual(['chat:messages-retracted', {
    messageIds: original.map(message => message.id), retractedStreamingTail: true,
  }]);
  await vi.waitFor(() => {
    expect(agent.getMessages()).toHaveLength(2);
    expect(agent.getMessages()[0].id).not.toBe(user.id);
    expect(agent.getMessages()[0].content).toBe('original question');
    expect(agent.isSessionBusy()).toBe(false);
  });
});

it('retains an exact rewind boundary across rejection and cold reopen', async () => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  state.queuedFollowup = true;
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  await agent.enqueueUserMessage('original', [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 2 full-only tail'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  const target = agent.getMessages()[2].id;
  state.queuedFollowup = false;
  expect(await agent.rewindSession(target)).toMatchObject({ success: true });
  expect(await store.getActiveSessionTranscript(meta.id)!.writer.flushForMutation()).toBe(true);
  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBe('tail-frame-1');
  await agent.resetSession();
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  state.query.mockImplementation(() => { throw new Error('No message found with message.uuid of: tail-frame-1'); });
  await agent.enqueueUserMessage('after reopen', [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await vi.waitFor(() => expect(state.query.mock.calls.at(-1)?.[0].options.resumeSessionAt).toBe('tail-frame-1'));
  await vi.waitFor(() => expect(state.events.some(([name]) => name === 'chat:message-error')).toBe(true));
  expect(agent.getMessages().some(message => message.role === 'user' && message.content === 'after reopen')).toBe(true);
  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBe('tail-frame-1');
  expect(state.query.mock.calls.at(-1)?.[0].options.resume).toBe(meta.id);
});

it.each([
  ['v1', 'result', false], ['v2', 'result', false], ['v1', 'throw', false], ['v2', 'throw', false],
  ['v1', 'result', true], ['v2', 'throw', true],
] as const)('recovers a rejected derived reload anchor for %s (%s, no-pre-warm=%s) without repeating the user turn', async (format, failure, noPreWarm) => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const id = randomUUID();
  if (format === 'v2') await store.createSession(workspace, { runtime: 'builtin', id });
  else await store.saveSessionMetadata({ id, agentDir: workspace, title: 'legacy', createdAt: 't', lastActiveAt: 't', runtime: 'builtin', sdkSessionId: id });
  const snapshot = await store.loadSessionTranscript(id);
  expect(await store.appendSessionMessages(id, snapshot.cursor, [
    { id: 'u1', role: 'user', content: 'prior', timestamp: 't', sdkUuid: 'native-user' },
    { id: 'a1', role: 'assistant', content: 'prior answer', timestamp: 't', sdkUuid: 'native-tail' },
  ])).toMatchObject({ ok: true });
  state.sdkRead.mockResolvedValue([{ type: 'user', uuid: 'native-user' }, { type: 'assistant', uuid: 'native-tail' }]);
  if (failure === 'result') state.rejectedResumeAt = 'native-tail';
  else state.query.mockImplementation((args: Parameters<typeof fakeQuery>[0]) => {
    if (args.options.resumeSessionAt === 'native-tail') {
      throw new Error('No message found with message.uuid of: native-tail');
    }
    return fakeQuery(args);
  });
  await agent.initializeAgent(workspace, null, id, { preWarmDisabled: true });
  if (!noPreWarm) (await import('../builtin-session/lifecycle')).setPreWarmDisabled(false);

  await agent.enqueueUserMessage('continue once', [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });

  await vi.waitFor(() => expect(state.query.mock.calls.some(([args]) =>
    args.options.resume === id && args.options.resumeSessionAt === undefined)).toBe(true));
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toContain('answer 1'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  expect(state.query.mock.calls[0][0].options.resumeSessionAt).toBe('native-tail');
  expect(state.sdkInputs).toHaveLength(1);
  expect(agent.getMessages().filter(message => message.role === 'user' && message.content === 'continue once')).toHaveLength(1);
  expect(state.events.some(([name]) => name === 'chat:message-error')).toBe(false);
  expect(store.getSessionMetadata(id)?.sdkResumeSessionAt).toBeUndefined();
});

it('pre-warm retries a rejected inferred anchor against the native head', async () => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  const snapshot = await store.loadSessionTranscript(meta.id);
  expect(await store.appendSessionMessages(meta.id, snapshot.cursor, [
    { id: 'u1', role: 'user', content: 'prior', timestamp: 't', sdkUuid: 'native-user' },
    { id: 'a1', role: 'assistant', content: 'prior answer', timestamp: 't', sdkUuid: 'native-tail' },
  ])).toMatchObject({ ok: true });
  state.sdkRead.mockResolvedValue([{ type: 'user', uuid: 'native-user' }, { type: 'assistant', uuid: 'native-tail' }]);
  state.rejectedResumeAt = 'native-tail';

  await agent.initializeAgent(workspace, null, meta.id);
  agent.setMcpServers([]);
  await vi.waitFor(() => {
    const calls = state.query.mock.calls.map(([args]) => args.options);
    const rejectedIndex = calls.findIndex(options => options.resume === meta.id && options.resumeSessionAt === 'native-tail');
    expect(rejectedIndex).toBeGreaterThanOrEqual(0);
    expect(calls.slice(rejectedIndex + 1).some(options =>
      options.resume === meta.id && options.resumeSessionAt === undefined)).toBe(true);
  }, { timeout: 3_000 });
  expect(state.events.some(([name]) => name === 'chat:message-error')).toBe(false);

  await agent.enqueueUserMessage('continue', [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toContain('answer 1'));
  expect(state.sdkInputs).toHaveLength(1);
});

it('preserves an IM turn across rejected inferred-anchor recovery', async () => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  const snapshot = await store.loadSessionTranscript(meta.id);
  expect(await store.appendSessionMessages(meta.id, snapshot.cursor, [
    { id: 'u1', role: 'user', content: 'prior', timestamp: 't', sdkUuid: 'native-user' },
    { id: 'a1', role: 'assistant', content: 'prior answer', timestamp: 't', sdkUuid: 'native-tail' },
  ])).toMatchObject({ ok: true });
  state.sdkRead.mockResolvedValue([{ type: 'user', uuid: 'native-user' }, { type: 'assistant', uuid: 'native-tail' }]);
  state.rejectedResumeAt = 'native-tail';
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  (await import('../builtin-session/lifecycle')).setPreWarmDisabled(false);

  const onTerminal = vi.fn<(outcome: TurnTerminalOutcome) => void>();
  const engine = (await import('../session-engine/builtin-adapter')).createBuiltinSessionEngine();
  expect(await engine.enqueueImMessage({ message: 'IM once', requestId: 'im-reload', sessionId: meta.id, workspacePath: workspace,
    scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' }, onTerminal })).toMatchObject({ success: true });

  await vi.waitFor(() => expect(state.query.mock.calls.some(([args]) =>
    args.options.resume === meta.id && args.options.resumeSessionAt === undefined)).toBe(true));
  await vi.waitFor(() => expect(state.sdkInputs).toHaveLength(1));
  await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
  expect(onTerminal.mock.calls[0][0]).toMatchObject({ status: 'complete' });
});

it('admits the replay before a desktop send arriving during rewind', async () => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  const engine = (await import('../session-engine/builtin-adapter')).createBuiltinSessionEngine();
  const request = (text: string) => ({ sessionId: meta.id, workspacePath: workspace, scenario: { type: 'desktop' as const }, text, turnBoundaryOnly: true });
  await engine.sendDesktopMessage(request('original'));
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 1 full-only tail'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  const transcript = await import('../builtin-session/transcript');
  const user = agent.getMessages()[0];
  transcript.bindSdkUuidToMessage(user, 'native-user');
  transcript.addCurrentSessionUuid('native-user');
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  state.rewindFiles.mockImplementation(async () => { entered(); await gate; return { canRewind: true }; });
  const retry = engine.retryUserMessage(user.id);
  await started;
  const competitor = engine.sendDesktopMessage(request('competing send'));
  release();
  expect(await retry).toMatchObject({ success: true, retryQueued: true });
  expect(await competitor).toMatchObject({ success: true });
  await vi.waitFor(() => expect(agent.getMessages().filter(message => message.role === 'user').map(message => message.content)).toEqual(['original', 'competing send']));
});

it('publishes a rewound turn only after the native Query has materialized its selected head', async () => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  state.queuedFollowup = true;
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  const send = (text: string) => agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await send('original');
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 2 full-only tail'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  state.queuedFollowup = false;
  expect(await agent.rewindSession(agent.getMessages()[2].id)).toMatchObject({ success: true });
  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBe('tail-frame-1');

  state.queryInputEnded = 0;
  state.queryExitGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const completionsBeforeReplacement = state.events.filter(([event]) => event === 'chat:message-complete').length;
  await send('replacement');
  await vi.waitFor(() => expect(state.queryInputEnded).toBe(1));

  // The native rows and SDK result already exist, but the Query has not yet
  // exited and published its durable branch selector.
  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBe('tail-frame-1');
  expect(state.events.filter(([event]) => event === 'chat:message-complete')).toHaveLength(completionsBeforeReplacement);
  expect(agent.isSessionBusy()).toBe(true);

  releaseWrite!();
  releaseWrite = undefined;
  await vi.waitFor(() => expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBeUndefined());
  await vi.waitFor(() => expect(state.events.filter(([event]) => event === 'chat:message-complete'))
    .toHaveLength(completionsBeforeReplacement + 1));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
});

it('waits for rewound Query background tasks before materializing the selected head', async () => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  state.queuedFollowup = true;
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  const send = (text: string) => agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await send('original');
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 2 full-only tail'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  state.queuedFollowup = false;
  expect(await agent.rewindSession(agent.getMessages()[2].id)).toMatchObject({ success: true });

  state.queryInputEnded = 0;
  state.backgroundTask = true;
  state.independentInputPump = true;
  state.sdkInputs.length = 0;
  state.backgroundTaskGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const completionsBeforeReplacement = state.events.filter(([event]) => event === 'chat:message-complete').length;
  const resultsBeforeReplacement = state.beforeResult.mock.calls.length;
  await send('replacement');
  await vi.waitFor(() => expect(state.events.some(([event]) => event === 'chat:task-started')).toBe(true));
  await vi.waitFor(() => expect(state.beforeResult).toHaveBeenCalledTimes(resultsBeforeReplacement + 1));
  await vi.waitFor(() => expect(state.sdkInputs).toHaveLength(1));

  expect(state.queryInputEnded).toBe(0);
  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBe('tail-frame-1');
  expect(state.events.filter(([event]) => event === 'chat:message-complete')).toHaveLength(completionsBeforeReplacement);

  const successor = send('successor after replacement');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(state.sdkInputs).toHaveLength(1);

  state.backgroundTask = false;
  releaseWrite!();
  releaseWrite = undefined;
  await successor;
  await vi.waitFor(() => expect(state.queryInputEnded).toBe(1));
  await vi.waitFor(() => expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBeUndefined());
  await vi.waitFor(() => expect(state.events.filter(([event]) => event === 'chat:message-complete'))
    .toHaveLength(completionsBeforeReplacement + 1));
});

it('does not publish deferred rewind success when the Query is explicitly aborted', async () => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  state.queuedFollowup = true;
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  const send = (text: string) => agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await send('original');
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 2 full-only tail'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  state.queuedFollowup = false;
  expect(await agent.rewindSession(agent.getMessages()[2].id)).toMatchObject({ success: true });

  state.backgroundTask = true;
  state.backgroundTaskGate = new Promise<void>(() => {});
  state.interruptCloses = true;
  const completionsBeforeReplacement = state.events.filter(([event]) => event === 'chat:message-complete').length;
  const resultsBeforeReplacement = state.beforeResult.mock.calls.length;
  await send('replacement');
  await vi.waitFor(() => expect(state.events.some(([event]) => event === 'chat:task-started')).toBe(true));
  await vi.waitFor(() => expect(state.beforeResult).toHaveBeenCalledTimes(resultsBeforeReplacement + 1));

  await agent.resetSession();
  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBe('tail-frame-1');
  expect(state.events.filter(([event]) => event === 'chat:message-complete')).toHaveLength(completionsBeforeReplacement);
});

it('retains the rewind boundary when native Query exit fails after a successful result', async () => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  state.queuedFollowup = true;
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  const send = (text: string) => agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await send('original');
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 2 full-only tail'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  state.queuedFollowup = false;
  expect(await agent.rewindSession(agent.getMessages()[2].id)).toMatchObject({ success: true });

  state.throwAfterInputEnd = true;
  const completionsBeforeReplacement = state.events.filter(([event]) => event === 'chat:message-complete').length;
  await send('replacement');
  await vi.waitFor(() => expect(state.events.some(([event]) => event === 'chat:message-error')).toBe(true));

  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBe('tail-frame-1');
  expect(state.events.filter(([event]) => event === 'chat:message-complete')).toHaveLength(completionsBeforeReplacement);
});

it('retires a rewound Query after an SDK error result and lets a new Query recover the retained boundary', async () => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  state.queuedFollowup = true;
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  const send = (text: string) => agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await send('original');
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 2 full-only tail'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  state.queuedFollowup = false;
  expect(await agent.rewindSession(agent.getMessages()[2].id)).toMatchObject({ success: true });

  state.independentInputPump = true;
  state.sdkInputs.length = 0;
  state.queryInputEnded = 0;
  state.resultMode = 'error';
  await send('replacement fails');

  await vi.waitFor(() => expect(state.events.some(([event]) => event === 'chat:agent-error')).toBe(true));
  await vi.waitFor(() => expect(state.queryInputEnded).toBe(1));
  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBe('tail-frame-1');
  expect(state.sdkInputs).toHaveLength(1);

  state.independentInputPump = false;
  state.resultMode = 'success';
  await send('replacement succeeds on a fresh Query');
  await vi.waitFor(() => expect(state.query).toHaveBeenCalledTimes(3));
  expect(state.query.mock.calls.at(-1)?.[0].options.resumeSessionAt).toBe('tail-frame-1');
  await vi.waitFor(() => expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBeUndefined());
});

it('settles the rewind boundary before a successful turn triggers a deferred restart', async () => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  state.queuedFollowup = true;
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: false });
  const send = (text: string) => agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await send('original');
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 2 full-only tail'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  state.queuedFollowup = false;
  expect(await agent.rewindSession(agent.getMessages()[2].id)).toMatchObject({ success: true });
  state.beforeResult.mockImplementationOnce(() => agent.setSessionReasoningEffort('high'));
  await send('replacement');
  await vi.waitFor(() => expect(state.beforeResult).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBeUndefined();
  await vi.waitFor(() => expect(state.query).toHaveBeenCalledTimes(3));
  expect(state.query.mock.calls[2][0].options.resumeSessionAt).toBeUndefined();
  await vi.waitFor(() => expect(agent.getMessages().filter(message => message.role === 'user').map(message => message.content))
    .toEqual(['original', 'replacement']));
});

it.each([false, true])('retries past an independent product diagnostic with cold restore=%s', async coldRestore => {
  const workspace = join(state.home, 'diagnostic-retry');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  const rows = [
    { id: 'u1', role: 'user' as const, content: 'confirmed input', timestamp: 't', sdkUuid: 'native-u1' },
    { id: 'd1', role: 'assistant' as const, content: 'Error: process exited', timestamp: 't', messageKind: 'diagnostic' as const },
    { id: 'u2', role: 'user' as const, content: 'send again', timestamp: 't' },
  ];
  const snapshot = await store.loadSessionTranscript(meta.id);
  expect(await store.appendSessionMessages(meta.id, snapshot.cursor, rows)).toMatchObject({ ok: true });
  if (coldRestore) await store.releaseSessionTranscriptForBinding(meta.id);
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  const replay = vi.fn(async () => {
    expect(agent.getMessages().map(row => row.id)).toEqual(['u1', 'd1']);
    const result = await agent.enqueueUserMessage('send again', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
    return { success: true as const, queued: result.queued };
  });
  expect(await agent.retryBuiltinUserMessage('u2', replay)).toMatchObject({ success: true });
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  expect(replay).toHaveBeenCalledTimes(1);
  expect(state.query.mock.calls.at(-1)?.[0].options.resumeSessionAt).toBe('native-u1');
  expect(agent.getMessages()[1]).toMatchObject({ id: 'd1', messageKind: 'diagnostic' });
});

it('does not promote a queued consumption id into a native rewind anchor', async () => {
  const workspace = join(state.home, 'queue-anchor');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  state.queuedFollowup = true;
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  await agent.enqueueUserMessage('original', [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 2 full-only tail'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  expect(agent.getMessages().find(message => message.content === 'queued question')).toMatchObject({ role: 'user', sdkUuid: undefined });
  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBeUndefined();
});

it.each(['unconfirmed-user', 'partial-assistant', 'legacy-error', 'conflicting-diagnostic', 'runtime-anchor'] as const)(
  'refuses retry past %s without truncating history or replaying', async shape => {
    const workspace = join(state.home, shape);
    await mkdir(workspace);
    const meta = await store.createSession(workspace, { runtime: 'builtin' });
    const unknown = shape === 'unconfirmed-user'
      ? { id: 'unknown', role: 'user' as const, content: 'not acknowledged', timestamp: 't' }
      : { id: 'unknown', role: 'assistant' as const, content: shape === 'legacy-error' ? 'Error: old error' : 'partial', timestamp: 't',
        ...(shape === 'conflicting-diagnostic' ? { messageKind: 'diagnostic' as const, sdkUuid: 'conflict' } : {}) };
    if (shape === 'runtime-anchor') Object.assign(unknown, { messageKind: 'diagnostic',
      runtimeTurnAnchor: { turnId: 'native-turn', rootUserMessageId: 'u1' } });
    const rows = [
      { id: 'u1', role: 'user' as const, content: 'confirmed', timestamp: 't', sdkUuid: 'native-u1' },
      unknown,
      { id: 'd1', role: 'assistant' as const, content: 'Error: failed', timestamp: 't', messageKind: 'diagnostic' as const },
      { id: 'u2', role: 'user' as const, content: 'retry me', timestamp: 't' },
    ];
    const snapshot = await store.loadSessionTranscript(meta.id);
    expect(await store.appendSessionMessages(meta.id, snapshot.cursor, rows)).toMatchObject({ ok: true });
    await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
    const replay = vi.fn(async () => ({ success: true as const }));
    const before = agent.getMessages();
    expect(await agent.retryBuiltinUserMessage('u2', replay)).toMatchObject({ success: false,
      error: 'The retained history has no exact native rewind boundary' });
    expect(agent.getMessages()).toEqual(before);
    expect(replay).not.toHaveBeenCalled();
    expect(state.rewindFiles).not.toHaveBeenCalled();
    expect(state.query).not.toHaveBeenCalled();
    expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBeUndefined();
  });

it('retains a diagnostic-only product prefix while starting a new native execution', async () => {
  const workspace = join(state.home, 'diagnostic-only');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  const snapshot = await store.loadSessionTranscript(meta.id);
  expect(await store.appendSessionMessages(meta.id, snapshot.cursor, [
    { id: 'd', role: 'assistant', content: 'Error: local diagnostic', timestamp: 't', messageKind: 'diagnostic' },
    { id: 'u', role: 'user', content: 'question', timestamp: 't' },
  ])).toMatchObject({ ok: true });
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  expect(await agent.rewindSession('u')).toMatchObject({ success: true });
  expect(agent.getMessages()).toMatchObject([{ id: 'd', messageKind: 'diagnostic' }]);
  expect(store.getSessionMetadata(meta.id)?.sdkSessionId).not.toBe(meta.id);
  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBeUndefined();
});

it('refuses a diagnostic fork point even if its source contract carries a conflicting native UUID', async () => {
  const workspace = join(state.home, 'diagnostic-fork-conflict');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  const snapshot = await store.loadSessionTranscript(meta.id);
  expect(await store.appendSessionMessages(meta.id, snapshot.cursor, [
    { id: 'd', role: 'assistant', content: 'Error: failed', timestamp: 't', messageKind: 'diagnostic', sdkUuid: 'conflict' },
  ])).toMatchObject({ ok: true });
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  expect(await agent.forkSession('d')).toMatchObject({ success: false, error: 'This message has no exact native fork boundary' });
  expect(state.sdkFork).not.toHaveBeenCalled();
});

it('preserves diagnostics through native fork and cold retry using remapped user UUIDs', async () => {
  const workspace = join(state.home, 'diagnostic-fork');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  const snapshot = await store.loadSessionTranscript(meta.id);
  expect(await store.appendSessionMessages(meta.id, snapshot.cursor, [
    { id: 'u1', role: 'user', content: 'one', timestamp: 't', sdkUuid: 'native-u1' },
    { id: 'd', role: 'assistant', content: 'Error: failed', timestamp: 't', messageKind: 'diagnostic' },
    { id: 'u2', role: 'user', content: 'two', timestamp: 't', sdkUuid: 'native-u2' },
    { id: 'a2', role: 'assistant', content: 'answer', timestamp: 't', sdkUuid: 'native-a2' },
  ])).toMatchObject({ ok: true });
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  expect(await agent.forkSession('d')).toMatchObject({ success: false });
  expect(state.sdkFork).not.toHaveBeenCalled();
  const nativeFork = randomUUID();
  state.sdkRead.mockImplementation(async (id: string) => [
    { type: 'user', uuid: `${id === nativeFork ? 'fork-' : ''}native-u1` },
    { type: 'user', uuid: `${id === nativeFork ? 'fork-' : ''}native-u2` },
    { type: 'assistant', uuid: `${id === nativeFork ? 'fork-' : ''}native-a2` },
  ]);
  state.sdkFork.mockResolvedValue({ sessionId: nativeFork });
  const fork = await agent.forkSession('a2');
  expect(fork).toMatchObject({ success: true });
  const forkData = (await store.getSessionData(fork.newSessionId!))!;
  expect(forkData.messages[1]).toMatchObject({ id: 'd', messageKind: 'diagnostic' });
  expect(forkData.messages[1].sdkUuid).toBeUndefined();
  await agent.resetSession();
  await agent.initializeAgent(workspace, null, fork.newSessionId!, { preWarmDisabled: true });
  expect(await agent.retryBuiltinUserMessage('u2', async () => ({ success: true }))).toMatchObject({ success: true });
  expect(agent.getMessages().map(row => row.id)).toEqual(['u1', 'd']);
  expect(store.getSessionMetadata(fork.newSessionId!)?.sdkResumeSessionAt).toBe('fork-native-u1');
});

it.each(['iterator-close', 'transport-error'] as const)(
  'keeps an unexpected %s separate from output and can send the next query', async exit => {
  state.exitWithoutResult = exit === 'iterator-close';
  if (exit === 'transport-error') state.query.mockImplementationOnce((args: Parameters<typeof fakeQuery>[0]) => {
    const query = fakeQuery(args);
    return { ...query, async next() {
      const frame = await query.next();
      if ((frame.value as { type?: string } | undefined)?.type === 'result') {
        throw new Error('Claude Code process exited with code 1. stderr: [claude-code:unrecognized_model] {"model":"kimi-k3","query_source":"sdk"}');
      }
      return frame;
    } };
  });
  const workspace = join(state.home, 'diagnostic-output');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  const send = async (text: string) => {
    let finish!: (outcome: TurnTerminalOutcome) => void;
    const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
    await agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: finish });
    return terminal;
  };
  expect(await send('first')).toMatchObject({ status: 'error' });
  const rows = agent.getMessages();
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({ sdkUuid: 'tail-frame-1', usage: { inputTokens: 4, outputTokens: 5 } });
  expect(JSON.stringify(rows[1].content)).not.toContain('Error:');
  expect(rows[2]).toMatchObject({ role: 'assistant', messageKind: 'diagnostic', content: expect.stringContaining('Error:') });
  expect(rows[2].sdkUuid).toBeUndefined();
  expect(rows[2].usage).toBeUndefined();
  expect(rows[2].turnId).toBe(rows[1].turnId);
  state.exitWithoutResult = false;
  await vi.waitFor(() => expect(agent.isSessionActive()).toBe(false));
  expect(await send('second')).toMatchObject({ status: 'complete' });
  expect(agent.getBuiltinSessionCompletionTerminal()?.status).toBe('complete');
  expect(state.query).toHaveBeenCalledTimes(2);
});

it('keeps the native local command assistant UUID as an exact retry boundary', async () => {
  state.query.mockImplementation((args: Parameters<typeof fakeQuery>[0]) => {
    const query = fakeQuery(args);
    return { ...query, async next() {
      const frame = await query.next();
      const value = frame.value as { type?: string } | undefined;
      return value?.type === 'assistant'
        ? { ...frame, value: { ...value, local_command_source: 'context' } } : frame;
    } };
  });
  const workspace = join(state.home, 'native-local-command');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  for (const text of ['/context', 'next question']) {
    let finish!: (outcome: TurnTerminalOutcome) => void;
    const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
    await agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: finish });
    await expect(terminal).resolves.toMatchObject({ status: 'complete' });
  }
  const rows = agent.getMessages();
  expect(rows[1]).toMatchObject({ sdkUuid: 'tail-frame-1' });
  expect(rows[1].messageKind).toBeUndefined();
  expect(await agent.retryBuiltinUserMessage(rows[2].id, async () => ({ success: true })))
    .toMatchObject({ success: true });
  expect(store.getSessionMetadata(meta.id)?.sdkResumeSessionAt).toBe('tail-frame-1');
});

it.each([false, true])('keeps the immediate native user boundary with an earlier assistant=%s', async earlierAssistant => {
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  const prefix = earlierAssistant ? [
    { id: 'u1', role: 'user' as const, content: 'one', timestamp: 't', sdkUuid: 'native-u1' },
    { id: 'a1', role: 'assistant' as const, content: 'one answer', timestamp: 't', sdkUuid: 'native-a1' },
  ] : [];
  const rows = [...prefix,
    { id: 'u2', role: 'user' as const, content: 'unanswered retained user', timestamp: 't', sdkUuid: 'native-u2' },
    { id: 'u3', role: 'user' as const, content: 'discard', timestamp: 't', sdkUuid: 'native-u3' },
    { id: 'a3', role: 'assistant' as const, content: 'discard answer', timestamp: 't', sdkUuid: 'native-a3' },
  ];
  const snapshot = await store.loadSessionTranscript(meta.id);
  expect(await store.appendSessionMessages(meta.id, snapshot.cursor, rows)).toMatchObject({ ok: true });
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: true });
  expect(await agent.rewindSession('u3')).toMatchObject({ success: true });
  expect(agent.getMessages().map(row => row.id)).toEqual([...prefix.map(row => row.id), 'u2']);
  expect(store.getSessionMetadata(meta.id)).toMatchObject({ sdkSessionId: meta.id, sdkResumeSessionAt: 'native-u2' });
});

async function startSdkContractSession(): Promise<Options> {
  const workspace = join(state.home, 'sdk-contract');
  await mkdir(workspace);
  const metadata = await store.createSession(workspace, { runtime: 'builtin' });
  await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
  await agent.enqueueUserMessage('contract question', [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 1 full-only tail'));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  return state.query.mock.calls.findLast(([call]) => call.options.cwd === workspace)![0].options as Options;
}

it('persists SDK cumulative usage as per-turn deltas across a Query restart', async () => {
  state.sdkCumulativeBase = { input: 0, output: 0 };
  const workspace = join(state.home, 'usage');
  await mkdir(workspace);
  const metadata = await store.createSession(workspace, { runtime: 'builtin' });
  await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
  const send = async (text: string) => {
    await agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
    await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  };

  await send('first');
  await send('second');
  let assistants = agent.getMessages().filter(message => message.role === 'assistant');
  expect(assistants.map(message => message.usage?.inputTokens)).toEqual([4, 4]);
  expect(assistants.map(message => message.usage?.outputTokens)).toEqual([5, 5]);
  expect(assistants[1].usage?.sdkCumulativeModelUsage?.['test-model']).toMatchObject({ inputTokens: 8, outputTokens: 10 });

  await agent.resetSession();
  state.sdkCumulativeBase = { input: 8, output: 10 };
  await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
  await send('after restart');
  assistants = agent.getMessages().filter(message => message.role === 'assistant');
  expect(state.query.mock.calls.at(-1)?.[0].options.resume).toBe(metadata.id);
  expect(assistants.map(message => message.usage?.inputTokens)).toEqual([4, 4, 4]);
  expect(assistants[2].usage?.sdkCumulativeModelUsage?.['test-model']).toMatchObject({ inputTokens: 12, outputTokens: 15 });
});

it('resumes usage from a compact control turn that has no assistant message', async () => {
  state.sdkCumulativeBase = { input: 0, output: 0 };
  state.compactAtTurn = 2;
  const workspace = join(state.home, 'compact-usage');
  await mkdir(workspace);
  const metadata = await store.createSession(workspace, { runtime: 'builtin' });
  await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
  const send = async (text: string) => {
    await agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
    await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  };

  await send('first');
  await send('/compact');
  expect(agent.getMessages().filter(message => message.role === 'assistant')).toHaveLength(1);
  const turns = [...store.getActiveSessionTranscript(metadata.id)!.writer.projection.turns.values()];
  expect(turns.at(-1)?.usage?.sdkCumulativeModelUsage?.['test-model']).toMatchObject({ inputTokens: 8, outputTokens: 5 });
  expect(await store.getActiveSessionTranscript(metadata.id)!.writer.flush()).toBe(true);

  await agent.resetSession();
  state.sdkCumulativeBase = { input: 8, output: 5 };
  state.compactAtTurn = null;
  await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
  expect([...store.getActiveSessionTranscript(metadata.id)!.writer.projection.turns.values()].at(-1)
    ?.usage?.sdkCumulativeModelUsage?.['test-model']).toMatchObject({ inputTokens: 8, outputTokens: 5 });
  await send('after compact');
  const assistants = agent.getMessages().filter(message => message.role === 'assistant');
  expect(assistants.map(message => message.usage?.inputTokens)).toEqual([4, 4]);
  expect(assistants[1].usage?.sdkCumulativeModelUsage?.['test-model']).toMatchObject({ inputTokens: 12, outputTokens: 10 });
});

it('persists an SDK conversation reset baseline through a Query restart', async () => {
  state.sdkCumulativeBase = { input: 0, output: 0 };
  state.resetAtTurn = 2;
  const workspace = join(state.home, 'reset-usage');
  await mkdir(workspace);
  const metadata = await store.createSession(workspace, { runtime: 'builtin' });
  await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
  const send = async (text: string) => {
    await agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
    await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  };

  await send('first');
  await send('/clear');
  const active = store.getActiveSessionTranscript(metadata.id)!;
  expect([...active.writer.projection.turns.values()].at(-1)?.usage?.sdkCumulativeModelUsage).toEqual({});
  expect(await active.writer.flush()).toBe(true);

  await agent.resetSession();
  state.sdkCumulativeBase = { input: 10, output: 10 };
  state.resetAtTurn = null;
  await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
  await send('after reset');
  const assistant = agent.getMessages().filter(message => message.role === 'assistant').at(-1);
  expect(assistant?.usage).toMatchObject({ inputTokens: 14, outputTokens: 15 });
});

it('shows the built-in slash command when the SDK returns a same-name plugin command first', async () => {
  state.sdkCommands = [
    { name: 'compact', description: 'Plugin compact', argumentHint: '', builtin: false },
    { name: 'Compact', description: 'Claude compact', argumentHint: '', builtin: true },
  ];
  await startSdkContractSession();
  const commandEvent = state.events.find(([event, payload]) =>
    event === 'chat:slash-commands' && (payload as { source?: string }).source === 'initialize');
  expect(commandEvent?.[1]).toMatchObject({
    commands: [{ name: 'Compact', description: 'Claude compact', source: 'sdk' }],
  });
});

it('keeps product append fresh and coalesced notification receipts outside product terminal handling', async () => {
  notificationReceipts = true;
  const options = await startSdkContractSession();
  expect(options.systemPrompt).toMatchObject({ type: 'preset', snapshot: false, append: expect.any(String) });
  expect(state.events.filter(([event]) => event === 'chat:message-error')).toEqual([]);
  expect(state.events.filter(([event]) => event === 'chat:message-complete')).toHaveLength(1);
  expect(agent.getMessages().map(message => message.role)).toEqual(['user', 'assistant']);
  expect(agent.getLastBuiltinAssistantText()).toBe('answer 1 full-only tail');
});

it('keeps constrained permissions per request through replay, approval, cascade and abort', async () => {
  const options = await startSdkContractSession();
  (await import('../builtin-session/config')).configState.currentPermissionMode = 'custom';
  const ask = options.canUseTool!;
  const controller = new AbortController();
  const hints = { defaultToNo: true, suppressAlwaysAllowRule: true };
  const first = ask('WebFetch', { url: 'https://example.invalid/first' }, { signal: controller.signal, toolUseID: 'first', requestId: 'first', ...hints });
  const second = ask('WebFetch', { url: 'https://example.invalid/second' }, { signal: controller.signal, toolUseID: 'second', requestId: 'second', ...hints });
  const plain = ask('WebFetch', {}, { signal: controller.signal, toolUseID: 'plain', requestId: 'plain' });
  const pending = () => agent.getPendingInteractiveRequests().filter(row => row.type === 'permission:request')
    .map(row => row.data as { requestId: string; defaultToNo?: boolean; suppressAlwaysAllowRule?: boolean });
  expect(pending()).toHaveLength(3);
  const [p1, p2, p3] = pending();
  expect(p1).toMatchObject(hints);
  expect(state.events.find(([event]) => event === 'permission:request')?.[1]).toMatchObject(hints);
  expect(agent.handlePermissionResponse(p1.requestId, 'always_allow')).toBe(false);
  expect(pending()).toHaveLength(3);
  expect(agent.handlePermissionResponse(p3.requestId, 'always_allow')).toBe(true);
  await expect(plain).resolves.toMatchObject({ behavior: 'allow' });
  expect(pending()).toHaveLength(2); // ordinary grant cannot cascade onto restricted calls
  expect(agent.handlePermissionResponse(p1.requestId, 'allow_once')).toBe(true);
  await expect(first).resolves.toMatchObject({ behavior: 'allow' });
  expect(pending().map(row => row.requestId)).toEqual([p2.requestId]);
  const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect(pending()).toHaveLength(0);
  expect(agent.handlePermissionResponse(p2.requestId, 'allow_once')).toBe(false);
  const againController = new AbortController();
  const again = ask('WebFetch', {}, { signal: againController.signal, toolUseID: 'again', requestId: 'again', ...hints });
  expect(pending()).toHaveLength(1); // an existing broad session grant cannot swallow the hints
  const aborted = expect(again).rejects.toMatchObject({ name: 'AbortError' });
  againController.abort();
  await aborted;
});

it('checks context MCP provenance in foreground, bypass hooks and background grants', async () => {
  const options = await startSdkContractSession();
  const { configState } = await import('../builtin-session/config');
  configState.frozenSdkMcpFingerprint = 'im-bridge-tools|';
  configState.currentPermissionMode = 'custom';
  const toolName = 'mcp__im-bridge-tools__send';
  const ask = (source?: string) => options.canUseTool!(toolName, {}, {
    signal: new AbortController().signal, toolUseID: 'mcp-call', requestId: 'mcp-call',
    ...(source ? { mcpServer: { name: 'im-bridge-tools', source } } : {}),
  });
  await expect(ask('sdk')).resolves.toMatchObject({ behavior: 'allow' });
  for (const source of ['plugin', 'project', 'dynamic', 'unknown', undefined]) {
    await expect(ask(source)).resolves.toMatchObject({ behavior: 'deny' });
  }
  const pre = options.hooks!.PreToolUse![0].hooks[0];
  const base = { hook_event_name: 'PreToolUse' as const, session_id: agent.getSessionId(), transcript_path: '', cwd: '',
    tool_name: toolName, tool_input: {}, tool_use_id: 'mcp-call', permission_mode: 'bypassPermissions' };
  expect(await pre({ ...base, mcp_server: { name: 'im-bridge-tools', source: 'plugin' } }, undefined,
    { signal: new AbortController().signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  configState.frozenSdkMcpFingerprint = '';
  await expect(ask('sdk')).resolves.toMatchObject({ behavior: 'deny' });

  const { recordQueryBackgroundTask } = await import('../builtin-session/lifecycle');
  recordQueryBackgroundTask(state.query.mock.results[state.query.mock.calls.findIndex(([call]) => call.options === options)]!.value, 'background-agent', {});
  configState.currentMcpServers = null;
  const userTool = 'mcp__example__write';
  const grant = options.canUseTool!(userTool, {}, { signal: new AbortController().signal,
    toolUseID: 'grant', requestId: 'grant', mcpServer: { name: 'example', source: 'dynamic' } });
  const request = agent.getPendingInteractiveRequests().find(row => row.type === 'permission:request')!.data as { requestId: string };
  expect(agent.handlePermissionResponse(request.requestId, 'always_allow')).toBe(true);
  await expect(grant).resolves.toMatchObject({ behavior: 'allow' });
  const background = options.hooks!.PermissionRequest![0].hooks[0];
  const checkBackground = (source: string) => background({ hook_event_name: 'PermissionRequest',
    session_id: agent.getSessionId(), transcript_path: '', cwd: '', agent_id: 'background-agent',
    tool_name: userTool, tool_input: {}, mcp_server: { name: 'example', source } }, undefined,
  { signal: new AbortController().signal });
  await expect(checkBackground('dynamic')).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
  await expect(checkBackground('plugin')).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  configState.currentMcpServers = [];
  await expect(checkBackground('dynamic')).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
});


it.each(['defaultToNo', 'suppressAlwaysAllowRule'] as const)('honors %s on product CLI calls without removing ordinary auto-approval', async hint => {
  const options = await startSdkContractSession();
  (await import('../builtin-session/config')).configState.currentPermissionMode = 'custom';
  const input = { command: "myagents record create 'note'" };
  const base = { signal: new AbortController().signal, toolUseID: 'record', requestId: 'record' };
  await expect(options.canUseTool!('Bash', input, base)).resolves.toMatchObject({ behavior: 'allow' });
  const restricted = options.canUseTool!('Bash', input, { ...base, [hint]: true });
  const pending = agent.getPendingInteractiveRequests().find(row => row.type === 'permission:request')!;
  expect(pending.data).toMatchObject({ [hint]: true });
  expect(agent.handlePermissionResponse((pending.data as { requestId: string }).requestId, 'deny')).toBe(true);
  await expect(restricted).resolves.toMatchObject({ behavior: 'deny' });
});

it('keeps plugin MCP enablement separate from user MCP selection without granting builtin trust', async () => {
  const options = await startSdkContractSession();
  const { configState } = await import('../builtin-session/config');
  configState.currentMcpServers = [];
  configState.currentPermissionMode = 'fullAgency';
  const toolName = 'mcp__plugin_example__write';
  const mcpServer = { name: 'plugin_example', source: 'plugin' };
  const signal = new AbortController().signal;
  const pre = options.hooks!.PreToolUse![0].hooks[0];
  const base = { hook_event_name: 'PreToolUse' as const, session_id: agent.getSessionId(), transcript_path: '', cwd: '',
    tool_name: toolName, tool_input: {}, tool_use_id: 'plugin-call', permission_mode: 'bypassPermissions' };
  expect(await pre({ ...base, mcp_server: mcpServer }, undefined, { signal })).toEqual({});
  const args = { signal, toolUseID: 'plugin-call', requestId: 'plugin-call', mcpServer };
  await expect(options.canUseTool!(toolName, {}, args)).resolves.toMatchObject({ behavior: 'allow' });
  expect(await pre({ ...base, mcp_server: { ...mcpServer, source: 'dynamic' } }, undefined, { signal }))
    .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  configState.currentPermissionMode = 'custom';
  const restricted = options.canUseTool!(toolName, {}, args);
  const pending = agent.getPendingInteractiveRequests().find(row => row.type === 'permission:request')!;
  expect(pending).toBeDefined();
  agent.handlePermissionResponse((pending.data as { requestId: string }).requestId, 'deny');
  await expect(restricted).resolves.toMatchObject({ behavior: 'deny' });
  expect(await pre({ ...base, permission_mode: 'plan', mcp_server: mcpServer }, undefined, { signal }))
    .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});

it.each(['stop', 'success', 'error'] as const)('keeps successor %s independent of a delayed force-send receipt through the real SDK loop', async nextOutcome => {
  const frames: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>(resolve => { resolveClosed = resolve; });
  const received: unknown[] = [];
  let releaseReceipt!: (receipt: { still_queued: string[] }) => void;
  const delayedReceipt = new Promise<{ still_queued: string[] }>(resolve => { releaseReceipt = resolve; });
  const interrupt = vi.fn(() => delayedReceipt);
  const close = vi.fn(() => { closed = true; resolveClosed(); wake?.(); });
  releaseWrite = () => { releaseReceipt({ still_queued: [] }); close(); };
  const emit = (...messages: unknown[]) => { frames.push(...messages); wake?.(); };
  state.query.mockImplementation((args: { prompt: AsyncIterable<unknown>; options: { sessionId: string } }) => {
    const prompt = args.prompt[Symbol.asyncIterator]();
    // Transport consumes input independently of delivering result/control frames,
    // like the SDK streaming protocol. No external provider or credentials.
    void (async () => {
      while (!closed) {
        const next = await Promise.race([prompt.next(), closedPromise.then(() => ({ done: true as const, value: undefined }))]);
        if (next.done) break;
        received.push(next.value);
      }
    })();
    emit({ type: 'system', subtype: 'init', session_id: args.options.sessionId, uuid: randomUUID(),
      model: 'test-model', tools: [], mcp_servers: [] });
    return {
      async next() {
        while (!closed && !frames.length) await new Promise<void>(resolve => { wake = resolve; });
        return closed ? { done: true, value: undefined } : { done: false, value: frames.shift() };
      },
      [Symbol.asyncIterator]() { return this; },
      initializationResult: async () => ({ commands: [] }), interrupt, close,
      mcpServerStatus: async () => [], setModel: async () => undefined,
      setPermissionMode: async () => undefined, setMcpServers: async () => undefined,
    };
  });
  const workspace = join(state.home, 'workspace');
  await mkdir(workspace);
  const metadata = await store.createSession(workspace, { runtime: 'builtin' });
  await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
  const send = (text: string) => agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    { channelDelivery: NO_CHANNEL_DELIVERY, queueResponseModeOverride: 'realtime' });
  const assistant = (text: string) => ({ type: 'assistant', session_id: metadata.id,
    parent_tool_use_id: null, uuid: randomUUID(), message: { id: randomUUID(), role: 'assistant', model: 'test-model',
      content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const result = (reason: string, error = false) => ({ type: 'result', session_id: metadata.id, uuid: randomUUID(),
    subtype: error ? 'error_during_execution' : 'success', is_error: error, terminal_reason: reason,
    ...(error ? { errors: ['synthetic provider failure'] } : { result: 'answer' }),
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
  await send('A');
  await vi.waitFor(() => expect(received).toHaveLength(1));
  emit(assistant('A partial'));
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('A partial'));
  const b = await send('B');
  await vi.waitFor(() => expect(received).toHaveLength(2));
  const force = agent.forceExecuteQueueItem(b.queueId!);
  expect(interrupt).toHaveBeenCalledTimes(1);
  emit(result('aborted_streaming'));
  await vi.waitFor(() => expect(state.events.some(([event, data]) => event === 'queue:started'
    && (data as { queueId?: string }).queueId === b.queueId)).toBe(true));
  await force;
  expect(agent.isSessionBusy()).toBe(true);
  const eventsAfterA = state.events.length;
  emit(assistant('B answer'));
  await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('B answer'));
  if (nextOutcome === 'stop') {
    const stop = agent.interruptCurrentResponse();
    expect(interrupt).toHaveBeenCalledTimes(2);
    emit(result('aborted_streaming'));
    await stop;
  } else {
    emit(result(nextOutcome === 'error' ? 'error_during_execution' : 'completed', nextOutcome === 'error'));
  }
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  await store.drainSessionTranscripts();
  const bEvents = state.events.slice(eventsAfterA);
  if (nextOutcome === 'error') {
    expect(bEvents.some(([event]) => event === 'chat:agent-error')).toBe(true);
  }
  if (nextOutcome !== 'stop') {
    expect(bEvents.some(([event]) => event === 'chat:message-stopped')).toBe(false);
  }
  expect(agent.getBuiltinSessionCompletionTerminal()?.status).toBe(nextOutcome === 'stop' ? 'stopped' : nextOutcome === 'error' ? 'error' : 'complete');
  releaseReceipt({ still_queued: [] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(close).not.toHaveBeenCalled();
});


it('consumes recovered queued input and the next direct input after a capabilities restart (#648)', async () => {
  const platform = await import('../utils/platform');
  vi.spyOn(platform, 'getCrossPlatformEnv').mockReturnValue({ home: state.home, user: 'synthetic', temp: tmpdir() });
  vi.spyOn(platform, 'getHomeDir').mockReturnValue(state.home);
  vi.spyOn(platform, 'getHomeDirOrNull').mockReturnValue(state.home);
  const diagnostic = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const workspace = join(state.home, 'restart-workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  state.independentInputPump = true;
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: false });
  const send = (text: string) => agent.enqueueUserMessage(text, [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY, queueResponseModeOverride: 'turn' });
  state.beforeResult.mockImplementationOnce(async () => {
    const skill = join(workspace, '.claude', 'skills', 'synthetic-restart');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: synthetic-restart\ndescription: Isolated restart fixture\n---\nSynthetic instructions.\n');
    agent.syncProjectUserConfig(workspace);
    expect(await send('recovered synthetic input')).toMatchObject({ queued: true });
  });
  await send('initial synthetic input');
  await vi.waitFor(() => expect(state.beforeResult).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  expect(state.query).toHaveBeenCalledTimes(2);
  await send('direct synthetic input');
  await vi.waitFor(() => expect(state.beforeResult).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  expect(state.query).toHaveBeenCalledTimes(2);
  expect(agent.getMessages().filter(row => row.role === 'user').map(row => row.content))
    .toEqual(['initial synthetic input', 'recovered synthetic input', 'direct synthetic input']);
  const traces = diagnostic.mock.calls.filter(([prefix]) => prefix === '[builtin-input]')
    .map(([, payload]) => JSON.parse(payload as string) as Record<string, unknown>);
  expect(traces.filter(row => row.phase === 'sdk-yield')).toHaveLength(3);
  expect(traces.some(row => row.phase === 'terminal-ready')).toBe(true);
  expect(new Set(traces.filter(row => row.phase === 'sdk-yield').map(row => row.inputGeneration)).size).toBe(2);
  const traceText = JSON.stringify(traces);
  expect(traceText).not.toContain('synthetic input');
  expect(traceText).not.toContain(workspace);
  expect(traces.every(row => Object.values(row).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value)))).toBe(true);
});


it('acknowledges Stop of promoted local input without yielding it to the SDK (#648)', async () => {
  const platform = await import('../utils/platform');
  vi.spyOn(platform, 'getCrossPlatformEnv').mockReturnValue({ home: state.home, user: 'synthetic', temp: tmpdir() });
  vi.spyOn(platform, 'getHomeDir').mockReturnValue(state.home);
  vi.spyOn(platform, 'getHomeDirOrNull').mockReturnValue(state.home);
  const workspace = join(state.home, 'promotion-workspace');
  await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  state.independentInputPump = true;
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: false });
  let release!: (result: { accepted: true }) => void;
  const gate = new Promise<{ accepted: true }>(resolve => { release = resolve; });
  releaseWrite = () => release({ accepted: true });
  const beforeDispatch = Object.assign(vi.fn(() => gate), { cancel: vi.fn(async () => { release({ accepted: true }); }) });
  const terminal = vi.fn();
  const send = agent.enqueueUserMessage('cancelled synthetic input', [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY, beforeDispatch, onTerminal: terminal });
  await vi.waitFor(() => expect(beforeDispatch).toHaveBeenCalledOnce());
  await expect(agent.interruptCurrentResponse()).resolves.toBe(true);
  await send;
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  expect(state.sdkInputs).toHaveLength(0);
  expect(state.beforeResult).not.toHaveBeenCalled();
  expect(state.query).toHaveBeenCalledOnce();
  expect(terminal).toHaveBeenCalledOnce();
  expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }));
});


it.each(['capabilities', 'provider-draining'] as const)('does not resurrect cancelled promoted input after %s requeue (#648 review)', async reason => {
  const platform = await import('../utils/platform');
  vi.spyOn(platform, 'getCrossPlatformEnv').mockReturnValue({ home: state.home, user: 'synthetic', temp: tmpdir() });
  vi.spyOn(platform, 'getHomeDir').mockReturnValue(state.home);
  vi.spyOn(platform, 'getHomeDirOrNull').mockReturnValue(state.home);
  const workspace = join(state.home, 'cancel-requeue-workspace'); await mkdir(workspace);
  const meta = await store.createSession(workspace, { runtime: 'builtin' });
  state.independentInputPump = true;
  await agent.initializeAgent(workspace, null, meta.id, { preWarmDisabled: false });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  releaseWrite = release;
  const { ManagedProxyError } = await import('../utils/managed-proxy-binding');
  state.beforeTurn.mockImplementationOnce(async () => {
    await gate;
    if (reason === 'provider-draining') throw new ManagedProxyError('draining', 'Synthetic provider draining');
  });
  const terminal = vi.fn();
  await agent.enqueueUserMessage('cancelled synthetic input', [], undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: terminal });
  await vi.waitFor(() => expect(state.beforeTurn).toHaveBeenCalledOnce());
  if (reason === 'capabilities') {
    const skill = join(workspace, '.claude', 'skills', 'synthetic-change');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: synthetic-change\ndescription: Isolated cancel fixture\n---\nSynthetic.\n');
    agent.syncProjectUserConfig(workspace);
  }
  await expect(agent.interruptCurrentResponse()).resolves.toBe(true);
  release();
  const lifecycle = await import('../builtin-session/lifecycle');
  await vi.waitFor(() => expect(lifecycle.hasMessageResolver()).toBe(true));
  await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
  expect(state.sdkInputs).toHaveLength(0);
  expect(state.beforeResult).not.toHaveBeenCalled();
  expect(terminal).toHaveBeenCalledOnce();
  expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }));
});
