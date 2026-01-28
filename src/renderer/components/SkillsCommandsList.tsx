/**
 * SkillsCommandsList - Component for displaying Skills and Commands list
 *
 * Uses Tab-scoped API when in Tab context (WorkspaceConfigPanel),
 * falls back to global API when not in Tab context (GlobalSkillsPanel in Settings).
 */
import { Plus, Sparkles, Terminal, ChevronRight, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState, useMemo, useRef } from 'react';

import { apiGetJson as globalApiGet, apiPostJson as globalApiPost, apiDelete as globalApiDelete } from '@/api/apiFetch';
import { useTabStateOptional } from '@/context/TabContext';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import { CreateDialog, NewSkillChooser } from './SkillDialogs';
import type { SkillItem, CommandItem } from '../../shared/skillsTypes';
import { CUSTOM_EVENTS } from '../../shared/constants';

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
    // Stabilize toast reference to avoid unnecessary effect re-runs
    const toastRef = useRef(toast);
    toastRef.current = toast;

    // Use Tab-scoped API when available (in project workspace context)
    // Fall back to global API when not in Tab context (Settings page)
    const tabState = useTabStateOptional();

    // Create stable API functions - only depend on the specific functions, not the whole tabState
    // This prevents re-creating the api object when unrelated tabState properties change
    const apiGet = tabState?.apiGet;
    const apiPost = tabState?.apiPost;
    const apiDeleteFn = tabState?.apiDelete;

    const api = useMemo(() => {
        if (apiGet && apiPost && apiDeleteFn) {
            return { get: apiGet, post: apiPost, delete: apiDeleteFn };
        }
        return { get: globalApiGet, post: globalApiPost, delete: globalApiDelete };
    }, [apiGet, apiPost, apiDeleteFn]);

    // Track if we're in tab context (stable boolean that won't change)
    const isInTabContext = !!tabState;
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
            toastRef.current.error('加载失败');
        } finally {
            setLoading(false);
        }
    }, [scope, api]);

    useEffect(() => {
        loadData();
    }, [loadData, refreshKey]);


    // 快速创建技能并立即进入编辑模式
    const handleQuickCreateSkill = useCallback(async (tempName: string) => {
        try {
            // When using Tab API, no need to pass agentDir (sidecar already has it)
            // When using global API, pass agentDir for project scope
            const payload = isInTabContext
                ? { name: tempName, scope, description: '' }
                : { name: tempName, scope, description: '', ...(scope === 'project' && agentDir ? { agentDir } : {}) };

            const response = await api.post<{ success: boolean; error?: string; folderName?: string }>('/api/skill/create', payload);
            if (response.success) {
                // 创建成功后直接进入详情页(编辑模式由详情页处理)
                // 使用返回的 folderName（sanitized）而非 tempName
                onSelectSkill(response.folderName || tempName, scope, true);
                loadData();
                // Notify SimpleChatInput to refresh slash commands
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, { detail: { skillName: response.folderName || tempName } }));
            } else {
                toastRef.current.error(response.error || '创建失败');
            }
        } catch {
            toastRef.current.error('创建失败');
        }
    }, [scope, agentDir, loadData, onSelectSkill, api, isInTabContext]);

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
                        toastRef.current.success(response.message || '技能导入成功');
                        setShowNewSkillDialog(false);
                        loadData();
                        // 进入新创建的技能详情页
                        if (response.folderName) {
                            onSelectSkill(response.folderName, scope, true);
                        }
                        // Notify SimpleChatInput to refresh slash commands
                        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, { detail: { skillName: response.folderName } }));
                    } else {
                        toastRef.current.error(response.error || '导入失败');
                    }
                } catch {
                    toastRef.current.error('导入失败');
                }
            };
            reader.onerror = () => {
                toastRef.current.error('读取文件失败');
            };
            reader.readAsDataURL(file);
        } catch {
            toastRef.current.error('上传失败');
        }
    }, [scope, loadData, onSelectSkill, api]);

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
                toastRef.current.success('指令创建成功');
                setShowNewCommandDialog(false);
                setNewItemName('');
                setNewItemDescription('');
                loadData();
            } else {
                toastRef.current.error(response.error || '创建失败');
            }
        } catch {
            toastRef.current.error('创建失败');
        } finally {
            setCreating(false);
        }
    }, [newItemName, newItemDescription, scope, loadData, api]);

    const handleDelete = useCallback(async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            const endpoint = deleteTarget.type === 'skill'
                ? `/api/skill/${encodeURIComponent(deleteTarget.name)}?scope=${deleteTarget.scope}`
                : `/api/command-item/${encodeURIComponent(deleteTarget.name)}?scope=${deleteTarget.scope}`;

            const response = await api.delete<{ success: boolean; error?: string }>(endpoint);
            if (response.success) {
                toastRef.current.success('删除成功');
                setDeleteTarget(null);
                loadData();
            } else {
                toastRef.current.error(response.error || '删除失败');
            }
        } catch {
            toastRef.current.error('删除失败');
        } finally {
            setDeleting(false);
        }
    }, [deleteTarget, loadData, api]);

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

// CreateDialog and NewSkillChooser are imported from SkillDialogs.tsx
