/**
 * SkillDialogs - Shared dialog components for Skills & Commands
 * Extracted from SkillsCommandsList and GlobalSkillsPanel to avoid duplication
 */
import React, { useRef, useState } from 'react';
import { Loader2, FolderOpen } from 'lucide-react';
import { isTauriEnvironment } from '@/utils/browserMock';

interface CreateDialogProps {
    title: string;
    name: string;
    description: string;
    onNameChange: (value: string) => void;
    onDescriptionChange: (value: string) => void;
    onConfirm: () => void;
    onCancel: () => void;
    loading: boolean;
}

export function CreateDialog({
    title,
    name,
    description,
    onNameChange,
    onDescriptionChange,
    onConfirm,
    onCancel,
    loading
}: CreateDialogProps) {
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-2xl bg-[var(--paper)] p-6 shadow-2xl">
                <h3 className="text-lg font-semibold text-[var(--ink)]">{title}</h3>
                <div className="mt-4 space-y-4">
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">名称</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => onNameChange(e.target.value)}
                            placeholder="例如：my-skill"
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">描述 (可选)</label>
                        <input
                            type="text"
                            value={description}
                            onChange={(e) => onDescriptionChange(e.target.value)}
                            placeholder="简短描述这个技能/指令的用途"
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                        />
                    </div>
                </div>
                <div className="mt-6 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)]"
                    >
                        取消
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={!name.trim() || loading}
                        className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                    >
                        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                        创建
                    </button>
                </div>
            </div>
        </div>
    );
}

interface NewSkillChooserProps {
    onWriteSkill: () => void;
    onUploadSkill: (file: File) => void;
    /** Import skill from a folder path (Tauri only) */
    onImportFolder?: (folderPath: string) => void;
    onCancel: () => void;
    /** Optional: sync from Claude Code functionality */
    syncConfig?: {
        onSync: () => Promise<void>;
        canSync: boolean;
        syncableCount: number;
    };
}

export function NewSkillChooser({
    onWriteSkill,
    onUploadSkill,
    onImportFolder,
    onCancel,
    syncConfig
}: NewSkillChooserProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [syncing, setSyncing] = useState(false);

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            onUploadSkill(file);
        }
        // Reset input so same file can be selected again
        e.target.value = '';
    };

    const handleFolderClick = async () => {
        if (!onImportFolder) return;

        try {
            // Use Tauri dialog to select folder
            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({
                directory: true,
                multiple: false,
                title: '选择技能文件夹（需包含 SKILL.md）',
            });

            if (selected && typeof selected === 'string') {
                onImportFolder(selected);
            }
        } catch (err) {
            console.error('[SkillDialogs] Failed to open folder dialog:', err);
        }
    };

    const handleSyncClick = async () => {
        if (!syncConfig) return;
        setSyncing(true);
        try {
            await syncConfig.onSync();
        } finally {
            setSyncing(false);
        }
    };

    // Check if folder import is available (Tauri environment + handler provided)
    const canImportFolder = isTauriEnvironment() && !!onImportFolder;

    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-2xl bg-[var(--paper)] p-6 shadow-2xl">
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-[var(--ink)]">新建技能</h3>
                    <button
                        type="button"
                        onClick={onCancel}
                        className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)]"
                    >
                        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                <div className="mt-6 space-y-3">
                    {/* Write Skill Option */}
                    <button
                        type="button"
                        onClick={onWriteSkill}
                        className="group flex w-full items-center gap-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
                    >
                        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--paper-contrast)] transition-colors group-hover:bg-[var(--paper-inset)]">
                            <svg className="h-6 w-6 text-[var(--ink-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                        </div>
                        <div>
                            <div className="font-medium text-[var(--ink)]">直接编写技能</div>
                            <p className="mt-0.5 text-sm text-[var(--ink-muted)]">适合简单易描述的技能</p>
                        </div>
                    </button>

                    {/* Upload Skill Option */}
                    <button
                        type="button"
                        onClick={handleUploadClick}
                        className="group flex w-full items-center gap-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
                    >
                        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--paper-contrast)] transition-colors group-hover:bg-[var(--paper-inset)]">
                            <svg className="h-6 w-6 text-[var(--ink-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="17 8 12 3 7 8" />
                                <line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                        </div>
                        <div>
                            <div className="font-medium text-[var(--ink)]">上传技能</div>
                            <p className="mt-0.5 text-sm text-[var(--ink-muted)]">导入 .zip、.skill 或 .md 文件</p>
                        </div>
                    </button>

                    {/* Import Folder Option - Only show in Tauri environment */}
                    {canImportFolder && (
                        <button
                            type="button"
                            onClick={handleFolderClick}
                            className="group flex w-full items-center gap-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
                        >
                            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--paper-contrast)] transition-colors group-hover:bg-[var(--paper-inset)]">
                                <FolderOpen className="h-6 w-6 text-[var(--ink-muted)]" />
                            </div>
                            <div>
                                <div className="font-medium text-[var(--ink)]">导入文件夹</div>
                                <p className="mt-0.5 text-sm text-[var(--ink-muted)]">选择包含 SKILL.md 的技能文件夹</p>
                            </div>
                        </button>
                    )}

                    {/* Sync from Claude Code Option - Only show when configured and has syncable skills */}
                    {syncConfig?.canSync && (
                        <button
                            type="button"
                            onClick={handleSyncClick}
                            disabled={syncing}
                            className="group flex w-full items-center gap-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm disabled:opacity-50"
                        >
                            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--paper-contrast)] transition-colors group-hover:bg-[var(--paper-inset)]">
                                {syncing ? (
                                    <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                                ) : (
                                    <svg className="h-6 w-6 text-[var(--ink-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                    </svg>
                                )}
                            </div>
                            <div>
                                <div className="font-medium text-[var(--ink)]">
                                    从 Claude Code 同步
                                    <span className="ml-2 text-xs text-[var(--ink-muted)]">({syncConfig.syncableCount} 个可同步)</span>
                                </div>
                                <p className="mt-0.5 text-sm text-[var(--ink-muted)]">导入 ~/.claude/skills 中的技能</p>
                            </div>
                        </button>
                    )}

                    {/* Hidden file input */}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".zip,.skill,.md"
                        onChange={handleFileChange}
                        className="hidden"
                    />
                </div>
            </div>
        </div>
    );
}
