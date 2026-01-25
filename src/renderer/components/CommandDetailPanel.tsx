/**
 * CommandDetailPanel - Component for viewing and editing a Command
 * Supports preview/edit mode with save confirmation and file rename
 */
import { Save, FolderOpen, Loader2, Trash2, Edit2, X } from 'lucide-react';
import { useCallback, useEffect, useState, useImperativeHandle, forwardRef } from 'react';

import { apiGetJson, apiPutJson, apiDelete, apiPostJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { CommandFrontmatter, CommandDetail } from '../../shared/skillsTypes';
import { sanitizeFolderName } from '../../shared/utils';

interface CommandDetailPanelProps {
    name: string;
    scope: 'user' | 'project';
    onBack: () => void;
    /** 保存成功回调，autoClose 为 true 时父组件应关闭详情视图 */
    onSaved: (autoClose?: boolean) => void;
    onDeleted: () => void;
    /** 项目目录，用于 scope='project' 时的文件操作 */
    agentDir?: string;
}

export interface CommandDetailPanelRef {
    isEditing: () => boolean;
}

const CommandDetailPanel = forwardRef<CommandDetailPanelRef, CommandDetailPanelProps>(
    function CommandDetailPanel({ name, scope, onBack: _onBack, onSaved, onDeleted, agentDir }, ref) {
        const toast = useToast();
        const [loading, setLoading] = useState(true);
        const [saving, setSaving] = useState(false);
        const [command, setCommand] = useState<CommandDetail | null>(null);
        const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
        const [deleting, setDeleting] = useState(false);
        const [isEditing, setIsEditing] = useState(false);

        // Original values for comparison
        const [originalCommandName, setOriginalCommandName] = useState('');
        const [originalDescription, setOriginalDescription] = useState('');
        const [originalBody, setOriginalBody] = useState('');

        // Editable fields
        const [commandName, setCommandName] = useState('');
        const [description, setDescription] = useState('');
        const [body, setBody] = useState('');

        // Expose isEditing to parent
        useImperativeHandle(ref, () => ({
            isEditing: () => isEditing
        }), [isEditing]);

        // Load command data
        useEffect(() => {
            const loadCommand = async () => {
                setLoading(true);
                try {
                    // Include agentDir for project scope to ensure correct path resolution
                    const agentDirParam = scope === 'project' && agentDir ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                    const response = await apiGetJson<{ success: boolean; command: CommandDetail; error?: string }>(
                        `/api/command-item/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`
                    );
                    if (response.success && response.command) {
                        setCommand(response.command);
                        const cmdName = response.command.name || name;
                        const desc = response.command.frontmatter.description || '';
                        const bd = response.command.body || '';
                        setCommandName(cmdName);
                        setOriginalCommandName(cmdName);
                        setDescription(desc);
                        setBody(bd);
                        setOriginalDescription(desc);
                        setOriginalBody(bd);
                    } else {
                        toast.error(response.error || '加载失败');
                    }
                } catch {
                    toast.error('加载失败');
                } finally {
                    setLoading(false);
                }
            };
            loadCommand();
        }, [name, scope, agentDir, toast]);

        const handleEdit = useCallback(() => {
            setIsEditing(true);
        }, []);

        const handleCancel = useCallback(() => {
            setCommandName(originalCommandName);
            setDescription(originalDescription);
            setBody(originalBody);
            setIsEditing(false);
        }, [originalCommandName, originalDescription, originalBody]);

        // Get the expected new file name based on current command name
        const expectedFileName = commandName.trim() ? sanitizeFolderName(commandName.trim()) : '';

        const handleSave = useCallback(async () => {
            if (!command) return;
            if (!commandName.trim()) {
                toast.error('指令名称不能为空');
                return;
            }
            setSaving(true);
            try {
                const frontmatter: Partial<CommandFrontmatter> = {
                    description,
                };

                // Check if file should be renamed (based on sanitized command name)
                const newFileName = sanitizeFolderName(commandName.trim());
                const currentFileName = name; // Original file name (without .md)
                const shouldRename = newFileName && newFileName !== currentFileName;

                const response = await apiPutJson<{
                    success: boolean;
                    error?: string;
                    fileName?: string;
                    path?: string;
                }>(
                    `/api/command-item/${encodeURIComponent(name)}`,
                    {
                        scope,
                        frontmatter,
                        body,
                        ...(shouldRename ? { newFileName } : {}),
                        ...(scope === 'project' && agentDir ? { agentDir } : {})
                    }
                );

                if (response.success) {
                    toast.success('保存成功');

                    // If file was renamed, always close detail view (name prop is now invalid)
                    const fileWasRenamed = response.fileName && response.fileName !== currentFileName;
                    if (fileWasRenamed) {
                        onSaved(true); // Auto-close when file renamed
                        return;
                    }

                    // Update command state with new path if file was renamed
                    if (response.fileName && response.path) {
                        setCommand(prev => prev ? {
                            ...prev,
                            name: response.fileName!,
                            path: response.path!
                        } : null);
                    }

                    // Update original values
                    setOriginalCommandName(commandName.trim());
                    setOriginalDescription(description);
                    setOriginalBody(body);
                    setIsEditing(false);
                    onSaved();
                } else {
                    toast.error(response.error || '保存失败');
                }
            } catch {
                toast.error('保存失败');
            } finally {
                setSaving(false);
            }
        }, [command, name, scope, agentDir, commandName, description, body, toast, onSaved]);

        const handleDelete = useCallback(async () => {
            setDeleting(true);
            try {
                const agentDirParam = scope === 'project' && agentDir ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                const response = await apiDelete<{ success: boolean; error?: string }>(
                    `/api/command-item/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`
                );
                if (response.success) {
                    toast.success('删除成功');
                    onDeleted();
                } else {
                    toast.error(response.error || '删除失败');
                }
            } catch {
                toast.error('删除失败');
            } finally {
                setDeleting(false);
                setShowDeleteConfirm(false);
            }
        }, [name, scope, agentDir, toast, onDeleted]);

        const handleOpenInFinder = useCallback(async () => {
            if (!command) return;
            try {
                // Use full path from command.path which is already correctly resolved by backend
                await apiPostJson('/agent/open-path', { fullPath: command.path });
            } catch {
                toast.error('无法打开目录');
            }
        }, [command, toast]);

        if (loading) {
            return (
                <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
                </div>
            );
        }

        if (!command) {
            return (
                <div className="flex h-full items-center justify-center">
                    <p className="text-sm text-[var(--ink-muted)]">指令不存在</p>
                </div>
            );
        }

        // Calculate preview path based on edited command name
        const pathChanged = isEditing && !!expectedFileName && expectedFileName !== name;
        const previewPath = pathChanged
            ? command.path.replace(`${name}.md`, `${expectedFileName}.md`)
            : command.path;

        return (
            <div className="flex h-full flex-col">
                {/* Header */}
                <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--paper-contrast)]/50 px-6 py-2">
                    <div className="min-w-0 flex-1">
                        <h3 className="text-base font-semibold text-[var(--ink)]">/{commandName || name}</h3>
                        <div className="mt-0.5 flex items-center gap-2">
                            <span
                                className={`max-w-[300px] truncate font-mono text-xs ${pathChanged ? 'text-[var(--accent)]' : 'text-[var(--ink-muted)]'}`}
                                title={previewPath}
                            >
                                {previewPath}
                            </span>
                            {pathChanged && (
                                <span className="text-xs text-[var(--accent)]">(将重命名)</span>
                            )}
                            <button
                                type="button"
                                onClick={handleOpenInFinder}
                                disabled={pathChanged}
                                className="flex-shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)] disabled:opacity-50 disabled:cursor-not-allowed"
                                title={pathChanged ? "保存后可打开新位置" : "在 Finder 中打开"}
                            >
                                <FolderOpen className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {isEditing ? (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setShowDeleteConfirm(true)}
                                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                                >
                                    <Trash2 className="h-4 w-4" />
                                    删除
                                </button>
                                <button
                                    type="button"
                                    onClick={handleCancel}
                                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)]"
                                >
                                    <X className="h-4 w-4" />
                                    取消
                                </button>
                                <button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-4 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                                >
                                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                    保存
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                onClick={handleEdit}
                                className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-1.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-contrast)]"
                            >
                                <Edit2 className="h-4 w-4" />
                                编辑
                            </button>
                        )}
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-auto p-6">
                    <div className="mx-auto max-w-2xl space-y-6">
                        {/* Command Name (editable) */}
                        <div>
                            <label className="mb-2 block text-sm font-medium text-[var(--ink)]">名称</label>
                            {isEditing ? (
                                <input
                                    type="text"
                                    value={commandName}
                                    onChange={(e) => setCommandName(e.target.value)}
                                    placeholder="为指令起一个名字"
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                                />
                            ) : (
                                <div
                                    onClick={handleEdit}
                                    className="w-full cursor-pointer rounded-lg border border-[var(--line)] bg-[var(--paper-contrast)]/30 px-4 py-2.5 text-sm transition-colors hover:border-[var(--ink-muted)]/50"
                                >
                                    {commandName ? (
                                        <span className="text-[var(--ink)]">/{commandName}</span>
                                    ) : (
                                        <span className="text-[var(--ink-muted)]/60">点击编辑名称...</span>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Description */}
                        <div>
                            <label className="mb-2 block text-sm font-medium text-[var(--ink)]">描述</label>
                            {isEditing ? (
                                <input
                                    type="text"
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    placeholder="描述这个指令是做什么的"
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                                />
                            ) : (
                                <div
                                    onClick={handleEdit}
                                    className="w-full cursor-pointer rounded-lg border border-[var(--line)] bg-[var(--paper-contrast)]/30 px-4 py-2.5 text-sm transition-colors hover:border-[var(--ink-muted)]/50"
                                >
                                    {description ? (
                                        <span className="text-[var(--ink)]">{description}</span>
                                    ) : (
                                        <span className="text-[var(--ink-muted)]/60">点击编辑描述...</span>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Instructions */}
                        <div>
                            <label className="mb-2 block text-sm font-medium text-[var(--ink)]">指令内容 (Instructions)</label>
                            {isEditing ? (
                                <textarea
                                    value={body}
                                    onChange={(e) => setBody(e.target.value)}
                                    placeholder="在这里编写指令的详细内容..."
                                    rows={16}
                                    className="w-full resize-none rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3 font-mono text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                                />
                            ) : (
                                <div
                                    onClick={handleEdit}
                                    className="min-h-[300px] w-full cursor-pointer rounded-lg border border-[var(--line)] bg-[var(--paper-contrast)]/30 px-4 py-3 font-mono text-sm transition-colors hover:border-[var(--ink-muted)]/50"
                                >
                                    {body ? (
                                        <pre className="m-0 whitespace-pre-wrap text-[var(--ink)]">{body}</pre>
                                    ) : (
                                        <span className="text-[var(--ink-muted)]/60">点击编辑指令内容...</span>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Delete Confirmation */}
                {showDeleteConfirm && (
                    <ConfirmDialog
                        title="删除指令"
                        message={`确定要删除「/${commandName}」吗？此操作无法撤销。`}
                        confirmText="删除"
                        confirmVariant="danger"
                        onConfirm={handleDelete}
                        onCancel={() => setShowDeleteConfirm(false)}
                        loading={deleting}
                    />
                )}
            </div>
        );
    });

export default CommandDetailPanel;
