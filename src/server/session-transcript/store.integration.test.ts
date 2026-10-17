import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../types/session';
import { transcriptMessages } from '../../shared/sessionTranscript';

const testState = vi.hoisted(() => ({ home: '', failMetadata: false, failSyncStorage: false, beforeTranscriptPublish: undefined as undefined | (() => Promise<void>) }));
vi.mock('os', async original => ({ ...await original<typeof import('os')>(), homedir: () => testState.home }));
vi.mock('../utils/fs-utils', async original => {
  const actual = await original<typeof import('../utils/fs-utils')>();
  return { ...actual, ensureDirSync: (...args: Parameters<typeof actual.ensureDirSync>) => {
    if (testState.failSyncStorage) throw Object.assign(new Error('sync product IO forbidden during birth'), { code: 'EACCES' });
    return actual.ensureDirSync(...args);
  } };
});
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (testState.failMetadata && String(args[1]).endsWith('sessions.json')) throw new Error('injected metadata failure');
      if (testState.beforeTranscriptPublish && String(args[1]).includes('sessions-v2') && String(args[1]).endsWith('.jsonl')) await testState.beforeTranscriptPublish();
      return actual.rename(...args);
    },
  };
});

let store: typeof import('../SessionStore');
let owned: string[];
beforeEach(async () => {
  testState.home = await mkdtemp(join(process.cwd(), '.tmp-v2-store-'));
  testState.failMetadata = false;
  testState.failSyncStorage = false;
  testState.beforeTranscriptPublish = undefined;
  owned = [];
  vi.resetModules();
  store = await import('../SessionStore');
});
afterEach(async () => {
  testState.failMetadata = false;
  testState.failSyncStorage = false;
  await Promise.all(owned.map(id => store.getActiveSessionTranscript(id)?.revoke()));
  await rm(testState.home, { recursive: true, force: true });
});

async function create(patch: Partial<SessionMetadata> = {}) {
  const metadata = await store.createSession('/workspace', patch);
  owned.push(metadata.id);
  return { metadata, active: store.getActiveSessionTranscript(metadata.id)! };
}

describe('SessionStore V2 ownership and compatibility', () => {
  it('does not create product directories during cold identity and empty transcript reads', async () => {
    testState.failSyncStorage = true;
    expect(store.getAllSessionMetadata()).toEqual([]);
    expect(store.getSessionMetadata('cold-birth')).toBeNull();
    expect((await store.loadSessionTranscript('cold-birth')).messages).toEqual([]);
    expect(await readdir(testState.home)).toEqual([]);
    const { metadata, active } = await create({ id: 'cold-birth' });
    expect(metadata.transcriptFormat).toBe(2);
    active.writer.observe({ kind: 'message-create', message: { id: 'u', role: 'user', content: 'admitted', timestamp: 't' } });
    expect((await store.getSessionData(metadata.id))?.messages[0].content).toBe('admitted');
  });

  async function preparedBinding() {
    const binding = await import('../session-engine/product-session-binding');
    const source = await create({ id: 'pending-retiring' });
    await binding.resetProductSessionBinding({ sessionId: source.metadata.id, allowLazySessionMaterialization: true });
    const target = await create({ materializationState: 'prepared', materializationSourceSessionId: source.metadata.id });
    binding.setPendingProductSessionMaterialization({
      priorSessionId: source.metadata.id, targetSessionId: target.metadata.id,
      reusingNativeSession: false, snapshotKind: 'owned',
    });
    return { binding, source, target };
  }

  it('waits for writer retirement before claiming a target and runs afterBind under the new identity', async () => {
    const { binding, source, target } = await preparedBinding();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const retire = source.active.retire.bind(source.active);
    const paused = vi.spyOn(source.active, 'retire').mockImplementation(async timeout => { await gate; return retire(timeout); });
    const afterBind = vi.fn(() => { expect(binding.getCurrentProductSessionId()).toBe(target.metadata.id); });
    let settled = false;
    const commit = binding.commitPendingProductSession({ afterBind }).finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(paused).toHaveBeenCalled());
      expect(settled).toBe(false);
      expect(afterBind).not.toHaveBeenCalled();
      expect(binding.getCurrentProductSessionId()).toBe(source.metadata.id);
      expect(store.getSessionMetadata(target.metadata.id)?.materializationState).toBe('prepared');
      release();
      await expect(commit).resolves.toMatchObject({ success: true, sessionId: target.metadata.id });
      expect(afterBind).toHaveBeenCalledOnce();
      expect(binding.getPendingProductSessionMaterialization()).toBeNull();
    } finally { release(); await commit.catch(() => undefined); paused.mockRestore(); }
  });

  it.each(['retry', 'rollback'] as const)('keeps an explicit materialization timeout recoverable through %s while source AI content continues', async recovery => {
    const { binding, source, target } = await preparedBinding();
    expect(await source.active.writer.flush()).toBe(true);
    const append = source.active.file.append.bind(source.active.file);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stalled = vi.spyOn(source.active.file, 'append').mockImplementation(async (...args) => { await gate; return append(...args); });
    source.active.writer.observe({ kind: 'message-create', message: { id: 'u1', role: 'user', content: 'before', timestamp: 't' } });
    expect(await source.active.writer.flush(20)).toBe(false);
    const retire = source.active.retire.bind(source.active);
    const deadline = vi.spyOn(source.active, 'retire').mockImplementation(() => retire(20));
    const afterBind = vi.fn();
    try {
      await expect(binding.commitPendingProductSession({ afterBind })).rejects.toThrow('still finishing');
      expect(afterBind).not.toHaveBeenCalled();
      expect(binding.getCurrentProductSessionId()).toBe(source.metadata.id);
      expect(store.getSessionMetadata(target.metadata.id)?.materializationState).toBe('prepared');
      expect(binding.getPendingProductSessionMaterialization()?.targetSessionId).toBe(target.metadata.id);
      source.active.writer.observe({ kind: 'message-create', message: { id: 'u2', role: 'user', content: 'still usable', timestamp: 't' } });
      expect(source.active.writer.projection.messages.has('u2')).toBe(true);
      release();
      expect(await source.active.writer.flush()).toBe(true);
      if (recovery === 'retry') {
        await expect(binding.commitPendingProductSession({ afterBind })).resolves.toMatchObject({ success: true });
        expect(binding.getCurrentProductSessionId()).toBe(target.metadata.id);
        expect(afterBind).toHaveBeenCalledOnce();
      } else {
        await expect(binding.rollbackPendingProductSession(target.metadata.id)).resolves.toMatchObject({ success: true });
        expect(store.getSessionMetadata(target.metadata.id)).toBeNull();
        expect(binding.getCurrentProductSessionId()).toBe(source.metadata.id);
      }
    } finally { release(); stalled.mockRestore(); deadline.mockRestore(); }
  });

  it('does not claim a target when rollback wins during previous-writer retirement', async () => {
    const { binding, source, target } = await preparedBinding();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const retire = source.active.retire.bind(source.active);
    const paused = vi.spyOn(source.active, 'retire').mockImplementation(async timeout => { await gate; return retire(timeout); });
    const afterBind = vi.fn();
    const commit = binding.commitPendingProductSession({ afterBind });
    try {
      await vi.waitFor(() => expect(paused).toHaveBeenCalled());
      await expect(binding.rollbackPendingProductSession(target.metadata.id)).resolves.toMatchObject({ success: true });
      release();
      await expect(commit).resolves.toMatchObject({ success: false, status: 409 });
      expect(afterBind).not.toHaveBeenCalled();
      expect(binding.getCurrentProductSessionId()).toBe(source.metadata.id);
      expect(store.getSessionMetadata(target.metadata.id)).toBeNull();
    } finally { release(); await commit.catch(() => undefined); paused.mockRestore(); }
  });

  it.each(['complete', 'stopped', 'error'] as const)('returns the assistant own %s terminal from cold V2 history', async status => {
    const { metadata, active } = await create();
    const { ProductTranscriptContent } = await import('./content');
    const content = new ProductTranscriptContent(active.writer);
    content.admitUser({ id: 'u', role: 'user', content: 'query', timestamp: 't' });
    content.append(content.block('text', 'text', { text: '' }), 'text', 'partial');
    content.finishTurn(status);
    expect(await active.writer.flush()).toBe(true);
    await store.releaseSessionTranscriptForBinding(metadata.id);
    const { readLatestSessionResult } = await import('../session-observation');
    expect(await readLatestSessionResult(metadata.id)).toMatchObject({
      text: 'partial', source: 'history', turnId: 'u', terminalStatus: status,
    });
  });

  it('derives user counts, preview and usage once across steered segments, live and on disk', async () => {
    const { metadata, active } = await create();
    const { ProductTranscriptContent } = await import('./content');
    const content = new ProductTranscriptContent(active.writer);
    for (const id of ['u1', 'u2']) {
      content.admitUser({ id, role: 'user', content: id, timestamp: 't' });
      content.append(content.block('text', 'text', { text: '' }), 'text', 'answer');
    }
    content.finishTurn('complete', { usage: { inputTokens: 10, outputTokens: 20 } });
    const expected = { stats: { messageCount: 2, totalInputTokens: 10, totalOutputTokens: 20 }, lastMessagePreview: 'u2' };
    expect(store.getSessionMetadata(metadata.id)).toMatchObject(expected);
    expect(await active.writer.flush()).toBe(true);
    expect(JSON.parse(await readFile(join(testState.home, '.myagents', 'sessions.json'), 'utf8'))[0]).toMatchObject(expected);
    content.admitUser({ id: 'u3', role: 'user', content: 'latest query', timestamp: 't' });
    content.append(content.block('next', 'text', { text: '' }), 'text', 'last answer');
    content.finishTurn('complete', { usage: { inputTokens: 3, outputTokens: 4 } });
    expect(store.getSessionMetadata(metadata.id)).toMatchObject({ stats: { messageCount: 3, totalInputTokens: 13, totalOutputTokens: 24 }, lastMessagePreview: 'latest query' });
  });

  it('checks auto-title CAS against the fresh durable row written by another owner', async () => {
    const { metadata, active } = await create();
    expect(await active.writer.flush()).toBe(true);
    // A separate SessionStore module represents Global Sidecar's own overlay.
    vi.resetModules();
    const globalStore = await import('../SessionStore');
    await globalStore.updateSessionMetadata(metadata.id, { title: 'user choice', titleSource: 'user' });
    expect(store.getSessionMetadata(metadata.id)?.titleSource).not.toBe('user');
    expect(await store.updateSessionMetadata(metadata.id, { title: 'late auto title', titleSource: 'auto' }, current => current.titleSource !== 'user')).toBeNull();
    expect(await active.writer.flush()).toBe(true);
    expect(globalStore.getSessionMetadata(metadata.id)).toMatchObject({ title: 'user choice', titleSource: 'user' });
  });

  it('admits a legitimate birth before any synchronous product directory or metadata access', async () => {
    testState.failSyncStorage = true;
    testState.failMetadata = true;
    const { metadata, active } = await create();
    const { ProductTranscriptContent } = await import('./content');
    const content = new ProductTranscriptContent(active.writer);
    content.admitUser({ id: 'first', role: 'user', content: 'still usable', timestamp: 't' });
    expect(store.getSessionMetadata(metadata.id)?.id).toBe(metadata.id);
    expect(active.writer.projection.messages.has('first')).toBe(true);
    // A flush deadline only ends the wait; the injected IO failure may settle later.
    await vi.waitFor(() => expect(active.writer.status.state).not.toBe('healthy'));
  });

  it('rejects corrupt live fork sources before publishing a target, while content keeps advancing', async () => {
    const { metadata, active } = await create();
    expect(await active.writer.flush()).toBe(true);
    await store.releaseSessionTranscriptForBinding(metadata.id);
    const path = join(testState.home, '.myagents', 'sessions-v2', `${metadata.id}.jsonl`);
    await writeFile(path, 'invalid transcript header\n');
    const resumed = (await store.activateSessionTranscript(metadata.id))!;
    const { ProductTranscriptContent } = await import('./content');
    const content = new ProductTranscriptContent(resumed.writer);
    content.admitUser({ id: 'new', role: 'user', content: 'continue', timestamp: 't' });
    content.append(content.block('reply', 'text', { text: '' }), 'text', 'new live reply');
    content.finishTurn('complete', { sdkUuid: 'valid-native-anchor' });
    const { createSessionMetadata } = await import('../types/session');
    const fork = createSessionMetadata('/workspace');
    await expect(store.assertCompleteSessionForkSource(metadata.id)).rejects.toThrow('incompletely');
    await expect(store.publishForkSession(fork, transcriptMessages(resumed.writer.projection), metadata.id)).rejects.toThrow('incompletely');
    expect(store.getSessionMetadata(fork.id)).toBeNull();
    content.admitUser({ id: 'next', role: 'user', content: 'still continue', timestamp: 't' });
    expect(resumed.writer.projection.messages.has('next')).toBe(true);
  });

  it('retires an outgoing writer before binding changes and retains it if IO is hung', async () => {
    const { metadata, active } = await create();
    expect(await active.writer.flush()).toBe(true);
    let finish!: () => void;
    const realAppend = active.file.append.bind(active.file);
    const append = vi.spyOn(active.file, 'append').mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { finish = resolve; });
      await realAppend(...args);
    });
    active.writer.observe({ kind: 'message-create', message: { id: 'a', role: 'assistant', timestamp: 't', content: 'first' } });
    const flushing = active.writer.flush(10);
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
    await expect(store.releaseSessionTranscriptForBinding(metadata.id, 10)).rejects.toThrow('still finishing');
    expect(store.getActiveSessionTranscript(metadata.id)).toBe(active);
    active.writer.observe({ kind: 'text-append', messageId: 'a', field: 'text', offset: 5, text: ' continues' });
    expect(active.writer.projection.messages.get('a')?.content).toBe('first continues');
    finish();
    await flushing;
    await store.releaseSessionTranscriptForBinding(metadata.id);
    expect(store.getActiveSessionTranscript(metadata.id)).toBeUndefined();
    expect(active.isRevoked).toBe(true);
    expect((await store.getSessionData(metadata.id))?.messages[0].content).toBe('first continues');
    const calls = append.mock.calls.length;
    active.writer.observe({ kind: 'text-append', messageId: 'a', field: 'text', offset: 15, text: ' stale' });
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(append).toHaveBeenCalledTimes(calls);
  });

  it('marks only orphaned cold work interrupted without dropping its observed results', async () => {
    const { metadata, active } = await create();
    active.writer.observe({ kind: 'message-create', message: { id: 'a', role: 'assistant', timestamp: 't', transcriptState: 'streaming', content: [
      { id: 't', type: 'tool_use', tool: { id: 'tool', name: 'Agent', isLoading: true, result: 'partial', subagentCalls: [{ id: 'child', name: 'Read', isLoading: true, result: 'observed' }], subagentLifecycle: { status: 'running', startedAt: 1 } } },
    ] } });
    expect(await active.writer.flush()).toBe(true);
    await store.releaseSessionTranscriptForBinding(metadata.id);
    const restored = await store.activateSessionTranscript(metadata.id);
    const row = restored!.writer.projection.messages.get('a')!;
    expect(row.transcriptState).toBe('interrupted');
    expect(Array.isArray(row.content) && row.content[0].tool).toMatchObject({ isLoading: false, result: 'partial', resultMeta: { status: 'interrupted' }, subagentLifecycle: { status: 'interrupted' }, subagentCalls: [{ isLoading: false, result: 'observed' }] });
  });

  it('publishes a complete fork baseline and hands it off without a source-side target writer', async () => {
    const { createSessionMetadata } = await import('../types/session');
    const legacy: SessionMetadata = { id: 'fork-source', agentDir: '/workspace', title: 'old', createdAt: 't', lastActiveAt: 't', archived: true };
    await store.saveSessionMetadata(legacy);
    const rows = [
      { id: 'u', role: 'user' as const, content: 'question', timestamp: 't' },
      { id: 'a', role: 'assistant' as const, content: 'x'.repeat(1024 * 1024), timestamp: 't', sdkUuid: 'native-anchor' },
    ];
    const source = await store.loadSessionTranscript(legacy.id);
    expect((await store.appendSessionMessages(legacy.id, source.cursor, rows)).ok).toBe(true);
    const sourcePath = join(testState.home, '.myagents', 'sessions', `${legacy.id}.jsonl`);
    const sourceBytes = await readFile(sourcePath);
    const target = createSessionMetadata('/workspace', { runtime: 'builtin', archived: true });
    testState.beforeTranscriptPublish = async () => {
      expect(store.isHistoryVisibleSession(store.getSessionMetadata(target.id)!)).toBe(false);
      expect(store.getActiveSessionTranscript(target.id)).toBeUndefined();
      await expect(readFile(join(testState.home, '.myagents', 'sessions-v2', `${target.id}.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' });
    };
    await store.publishForkSession(target, rows, legacy.id);
    expect(store.isHistoryVisibleSession(store.getSessionMetadata(target.id)!)).toBe(true);
    expect(store.getSessionMetadata(target.id)?.archived).toBeUndefined();
    expect(store.getSessionMetadata(legacy.id)?.archived).toBe(true);
    expect((await store.getSessionData(target.id))?.messages).toEqual(rows);
    expect(store.getActiveSessionTranscript(target.id)).toBeUndefined();
    expect((await readFile(sourcePath)).equals(sourceBytes)).toBe(true);
    await expect(store.publishForkSession(target, rows, legacy.id)).rejects.toThrow('fresh V2');
  });

  it('keeps archive and concurrent index fields through active binding patches and transcript commits', async () => {
    const { metadata, active } = await create({ id: 'archive-active-binding' });
    active.writer.observe({ kind: 'message-create', message: { id: 'u1', role: 'user', content: 'first', timestamp: 't' } });
    expect(await active.writer.flush()).toBe(true);

    const update = await store.updateSessionMetadataForBinding(metadata.id, { archived: true }, () => true);
    expect(update?.archived).toBe(true);
    expect(await active.writer.flush()).toBe(true);

    // Model another process updating the sessions index after our binding
    // snapshot. V2 publication must reread and merge this unrelated field.
    const indexPath = join(testState.home, '.myagents', 'sessions.json');
    const rows = JSON.parse(await readFile(indexPath, 'utf8')) as SessionMetadata[];
    const row = rows.find(item => item.id === metadata.id)!;
    row.providerId = 'concurrent-provider';
    await writeFile(indexPath, JSON.stringify(rows, null, 2));

    active.writer.observe({ kind: 'message-create', message: { id: 'u2', role: 'user', content: 'second', timestamp: 't' } });
    expect(await active.writer.flush()).toBe(true);
    const renamed = await store.updateSessionMetadataForBinding(metadata.id, { title: 'Still archived' }, () => true);
    expect(renamed).toMatchObject({ archived: true, providerId: 'concurrent-provider', title: 'Still archived' });
    expect(await active.writer.flush()).toBe(true);

    const persistedRows = JSON.parse(await readFile(indexPath, 'utf8')) as SessionMetadata[];
    expect(persistedRows.find(item => item.id === metadata.id)).toMatchObject({
      archived: true,
      providerId: 'concurrent-provider',
      title: 'Still archived',
    });
    expect((await store.getSessionData(metadata.id))?.messages.map(message => message.id)).toEqual(['u1', 'u2']);
  });

  it('waits for healthy slow fork IO and publishes the same target', async () => {
    await store.saveSessionMetadata({ id: 'source', agentDir: '/workspace', title: 'source', createdAt: 't', lastActiveAt: 't' });
    const { createSessionMetadata } = await import('../types/session');
    const target = createSessionMetadata('/workspace');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    testState.beforeTranscriptPublish = async () => { entered(); await gate; };
    let settled = false;
    const publishing = store.publishForkSession(target, [{ id: 'u', role: 'user', content: 'question', timestamp: 't' }], 'source')
      .finally(() => { settled = true; });
    try {
      await started;
      await new Promise(resolve => setTimeout(resolve, 2100));
      expect(settled).toBe(false);
      expect(store.isHistoryVisibleSession(store.getSessionMetadata(target.id)!)).toBe(false);
    } finally { release(); }
    await publishing;
    expect(store.isHistoryVisibleSession(store.getSessionMetadata(target.id)!)).toBe(true);
    expect((await store.getSessionData(target.id))?.messages[0].content).toBe('question');
  });

  it('gives fork user and nested tool attachments independent target copies', async () => {
    await store.saveSessionMetadata({ id: 'source', agentDir: '/workspace', title: 'source', createdAt: 't', lastActiveAt: 't' });
    const { createSessionMetadata } = await import('../types/session');
    const root = join(testState.home, '.myagents');
    const userPath = join(root, 'attachments', 'source', 'image.png');
    const toolPath = join(root, 'generated', 'source.png');
    await mkdir(join(root, 'attachments', 'source'), { recursive: true });
    await mkdir(join(root, 'generated'), { recursive: true });
    await writeFile(userPath, 'user image');
    await writeFile(toolPath, 'tool image');
    const rows = [{ id: 'u', role: 'user' as const, content: 'question', timestamp: 't',
      attachments: [{ id: 'image', name: 'image.png', mimeType: 'image/png', path: 'source/image.png' }],
    }, { id: 'a', role: 'assistant' as const, timestamp: 't', content: JSON.stringify([{ type: 'tool_use', tool: {
      id: 'parent', name: 'Task', input: {}, subagentCalls: [{ id: 'child', name: 'Read', input: {}, attachments: [{
        kind: 'image', mimeType: 'image/png', savedPath: toolPath, refPath: '/api/attachment/tool/source/tool/source.png',
      }] }],
    } }]) }];
    const original = JSON.stringify(rows);
    const target = createSessionMetadata('/workspace');
    await store.publishForkSession(target, rows, 'source');
    expect(JSON.stringify(rows)).toBe(original);
    const data = (await store.getSessionData(target.id))!;
    const copiedUser = data.messages[0].attachments![0].path;
    const copiedTool = JSON.parse(data.messages[1].content)[0].tool.subagentCalls[0].attachments[0];
    expect(copiedUser.startsWith(target.id + '/')).toBe(true);
    expect(copiedTool.refPath).toContain(`/tool/${target.id}/`);
    await rm(join(root, 'attachments', 'source'), { recursive: true });
    await rm(toolPath);
    expect(await readFile(join(root, 'attachments', copiedUser), 'utf8')).toBe('user image');
    expect(await readFile(copiedTool.savedPath, 'utf8')).toBe('tool image');
  });

  it('fixes V2 at birth even when an inherited snapshot omits the format', async () => {
    const { metadata, active } = await create({ transcriptFormat: undefined });
    expect(metadata.transcriptFormat).toBe(2);
    active.writer.observe({ kind: 'message-create', message: { id: 'u', role: 'user', content: 'hello', timestamp: 't' } });
    active.writer.observe({ kind: 'message-create', message: { id: 'a', role: 'assistant', content: '', timestamp: 't', transcriptState: 'streaming' } });
    active.writer.observe({ kind: 'text-append', messageId: 'a', field: 'text', offset: 0, text: 'unfinished' });
    expect(await active.writer.flush()).toBe(true);
    const bytes = await readFile(join(testState.home, '.myagents', 'sessions-v2', `${metadata.id}.jsonl`), 'utf8');
    expect(bytes).toContain('session-transcript');
    await expect(readFile(join(testState.home, '.myagents', 'sessions', `${metadata.id}.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' });
    await active.revoke();
    vi.resetModules();
    store = await import('../SessionStore');
    const cold = await store.getSessionData(metadata.id);
    expect(cold?.messages.map(message => message.content)).toEqual(['hello', 'unfinished']);
    const rebound = await store.activateSessionTranscript(metadata.id);
    expect(transcriptMessages(rebound!.writer.projection)[1].transcriptState).toBe('interrupted');
  });

  it('keeps accepted birth and live content available while metadata publication fails', async () => {
    testState.failMetadata = true;
    const { metadata, active } = await create({ materializationState: 'prepared', materializationSourceSessionId: 'pending-test' });
    const claim = await store.claimPreparedSessionForTurnAdmission(metadata.id, 'pending-test', { messageText: 'first' });
    expect(claim.status).toBe('claimed');
    active.writer.observe({ kind: 'message-create', message: { id: 'u', role: 'user', content: 'first', timestamp: 't' } });
    await vi.waitFor(() => expect(active.writer.status.state).not.toBe('healthy'));
    expect(await active.writer.flush(40)).toBe(false);
    expect((await store.getSessionData(metadata.id))?.messages[0].content).toBe('first');
    expect(await store.deleteSession(metadata.id, { kind: 'prepared-materialization-rollback', sourceSessionId: 'pending-test' })).toEqual({ deleted: false, reason: 'precondition-failed' });
    testState.failMetadata = false;
    expect(await active.writer.flush()).toBe(true);
    expect(active.writer.status.state).toBe('healthy');
    const disk = JSON.parse(await readFile(join(testState.home, '.myagents', 'sessions.json'), 'utf8')) as SessionMetadata[];
    expect(disk[0].materializationState).toBeUndefined();
  });

  it('lets rollback win before admission and refuses resurrection in the same owner', async () => {
    const { metadata } = await create({ materializationState: 'prepared', materializationSourceSessionId: 'pending-test' });
    expect(await store.deleteSession(metadata.id, { kind: 'prepared-materialization-rollback', sourceSessionId: 'pending-test' })).toEqual({ deleted: true });
    expect(await store.claimPreparedSessionForTurnAdmission(metadata.id, 'pending-test', {})).toEqual({ status: 'not-found' });
    expect(store.getSessionMetadata(metadata.id)).toBeNull();
  });

  it('preserves the legacy writer and refuses to reinterpret conflicting V2 evidence', async () => {
    const metadata: SessionMetadata = { id: 'legacy-session', agentDir: '/workspace', title: 'old', createdAt: 't', lastActiveAt: 't' };
    await store.saveSessionMetadata(metadata);
    const snapshot = await store.loadSessionTranscript(metadata.id);
    const row = { id: 'u', role: 'user' as const, content: 'old history', timestamp: 't' };
    expect((await store.appendSessionMessages(metadata.id, snapshot.cursor, [row])).ok).toBe(true);
    expect(await readFile(join(testState.home, '.myagents', 'sessions', `${metadata.id}.jsonl`), 'utf8')).toBe(JSON.stringify(row) + '\n');
    expect((await store.getSessionData(metadata.id))?.messages).toEqual([row]);
    const { metadata: v2, active } = await create();
    expect(await active.writer.flush()).toBe(true);
    await writeFile(join(testState.home, '.myagents', 'sessions-v2', `${metadata.id}.jsonl`), await readFile(join(testState.home, '.myagents', 'sessions-v2', `${v2.id}.jsonl`)));
    await expect(store.loadSessionTranscript(metadata.id)).rejects.toThrow('Conflicting');
    expect((await store.appendSessionMessages(metadata.id, snapshot.cursor, [row])).ok).toBe(false);
  });

  it('commits a new native binding in memory independently of rewind publication', async () => {
    const { metadata, active } = await create({ runtime: 'codex', runtimeSessionId: 'native-old' });
    const rows = ['u1', 'a1', 'u2', 'a2'].map((id, i) => ({ id, role: i % 2 ? 'assistant' as const : 'user' as const, content: id, timestamp: 't' }));
    for (const message of rows) active.writer.observe({ kind: 'message-create', message });
    expect(await active.writer.flush()).toBe(true);
    testState.failMetadata = true;
    const result = await store.commitCodexConversationRewind({ sessionId: metadata.id, sourceRuntimeSessionId: 'native-old', replacementRuntimeSessionId: 'native-new', sourceMessages: rows, targetMessages: rows.slice(0, 2) });
    expect(result.success).toBe(true);
    expect(store.getSessionMetadata(metadata.id)?.runtimeSessionId).toBe('native-new');
    expect((await store.resolvePendingConversationMutation(metadata.id)).success).toBe(true);
    expect(await active.writer.flush(40)).toBe(false);
    active.writer.observe({ kind: 'message-create', message: { id: 'u3', role: 'user', content: 'continue', timestamp: 't' } });
    expect((await store.getSessionData(metadata.id))?.messages.map(message => message.id)).toEqual(['u1', 'a1', 'u3']);
    testState.failMetadata = false;
    expect(await active.writer.flush()).toBe(true);
    expect(active.hasPendingMutation).toBe(false);
    const disk = JSON.parse(await readFile(join(testState.home, '.myagents', 'sessions.json'), 'utf8')) as SessionMetadata[];
    expect(disk[0]).toMatchObject({ runtimeSessionId: 'native-new' });
    expect(disk[0].pendingConversationMutation).toBeUndefined();
  });
});
