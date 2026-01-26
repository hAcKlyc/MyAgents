/**
 * GlobalSkillsPanel - User-level Skills & Commands management for Settings page
 * Refactored to reuse SkillDetailPanel and CommandDetailPanel for consistent UX
 */
import { Plus, Sparkles, Terminal, ChevronRight, Loader2, ChevronLeft } from 'lucide-react';
import React, { useCallback, useEffect, useState, useRef } from 'react';

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';
import SkillDetailPanel from './SkillDetailPanel';
import type { SkillDetailPanelRef } from './SkillDetailPanel';
import CommandDetailPanel from './CommandDetailPanel';
import type { CommandDetailPanelRef } from './CommandDetailPanel';
import type { SkillItem, CommandItem } from '../../shared/skillsTypes';

type ViewState =
    | { type: 'list' }
    | { type: 'skill-detail'; name: string; isNewSkill?: boolean }
    | { type: 'command-detail'; name: string };

export default function GlobalSkillsPanel() {
    const toast = useToast();
    const [viewState, setViewState] = useState<ViewState>({ type: 'list' });
    const [loading, setLoading] = useState(true);
    const [skills, setSkills] = useState<SkillItem[]>([]);
    const [commands, setCommands] = useState<CommandItem[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);

    // Refs for checking editing state
    const skillDetailRef = useRef<SkillDetailPanelRef>(null);
    const commandDetailRef = useRef<CommandDetailPanelRef>(null);

    // Dialog states
    const [showNewSkillDialog, setShowNewSkillDialog] = useState(false);
    const [showNewCommandDialog, setShowNewCommandDialog] = useState(false);
    const [newItemName, setNewItemName] = useState('');
    const [newItemDescription, setNewItemDescription] = useState('');
    const [creating, setCreating] = useState(false);

    // Sync from Claude Code state
    const [canSyncFromClaude, setCanSyncFromClaude] = useState(false);
    const [syncableCount, setSyncableCount] = useState(0);

    // Check if any child is in editing mode
    const isAnyEditing = useCallback(() => {
        if (viewState.type === 'skill-detail' && skillDetailRef.current?.isEditing()) {
            return true;
        }
        if (viewState.type === 'command-detail' && commandDetailRef.current?.isEditing()) {
            return true;
        }
        return false;
    }, [viewState]);

    // Load skills and commands
    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [skillsRes, commandsRes, syncCheckRes] = await Promise.all([
                apiGetJson<{ success: boolean; skills: SkillItem[] }>('/api/skills?scope=user'),
                apiGetJson<{ success: boolean; commands: CommandItem[] }>('/api/command-items?scope=user'),
                apiGetJson<{ canSync: boolean; count: number; folders: string[] }>('/api/skill/sync-check')
            ]);

            if (skillsRes.success) setSkills(skillsRes.skills);
            if (commandsRes.success) setCommands(commandsRes.commands);

            // Update sync state (with defensive checks for API errors)
            setCanSyncFromClaude(syncCheckRes?.canSync ?? false);
            setSyncableCount(syncCheckRes?.count ?? 0);
        } catch {
            toast.error('加载失败');
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        loadData();
    }, [loadData, refreshKey]);

    const handleBackToList = useCallback(() => {
        if (isAnyEditing()) {
            toast.warning('请先保存或取消编辑');
            return;
        }
        setViewState({ type: 'list' });
    }, [isAnyEditing, toast]);


    // 快速创建技能并进入编辑模式
    const handleQuickCreateSkill = useCallback(async (tempName: string) => {
        try {
            const response = await apiPostJson<{ success: boolean; error?: string; folderName?: string }>('/api/skill/create', {
                name: tempName,
                scope: 'user',
                description: ''
            });
            if (response.success) {
                // 使用返回的 folderName（sanitized）而非 tempName
                setViewState({ type: 'skill-detail', name: response.folderName || tempName, isNewSkill: true });
                setRefreshKey(k => k + 1);
            } else {
                toast.error(response.error || '创建失败');
            }
        } catch {
            toast.error('创建失败');
        }
    }, [toast]);

    // 从 Claude Code 同步技能
    const handleSyncFromClaude = useCallback(async () => {
        try {
            const response = await apiPostJson<{
                success: boolean;
                synced: number;
                failed: number;
                errors?: string[];
            }>('/api/skill/sync-from-claude', {});

            if (response.success) {
                if (response.failed > 0) {
                    toast.warning(`成功 ${response.synced} 个，失败 ${response.failed} 个`);
                } else if (response.synced > 0) {
                    toast.success(`成功同步 ${response.synced} 个技能`);
                } else {
                    toast.info('没有可同步的技能');
                }
                setShowNewSkillDialog(false);
                setRefreshKey(k => k + 1);
            } else {
                toast.error('同步失败');
            }
        } catch {
            toast.error('同步失败');
        }
    }, [toast]);

    // 上传技能文件
    const handleUploadSkill = useCallback(async (file: File) => {
        try {
            const reader = new FileReader();
            reader.onload = async () => {
                const base64Content = (reader.result as string).split(',')[1];
                try {
                    const response = await apiPostJson<{
                        success: boolean;
                        folderName?: string;
                        message?: string;
                        error?: string;
                    }>('/api/skill/upload', {
                        filename: file.name,
                        content: base64Content,
                        scope: 'user'
                    });

                    if (response.success) {
                        toast.success(response.message || '技能导入成功');
                        setShowNewSkillDialog(false);
                        setRefreshKey(k => k + 1);
                        if (response.folderName) {
                            setViewState({ type: 'skill-detail', name: response.folderName });
                        }
                    } else {
                        toast.error(response.error || '导入失败');
                    }
                } catch {
                    toast.error('导入失败');
                }
            };
            reader.onerror = () => toast.error('读取文件失败');
            reader.readAsDataURL(file);
        } catch {
            toast.error('上传失败');
        }
    }, [toast]);

    const handleCreateCommand = useCallback(async () => {
        if (!newItemName.trim()) return;
        setCreating(true);
        try {
            const response = await apiPostJson<{ success: boolean; error?: string }>('/api/command-item/create', {
                name: newItemName.trim(),
                scope: 'user',
                description: newItemDescription.trim() || undefined
            });
            if (response.success) {
                toast.success('指令创建成功');
                setShowNewCommandDialog(false);
                setNewItemName('');
                setNewItemDescription('');
                setRefreshKey(k => k + 1);
            } else {
                toast.error(response.error || '创建失败');
            }
        } catch {
            toast.error('创建失败');
        } finally {
            setCreating(false);
        }
    }, [newItemName, newItemDescription, toast]);

    const handleItemSaved = useCallback((autoClose?: boolean) => {
        setRefreshKey(k => k + 1);
        if (autoClose) {
            setViewState({ type: 'list' });
        }
    }, []);

    const handleItemDeleted = useCallback(() => {
        setViewState({ type: 'list' });
        setRefreshKey(k => k + 1);
    }, []);

    if (loading && viewState.type === 'list') {
        return (
            <div className="flex h-64 items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
            </div>
        );
    }

    // Skill Detail View - Reuse SkillDetailPanel
    if (viewState.type === 'skill-detail') {
        return (
            <div className="mx-auto max-w-3xl space-y-4">
                <button
                    onClick={handleBackToList}
                    className="flex items-center gap-1 text-sm text-[var(--ink-muted)] hover:text-[var(--ink)]"
                >
                    <ChevronLeft className="h-4 w-4" />
                    返回列表
                </button>
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] overflow-hidden" style={{ minHeight: '500px' }}>
                    <SkillDetailPanel
                        ref={skillDetailRef}
                        name={viewState.name}
                        scope="user"
                        onBack={handleBackToList}
                        onSaved={handleItemSaved}
                        onDeleted={handleItemDeleted}
                        startInEditMode={viewState.isNewSkill}
                    />
                </div>
            </div>
        );
    }

    // Command Detail View - Reuse CommandDetailPanel
    if (viewState.type === 'command-detail') {
        return (
            <div className="mx-auto max-w-3xl space-y-4">
                <button
                    onClick={handleBackToList}
                    className="flex items-center gap-1 text-sm text-[var(--ink-muted)] hover:text-[var(--ink)]"
                >
                    <ChevronLeft className="h-4 w-4" />
                    返回列表
                </button>
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] overflow-hidden" style={{ minHeight: '400px' }}>
                    <CommandDetailPanel
                        ref={commandDetailRef}
                        name={viewState.name}
                        scope="user"
                        onBack={handleBackToList}
                        onSaved={handleItemSaved}
                        onDeleted={handleItemDeleted}
                    />
                </div>
            </div>
        );
    }

    // List View
    return (
        <div className="mx-auto max-w-3xl space-y-8">
            {/* Skills Section */}
            <div>
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">用户技能</h3>
                        <span className="text-xs text-[var(--ink-muted)]">({skills.length})</span>
                    </div>
                    <button
                        onClick={() => setShowNewSkillDialog(true)}
                        className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        新建
                    </button>
                </div>
                {skills.length > 0 ? (
                    <div className="space-y-2">
                        {skills.map(skill => (
                            <div
                                key={skill.folderName}
                                onClick={() => setViewState({ type: 'skill-detail', name: skill.folderName })}
                                className="group flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
                            >
                                <div className="flex min-w-0 flex-1 items-center gap-3">
                                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--paper-contrast)]">
                                        <Sparkles className="h-4 w-4 text-[var(--ink-muted)]" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate font-medium text-[var(--ink)]">{skill.name}</div>
                                        <p className="truncate text-xs text-[var(--ink-muted)]">{skill.description || '暂无描述'}</p>
                                    </div>
                                </div>
                                <ChevronRight className="h-4 w-4 flex-shrink-0 text-[var(--ink-muted)]" />
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-contrast)]/30 py-8 text-center">
                        <Sparkles className="mx-auto h-10 w-10 text-[var(--ink-muted)]/30" />
                        <p className="mt-2 text-sm text-[var(--ink-muted)]">还没有用户技能</p>
                    </div>
                )}
            </div>

            {/* Commands Section */}
            <div>
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Terminal className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">用户指令</h3>
                        <span className="text-xs text-[var(--ink-muted)]">({commands.length})</span>
                    </div>
                    <button
                        onClick={() => setShowNewCommandDialog(true)}
                        className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        新建
                    </button>
                </div>
                {commands.length > 0 ? (
                    <div className="space-y-2">
                        {commands.map(cmd => (
                            <div
                                key={cmd.fileName}
                                onClick={() => setViewState({ type: 'command-detail', name: cmd.fileName })}
                                className="group flex cursor-pointer items-center justify-between rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
                            >
                                <div className="flex min-w-0 flex-1 items-center gap-3">
                                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--paper-contrast)]">
                                        <Terminal className="h-4 w-4 text-[var(--ink-muted)]" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate font-medium text-[var(--ink)]">{cmd.name}</div>
                                        <p className="truncate text-xs text-[var(--ink-muted)]">{cmd.description || '暂无描述'}</p>
                                    </div>
                                </div>
                                <ChevronRight className="h-4 w-4 flex-shrink-0 text-[var(--ink-muted)]" />
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-contrast)]/30 py-8 text-center">
                        <Terminal className="mx-auto h-10 w-10 text-[var(--ink-muted)]/30" />
                        <p className="mt-2 text-sm text-[var(--ink-muted)]">还没有用户指令</p>
                    </div>
                )}
            </div>

            {/* Dialogs */}
            {showNewSkillDialog && (
                <NewSkillChooser
                    onWriteSkill={() => {
                        setShowNewSkillDialog(false);
                        const tempName = `new-skill-${Date.now()}`;
                        handleQuickCreateSkill(tempName);
                    }}
                    onUploadSkill={handleUploadSkill}
                    onSyncFromClaude={handleSyncFromClaude}
                    canSyncFromClaude={canSyncFromClaude}
                    syncableCount={syncableCount}
                    onCancel={() => setShowNewSkillDialog(false)}
                    scope="user"
                />
            )}
            {showNewCommandDialog && (
                <CreateDialog
                    title="新建指令"
                    name={newItemName}
                    description={newItemDescription}
                    onNameChange={setNewItemName}
                    onDescriptionChange={setNewItemDescription}
                    onConfirm={handleCreateCommand}
                    onCancel={() => { setShowNewCommandDialog(false); setNewItemName(''); setNewItemDescription(''); }}
                    loading={creating}
                />
            )}

            <p className="text-center text-xs text-[var(--ink-muted)]">
                用户技能和指令存储在 ~/.myagents/ 目录下，对所有项目生效
            </p>
        </div>
    );
}

function CreateDialog({
    title, name, description, onNameChange, onDescriptionChange, onConfirm, onCancel, loading
}: {
    title: string; name: string; description: string;
    onNameChange: (v: string) => void; onDescriptionChange: (v: string) => void;
    onConfirm: () => void; onCancel: () => void; loading: boolean;
}) {
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-2xl bg-[var(--paper)] p-6 shadow-2xl">
                <h3 className="text-lg font-semibold text-[var(--ink)]">{title}</h3>
                <div className="mt-4 space-y-4">
                    <div>
                        <label className="mb-1 block text-sm font-medium">名称</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => onNameChange(e.target.value)}
                            placeholder="例如：my-skill"
                            className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-sm font-medium">描述 (可选)</label>
                        <input
                            type="text"
                            value={description}
                            onChange={(e) => onDescriptionChange(e.target.value)}
                            placeholder="简短描述"
                            className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
                        />
                    </div>
                </div>
                <div className="mt-6 flex justify-end gap-3">
                    <button onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)]">取消</button>
                    <button
                        onClick={onConfirm}
                        disabled={!name.trim() || loading}
                        className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                    >
                        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                        创建
                    </button>
                </div>
            </div>
        </div>
    );
}

// New Skill Chooser Component - 选择创建方式
function NewSkillChooser({
    onWriteSkill,
    onUploadSkill,
    onSyncFromClaude,
    canSyncFromClaude,
    syncableCount,
    onCancel,
    scope: _scope  // Reserved for future use
}: {
    onWriteSkill: () => void;
    onUploadSkill: (file: File) => void;
    onSyncFromClaude: () => void;
    canSyncFromClaude: boolean;
    syncableCount: number;
    onCancel: () => void;
    scope: 'user' | 'project';
}) {
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const [syncing, setSyncing] = React.useState(false);

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            onUploadSkill(file);
        }
        e.target.value = '';
    };

    const handleSyncClick = async () => {
        setSyncing(true);
        try {
            await onSyncFromClaude();
        } finally {
            setSyncing(false);
        }
    };

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

                    {/* Sync from Claude Code Option - Only show when there are syncable skills */}
                    {canSyncFromClaude && (
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
                                    <span className="ml-2 text-xs text-[var(--ink-muted)]">({syncableCount} 个可同步)</span>
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
