/**
 * 设置 → 工具箱 的「CLI 工具」分区（PRD 0.2.36 cli_first_tool_registry）。
 *
 * 数据源 = sidecar Admin API（/api/admin/tool/*，与 `myagents tool` 同一套
 * handler），不直读磁盘。注册入口刻意不在 GUI：工具由对话中的 AI 经
 * tool-creator 创建注册，本分区只承担可见性/管理（可审计性三件套之一）+
 * 空状态的用户引导。视觉以 specs/playgrounds/toolbox_settings_tab.html
 * 定稿版为准。
 */
import {
  CopyIcon,
  LoaderIcon,
  SlidersIcon,
  TerminalIcon,
  TrashIcon,
  CloseIcon,
} from '@/components/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CliToolRegistryEntry } from '../../shared/types/cliTools';
import { CLI_TOOL_DESCRIPTION_MAX_CHARS } from '../../shared/types/cliTools';
import { apiPostJson } from '@/api/apiFetch';
import ConfirmDialog from '@/components/ConfirmDialog';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { formatCalendarDate } from '@/i18n/format';
import { copyPlainText } from '@/utils/clipboard';

type CliToolView = CliToolRegistryEntry & {
    kind: 'api' | 'local';
    missingEnvKeys: string[];
};

interface AdminResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    hint?: string;
}

async function postAdmin<T>(route: string, body: Record<string, unknown>): Promise<AdminResponse<T>> {
    return await apiPostJson<AdminResponse<T>>(`/api/admin/tool/${route}`, body);
}

export function CliToolsSection() {
    const { t } = useTranslation('settings');
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const [tools, setTools] = useState<CliToolView[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [detailTool, setDetailTool] = useState<CliToolView | null>(null);
    const [readme, setReadme] = useState<{ loading: boolean; text?: string; error?: string; failed?: boolean }>({ loading: false });
    const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
    const [envConfigured, setEnvConfigured] = useState<Record<string, string>>({});
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [busy, setBusy] = useState(false);
    /** 发给 AI 的注册指令（复制时不带占位符，方便用户直接续写路径） */
    const registerPrompt = t('toolbox.cliTools.registerPrompt');
    const registerPromptDisplay = registerPrompt.replace(/[:：]\s*$/, '');
    const examplePrompts = [
        t('toolbox.cliTools.examples.mergeMarkdown'),
        t('toolbox.cliTools.examples.ttsApi'),
    ];

    const refresh = useCallback(async () => {
        try {
            const res = await postAdmin<{ tools: CliToolView[] }>('list', {});
            if (!isMountedRef.current) return;
            if (res.success) setTools(res.data?.tools ?? []);
        } catch {
            // sidecar 未就绪等瞬态错误：保持现状，区头仍可见
        } finally {
            if (isMountedRef.current) setLoaded(true);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    // 与兄弟组件（LinkContextMenuProvider / ProcessRow）同一形态：失败如实报错，
    // 且由统一 helper 处理 WebView 的 Async Clipboard 拒绝与 selection fallback。
    const copyText = useCallback((text: string) => {
        copyPlainText(text).then(
            () => toastRef.current.success(t('toolbox.cliTools.copySuccess')),
            () => toastRef.current.error(t('toolbox.cliTools.copyFailed')),
        );
    }, [t]);

    const handleToggle = useCallback(async (tool: CliToolView) => {
        const next = !tool.enabled;
        setTools(prev => prev.map(t => (t.name === tool.name ? { ...t, enabled: next } : t)));
        try {
            const res = await postAdmin(next ? 'enable' : 'disable', { name: tool.name });
            if (!res.success) throw new Error(res.error);
            toastRef.current.success(next ? t('toolbox.cliTools.enabledToast') : t('toolbox.cliTools.disabledToast'));
        } catch (e) {
            if (isMountedRef.current) {
                // 函数式回滚基于本次意图取反，不用闭包捕获的 tool.enabled（连续快速点击会捕获到陈旧值）
                setTools(prev => prev.map(t => (t.name === tool.name ? { ...t, enabled: !next } : t)));
            }
            toastRef.current.error(t('toolbox.cliTools.operationFailed', { message: e instanceof Error ? e.message : String(e) }));
        }
    }, [t]);

    // latest-wins：快速 A→B 打开详情时，A 的迟到响应不能写进 B 的弹窗（useRef + reqId）
    const detailReqRef = useRef(0);
    const openDetail = useCallback(async (tool: CliToolView) => {
        const reqId = ++detailReqRef.current;
        setDetailTool(tool);
        setEnvDraft({});
        setEnvConfigured({});
        setReadme({ loading: true });
        const [readmeRes, envRes] = await Promise.allSettled([
            postAdmin<{ readme: string }>('readme', { name: tool.name }),
            postAdmin<{ env: Record<string, string> }>('env', { name: tool.name, action: 'get' }),
        ]);
        if (!isMountedRef.current || detailReqRef.current !== reqId) return;
        if (readmeRes.status === 'fulfilled' && readmeRes.value.success) {
            setReadme({ loading: false, text: readmeRes.value.data?.readme ?? '' });
        } else {
            const msg = readmeRes.status === 'fulfilled' ? readmeRes.value.error : String(readmeRes.reason);
            setReadme({ loading: false, error: msg || undefined, failed: true });
        }
        if (envRes.status === 'fulfilled' && envRes.value.success) {
            setEnvConfigured(envRes.value.data?.env ?? {});
        }
    }, []);

    const closeDetail = useCallback(() => {
        setDetailTool(null);
        setConfirmDelete(false);
    }, []);

    const handleSaveEnv = useCallback(async () => {
        if (!detailTool) return;
        const filled = Object.fromEntries(Object.entries(envDraft).filter(([, v]) => v.trim().length > 0));
        if (Object.keys(filled).length === 0) {
            closeDetail();
            return;
        }
        setBusy(true);
        try {
            const res = await postAdmin('env', { name: detailTool.name, action: 'set', env: filled });
            if (!res.success) throw new Error(res.error);
            toastRef.current.success(t('toolbox.cliTools.envSaved'));
            closeDetail();
            void refresh();
        } catch (e) {
            toastRef.current.error(t('toolbox.cliTools.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
        } finally {
            if (isMountedRef.current) setBusy(false);
        }
    }, [detailTool, envDraft, closeDetail, refresh, t]);

    const handleDelete = useCallback(async () => {
        if (!detailTool) return;
        setBusy(true);
        try {
            const res = await postAdmin('remove', { name: detailTool.name, purge: false });
            if (!res.success) throw new Error(res.error);
            toastRef.current.success(t('toolbox.cliTools.deleteSuccess', { name: detailTool.name }));
            closeDetail();
            void refresh();
        } catch (e) {
            toastRef.current.error(t('toolbox.cliTools.deleteFailed', { message: e instanceof Error ? e.message : String(e) }));
        } finally {
            if (isMountedRef.current) setBusy(false);
        }
    }, [detailTool, closeDetail, refresh, t]);

    return (
        <div className="mt-9 border-t border-[var(--line)] pt-7">
            <div className="flex items-center gap-2">
                <TerminalIcon className="h-5 w-5 text-[var(--ink-muted)]" />
                <h3 className="text-base font-semibold text-[var(--ink)]">
                    {t('toolbox.cliTools.title')}
                </h3>
                <span className="text-xs text-[var(--ink-muted)]">({tools.length})</span>
            </div>
            <p className="mb-4 mt-1 text-sm text-[var(--ink-muted)]">
                {t('toolbox.cliTools.description')}
            </p>

            {!loaded ? (
                <div className="flex items-center justify-center rounded-xl border border-dashed border-[var(--line-strong)] py-10">
                    <LoaderIcon className="h-5 w-5 animate-spin text-[var(--ink-muted)]" />
                </div>
            ) : tools.length === 0 ? (
                /* 空状态：与列表 + 注册指令条互斥，承担"怎么创建"的引导 */
                <div className="rounded-xl border border-dashed border-[var(--line-strong)] px-8 py-12 text-center">
                    <TerminalIcon className="mx-auto mb-3 h-8 w-8 text-[var(--ink-muted)] opacity-50" />
                    <p className="mb-2 text-lg font-semibold text-[var(--ink)]">{t('toolbox.cliTools.emptyTitle')}</p>
                    <p className="mx-auto max-w-xl text-sm leading-relaxed text-[var(--ink-muted)]">
                        {t('toolbox.cliTools.emptyDescription')}
                    </p>
                    <div className="mt-4 flex flex-col items-center gap-2">
                        {examplePrompts.map((prompt) => (
                            <div key={prompt} className="flex items-center gap-2">
                                <span className="rounded-lg bg-[var(--paper-inset)]/45 px-3.5 py-1.5 text-sm text-[var(--ink)]">
                                    &ldquo;{prompt}&rdquo;
                                </span>
                                <button
                                    onClick={() => void copyText(prompt)}
                                    className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:border-[var(--ink-muted)] hover:text-[var(--ink)]"
                                >
                                    <CopyIcon className="h-3 w-3" />
                                    {t('toolbox.cliTools.copy')}
                                </button>
                            </div>
                        ))}
                    </div>
                    <p className="mt-6 flex items-center justify-center gap-2 border-t border-dashed border-[var(--line)] pt-4 text-xs text-[var(--ink-muted)]">
                        {t('toolbox.cliTools.existingToolHint', { prompt: registerPromptDisplay })}
                        <button
                            onClick={() => void copyText(registerPrompt)}
                            className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2 py-1 text-xs text-[var(--ink-muted)] transition-colors hover:border-[var(--ink-muted)] hover:text-[var(--ink)]"
                        >
                            <CopyIcon className="h-3 w-3" />
                            {t('toolbox.cliTools.copy')}
                        </button>
                    </p>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-4">
                        {tools.map((tool) => (
                            <div key={tool.name} className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="flex min-w-0 flex-1 items-center gap-2">
                                        <TerminalIcon className="h-4 w-4 shrink-0 text-[var(--accent)]/80" />
                                        <h3 className="min-w-0 truncate font-mono font-semibold text-[var(--ink)]" title={tool.name}>{tool.name}</h3>
                                        {tool.version && (
                                            <span className="shrink-0 rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                                                v{tool.version}
                                            </span>
                                        )}
                                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tool.kind === 'api'
                                            ? 'border border-[var(--info)]/20 bg-[var(--info-bg)] text-[var(--info)]'
                                            : 'border border-[var(--success)]/20 bg-[var(--success-bg)] text-[var(--success)]'
                                            }`}>
                                            {tool.kind === 'api' ? 'API' : t('toolbox.cliTools.localKind')}
                                        </span>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        <button
                                            onClick={() => void openDetail(tool)}
                                            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                            title={t('toolbox.cliTools.detailTitle')}
                                        >
                                            <SlidersIcon className="h-4 w-4" />
                                        </button>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={tool.enabled}
                                            onClick={() => void handleToggle(tool)}
                                            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 ${tool.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'}`}
                                            title={tool.enabled ? t('toolbox.cliTools.toggleEnabledTitle') : t('toolbox.cliTools.toggleDisabledTitle')}
                                        >
                                            <span className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${tool.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                        </button>
                                    </div>
                                </div>
                                {/* 描述行 = manifest.description（触发描述）截断；五件套首句即能力声明，截断后天然可读 */}
                                <p className="mt-1 truncate text-xs text-[var(--ink-muted)]" title={tool.description}>
                                    {tool.description}
                                </p>
                                {tool.missingEnvKeys.length > 0 && (
                                    <p className="mt-1 text-xs text-[var(--warning)]">
                                        {t('toolbox.cliTools.needsApiKey')}
                                    </p>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* 注册指令条（有工具时显示，与空状态互斥） */}
                    <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-dashed border-[var(--line-strong)] px-4 py-3">
                        <span className="shrink-0 text-sm text-[var(--ink-muted)]">{t('toolbox.cliTools.existingToolLabel')}</span>
                        <span className="min-w-0 flex-1 truncate rounded-lg bg-[var(--paper-inset)]/45 px-3 py-1.5 text-sm text-[var(--ink)]">
                            {registerPrompt}&lt;{t('toolbox.cliTools.toolPathPlaceholder')}&gt;
                        </span>
                        <button
                            onClick={() => void copyText(registerPrompt)}
                            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:border-[var(--ink-muted)] hover:text-[var(--ink)]"
                        >
                            <CopyIcon className="h-3.5 w-3.5" />
                            {t('toolbox.cliTools.copy')}
                        </button>
                    </div>
                </>
            )}

            {/* 详情弹窗：触发描述 + env + readme（AI 与人看同一份）+ 删除。
                独立子组件：mount 即注册 useCloseLayer（Cmd+W 红线） */}
            {detailTool && (
                <CliToolDetailModal
                    tool={detailTool}
                    readme={readme}
                    envDraft={envDraft}
                    onEnvDraftChange={setEnvDraft}
                    envConfigured={envConfigured}
                    busy={busy}
                    onClose={closeDetail}
                    onSaveEnv={handleSaveEnv}
                    onRequestDelete={() => setConfirmDelete(true)}
                />
            )}

            {confirmDelete && detailTool && (
                <ConfirmDialog
                    title={t('toolbox.cliTools.deleteTitle')}
                    message={t('toolbox.cliTools.deleteMessage', { name: detailTool.name })}
                    confirmText={t('toolbox.cliTools.deleteConfirm')}
                    confirmVariant="danger"
                    loading={busy}
                    onConfirm={() => void handleDelete()}
                    onCancel={() => setConfirmDelete(false)}
                />
            )}
        </div>
    );
}

interface CliToolDetailModalProps {
    tool: CliToolView;
    readme: { loading: boolean; text?: string; error?: string; failed?: boolean };
    envDraft: Record<string, string>;
    onEnvDraftChange: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    envConfigured: Record<string, string>;
    busy: boolean;
    onClose: () => void;
    onSaveEnv: () => void;
    onRequestDelete: () => void;
}

/**
 * 工具详情弹窗。独立组件而非内联 JSX：mount 即注册 useCloseLayer（Cmd+W 红线），
 * 与生态内 ConfirmDialog(300)/ContextMenu(50) 同一模式。
 */
function CliToolDetailModal({
    tool, readme, envDraft, onEnvDraftChange, envConfigured, busy,
    onClose, onSaveEnv, onRequestDelete,
}: CliToolDetailModalProps) {
    const { t } = useTranslation('settings');
    useCloseLayer(() => { onClose(); return true; }, 100);

    // env 区显示的 key 集合：manifest 声明的 ∪ 已配置的（防御已配置但未声明的残留）
    const envKeysToShow = Array.from(new Set([...(tool.envKeys ?? []), ...Object.keys(envConfigured)]));
    const registeredDate = formatCalendarDate(new Date(tool.registeredAt)) || tool.registeredAt.slice(0, 10);

    return (
        <OverlayBackdrop portal className="z-[100]" onClose={onClose}>
            <div className="mx-4 flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
                <div className="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
                    <div className="min-w-0">
                        <h2 className="truncate font-mono text-base font-semibold text-[var(--ink)]">{tool.name}</h2>
                        <p className="mt-0.5 truncate font-mono text-xs text-[var(--ink-muted)]" title={tool.dir}>
                            {tool.dir}{tool.version ? ` · v${tool.version}` : ''} · {t('toolbox.cliTools.detail.registeredOn', { date: registeredDate })}
                        </p>
                    </div>
                    <button onClick={onClose} className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]">
                        <CloseIcon className="h-5 w-5" />
                    </button>
                </div>

                <div className="flex-1 space-y-5 overflow-y-auto px-6 py-4">
                    <div>
                        <label className="mb-1.5 flex items-baseline justify-between text-sm font-medium text-[var(--ink)]">
                            {t('toolbox.cliTools.detail.triggerDescription')}
                            <span className="text-xs font-normal text-[var(--ink-muted)]">
                                {tool.description.length} / {CLI_TOOL_DESCRIPTION_MAX_CHARS}
                            </span>
                        </label>
                        <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-inset)]/45 px-3 py-2.5 text-xs leading-relaxed text-[var(--ink-muted)]">
                            {tool.description}
                        </div>
                    </div>

                    {envKeysToShow.length > 0 && (
                        <div>
                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t('toolbox.cliTools.detail.envVars')}</label>
                            <div className="space-y-2">
                                {envKeysToShow.map((key) => (
                                    <div key={key} className="flex items-center gap-2">
                                        <span className="w-1/3 truncate font-mono text-xs text-[var(--ink)]" title={key}>{key}</span>
                                        <input
                                            type="text"
                                            value={envDraft[key] ?? ''}
                                            onChange={(e) => onEnvDraftChange(prev => ({ ...prev, [key]: e.target.value }))}
                                            placeholder={envConfigured[key] ? envConfigured[key] : t('toolbox.cliTools.detail.notConfigured')}
                                            className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 font-mono text-xs text-[var(--ink)] placeholder:text-[var(--ink-muted)]/60 focus:border-[var(--accent)] focus:outline-none"
                                        />
                                    </div>
                                ))}
                            </div>
                            <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                                {t('toolbox.cliTools.detail.envHint')}
                            </p>
                        </div>
                    )}

                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                            {t('toolbox.cliTools.detail.readmeLabelPrefix')}{' '}
                            <span className="font-mono">{tool.name} readme</span>
                            {t('toolbox.cliTools.detail.readmeLabelSuffix')}
                        </label>
                        {readme.loading ? (
                            <div className="flex items-center justify-center rounded-lg border border-[var(--line)] py-8">
                                <LoaderIcon className="h-4 w-4 animate-spin text-[var(--ink-muted)]" />
                            </div>
                        ) : readme.failed ? (
                            <div className="rounded-lg border border-[var(--line)] px-3 py-2.5 text-xs text-[var(--warning)]">
                                {readme.error
                                    ? t('toolbox.cliTools.detail.readmeFailed', { message: readme.error })
                                    : t('toolbox.cliTools.readFailed')}
                            </div>
                        ) : (
                            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--line)] px-4 py-3 text-xs leading-relaxed text-[var(--ink-muted)]">
                                {readme.text}
                            </pre>
                        )}
                    </div>
                </div>

                <div className="flex items-center justify-between border-t border-[var(--line)] px-6 py-4">
                    <button
                        onClick={onRequestDelete}
                        disabled={busy}
                        className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-[var(--error)] transition-colors hover:bg-[var(--error-subtle)] disabled:opacity-50"
                    >
                        <TrashIcon className="h-4 w-4" />
                        {t('toolbox.cliTools.detail.deleteTool')}
                    </button>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                        >
                            {t('toolbox.cliTools.detail.close')}
                        </button>
                        {envKeysToShow.length > 0 && (
                            <button
                                onClick={onSaveEnv}
                                disabled={busy}
                                className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                            >
                                {t('toolbox.cliTools.detail.save')}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </OverlayBackdrop>
    );
}
