import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thought } from '@/../shared/types/thought';
import type { ComposerOwner } from '@/utils/composerUpdateCheckpoint';
import { beginComposerUpdateCheckpoint, clearComposerUpdateHandoff, loadComposerUpdateHandoff } from '@/utils/composerUpdateCheckpoint';
import { serializeTabs, deserializeTabs } from '@/utils/tabPersistence';
import { ThoughtCard } from './ThoughtCard';

const fixture = vi.hoisted(() => ({
  profile: 'moxbot', update: vi.fn(), delete: vi.fn(), archive: vi.fn(), register: vi.fn(),
}));
vi.mock('@/../shared/appProfile', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get APP_BUILD_PROFILE() { return fixture.profile; },
}));
vi.mock('@/utils/composerUpdateCheckpoint', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/composerUpdateCheckpoint')>();
  return { ...actual, registerComposerUpdateOwner: (owner: ComposerOwner) => {
    fixture.register(owner);
    return actual.registerComposerUpdateOwner(owner);
  } };
});
vi.mock('@/api/taskCenter', () => ({ thoughtUpdate: fixture.update, thoughtDelete: fixture.delete, thoughtSetArchived: fixture.archive }));
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ projects: [] }) }));
vi.mock('@/config/services/configStore', () => ({ getConfigDir: async () => '/synthetic/qa', safeLoadJson: async () => null }));
vi.mock('@tauri-apps/api/path', () => ({ join: async (...parts: string[]) => parts.join('/') }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async () => false, remove: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isBrowserDevMode: () => false }));
const THOUGHT: Thought = { id: 'synthetic-thought', content: '原始任务中心文本', tags: [], images: [], createdAt: 1700000000000, updatedAt: 1700000000000, convertedTaskIds: [] };
const reason = '任务中心文本记录仍在编辑或保存，请先保存或取消后再更新；内容已保留。';
let lease: ReturnType<typeof beginComposerUpdateCheckpoint> | undefined;
beforeEach(async () => { fixture.profile = 'moxbot'; vi.clearAllMocks(); await loadComposerUpdateHandoff(deserializeTabs); });
afterEach(async () => { lease?.release(); lease = undefined; await clearComposerUpdateHandoff(); });
function card(onChanged = vi.fn()) { return render(<ThoughtCard thought={THOUGHT} onChanged={onChanged} />); }
function edit(text = '保留的未保存文本') {
  fireEvent.click(screen.getByRole('button', { name: `编辑: ${THOUGHT.content}` }));
  const textarea = screen.getByRole('textbox'); fireEvent.change(textarea, { target: { value: text } }); return textarea;
}
function allowUpdate() { act(() => { lease = beginComposerUpdateCheckpoint(serializeTabs); }); }

describe('ThoughtCard MoxBots update checkpoint', () => {
  it('refuses actual inline editing and preserves text; cancel removes the blocker', () => {
    card(); const textarea = edit();
    expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow(reason);
    expect(textarea).toHaveValue('保留的未保存文本'); expect(fixture.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' })); allowUpdate();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
  it('keeps a failed save and its draft blocked rather than auto-saving on update', async () => {
    fixture.update.mockRejectedValueOnce(new Error('synthetic save failed'));
    card(); const textarea = edit('失败后仍保留'); fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('Error: synthetic save failed');
    expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow(reason); expect(textarea).toHaveValue('失败后仍保留');
    expect(fixture.update).toHaveBeenCalledTimes(1);
  });
  it('refuses an awaited save and permits update only after completion', async () => {
    let finish!: (thought: Thought) => void;
    fixture.update.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const changed = vi.fn(); card(changed); edit('异步保存中'); fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow(reason);
    expect(screen.getByRole('textbox')).toHaveValue('异步保存中');
    await act(async () => finish({ ...THOUGHT, content: '异步保存中' }));
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ content: '异步保存中' })); allowUpdate();
  });
  it.each(['归档', '删除'])('sets the busy blocker before the first %s API await, then releases it on completion', async action => {
    let finish!: (thought?: Thought) => void;
    const api = action === '归档' ? fixture.archive : fixture.delete;
    api.mockImplementationOnce(() => {
      // This executes inside the click handler, before its first await, so
      // React hasn't needed to commit a busy render to close the race.
      expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow(reason);
      return new Promise(resolve => { finish = resolve; });
    });
    card(); fireEvent.click(screen.getByTitle('更多操作'));
    fireEvent.click(screen.getByRole('button', { name: action })); expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow(reason);
    await act(async () => finish(action === '归档' ? { ...THOUGHT, archived: true } : undefined)); allowUpdate();
  });
  it('freezes an idle card against clicks, keyboard editing and an already-open action portal', () => {
    card(); fireEvent.click(screen.getByTitle('更多操作'));
    const root = screen.getByRole('button', { name: `编辑: ${THOUGHT.content}` });
    const menuEdit = screen.getByRole('button', { name: '编辑' }); const archive = screen.getByRole('button', { name: '归档' }); const remove = screen.getByRole('button', { name: '删除' });
    allowUpdate(); expect((root as HTMLElement).inert).toBe(true);
    fireEvent.click(root); fireEvent.keyDown(root, { key: 'Enter' }); fireEvent.click(menuEdit); fireEvent.click(archive); fireEvent.click(remove);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); expect(fixture.archive).not.toHaveBeenCalled(); expect(fixture.delete).not.toHaveBeenCalled();
    act(() => lease!.release()); expect((root as HTMLElement).inert).toBe(false);
    fireEvent.click(root); expect(screen.getByRole('textbox')).toHaveValue(THOUGHT.content);
  });
  it('guards textarea and save/cancel keyboard handlers even if frozen externally during an edit', () => {
    card(); const textarea = edit('冻结仍保留'); const owner = fixture.register.mock.calls[0][0] as ComposerOwner;
    owner.freeze(true); fireEvent.change(textarea, { target: { value: 'should not commit' } });
    fireEvent.keyDown(textarea, { key: 'Escape' }); fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: '保存' })); fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('textbox')).toHaveValue('冻结仍保留'); expect(fixture.update).not.toHaveBeenCalled();
    owner.freeze(false); fireEvent.keyDown(textarea, { key: 'Escape' }); expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
  it('registers stable distinct card scopes and serializes no inactive content', () => {
    const view = card(); const first = fixture.register.mock.calls[0][0] as ComposerOwner;
    view.rerender(<ThoughtCard thought={{ ...THOUGHT, content: 'server refreshed' }} onChanged={vi.fn()} />);
    expect(fixture.register).toHaveBeenCalledTimes(1); expect(first.snapshot()).toMatchObject({ text: '', context: {}, scope: { mode: 'launcher', sessionId: null, workspacePath: null } });
    expect(first.snapshot().blockingReason).toBeUndefined();
    render(<ThoughtCard thought={{ ...THOUGHT, id: 'other' }} onChanged={vi.fn()} />);
    const second = fixture.register.mock.calls[1][0] as ComposerOwner;
    expect(second.snapshot().scope.tabId).not.toBe(first.snapshot().scope.tabId);
  });
  it('leaves default MyAgents unregistered and unfrozen', () => {
    fixture.profile = 'myagents'; card(); expect(fixture.register).not.toHaveBeenCalled();
    allowUpdate(); const textarea = edit('上游默认输入'); expect(textarea).toHaveValue('上游默认输入');
    expect((textarea.closest('[inert]') as HTMLElement | null)).toBeNull();
  });
});
