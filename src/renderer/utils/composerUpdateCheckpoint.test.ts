import { serializeTabs, deserializeTabs } from './tabPersistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerSnapshot } from './composerUpdateCheckpoint';
import type { Tab } from '@/types/tab';
import { TASK_ALIGNMENT_SKILL_REQUIREMENT } from '@/../shared/systemSkills';
const disk = vi.hoisted(() => ({ values: new Map<string, unknown>(), write: vi.fn(), read: vi.fn(), remove: vi.fn(), browser: false }));
vi.mock('@tauri-apps/api/path', () => ({ join: async (...parts: string[]) => parts.join('/') }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async (path: string) => disk.values.has(path), remove: disk.remove }));
vi.mock('@/config/services/configStore', () => ({ getConfigDir: async () => '/synthetic/qa', safeWriteJson: disk.write, safeLoadJson: disk.read }));
vi.mock('@/utils/browserMock', () => ({ isBrowserDevMode: () => disk.browser }));
const tab = { id: 'tab-a', view: 'chat', agentDir: '/synthetic/workspace-a', sessionId: 'session-a', title: 'A' } as Tab;
function snapshot(patch: Partial<ComposerSnapshot> = {}): ComposerSnapshot {
  return { scope: { tabId: tab.id, sessionId: 'session-a', workspacePath: '/synthetic/workspace-a', mode: 'chat' }, text: 'KEEP-AFTER-UPDATE', context: {}, imageCount: 0, pendingAttachments: false, composing: false, sending: false, stagedWorkflow: false, ...patch };
}
beforeEach(() => {
  vi.resetModules(); disk.values.clear(); disk.browser = false;
  disk.write.mockReset().mockImplementation(async (path, value) => { disk.values.set(path, JSON.parse(JSON.stringify(value))); });
  disk.read.mockReset().mockImplementation(async path => disk.values.get(path) ?? null);
  disk.remove.mockReset().mockImplementation(async path => { disk.values.delete(path); });
});
async function owner(patch: Partial<ComposerSnapshot> = {}) {
  const api = await import('./composerUpdateCheckpoint');
  await api.loadComposerUpdateHandoff(deserializeTabs);
  const state = snapshot(patch); const freeze = vi.fn();
  const unregister = api.registerComposerUpdateOwner({ snapshot: () => state, freeze });
  return { api, state, freeze, unregister };
}

describe('MoxBots composer update checkpoint', () => {
  it('refuses unverified remote tabs before persistence and final install, retaining live drafts', async () => {
    const { api, state, freeze } = await owner();
    expect(() => api.assertUpdateTabsSafe([{ view: 'remote-session' }])).toThrow('尚未接入安全更新检查');
    const lease = api.beginComposerUpdateCheckpoint(serializeTabs);
    const remote = { id: 'remote-unverified', view: 'remote-session' } as Tab;
    await expect(lease.persist([tab, remote], tab.id)).rejects.toThrow('远程会话');
    expect(disk.write).not.toHaveBeenCalled();
    await lease.persist([tab], tab.id);
    expect(() => lease.verify([tab, remote], tab.id)).toThrow('远程会话');
    expect(api.isComposerUpdateCheckpointLocked()).toBe(true);
    await lease.abort(); lease.release();
    expect(api.isComposerUpdateCheckpointLocked()).toBe(false);
    expect(freeze).toHaveBeenLastCalledWith(false); expect(state.text).toBe('KEEP-AFTER-UPDATE');
  });

  it('awaits durable IO, restores exact scope and never consumes for another owner', async () => {
    const { api, state, freeze } = await owner({ text: '  A @myagents_files/a.pdf\n继续  ', context: { primaryContext: { kind: 'floating-context', input: { selectedText: 'selected source', appName: 'Synthetic' } }, requiredSystemSkill: TASK_ALIGNMENT_SKILL_REQUIREMENT } });
    let finish!: () => void;
    disk.write.mockImplementationOnce(async (path, value) => {
      await new Promise<void>(resolve => { finish = resolve; }); disk.values.set(path, value);
    });
    const lease = api.beginComposerUpdateCheckpoint(serializeTabs); expect(freeze).toHaveBeenCalledWith(true);
    let completed = false;
    const persistence = lease.persist([tab], tab.id).then(() => { completed = true; });
    await vi.waitFor(() => expect(finish).toBeDefined()); expect(completed).toBe(false);
    finish(); await persistence; lease.verify([tab], tab.id); lease.release();
    expect(await api.loadComposerUpdateHandoff(deserializeTabs)).toMatchObject({ activeTabId: 'tab-a' });
    expect(api.restoreComposerUpdateDraft({ ...state.scope, tabId: 'other-tab' }, true)).toBeNull();
    expect(api.restoreComposerUpdateDraft({ ...state.scope, sessionId: 'other-session' }, true)).toBeNull();
    expect(api.restoreComposerUpdateDraft({ ...state.scope, workspacePath: '/other-workspace' }, true)).toBeNull();
    expect(api.restoreComposerUpdateDraft(state.scope, false)).toBeNull();
    expect(api.restoreComposerUpdateDraft(state.scope, true)).toEqual({ scope: state.scope, text: state.text, context: state.context });
    expect(api.restoreComposerUpdateDraft(state.scope, true)).toBeNull();
    await api.clearComposerUpdateHandoff(); expect(disk.values.size).toBe(0);
  });
  it.each(['goal', 'scheduled'] as const)('persists a settings-only %s draft and restores it only after the config owner accepts', async kind => {
    const workflowDraft = kind === 'goal' ? {
      kind: 'goal' as const, config: { taskKind: 'goal' as const, prompt: '', endConditions: { aiCanExit: false, maxExecutions: 7 }, notifyEnabled: false, runtime: 'codex' as const, permissionMode: 'full-auto' },
    } : {
      kind: 'scheduled' as const, config: { taskKind: 'cron' as const, prompt: 'saved prompt', intervalMinutes: 9, endConditions: { aiCanExit: true, deadline: '2027-01-01T00:00:00Z' }, runMode: 'new_session' as const, notifyEnabled: true,
        schedule: { kind: 'every' as const, minutes: 9, startAt: '2026-12-01T00:00:00Z', catchUpWindow: { timezone: 'Asia/Shanghai', start: '09:00', end: '18:00' } },
        executionTarget: 'new_task' as const, providerId: 'synthetic-provider', model: 'synthetic-model', permissionMode: 'default', runtime: 'codex' as const,
        runtimeConfig: { source: 'system-cli' as const, model: 'synthetic-model', permissionMode: 'default', reasoningEffort: 'high', additionalArgs: ['--synthetic'], envPolicy: { proxy: 'terminal' as const } },
        delivery: { botId: 'synthetic-bot', chatId: 'synthetic-room', platform: 'synthetic' }, mcpEnabledServers: ['synthetic-mcp'] },
    };
    const { api, state, unregister } = await owner({ text: '', stagedWorkflow: true, workflowDraft });
    const lease = api.beginComposerUpdateCheckpoint(serializeTabs);
    await lease.persist([tab], tab.id); lease.verify([tab], tab.id); lease.release(); unregister();
    const stored = disk.values.get('/synthetic/qa/update-composer-drafts.json');
    expect(stored).toMatchObject({ version: 2, drafts: [{ text: '', workflowDraft }] });
    await api.loadComposerUpdateHandoff(deserializeTabs);
    const accept = vi.fn(() => false);
    expect(api.restoreComposerUpdateDraft({ ...state.scope, sessionId: 'wrong' }, true, accept)).toBeNull();
    expect(accept).not.toHaveBeenCalled();
    expect(api.restoreComposerUpdateDraft(state.scope, true)).toBeNull();
    expect(api.restoreComposerUpdateDraft(state.scope, true, accept)).toBeNull();
    expect(() => api.beginComposerUpdateCheckpoint(serializeTabs)).toThrow('尚未恢复');
    accept.mockReturnValue(true);
    const draft = api.restoreComposerUpdateDraft(state.scope, true, accept);
    expect(draft?.workflowDraft).toEqual(workflowDraft);
    expect(accept).toHaveBeenLastCalledWith(workflowDraft);
    expect(api.restoreComposerUpdateDraft(state.scope, true, accept)).toBeNull();
    await api.clearComposerUpdateHandoff(); expect(disk.values.size).toBe(0);
  });
  it('retains task settings when changed during persistence or when the handoff cannot be written', async () => {
    const workflowDraft = { kind: 'goal' as const, config: { taskKind: 'goal' as const, prompt: '', endConditions: { aiCanExit: true }, notifyEnabled: false } };
    const { api, state } = await owner({ stagedWorkflow: true, workflowDraft });
    const lease = api.beginComposerUpdateCheckpoint(serializeTabs); await lease.persist([tab], tab.id);
    state.workflowDraft = { ...workflowDraft, config: { ...workflowDraft.config, notifyEnabled: true } };
    expect(() => lease.verify([tab], tab.id)).toThrow('变化');
    await lease.abort(); lease.release(); expect(state.workflowDraft.config.notifyEnabled).toBe(true);
    disk.write.mockRejectedValueOnce(new Error('synthetic fsync failure'));
    const retry = api.beginComposerUpdateCheckpoint(serializeTabs);
    await expect(retry.persist([tab], tab.id)).rejects.toThrow('fsync');
    await retry.abort(); retry.release(); expect(state.workflowDraft.config.notifyEnabled).toBe(true);
  });
  it('does not discard unknown task settings or admit workflow data under the legacy format', async () => {
    const { api } = await owner({ stagedWorkflow: true, workflowDraft: { kind: 'goal', config: { taskKind: 'goal', prompt: '', endConditions: { aiCanExit: true }, notifyEnabled: false } } });
    const lease = api.beginComposerUpdateCheckpoint(serializeTabs); await lease.persist([tab], tab.id); lease.release();
    const path = '/synthetic/qa/update-composer-drafts.json';
    const stored = disk.values.get(path) as { version: number; drafts: Array<{ workflowDraft: { config: Record<string, unknown> } }> };
    stored.drafts[0].workflowDraft.config.providerEnv = { apiKey: 'synthetic-only' };
    await expect(api.loadComposerUpdateHandoff(deserializeTabs)).rejects.toThrow(); expect(disk.values.has(path)).toBe(true);
    delete stored.drafts[0].workflowDraft.config.providerEnv; stored.version = 1;
    await expect(api.loadComposerUpdateHandoff(deserializeTabs)).rejects.toThrow(); expect(disk.values.has(path)).toBe(true);
  });
  it('rejects IME before freezing to preserve uncommitted input', async () => {
    const { api, freeze } = await owner({ composing: true });
    expect(() => api.beginComposerUpdateCheckpoint(serializeTabs)).toThrow('输入法'); expect(freeze).not.toHaveBeenCalled();
  });
  it.each([
    { imageCount: 1 }, { pendingAttachments: true }, { sending: true }, { stagedWorkflow: true },
    { blockingReason: '文本记录尚未保存。' },
    { context: { primaryContext: { kind: 'floating-context' as const, input: { screenshotAttached: true } } } },
  ])('rejects unsafe material without altering the draft: %j', async patch => {
    const { api, state, freeze } = await owner(patch);
    expect(() => api.beginComposerUpdateCheckpoint(serializeTabs)).toThrow(); expect(state.text).toBe('KEEP-AFTER-UPDATE');
    expect(disk.write).not.toHaveBeenCalled(); expect(freeze).not.toHaveBeenCalled();
  });
  it.each([
    { mode: 'launcher' as const }, { sessionId: 'pending-tab-a' }, { tabId: '' },
    { workspacePath: '/other-workspace' }, { discussionId: 'different-discussion' },
  ])('fails closed for non-restorable/unknown scope: %j', async patch => {
    const { api, state } = await owner(); state.scope = { ...state.scope, ...patch };
    const lease = api.beginComposerUpdateCheckpoint(serializeTabs); await expect(lease.persist([tab], tab.id)).rejects.toThrow();
    expect(disk.write).not.toHaveBeenCalled(); lease.release();
  });
  it('rejects disk errors and browser-only persistence', async () => {
    const { api, freeze } = await owner(); disk.write.mockRejectedValueOnce(new Error('fsync failed'));
    let lease = api.beginComposerUpdateCheckpoint(serializeTabs); await expect(lease.persist([tab], tab.id)).rejects.toThrow('fsync'); lease.release();
    expect(freeze).toHaveBeenLastCalledWith(false); disk.browser = true;
    lease = api.beginComposerUpdateCheckpoint(serializeTabs); await expect(lease.persist([tab], tab.id)).rejects.toThrow('环境'); lease.release();
  });
  it('rejects owner changes or input mutation during await and before install', async () => {
    const { api, state, unregister } = await owner(); const lease = api.beginComposerUpdateCheckpoint(serializeTabs);
    await lease.persist([tab], tab.id); state.text += 'late'; expect(() => lease.verify([tab], tab.id)).toThrow('变化');
    state.text = 'KEEP-AFTER-UPDATE'; unregister(); expect(() => lease.verify([tab], tab.id)).toThrow('窗口'); lease.release();
  });
  it('keeps unclaimed disk drafts across boot and refuses another update before restore', async () => {
    const { api } = await owner(); const lease = api.beginComposerUpdateCheckpoint(serializeTabs); await lease.persist([tab], tab.id); lease.release();
    await api.loadComposerUpdateHandoff(deserializeTabs); expect(disk.remove).not.toHaveBeenCalled();
    expect(() => api.beginComposerUpdateCheckpoint(serializeTabs)).toThrow('尚未恢复');
    await api.clearComposerUpdateHandoff(); expect(() => api.beginComposerUpdateCheckpoint(serializeTabs)).not.toThrow();
  });
  it('does not flatten invalid structured context into plain text', async () => {
    const { api, state } = await owner(); state.context = { requiredSystemSkill: { ...TASK_ALIGNMENT_SKILL_REQUIREMENT, contentSha256: 'unknown' } };
    const lease = api.beginComposerUpdateCheckpoint(serializeTabs); await expect(lease.persist([tab], tab.id)).rejects.toThrow(); expect(disk.write).not.toHaveBeenCalled(); lease.release();
  });
  it('refuses unreadable existing files even when safeLoadJson returns null and does not let an unrelated abort delete them', async () => {
    const { api } = await owner();
    const lease = api.beginComposerUpdateCheckpoint(serializeTabs);
    disk.values.set('/synthetic/qa/update-composer-drafts.json.tmp', 'corrupt synthetic');
    await expect(lease.persist([tab], tab.id)).rejects.toThrow('不能覆盖');
    await lease.abort(); lease.release(); expect(disk.values.size).toBe(1);
    await api.dismissLoadedComposerUpdateHandoff(); expect(disk.values.size).toBe(1);
    disk.read.mockResolvedValue(null);
    await expect(api.loadComposerUpdateHandoff(deserializeTabs)).rejects.toThrow('损坏');
    expect(() => api.beginComposerUpdateCheckpoint(serializeTabs)).toThrow('上次更新');
  });
  it('owns and cleans a failed partial write, awaiting backup/tmp removal while preserving live text', async () => {
    const { api, state } = await owner();
    disk.write.mockImplementationOnce(async path => { disk.values.set(path + '.tmp', 'partial'); throw new Error('fsync failed'); });
    const lease = api.beginComposerUpdateCheckpoint(serializeTabs); await expect(lease.persist([tab], tab.id)).rejects.toThrow('fsync');
    await lease.abort(); lease.release(); expect(disk.values.size).toBe(0); expect(state.text).toBe('KEEP-AFTER-UPDATE');
  });
  it('clears recoverable backups/tmp on abort and never recovers corrupted schema as another scope', async () => {
    const { api } = await owner(); const path = '/synthetic/qa/update-composer-drafts.json';
    disk.values.set(path, { version: 99, drafts: [] }); disk.values.set(path + '.bak', {}); disk.values.set(path + '.tmp', {});
    await expect(api.loadComposerUpdateHandoff(deserializeTabs)).rejects.toThrow(); expect(disk.values.size).toBe(3);
    expect(() => api.beginComposerUpdateCheckpoint(serializeTabs)).toThrow('上次更新');
    await api.clearComposerUpdateHandoff(); expect(disk.remove.mock.calls.map(call => call[0])).toEqual([path + '.bak', path + '.tmp', path]);
  });
});
