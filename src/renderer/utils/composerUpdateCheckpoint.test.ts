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
  await api.loadComposerUpdateHandoff();
  const state = snapshot(patch); const freeze = vi.fn();
  const unregister = api.registerComposerUpdateOwner({ snapshot: () => state, freeze });
  return { api, state, freeze, unregister };
}

describe('MoxBots composer update checkpoint', () => {
  it('awaits durable IO, restores exact scope and never consumes for another owner', async () => {
    const { api, state, freeze } = await owner({ text: '  A @myagents_files/a.pdf\n继续  ', context: { primaryContext: { kind: 'floating-context', input: { selectedText: 'selected source', appName: 'Synthetic' } }, requiredSystemSkill: TASK_ALIGNMENT_SKILL_REQUIREMENT } });
    let finish!: () => void;
    disk.write.mockImplementationOnce(async (path, value) => {
      await new Promise<void>(resolve => { finish = resolve; }); disk.values.set(path, value);
    });
    const lease = api.beginComposerUpdateCheckpoint(); expect(freeze).toHaveBeenCalledWith(true);
    let completed = false;
    const persistence = lease.persist([tab], tab.id).then(() => { completed = true; });
    await vi.waitFor(() => expect(finish).toBeDefined()); expect(completed).toBe(false);
    finish(); await persistence; lease.verify([tab], tab.id); lease.release();
    expect(await api.loadComposerUpdateHandoff()).toMatchObject({ activeTabId: 'tab-a' });
    expect(api.restoreComposerUpdateDraft({ ...state.scope, tabId: 'other-tab' }, true)).toBeNull();
    expect(api.restoreComposerUpdateDraft({ ...state.scope, sessionId: 'other-session' }, true)).toBeNull();
    expect(api.restoreComposerUpdateDraft({ ...state.scope, workspacePath: '/other-workspace' }, true)).toBeNull();
    expect(api.restoreComposerUpdateDraft(state.scope, false)).toBeNull();
    expect(api.restoreComposerUpdateDraft(state.scope, true)).toEqual({ scope: state.scope, text: state.text, context: state.context });
    expect(api.restoreComposerUpdateDraft(state.scope, true)).toBeNull();
    await api.clearComposerUpdateHandoff(); expect(disk.values.size).toBe(0);
  });
  it('rejects IME before freezing to preserve uncommitted input', async () => {
    const { api, freeze } = await owner({ composing: true });
    expect(() => api.beginComposerUpdateCheckpoint()).toThrow('输入法'); expect(freeze).not.toHaveBeenCalled();
  });
  it.each([
    { imageCount: 1 }, { pendingAttachments: true }, { sending: true }, { stagedWorkflow: true },
    { context: { primaryContext: { kind: 'floating-context' as const, input: { screenshotAttached: true } } } },
  ])('rejects unsafe material without altering the draft: %j', async patch => {
    const { api, state, freeze } = await owner(patch);
    expect(() => api.beginComposerUpdateCheckpoint()).toThrow(); expect(state.text).toBe('KEEP-AFTER-UPDATE');
    expect(disk.write).not.toHaveBeenCalled(); expect(freeze).not.toHaveBeenCalled();
  });
  it.each([
    { mode: 'launcher' as const }, { sessionId: 'pending-tab-a' }, { tabId: '' },
    { workspacePath: '/other-workspace' }, { discussionId: 'different-discussion' },
  ])('fails closed for non-restorable/unknown scope: %j', async patch => {
    const { api, state } = await owner(); state.scope = { ...state.scope, ...patch };
    const lease = api.beginComposerUpdateCheckpoint(); await expect(lease.persist([tab], tab.id)).rejects.toThrow();
    expect(disk.write).not.toHaveBeenCalled(); lease.release();
  });
  it('rejects disk errors and browser-only persistence', async () => {
    const { api, freeze } = await owner(); disk.write.mockRejectedValueOnce(new Error('fsync failed'));
    let lease = api.beginComposerUpdateCheckpoint(); await expect(lease.persist([tab], tab.id)).rejects.toThrow('fsync'); lease.release();
    expect(freeze).toHaveBeenLastCalledWith(false); disk.browser = true;
    lease = api.beginComposerUpdateCheckpoint(); await expect(lease.persist([tab], tab.id)).rejects.toThrow('环境'); lease.release();
  });
  it('rejects owner changes or input mutation during await and before install', async () => {
    const { api, state, unregister } = await owner(); const lease = api.beginComposerUpdateCheckpoint();
    await lease.persist([tab], tab.id); state.text += 'late'; expect(() => lease.verify([tab], tab.id)).toThrow('变化');
    state.text = 'KEEP-AFTER-UPDATE'; unregister(); expect(() => lease.verify([tab], tab.id)).toThrow('窗口'); lease.release();
  });
  it('keeps unclaimed disk drafts across boot and refuses another update before restore', async () => {
    const { api } = await owner(); const lease = api.beginComposerUpdateCheckpoint(); await lease.persist([tab], tab.id); lease.release();
    await api.loadComposerUpdateHandoff(); expect(disk.remove).not.toHaveBeenCalled();
    expect(() => api.beginComposerUpdateCheckpoint()).toThrow('尚未恢复');
    await api.clearComposerUpdateHandoff(); expect(() => api.beginComposerUpdateCheckpoint()).not.toThrow();
  });
  it('does not flatten invalid structured context into plain text', async () => {
    const { api, state } = await owner(); state.context = { requiredSystemSkill: { ...TASK_ALIGNMENT_SKILL_REQUIREMENT, contentSha256: 'unknown' } };
    const lease = api.beginComposerUpdateCheckpoint(); await expect(lease.persist([tab], tab.id)).rejects.toThrow(); expect(disk.write).not.toHaveBeenCalled(); lease.release();
  });
  it('refuses unreadable existing files even when safeLoadJson returns null and does not let an unrelated abort delete them', async () => {
    const { api } = await owner();
    const lease = api.beginComposerUpdateCheckpoint();
    disk.values.set('/synthetic/qa/update-composer-drafts.json.tmp', 'corrupt synthetic');
    await expect(lease.persist([tab], tab.id)).rejects.toThrow('不能覆盖');
    await lease.abort(); lease.release(); expect(disk.values.size).toBe(1);
    await api.dismissLoadedComposerUpdateHandoff(); expect(disk.values.size).toBe(1);
    disk.read.mockResolvedValue(null);
    await expect(api.loadComposerUpdateHandoff()).rejects.toThrow('损坏');
    expect(() => api.beginComposerUpdateCheckpoint()).toThrow('上次更新');
  });
  it('owns and cleans a failed partial write, awaiting backup/tmp removal while preserving live text', async () => {
    const { api, state } = await owner();
    disk.write.mockImplementationOnce(async path => { disk.values.set(path + '.tmp', 'partial'); throw new Error('fsync failed'); });
    const lease = api.beginComposerUpdateCheckpoint(); await expect(lease.persist([tab], tab.id)).rejects.toThrow('fsync');
    await lease.abort(); lease.release(); expect(disk.values.size).toBe(0); expect(state.text).toBe('KEEP-AFTER-UPDATE');
  });
  it('clears recoverable backups/tmp on abort and never recovers corrupted schema as another scope', async () => {
    const { api } = await owner(); const path = '/synthetic/qa/update-composer-drafts.json';
    disk.values.set(path, { version: 99, drafts: [] }); disk.values.set(path + '.bak', {}); disk.values.set(path + '.tmp', {});
    await expect(api.loadComposerUpdateHandoff()).rejects.toThrow(); expect(disk.values.size).toBe(3);
    expect(() => api.beginComposerUpdateCheckpoint()).toThrow('上次更新');
    await api.clearComposerUpdateHandoff(); expect(disk.remove.mock.calls.map(call => call[0])).toEqual([path + '.bak', path + '.tmp', path]);
  });
});
