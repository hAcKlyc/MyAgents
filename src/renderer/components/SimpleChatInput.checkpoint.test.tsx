import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
import { ToastProvider } from './Toast';
import SimpleChatInput, { type SimpleChatInputHandle } from './SimpleChatInput';
import { beginComposerUpdateCheckpoint, clearComposerUpdateHandoff, loadComposerUpdateHandoff, registerComposerUpdateOwner, type ComposerSnapshot } from '@/utils/composerUpdateCheckpoint';
import type { Tab } from '@/types/tab';
import { TASK_ALIGNMENT_SKILL_REQUIREMENT } from '@/../shared/systemSkills';
const fixture = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  service: { isAvailable: true, importBase64Files: vi.fn(), copyPaths: vi.fn(), addGitignore: vi.fn(), prepareUserImageAttachments: vi.fn(), searchFilesPage: vi.fn(), listSlashCommands: vi.fn() },
}));
vi.mock('@/../shared/appProfile', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), APP_BUILD_PROFILE: 'moxbot' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ items: [], complete: true, networkStatus: 'connecting', authGeneration: 0, principalId: null, networkId: null })) }));
vi.mock('@tauri-apps/api/path', () => ({ join: async (...parts: string[]) => parts.join('/') }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async (path: string) => fixture.values.has(path), remove: async (path: string) => { fixture.values.delete(path); } }));
vi.mock('@/config/services/configStore', () => ({ getConfigDir: async () => '/synthetic/qa', safeWriteJson: async (path: string, value: unknown) => { fixture.values.set(path, JSON.parse(JSON.stringify(value))); }, safeLoadJson: async (path: string) => fixture.values.get(path) ?? null }));
vi.mock('@/utils/browserMock', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), isBrowserDevMode: () => false }));
vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ config: { chatSendShortcut: 'enter' }, projects: [] }) }));
vi.mock('@/hooks/useWorkspaceFileService', () => ({ useWorkspaceFileService: () => fixture.service }));
const tab = { id: 'tab-a', view: 'chat', agentDir: '/synthetic/workspace-a', sessionId: 'session-a', title: 'Synthetic A' } as Tab;
let lease: ReturnType<typeof beginComposerUpdateCheckpoint> | undefined;
beforeEach(async () => {
  fixture.values.clear(); vi.clearAllMocks();
  await loadComposerUpdateHandoff();
  fixture.service.listSlashCommands.mockResolvedValue({ success: true, commands: [] });
  fixture.service.searchFilesPage.mockResolvedValue({ items: [], complete: true, hasMore: false, nextCursor: null });
  fixture.service.addGitignore.mockResolvedValue({});
});
afterEach(async () => { lease?.release(); lease = undefined; await clearComposerUpdateHandoff(); });
function input(props: Partial<React.ComponentProps<typeof SimpleChatInput>> = {}) {
  const onSend = vi.fn(); const ref = createRef<SimpleChatInputHandle>();
  const result = render(<ToastProvider><ImagePreviewProvider><SimpleChatInput ref={ref} composerTabId="tab-a" sessionId="session-a" workspacePath="/synthetic/workspace-a" runtime="codex" usesExternalRuntimeControls isLoading={false} onSend={onSend} {...props} /></ImagePreviewProvider></ToastProvider>);
  return { ...result, ref, onSend, textarea: screen.getByRole('textbox') };
}
describe('SimpleChatInput update checkpoint owner', () => {
  it('unlocks after an owner scope changes while the checkpoint is frozen', async () => {
    const { textarea, rerender } = input();
    fireEvent.change(textarea, { target: { value: 'keep scoped draft' } });
    act(() => { lease = beginComposerUpdateCheckpoint(); });
    await lease!.persist([tab], tab.id);
    rerender(<ToastProvider><ImagePreviewProvider><SimpleChatInput composerTabId="tab-a" sessionId="session-b" workspacePath="/synthetic/workspace-b" runtime="codex" usesExternalRuntimeControls isLoading={false} onSend={vi.fn()} /></ImagePreviewProvider></ToastProvider>);
    expect(() => lease!.verify([tab], tab.id)).toThrow();
    await lease!.abort();
    act(() => lease!.release());
    expect(textarea).not.toHaveAttribute('readonly');
    fireEvent.change(textarea, { target: { value: 'editable again' } });
    expect(textarea).toHaveValue('editable again');
  });
  it('freezes text and imperative writes, blocks send, then releases on aborted install', async () => {
    const { textarea, ref, onSend } = input();
    fireEvent.change(textarea, { target: { value: 'KEEP-AFTER-UPDATE' } });
    act(() => { lease = beginComposerUpdateCheckpoint(); });
    expect(textarea).toHaveAttribute('readonly');
    await lease!.persist([tab], tab.id);
    fireEvent.change(textarea, { target: { value: 'late change' } });
    act(() => ref.current?.setValue('late imperative'));
    fireEvent.click(screen.getByTitle(/发送/));
    expect(textarea).toHaveValue('KEEP-AFTER-UPDATE'); expect(onSend).not.toHaveBeenCalled();
    lease!.verify([tab], tab.id); act(() => lease!.release());
    expect(textarea).not.toHaveAttribute('readonly');
    fireEvent.change(textarea, { target: { value: 'continue working' } }); expect(textarea).toHaveValue('continue working');
  });
  it('restores durable structured draft only into its exact owner without sending', async () => {
    const context = { primaryContext: { kind: 'floating-context' as const, input: { appName: 'Synthetic app', selectedText: 'source text' } }, requiredSystemSkill: TASK_ALIGNMENT_SKILL_REQUIREMENT };
    const snapshot: ComposerSnapshot = { scope: { tabId: tab.id, sessionId: 'session-a', workspacePath: '/synthetic/workspace-a', mode: 'chat' }, text: '  A @myagents_files/source.pdf\n继续  ', context, composing: false, sending: false, imageCount: 0, pendingAttachments: false, stagedWorkflow: false };
    const unregister = registerComposerUpdateOwner({ snapshot: () => snapshot, freeze: vi.fn() });
    lease = beginComposerUpdateCheckpoint(); await lease.persist([tab], tab.id); lease.release(); unregister();
    await loadComposerUpdateHandoff();
    const { ref, textarea, onSend } = input();
    expect(textarea).toHaveValue(snapshot.text); expect(ref.current?.getQueryContext()).toMatchObject(context);
    expect(onSend).not.toHaveBeenCalled();
  });
  it('rejects live IME without making the input readOnly or losing its draft', () => {
    const { textarea } = input(); fireEvent.change(textarea, { target: { value: '组合输入' } }); fireEvent.compositionStart(textarea);
    expect(() => beginComposerUpdateCheckpoint()).toThrow('输入法');
    expect(textarea).not.toHaveAttribute('readonly'); expect(textarea).toHaveValue('组合输入');
  });
  it('blocks while Rust attachment import is pending, then retains durable workspace reference', async () => {
    let finish!: (value: unknown) => void;
    fixture.service.copyPaths.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { ref, textarea } = input(); fireEvent.change(textarea, { target: { value: '文件草稿 ' } });
    let pending!: Promise<void>;
    act(() => { pending = ref.current!.processDroppedFilePaths!(['/synthetic/source.pdf']); });
    expect(() => beginComposerUpdateCheckpoint()).toThrow('处理中');
    await act(async () => { finish({ success: true, copiedFiles: [{ targetPath: 'myagents_files/source.pdf' }] }); await pending; });
    expect((textarea as HTMLTextAreaElement).value).toContain('@myagents_files/source.pdf');
    lease = beginComposerUpdateCheckpoint(); await lease.persist([tab], tab.id);
  });
  it('rejects in-memory File images, preserves image and text, and blocks nonempty Launcher', async () => {
    const { ref, textarea, unmount } = input(); fireEvent.change(textarea, { target: { value: 'image draft' } });
    act(() => ref.current!.setImages([{ id: 'synthetic-image', file: new File(['synthetic'], 'a.png', { type: 'image/png' }), preview: 'data:image/png;base64,c3ludGhldGlj' }]));
    expect(() => beginComposerUpdateCheckpoint()).toThrow('图片');
    expect(ref.current!.getImages()).toHaveLength(1); expect(textarea).toHaveValue('image draft'); unmount();
    const launcher = input({ mode: 'launcher', sessionId: 'pending-tab-a' }); fireEvent.change(launcher.textarea, { target: { value: 'launcher stays' } });
    lease = beginComposerUpdateCheckpoint(); await expect(lease.persist([{ id: 'tab-a', view: 'launcher', title: 'New' } as Tab], 'tab-a')).rejects.toThrow('可恢复');
    expect(launcher.textarea).toHaveValue('launcher stays');
  });
});
