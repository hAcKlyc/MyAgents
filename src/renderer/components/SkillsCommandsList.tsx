/**
 * SkillsCommandsList - Component for displaying Skills and Commands list
 *
 * Uses Tab-scoped API when in Tab context (WorkspaceConfigPanel),
 * falls back to global API when not in Tab context (GlobalSkillsPanel in Settings).
 */
import { Plus, Sparkles, Terminal, ChevronRight, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useState, useMemo } from 'react';

import { apiGetJson as globalApiGet, apiPostJson as globalApiPost, apiDelete as globalApiDelete } from '@/api/apiFetch';
import { useTabStateOptional } from '@/context/TabContext';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { SkillItem, CommandItem } from '../../shared/skillsTypes';

interface SkillsCommandsListProps {
    scope: 'user' | 'project';
    agentDir?: string;
    onSelectSkill: (name: string, scope: 'user' | 'project', isNewSkill?: boolean) => void;
    onSelectCommand: (name: string, scope: 'user' | 'project') => void;
    refreshKey?: number;
}

export default function SkillsCommandsList({
    scope,
    agentDir,
    onSelectSkill,
    onSelectCommand,
    refreshKey = 0
}: SkillsCommandsListProps) {
    const toast = useToast();

    // Use Tab-scoped API when available (in project workspace context)
    // Fall back to global API when not in Tab context (Settings page)
    const tabState = useTabStateOptional();

    // Create API functions that use Tab API when available
    const api = useMemo(() => {
        if (tabState) {
            return {
                get: tabState.apiGet,
                post: tabState.apiPost,
                delete: tabState.apiDelete,
            };
        }
        return {
            get: globalApiGet,
            post: globalApiPost,
            delete: globalApiDelete,
        };
    }, [tabState]);
    const [loading, setLoading] = useState(true);
    const [skills, setSkills] = useState<SkillItem[]>([]);
    const [commands, setCommands] = useState<CommandItem[]>([]);
    const [showNewSkillDialog, setShowNewSkillDialog] = useState(false);
    const [showNewCommandDialog, setShowNewCommandDialog] = useState(false);
    const [newItemName, setNewItemName] = useState('');
    const [newItemDescription, setNewItemDescription] = useState('');
    const [creating, setCreating] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<{ type: 'skill' | 'command'; name: string; scope: 'user' | 'project' } | null>(null);
    const [deleting, setDeleting] = useState(false);

    // Load skills and commands
    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [skillsRes, commandsRes] = await Promise.all([
                api.get<{ success: boolean; skills: SkillItem[] }>(`/api/skills?scope=${scope === 'user' ? 'user' : 'all'}`),
                api.get<{ success: boolean; commands: CommandItem[] }>(`/api/command-items?scope=${scope === 'user' ? 'user' : 'all'}`)
            ]);

            if (skillsRes.success) {
                setSkills(skillsRes.skills);
            }
            if (commandsRes.success) {
                setCommands(commandsRes.commands);
            }
        } catch {
            toast.error('加载失败');
        } finally {
            setLoading(false);
        }
    }, [scope, toast, api]);

    useEffect(() => {
        loadData();
    }, [loadData, refreshKey]);


    // 快速创建技能并立即进入编辑模式
    const handleQuickCreateSkill = useCallback(async (tempName: string) => {
        try {
            // When using Tab API, no need to pass agentDir (sidecar already has it)
            // When using global API, pass agentDir for project scope
            const payload = tabState
                ? { name: tempName, scope, description: '' }
                : { name: tempName, scope, description: '', ...(scope === 'project' && agentDir ? { agentDir } : {}) };

            const response = await api.post<{ success: boolean; error?: string; folderName?: string }>('/api/skill/create', payload);
            if (response.success) {
                // 创建成功后直接进入详情页(编辑模式由详情页处理)
                // 使用返回的 folderName（sanitized）而非 tempName
                onSelectSkill(response.folderName || tempName, scope, true);
                loadData();
            } else {
                toast.error(response.error || '创建失败');
            }
        } catch {
            toast.error('创建失败');
        }
    }, [scope, agentDir, toast, loadData, onSelectSkill, api, tabState]);

    // 上传技能文件
    const handleUploadSkill = useCallback(async (file: File) => {
        try {
            // 读取文件为 base64
            const reader = new FileReader();
            reader.onload = async () => {
                const base64Content = (reader.result as string).split(',')[1]; // 去除 data:xxx;base64, 前缀
                try {
                    const response = await api.post<{
                        success: boolean;
                        folderName?: string;
                        message?: string;
                        error?: string;
                    }>('/api/skill/upload', {
                        filename: file.name,
                        content: base64Content,
                        scope
                    });

                    if (response.success) {
                        toast.success(response.message || '技能导入成功');
                        setShowNewSkillDialog(false);
                        loadData();
                        // 进入新创建的技能详情页
                        if (response.folderName) {
                            onSelectSkill(response.folderName, scope, true);
                        }
                    } else {
                        toast.error(response.error || '导入失败');
                    }
                } catch {
                    toast.error('导入失败');
                }
            };
            reader.onerror = () => {
                toast.error('读取文件失败');
            };
            reader.readAsDataURL(file);
        } catch {
            toast.error('上传失败');
        }
    }, [scope, toast, loadData, onSelectSkill, api]);

    const handleCreateCommand = useCallback(async () => {
        if (!newItemName.trim()) return;
        setCreating(true);
        try {
            const response = await api.post<{ success: boolean; error?: string }>('/api/command-item/create', {
                name: newItemName.trim(),
                scope,
                description: newItemDescription.trim() || undefined
            });
            if (response.success) {
                toast.success('指令创建成功');
                setShowNewCommandDialog(false);
                setNewItemName('');
                setNewItemDescription('');
                loadData();
            } else {
                toast.error(response.error || '创建失败');
            }
        } catch {
            toast.error('创建失败');
        } finally {
            setCreating(false);
        }
    }, [newItemName, newItemDescription, scope, toast, loadData, api]);

    const handleDelete = useCallback(async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            const endpoint = deleteTarget.type === 'skill'
                ? `/api/skill/${encodeURIComponent(deleteTarget.name)}?scope=${deleteTarget.scope}`
                : `/api/command-item/${encodeURIComponent(deleteTarget.name)}?scope=${deleteTarget.scope}`;

            const response = await api.delete<{ success: boolean; error?: string }>(endpoint);
            if (response.success) {
                toast.success('删除成功');
                setDeleteTarget(null);
                loadData();
            } else {
                toast.error(response.error || '删除失败');
            }
        } catch {
            toast.error('删除失败');
        } finally {
            setDeleting(false);
        }
    }, [deleteTarget, toast, loadData, api]);

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
            </div>
        );
    }

    const projectSkills = skills.filter(s => s.scope === 'project');
    const userSkills = skills.filter(s => s.scope === 'user');
    const projectCommands = commands.filter(c => c.scope === 'project');
    const userCommands = commands.filter(c => c.scope === 'user');

    return (
        <div className="h-full overflow-auto p-6">
            {/* Skills Section */}
            <div className="mb-8">
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">技能 Skills</h3>
                        <span className="rounded-full bg-[var(--paper-contrast)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                            {skills.length}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowNewSkillDialog(true)}
                        className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        新建
                    </button>
                </div>

                {/* Project Skills */}
                {scope === 'project' && projectSkills.length > 0 && (
                    <div className="mb-4">
                        <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">项目级</h4>
                        <div className="space-y-2">
                            {projectSkills.map(skill => (
                                <SkillCard
                                    key={`${skill.scope}-${skill.folderName}`}
                                    skill={skill}
                                    onClick={() => onSelectSkill(skill.folderName, skill.scope)}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {/* User Skills */}
                {userSkills.length > 0 && (
                    <div>
                        <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">
                            {scope === 'project' ? '用户级 (全局)' : '用户技能'}
                        </h4>
                        <div className="space-y-2">
                            {userSkills.map(skill => (
                                <SkillCard
                                    key={`${skill.scope}-${skill.folderName}`}
                                    skill={skill}
                                    onClick={() => onSelectSkill(skill.folderName, skill.scope)}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {skills.length === 0 && (
                    <EmptyState
                        icon={<Sparkles className="h-12 w-12" />}
                        title="还没有技能"
                        description="创建你的第一个技能来扩展 Claude 的能力"
                    />
                )}
            </div>

            {/* Commands Section */}
            <div>
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Terminal className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">指令 Commands</h3>
                        <span className="rounded-full bg-[var(--paper-contrast)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                            {commands.length}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowNewCommandDialog(true)}
                        className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        新建
                    </button>
                </div>

                {/* Project Commands */}
                {scope === 'project' && projectCommands.length > 0 && (
                    <div className="mb-4">
                        <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">项目级</h4>
                        <div className="space-y-2">
                            {projectCommands.map(cmd => (
                                <CommandCard
                                    key={`${cmd.scope}-${cmd.fileName}`}
                                    command={cmd}
                                    onClick={() => onSelectCommand(cmd.fileName, cmd.scope)}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {/* User Commands */}
                {userCommands.length > 0 && (
                    <div>
                        <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">
                            {scope === 'project' ? '用户级 (全局)' : '用户指令'}
                        </h4>
                        <div className="space-y-2">
                            {userCommands.map(cmd => (
                                <CommandCard
                                    key={`${cmd.scope}-${cmd.fileName}`}
                                    command={cmd}
                                    onClick={() => onSelectCommand(cmd.fileName, cmd.scope)}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {commands.length === 0 && (
                    <EmptyState
                        icon={<Terminal className="h-12 w-12" />}
                        title="还没有指令"
                        description="创建你的第一个指令来定义工作流"
                    />
                )}
            </div>

            {/* New Skill Dialog - Choice Mode */}
            {showNewSkillDialog && (
                <NewSkillChooser
                    onWriteSkill={() => {
                        // 直接进入编辑模式创建新技能
                        setShowNewSkillDialog(false);
                        // 创建临时技能并进入编辑模式
                        const tempName = `new-skill-${Date.now()}`;
                        handleQuickCreateSkill(tempName);
                    }}
                    onUploadSkill={handleUploadSkill}
                    onCancel={() => setShowNewSkillDialog(false)}
                    scope={scope}
                />
            )}

            {/* New Command Dialog */}
            {showNewCommandDialog && (
                <CreateDialog
                    title="新建指令"
                    name={newItemName}
                    description={newItemDescription}
                    onNameChange={setNewItemName}
                    onDescriptionChange={setNewItemDescription}
                    onConfirm={handleCreateCommand}
                    onCancel={() => {
                        setShowNewCommandDialog(false);
                        setNewItemName('');
                        setNewItemDescription('');
                    }}
                    loading={creating}
                />
            )}

            {/* Delete Confirmation */}
            {deleteTarget && (
                <ConfirmDialog
                    title={`删除${deleteTarget.type === 'skill' ? '技能' : '指令'}`}
                    message={`确定要删除「${deleteTarget.name}」吗？此操作无法撤销。`}
                    confirmText="删除"
                    confirmVariant="danger"
                    onConfirm={handleDelete}
                    onCancel={() => setDeleteTarget(null)}
                    loading={deleting}
                />
            )}
        </div>
    );
}

// Skill Card Component
function SkillCard({ skill, onClick }: { skill: SkillItem; onClick: () => void }) {
    return (
        <div
            className="group flex items-center justify-between rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 transition-all hover:border-[var(--line-strong)] hover:shadow-sm cursor-pointer"
            onClick={onClick}
        >
            <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--paper-contrast)]">
                    <Sparkles className="h-5 w-5 text-[var(--ink-muted)]" />
                </div>
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-[var(--ink)]">{skill.name}</span>
                        <span className="shrink-0 rounded bg-[var(--paper-contrast)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
                            skill
                        </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
                        {skill.description || '暂无描述'}
                    </p>
                </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
        </div>
    );
}

// Command Card Component
function CommandCard({ command, onClick }: { command: CommandItem; onClick: () => void }) {
    return (
        <div
            className="group flex items-center justify-between rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 transition-all hover:border-[var(--line-strong)] hover:shadow-sm cursor-pointer"
            onClick={onClick}
        >
            <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--paper-contrast)]">
                    <Terminal className="h-5 w-5 text-[var(--ink-muted)]" />
                </div>
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-[var(--ink)]">{command.name}</span>
                        <span className="shrink-0 rounded bg-[var(--paper-contrast)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
                            command
                        </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
                        {command.description || '暂无描述'}
                    </p>
                </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
        </div>
    );
}

// Empty State Component
function EmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
    return (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-contrast)]/30 py-8">
            <div className="text-[var(--ink-muted)]/30">{icon}</div>
            <p className="mt-3 text-sm font-medium text-[var(--ink-muted)]">{title}</p>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">{description}</p>
        </div>
    );
}

// Create Dialog Component
function CreateDialog({
    title,
    name,
    description,
    onNameChange,
    onDescriptionChange,
    onConfirm,
    onCancel,
    loading
}: {
    title: string;
    name: string;
    description: string;
    onNameChange: (value: string) => void;
    onDescriptionChange: (value: string) => void;
    onConfirm: () => void;
    onCancel: () => void;
    loading: boolean;
}) {
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

// New Skill Chooser Component - 选择创建方式
function NewSkillChooser({
    onWriteSkill,
    onUploadSkill,
    onCancel,
    scope: _scope  // Reserved for future use
}: {
    onWriteSkill: () => void;
    onUploadSkill: (file: File) => void;
    onCancel: () => void;
    scope: 'user' | 'project';
}) {
    const fileInputRef = React.useRef<HTMLInputElement>(null);

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
