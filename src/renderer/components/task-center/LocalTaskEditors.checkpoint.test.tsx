import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thought } from '@/../shared/types/thought';
import type { Task } from '@/../shared/types/task';
import type { TaskComment } from '@/../shared/types/taskComment';
import type { ComposerOwner } from '@/utils/composerUpdateCheckpoint';
import { beginComposerUpdateCheckpoint, clearComposerUpdateHandoff, loadComposerUpdateHandoff } from '@/utils/composerUpdateCheckpoint';
import { serializeTabs, deserializeTabs } from '@/utils/tabPersistence';
import { ThoughtInput } from './ThoughtInput';
import { TaskCommentTimeline } from './TaskCommentTimeline';
const fixture = vi.hoisted(() => ({
  profile: 'moxbot', createThought: vi.fn(), list: vi.fn(), createComment: vi.fn(), retry: vi.fn(), register: vi.fn(),
}));
vi.mock('@/../shared/appProfile', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), get APP_BUILD_PROFILE() { return fixture.profile; } }));
vi.mock('@/utils/composerUpdateCheckpoint', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/composerUpdateCheckpoint')>();
  return { ...actual, registerComposerUpdateOwner: (owner: ComposerOwner) => { fixture.register(owner); return actual.registerComposerUpdateOwner(owner); } };
});
vi.mock('@/api/taskCenter', () => ({ thoughtCreate: fixture.createThought, taskListComments: fixture.list, taskGetCommentContext: vi.fn(), taskCreateUserComment: fixture.createComment, taskRetryComment: fixture.retry }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async () => ({ unlisten: vi.fn(), isRegistered: () => true })) }));
vi.mock('@/components/Markdown', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/config/services/configStore', () => ({ getConfigDir: async () => '/synthetic/qa', safeLoadJson: async () => null }));
vi.mock('@tauri-apps/api/path', () => ({ join: async (...parts: string[]) => parts.join('/') }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async () => false, remove: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isBrowserDevMode: () => false }));
const THOUGHT: Thought = { id: 'synthetic-thought', content: 'submitted', tags: [], images: [], createdAt: 1, updatedAt: 2, convertedTaskIds: [] };
const TASK: Task = { id: 'synthetic-task', name: 'Synthetic', executor: 'agent', workspaceId: 'synthetic-workspace', workspacePath: '/synthetic/workspace', executionMode: 'once', runMode: 'new-session', sessionIds: [], status: 'done', tags: [], createdAt: 1, updatedAt: 2, statusHistory: [], dispatchOrigin: 'direct' };
const COMMENT: TaskComment = { id: 'synthetic-comment', taskId: TASK.id, body: '持久评论', author: { kind: 'user' }, createdAt: 1, admission: { state: 'failed' } };
let lease: ReturnType<typeof beginComposerUpdateCheckpoint> | undefined;
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
beforeEach(async () => {
  fixture.profile = 'moxbot'; vi.clearAllMocks(); await loadComposerUpdateHandoff(deserializeTabs);
  fixture.list.mockResolvedValue({ items: [COMMENT] });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
});
afterEach(async () => {
  lease?.release(); lease = undefined; await clearComposerUpdateHandoff();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});
function acquire() { act(() => { lease = beginComposerUpdateCheckpoint(serializeTabs); }); }
function enter(text = '保留的未提交文本') { const textarea = screen.getByRole('textbox'); fireEvent.change(textarea, { target: { value: text } }); return textarea; }
function saveThought() { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true }); }
function sendComment() { fireEvent.click(screen.getByRole('button', { name: '发送评论' })); }
function captureOwner() { return fixture.register.mock.calls[0][0] as ComposerOwner; }

describe('ThoughtInput update admission', () => {
  it('blocks unsaved input and retains a failed create without another automatic submit', async () => {
    fixture.createThought.mockRejectedValueOnce(new Error('synthetic create failed')); render(<ThoughtInput />);
    const textarea = enter(); expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('新建文本记录');
    saveThought(); await screen.findByText('Error: synthetic create failed');
    expect(textarea).toHaveValue('保留的未提交文本'); expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('内容已保留'); expect(fixture.createThought).toHaveBeenCalledTimes(1);
    fireEvent.change(textarea, { target: { value: '' } }); acquire();
  });
  it('tracks create synchronously before its first await and releases after success', async () => {
    let finish!: (thought: Thought) => void;
    fixture.createThought.mockImplementationOnce(() => {
      expect(captureOwner().snapshot().blockingReason).toBeDefined();
      expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('保存');
      return new Promise(resolve => { finish = resolve; });
    });
    render(<ThoughtInput />); enter(); saveThought(); expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('保存');
    await act(async () => finish(THOUGHT)); expect(screen.getByRole('textbox')).toHaveValue(''); acquire();
  });
  it('blocks empty IME composition and permits update after composition completes', () => {
    render(<ThoughtInput />); const textarea = screen.getByRole('textbox'); fireEvent.compositionStart(textarea);
    expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('输入'); expect(textarea).not.toHaveAttribute('readonly');
    fireEvent.compositionEnd(textarea); acquire(); expect(textarea).toHaveAttribute('readonly');
  });
  it('freezes idle change/hash/record/submit entry points and restores normal input on abort', () => {
    const record = vi.fn(); render(<ThoughtInput onStartRecording={record} />); const textarea = screen.getByRole('textbox'); acquire();
    expect(textarea).toHaveAttribute('readonly'); fireEvent.change(textarea, { target: { value: 'late' } });
    fireEvent.click(screen.getByTitle('插入 # 标签')); fireEvent.click(screen.getByRole('button', { name: '开始录音' })); saveThought();
    expect(textarea).toHaveValue(''); expect(record).not.toHaveBeenCalled(); expect(fixture.createThought).not.toHaveBeenCalled();
    act(() => lease!.release()); fireEvent.change(textarea, { target: { value: '继续输入' } }); expect(textarea).toHaveValue('继续输入'); expect(textarea).not.toHaveAttribute('readonly');
  });
  it('guards an already-open tag portal while externally frozen', async () => {
    render(<ThoughtInput existingTags={[["keyword", 1]]} />);
    // The real update path refuses this draft; exercising the owner directly
    // ensures existing portals cannot mutate it if a freeze arrives.
    const textarea = enter('#key'); const tag = await screen.findByRole('button', { name: /#keyword/ }); const owner = captureOwner(); owner.freeze(true);
    fireEvent.mouseDown(tag); fireEvent.keyDown(textarea, { key: 'Enter' }); fireEvent.click(screen.getByTitle('插入 # 标签'));
    expect(textarea).toHaveValue('#key'); owner.freeze(false);
  });
  it('blocks parent recordingBusy and the start promise before its first await', async () => {
    let finish!: () => void;
    const record = vi.fn(() => {
      expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('录音');
      return new Promise<void>(resolve => { finish = resolve; });
    });
    const view = render(<ThoughtInput recordingBusy />); expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('录音');
    view.rerender(<ThoughtInput onStartRecording={record} />); fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
    expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('录音'); await act(async () => finish()); acquire();
  });
});

describe('TaskCommentTimeline update admission', () => {
  it('retains a failed comment body and blocks update until cleared', async () => {
    fixture.createComment.mockRejectedValueOnce(new Error('synthetic comment failed')); render(<TaskCommentTimeline task={TASK} />);
    const textarea = enter('评论草稿保留'); sendComment(); await screen.findByRole('alert');
    expect(textarea).toHaveValue('评论草稿保留'); expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('任务评论'); expect(fixture.createComment).toHaveBeenCalledTimes(1);
    fireEvent.change(textarea, { target: { value: '' } }); acquire();
  });
  it('blocks pending comment persistence before its first await and releases on success', async () => {
    let finish!: (comment: TaskComment) => void;
    fixture.createComment.mockImplementationOnce(() => {
      expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('发送');
      return new Promise(resolve => { finish = resolve; });
    });
    render(<TaskCommentTimeline task={TASK} />); enter('异步评论'); sendComment();
    expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('发送');
    await act(async () => finish({ ...COMMENT, id: 'created', body: '异步评论', admission: { state: 'accepted' } }));
    expect(screen.getByRole('textbox')).toHaveValue(''); acquire();
  });
  it('blocks retry even with an empty composer and releases when its API completes', async () => {
    let finish!: (comment: TaskComment) => void;
    fixture.retry.mockImplementationOnce(() => {
      expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('重试');
      return new Promise(resolve => { finish = resolve; });
    });
    render(<TaskCommentTimeline task={TASK} />); fireEvent.click(await screen.findByRole('button', { name: '重试发送' }));
    expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('重试');
    await act(async () => finish({ ...COMMENT, admission: { state: 'accepted' } })); acquire();
  });
  it('keeps all concurrent retries covered until the last API returns', async () => {
    const finishes: Array<(comment: TaskComment) => void> = [];
    fixture.retry.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
    render(<TaskCommentTimeline task={TASK} />); const retry = await screen.findByRole('button', { name: '重试发送' });
    fireEvent.click(retry); fireEvent.click(retry); expect(fixture.retry).toHaveBeenCalledTimes(2);
    await act(async () => finishes[0]({ ...COMMENT, admission: { state: 'failed' } }));
    expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('重试');
    await act(async () => finishes[1]({ ...COMMENT, admission: { state: 'accepted' } })); acquire();
  });
  it('blocks empty IME and pending reply intent without flattening it', async () => {
    render(<TaskCommentTimeline task={TASK} />); const textarea = screen.getByRole('textbox'); fireEvent.compositionStart(textarea);
    expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('输入'); fireEvent.compositionEnd(textarea);
    fireEvent.click(await screen.findByRole('button', { name: '回复' })); expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('任务评论');
    fireEvent.click(screen.getByRole('button', { name: '取消回复' })); acquire();
  });
  it('freezes change/Reply/retry/send/keyboard entries and leaves empty idle content unserialized', async () => {
    render(<TaskCommentTimeline task={TASK} />); const reply = await screen.findByRole('button', { name: '回复' }); const retry = screen.getByRole('button', { name: '重试发送' });
    const textarea = screen.getByRole('textbox'); acquire(); await lease!.persist([], null);
    expect(textarea).toHaveAttribute('readonly'); fireEvent.change(textarea, { target: { value: 'late' } });
    fireEvent.click(reply); fireEvent.click(retry); sendComment(); fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(textarea).toHaveValue(''); expect(screen.queryByRole('button', { name: '取消回复' })).not.toBeInTheDocument(); expect(fixture.retry).not.toHaveBeenCalled(); expect(fixture.createComment).not.toHaveBeenCalled();
    act(() => lease!.release()); fireEvent.click(reply); expect(screen.getByRole('button', { name: '取消回复' })).toBeInTheDocument();
  });
});

it.each(['thought', 'comment'])('keeps default MyAgents %s unregistered and editable', kind => {
  fixture.profile = 'myagents';
  render(kind === 'thought' ? <ThoughtInput /> : <TaskCommentTimeline task={TASK} />); expect(fixture.register).not.toHaveBeenCalled(); acquire();
  const textarea = enter('默认上游仍可输入'); expect(textarea).toHaveValue('默认上游仍可输入'); expect(textarea).not.toHaveAttribute('readonly');
});
