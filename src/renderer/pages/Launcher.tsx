/**
 * Launcher - Main entry page for MyAgents
 * Two-column layout: Brand section (left 60%) + Workspaces (right 40%)
 * Responsive: stacks vertically below 768px
 */

import { FolderOpen, Loader2, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

import { apiGetJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import PathInputDialog from '@/components/PathInputDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import { BrandSection, QuickAccess, RecentTasks, WorkspaceCard } from '@/components/launcher';
import { useConfig } from '@/hooks/useConfig';
import { type Project, type Provider } from '@/config/types';
import { isBrowserDevMode, pickFolderForDialog } from '@/utils/browserMock';
import type { SessionMetadata } from '@/api/sessionClient';

import type { SubscriptionStatus } from '@/types/subscription';

interface LauncherProps {
    onLaunchProject: (project: Project, provider: Provider, sessionId?: string) => void;
    isStarting?: boolean;
    startError?: string | null;
    /** Callback to open Settings tab with optional initial section */
    onOpenSettings?: (initialSection?: string) => void;
}

export default function Launcher({ onLaunchProject, isStarting, startError, onOpenSettings }: LauncherProps) {
    const toast = useToast();
    const {
        config,
        projects,
        providers,
        isLoading,
        error,
        addProject,
        updateProject,
        removeProject,
        touchProject,
        apiKeys,
        refreshProviderData,
    } = useConfig();
    const [addError, setAddError] = useState<string | null>(null);
    const [activeMenuProjectId, setActiveMenuProjectId] = useState<string | null>(null);
    const [launchingProjectId, setLaunchingProjectId] = useState<string | null>(null);
    const [showLogs, setShowLogs] = useState(false);
    const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
    const [projectToRemove, setProjectToRemove] = useState<Project | null>(null);

    // Check subscription status on mount
    useEffect(() => {
        let retryCount = 0;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let isMounted = true;
        const maxRetries = 3;
        const retryDelay = 1000;

        const checkSubscription = () => {
            apiGetJson<SubscriptionStatus>('/api/subscription/status')
                .then((status) => {
                    if (isMounted) setSubscriptionStatus(status);
                })
                .catch((err) => {
                    if (!isMounted) return;
                    if (retryCount < maxRetries) {
                        retryCount++;
                        timeoutId = setTimeout(checkSubscription, retryDelay);
                    } else {
                        console.error('[Launcher] Failed to check subscription:', err);
                        setSubscriptionStatus({ available: false });
                    }
                });
        };

        checkSubscription();

        return () => {
            isMounted = false;
            if (timeoutId) clearTimeout(timeoutId);
        };
    }, []);

    // Path input dialog state (for browser dev mode)
    const [pathDialogOpen, setPathDialogOpen] = useState(false);
    const [pendingFolderName, setPendingFolderName] = useState('');
    const [pendingDefaultPath, setPendingDefaultPath] = useState('');

    const handleUpdateProject = async (updated: Project) => {
        await updateProject(updated);
    };

    const handleLaunch = (project: Project, sessionId?: string) => {
        setLaunchingProjectId(project.id);
        const providerId = project.providerId ?? config.defaultProviderId;
        const provider = providers.find((p) => p.id === providerId) ?? providers[0];
        // Update lastOpened timestamp (async, don't block launch)
        touchProject(project.id).catch((err) => {
            console.warn('[Launcher] Failed to update lastOpened:', err);
        });
        onLaunchProject(project, provider, sessionId);
    };

    const handleOpenTask = (session: SessionMetadata, project: Project) => {
        handleLaunch(project, session.id);
    };

    const handleAddProject = async () => {
        setAddError(null);
        console.log('[Launcher] handleAddProject called');

        try {
            if (isBrowserDevMode()) {
                const folderInfo = await pickFolderForDialog();
                if (folderInfo) {
                    setPendingFolderName(folderInfo.folderName);
                    setPendingDefaultPath(folderInfo.defaultPath);
                    setPathDialogOpen(true);
                } else {
                    console.log('[Launcher] Folder picker cancelled');
                }
            } else {
                const selected = await open({
                    directory: true,
                    multiple: false,
                    title: '选择项目文件夹',
                });
                console.log('[Launcher] Dialog result:', selected);

                if (selected && typeof selected === 'string') {
                    console.log('[Launcher] Adding project:', selected);
                    const project = await addProject(selected);
                    console.log('[Launcher] Project added:', project);
                } else {
                    console.log('[Launcher] No folder selected or dialog cancelled');
                }
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[Launcher] Failed to add project:', errorMsg);
            setAddError(errorMsg);
            toast.error(`添加项目失败: ${errorMsg}`);
        }
    };

    const handlePathConfirm = async (path: string) => {
        setPathDialogOpen(false);
        console.log('[Launcher] Path confirmed:', path);

        try {
            const project = await addProject(path);
            console.log('[Launcher] Project added:', project);
            const parentDir = path.split('/').slice(0, -1).join('/');
            if (parentDir) {
                localStorage.setItem('myagents:lastProjectDir', parentDir);
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[Launcher] Failed to add project:', errorMsg);
            setAddError(errorMsg);
            toast.error(`添加项目失败: ${errorMsg}`);
        }
    };

    const handlePathCancel = () => {
        setPathDialogOpen(false);
        console.log('[Launcher] Path dialog cancelled');
    };

    const handleRemoveProject = (project: Project) => {
        setProjectToRemove(project);
    };

    const confirmRemoveProject = async () => {
        if (projectToRemove) {
            await removeProject(projectToRemove.id);
            setProjectToRemove(null);
        }
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
            {/* Path Input Dialog (browser dev mode) */}
            <PathInputDialog
                isOpen={pathDialogOpen}
                folderName={pendingFolderName}
                defaultPath={pendingDefaultPath}
                onConfirm={handlePathConfirm}
                onCancel={handlePathCancel}
            />

            {/* Logs Panel */}
            <UnifiedLogsPanel
                sseLogs={[]}
                isVisible={showLogs}
                onClose={() => setShowLogs(false)}
            />

            {/* Remove Workspace Confirm Dialog */}
            {projectToRemove && (
                <ConfirmDialog
                    title="移除工作区"
                    message={`确定要从列表中移除「${projectToRemove.name}」吗？此操作不会删除项目文件。`}
                    confirmText="移除"
                    cancelText="取消"
                    confirmVariant="danger"
                    onConfirm={confirmRemoveProject}
                    onCancel={() => setProjectToRemove(null)}
                />
            )}

            {/* Main Content: Two-column layout */}
            <main className="launcher-layout flex-1 overflow-hidden">
                {/* Left: Brand Section */}
                <section className="launcher-brand relative flex items-center justify-center overflow-hidden">
                    <BrandSection />
                </section>

                {/* Right: Workspaces Section */}
                <section className="launcher-workspaces flex flex-col overflow-hidden border-l border-[var(--line)]">
                    {/* Recent Tasks */}
                    <div className="flex-shrink-0 px-6 pt-6">
                        <RecentTasks projects={projects} onOpenTask={handleOpenTask} />
                    </div>

                    {/* Quick Access */}
                    <div className="flex-shrink-0 px-6">
                        <QuickAccess onOpenSettings={onOpenSettings} />
                    </div>

                    {/* Workspaces Header */}
                    <div className="flex flex-shrink-0 items-center justify-between border-t border-[var(--line)]/60 px-6 py-4">
                        <h2 className="text-[13px] font-medium uppercase tracking-widest text-[var(--ink-muted)]/70">
                            工作区
                        </h2>
                        <div className="flex items-center gap-3">
                            {config.showDevTools && (
                                <button
                                    onClick={() => setShowLogs(true)}
                                    className="rounded-md px-2.5 py-1.5 text-[13px] font-normal text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink-muted)]"
                                    title="查看 Rust 日志"
                                >
                                    Logs
                                </button>
                            )}
                            {projects.length > 0 && (
                                <button
                                    onClick={handleAddProject}
                                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-normal text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink-muted)]"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    添加
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Workspaces List */}
                    <div className="flex-1 overflow-y-auto px-6 pb-6">
                        {isLoading ? (
                            <div className="flex flex-col items-center justify-center py-16">
                                <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]/50" />
                                <p className="mt-4 text-[13px] text-[var(--ink-muted)]">加载中...</p>
                            </div>
                        ) : projects.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--paper-contrast)]/60">
                                    <FolderOpen className="h-6 w-6 text-[var(--ink-muted)]/50" />
                                </div>
                                <h3 className="mb-1.5 text-[13px] font-medium text-[var(--ink)]">
                                    还没有工作区
                                </h3>
                                <p className="mb-5 max-w-[200px] text-[13px] leading-relaxed text-[var(--ink-muted)]/70">
                                    添加一个工作目录开始使用 Agent
                                </p>
                                <button
                                    onClick={handleAddProject}
                                    className="flex items-center gap-1.5 rounded-full bg-[var(--button-primary-bg)] px-5 py-2.5 text-[13px] font-medium text-[var(--button-primary-text)] transition-all hover:bg-[var(--button-primary-bg-hover)] hover:shadow-sm"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    添加工作区
                                </button>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {projects.map((project) => (
                                    <WorkspaceCard
                                        key={project.id}
                                        project={project}
                                        providers={providers}
                                        apiKeys={apiKeys}
                                        defaultProviderId={config.defaultProviderId}
                                        onLaunch={(p) => handleLaunch(p)}
                                        onUpdateProject={handleUpdateProject}
                                        onRemove={handleRemoveProject}
                                        isMenuOpen={activeMenuProjectId === project.id}
                                        onMenuToggle={(open) =>
                                            setActiveMenuProjectId(open ? project.id : null)
                                        }
                                        isLoading={launchingProjectId === project.id && isStarting}
                                        subscriptionAvailable={subscriptionStatus?.available}
                                        onOpenSettings={onOpenSettings}
                                        onRefreshProviders={refreshProviderData}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </section>
            </main>
        </div>
    );
}
