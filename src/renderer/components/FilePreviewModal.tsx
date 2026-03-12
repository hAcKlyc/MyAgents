/**
 * FilePreviewModal - File preview and edit modal for workspace files
 * 
 * Features:
 * - Syntax highlighted preview for code files (with line numbers)
 * - Rendered HTML preview for Markdown files
 * - Plain text preview for txt/log files
 * - Monaco Editor for editing mode
 * - Unsaved changes confirmation
 */
import { Edit2, FileText, FolderOpen, Loader2, Save, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { useTabApi } from '@/context/TabContext';
import { getPrismLanguage, getMonacoLanguage, shouldShowLineNumbers, isMarkdownFile } from '@/utils/languageUtils';
import { shortenPathForDisplay } from '@/utils/pathDetection';

import ConfirmDialog from './ConfirmDialog';
import Markdown from './Markdown';
import { useToast } from './Toast';

// Lazy load Monaco Editor: the ~3MB bundle is only loaded when user first clicks "edit"
const MonacoEditor = lazy(() => import('./MonacoEditor'));


interface FilePreviewModalProps {
    /** File name to display */
    name: string;
    /** File content */
    content: string;
    /** File size in bytes */
    size: number;
    /** Relative path from agent directory (for saving) */
    path: string;
    /** Whether content is loading */
    isLoading?: boolean;
    /** Error message to display */
    error?: string | null;
    /** Callback when modal is closed */
    onClose: () => void;
    /** Callback after file is saved successfully */
    onSaved?: () => void;
}

// Files above this threshold use plaintext mode (skip tokenization) to prevent UI freeze
const LARGE_FILE_TOKENIZATION_THRESHOLD = 100 * 1024; // 100KB

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilePreviewModal({
    name,
    content,
    size,
    path,
    isLoading = false,
    error = null,
    onClose,
    onSaved
}: FilePreviewModalProps) {
    const toast = useToast();
    // Stabilize toast reference to avoid unnecessary effect re-runs
    const toastRef = useRef(toast);
    toastRef.current = toast;

    const { apiPost } = useTabApi();

    // State
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(content);
    const [previewContent, setPreviewContent] = useState(content); // Content displayed in preview mode, updated after save
    const [isSaving, setIsSaving] = useState(false);
    const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
    // Track if content is ready to render (avoids blank flash while SyntaxHighlighter computes)
    const [isContentReady, setIsContentReady] = useState(false);
    // Defer Monaco Editor mounting to avoid blocking the click event's microtask chain
    const [isEditorReady, setIsEditorReady] = useState(false);

    // Sync content when prop changes (e.g., when file is reloaded externally)
    // Use requestAnimationFrame to let loading state render first before heavy SyntaxHighlighter
    useEffect(() => {
        setEditContent(content);
        setPreviewContent(content);
        setIsContentReady(false);

        // Defer content ready to next frame so loading spinner shows first
        const rafId = requestAnimationFrame(() => {
            setIsContentReady(true);
        });
        return () => cancelAnimationFrame(rafId);
    }, [content]);

    // Derived state - compare with previewContent (the last saved state)
    const hasUnsavedChanges = useMemo(() => {
        return isEditing && editContent !== previewContent;
    }, [isEditing, editContent, previewContent]);

    // Defer editor mounting: when isEditing becomes true, wait one frame before rendering Monaco
    useEffect(() => {
        if (isEditing && !isEditorReady) {
            const rafId = requestAnimationFrame(() => {
                setIsEditorReady(true);
            });
            return () => cancelAnimationFrame(rafId);
        }
    }, [isEditing, isEditorReady]);

    const language = useMemo(() => getPrismLanguage(name), [name]);
    const monacoLanguage = useMemo(() => getMonacoLanguage(name), [name]);
    const showLineNumbers = useMemo(() => shouldShowLineNumbers(name), [name]);
    const isMarkdown = useMemo(() => isMarkdownFile(name), [name]);

    // Large files: force plaintext to skip tokenization
    const effectiveMonacoLanguage = useMemo(() => {
        if (size > LARGE_FILE_TOKENIZATION_THRESHOLD) return 'plaintext';
        return monacoLanguage;
    }, [size, monacoLanguage]);

    // Memoize the syntax highlighted content to avoid re-computation on every render
    // SyntaxHighlighter is expensive - only recompute when content or language changes
    const syntaxHighlightedContent = useMemo(() => {
        if (isMarkdown || isEditing) return null; // Not used in these modes
        return (
            <SyntaxHighlighter
                language={language}
                style={oneLight}
                showLineNumbers={showLineNumbers}
                lineNumberStyle={{
                    minWidth: '3em',
                    paddingRight: '1em',
                    color: 'var(--ink-muted)',
                    fontSize: '12px',
                    userSelect: 'none',
                }}
                customStyle={{
                    margin: 0,
                    padding: '1.5rem',
                    background: 'transparent',
                    fontSize: '13px',
                    lineHeight: '1.6',
                    fontFamily: 'var(--font-code)',
                }}
                codeTagProps={{
                    style: {
                        fontFamily: 'inherit',
                    }
                }}
            >
                {previewContent}
            </SyntaxHighlighter>
        );
    }, [previewContent, language, showLineNumbers, isMarkdown, isEditing]);

    // Handlers
    const handleEdit = useCallback(() => {
        setEditContent(previewContent); // Start editing from current preview content
        setIsEditorReady(false); // Reset so deferred mounting kicks in
        setIsEditing(true);
    }, [previewContent]);

    const handleCancel = useCallback(() => {
        if (hasUnsavedChanges) {
            setShowUnsavedConfirm(true);
        } else {
            setIsEditing(false);
        }
    }, [hasUnsavedChanges]);

    const handleDiscardChanges = useCallback(() => {
        setShowUnsavedConfirm(false);
        setEditContent(previewContent); // Revert to current preview content
        setIsEditing(false);
    }, [previewContent]);

    const handleClose = useCallback(() => {
        if (hasUnsavedChanges) {
            setShowUnsavedConfirm(true);
        } else {
            onClose();
        }
    }, [hasUnsavedChanges, onClose]);

    const handleSave = useCallback(async () => {
        setIsSaving(true);
        try {
            const response = await apiPost<{ success: boolean; error?: string }>(
                '/agent/save-file',
                { path, content: editContent }
            );

            if (response.success) {
                toastRef.current.success('文件保存成功');
                setPreviewContent(editContent); // Update preview content after successful save
                setIsEditing(false);
                onSaved?.();
            } else {
                toastRef.current.error(response.error ?? '保存失败');
            }
        } catch (err) {
            toastRef.current.error(err instanceof Error ? err.message : '保存失败');
        } finally {
            setIsSaving(false);
        }
    }, [apiPost, path, editContent, onSaved]);

    // Handle backdrop click — only close on genuine clicks (mousedown + mouseup both on backdrop).
    // Prevents closing when user drags a text selection out of the modal and releases on the backdrop.
    const mouseDownTargetRef = useRef<EventTarget | null>(null);

    const handleBackdropMouseDown = useCallback((e: React.MouseEvent) => {
        mouseDownTargetRef.current = e.target;
    }, []);

    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) {
            handleClose();
        }
    }, [handleClose]);

    const handleOpenInFinder = useCallback(async () => {
        try {
            await apiPost('/agent/open-in-finder', { path });
        } catch {
            toastRef.current.error('无法打开目录');
        }
    }, [apiPost, path]);

    // Render preview content based on file type
    const renderPreviewContent = () => {
        // Show loading spinner while fetching or while content is preparing to render
        // Use same background as content area to avoid color flash during transition
        if (isLoading || !isContentReady) {
            return (
                <div className="flex h-full items-center justify-center bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
                    <Loader2 className="h-5 w-5 animate-spin" />
                </div>
            );
        }

        if (error) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--error)]">
                    <X className="h-8 w-8" />
                    <span className="text-sm">{error}</span>
                </div>
            );
        }

        // Editing mode: use Monaco Editor
        // - Suspense handles first-time chunk loading (lazy import)
        // - isEditorReady defers mounting to next frame on every edit (avoids blocking click microtask)
        if (isEditing) {
            const editorLoading = (
                <div className="flex h-full items-center justify-center bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
                    <Loader2 className="h-5 w-5 animate-spin" />
                </div>
            );
            if (!isEditorReady) {
                return editorLoading;
            }
            return (
                <Suspense fallback={editorLoading}>
                    <div className="h-full bg-[var(--paper-elevated)]">
                        <MonacoEditor
                            value={editContent}
                            onChange={setEditContent}
                            language={effectiveMonacoLanguage}
                        />
                    </div>
                </Suspense>
            );
        }

        // Preview mode: Markdown renders as HTML
        // Use raw mode to skip streaming preprocessing (which can break valid markdown)
        if (isMarkdown) {
            return (
                <div className="h-full overflow-auto p-6 bg-[var(--paper-elevated)]">
                    <div className="prose prose-stone max-w-none dark:prose-invert">
                        <Markdown raw basePath={path ? path.substring(0, path.lastIndexOf('/')) : undefined}>{previewContent}</Markdown>
                    </div>
                </div>
            );
        }

        // Preview mode: Code files with syntax highlighting (memoized)
        return (
            <div className="h-full overflow-auto bg-[var(--paper-elevated)]">
                {syntaxHighlightedContent}
            </div>
        );
    };

    // Render via portal to document.body to avoid chat scrollbar penetrating through
    // (parent stacking context from Chat/DirectoryPanel would otherwise overlay scrollbar on modal)
    return createPortal(
        <>
            {/* Modal backdrop */}
            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
                style={{ padding: '2vh 2vw' }}
                onMouseDown={handleBackdropMouseDown}
                onClick={handleBackdropClick}
                onWheel={(e) => e.stopPropagation()}
            >
                {/* Modal content */}
                <div
                    className="glass-panel flex h-full w-full max-w-5xl flex-col overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div
                        className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4 bg-[var(--paper-elevated)]"
                    >
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-muted)]">
                                <FileText className="h-4 w-4 text-[var(--accent)]" />
                            </div>
                            <div className="min-w-0">
                                <div className="flex items-center gap-3 truncate">
                                    <span className="truncate text-[13px] font-semibold text-[var(--ink)]">{name}</span>
                                    <span className="flex-shrink-0 text-[11px] text-[var(--ink-muted)]">{formatFileSize(size)}</span>
                                    {isEditing && (
                                        <span className="flex-shrink-0 text-[11px] text-[var(--accent)]">
                                            {hasUnsavedChanges ? '编辑中（未保存）' : '编辑中'}
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <span className="max-w-[400px] truncate text-[11px] text-[var(--ink-muted)]" title={path}>
                                        {shortenPathForDisplay(path)}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={handleOpenInFinder}
                                        className="flex-shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                        title="打开所在文件夹"
                                    >
                                        <FolderOpen className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Action buttons - unified styling with smooth transitions */}
                        <div className="flex flex-shrink-0 items-center gap-1.5">
                            {isEditing ? (
                                <div key="editing" className="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        onClick={handleCancel}
                                        className="inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98]"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                        取消
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleSave}
                                        disabled={isSaving || !hasUnsavedChanges}
                                        className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-all duration-150 hover:bg-[var(--accent-warm-hover)] hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                                    >
                                        {isSaving ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Save className="h-3.5 w-3.5" />
                                        )}
                                        保存
                                    </button>
                                </div>
                            ) : (
                                <button
                                    key="view"
                                    type="button"
                                    onClick={handleEdit}
                                    disabled={isLoading || !!error}
                                    className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--ink)] px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-all duration-150 hover:bg-[var(--ink-secondary)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                                >
                                    <Edit2 className="h-3.5 w-3.5" />
                                    编辑
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleClose}
                                className="inline-flex items-center justify-center rounded-md border border-[var(--line-strong)] bg-[var(--button-secondary-bg)] px-3 py-1.5 text-[11px] font-semibold text-[var(--ink)] shadow-sm transition-all duration-150 hover:bg-[var(--button-secondary-bg-hover)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98]"
                            >
                                关闭
                            </button>
                        </div>
                    </div>

                    {/* Content area */}
                    <div className="flex-1 overflow-hidden">
                        {renderPreviewContent()}
                    </div>
                </div>
            </div>

            {/* Unsaved changes confirmation dialog */}
            {showUnsavedConfirm && (
                <ConfirmDialog
                    title="未保存的更改"
                    message="您有未保存的更改，确定要放弃吗？"
                    confirmLabel="放弃更改"
                    cancelLabel="继续编辑"
                    danger
                    onConfirm={handleDiscardChanges}
                    onCancel={() => setShowUnsavedConfirm(false)}
                />
            )}
        </>,
        document.body
    );
}
