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
import { Edit2, FileText, Loader2, Save, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { useTabState } from '@/context/TabContext';
import { getPrismLanguage, getMonacoLanguage, shouldShowLineNumbers, isMarkdownFile } from '@/utils/languageUtils';

import ConfirmDialog from './ConfirmDialog';
import Markdown from './Markdown';
import MonacoEditor from './MonacoEditor';
import { useToast } from './Toast';


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

    const { apiPost } = useTabState();

    // State
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(content);
    const [isSaving, setIsSaving] = useState(false);
    const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);

    // Sync edit content when content prop changes
    useEffect(() => {
        setEditContent(content);
    }, [content]);

    // Derived state
    const hasUnsavedChanges = useMemo(() => {
        return isEditing && editContent !== content;
    }, [isEditing, editContent, content]);

    const language = useMemo(() => getPrismLanguage(name), [name]);
    const monacoLanguage = useMemo(() => getMonacoLanguage(name), [name]);
    const showLineNumbers = useMemo(() => shouldShowLineNumbers(name), [name]);
    const isMarkdown = useMemo(() => isMarkdownFile(name), [name]);

    // Handlers
    const handleEdit = useCallback(() => {
        setEditContent(content);
        setIsEditing(true);
    }, [content]);

    const handleCancel = useCallback(() => {
        if (hasUnsavedChanges) {
            setShowUnsavedConfirm(true);
        } else {
            setIsEditing(false);
        }
    }, [hasUnsavedChanges]);

    const handleDiscardChanges = useCallback(() => {
        setShowUnsavedConfirm(false);
        setEditContent(content);
        setIsEditing(false);
    }, [content]);

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

    // Handle backdrop click
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            handleClose();
        }
    }, [handleClose]);

    // Render preview content based on file type
    const renderPreviewContent = () => {
        if (isLoading) {
            return (
                <div className="flex h-full items-center justify-center gap-2 text-[var(--ink-muted)]">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="text-sm">加载中...</span>
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
        if (isEditing) {
            return (
                <div className="h-full bg-[var(--paper-reading)]">
                    <MonacoEditor
                        value={editContent}
                        onChange={setEditContent}
                        language={monacoLanguage}
                    />
                </div>
            );
        }

        // Preview mode: Markdown renders as HTML
        if (isMarkdown) {
            return (
                <div className="h-full overflow-auto p-6 bg-[var(--paper-reading)]">
                    <div className="prose prose-stone max-w-none dark:prose-invert">
                        <Markdown>{content}</Markdown>
                    </div>
                </div>
            );
        }

        // Preview mode: Code files with syntax highlighting
        return (
            <div className="h-full overflow-auto bg-[var(--paper-reading)]">
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
                        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                    }}
                    codeTagProps={{
                        style: {
                            fontFamily: 'inherit',
                        }
                    }}
                >
                    {content}
                </SyntaxHighlighter>
            </div>
        );
    };

    return (
        <>
            {/* Modal backdrop */}
            <div
                className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm"
                style={{ padding: '2vh 2vw' }}
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
                        className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4 bg-[var(--paper-reading)]"
                    >
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-bg)]">
                                <FileText className="h-4 w-4 text-[var(--accent)]" />
                            </div>
                            <div className="min-w-0">
                                <div className="truncate text-[13px] font-semibold text-[var(--ink)]">
                                    {name}
                                </div>
                                <div className="text-[11px] text-[var(--ink-muted)]">
                                    {isEditing ? (
                                        hasUnsavedChanges ? '编辑中（未保存）' : '编辑中'
                                    ) : (
                                        `${size.toLocaleString()} bytes`
                                    )}
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
                                        className="inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98]"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                        取消
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleSave}
                                        disabled={isSaving || !hasUnsavedChanges}
                                        className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-all duration-150 hover:bg-[var(--accent-strong)] hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
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
                                    className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--ink)] px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-all duration-150 hover:bg-[var(--ink-strong)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                                >
                                    <Edit2 className="h-3.5 w-3.5" />
                                    编辑
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleClose}
                                className="inline-flex items-center justify-center rounded-md border border-[var(--line-strong)] bg-[var(--paper-button)] px-3 py-1.5 text-[11px] font-semibold text-[var(--ink)] shadow-sm transition-all duration-150 hover:bg-[var(--paper-button-hover)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98]"
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
        </>
    );
}
