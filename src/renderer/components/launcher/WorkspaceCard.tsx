/**
 * WorkspaceCard - Simplified project card for the launcher
 * Includes model selection with API key validation
 */

import { useEffect, useState, useRef } from 'react';
import { AlertCircle, ChevronDown, FolderOpen, Loader2, MoreVertical, Play, Trash2 } from 'lucide-react';

import { getModelsDisplay, type Project, type Provider } from '@/config/types';

interface WorkspaceCardProps {
    project: Project;
    providers: Provider[];
    apiKeys: Record<string, string>;
    defaultProviderId: string;
    onLaunch: (project: Project) => void;
    onUpdateProject: (project: Project) => void;
    onRemove: (project: Project) => void;
    isMenuOpen: boolean;
    onMenuToggle: (open: boolean) => void;
    isLoading?: boolean;
    subscriptionAvailable?: boolean; // Anthropic subscription status
    /** Callback to open Settings with optional initial section */
    onOpenSettings?: (initialSection?: string) => void;
    /** Callback to refresh providers data */
    onRefreshProviders?: () => void;
}

export default function WorkspaceCard({
    project,
    providers,
    apiKeys,
    defaultProviderId,
    onLaunch,
    onUpdateProject,
    onRemove,
    isMenuOpen,
    onMenuToggle,
    isLoading,
    subscriptionAvailable,
    onOpenSettings,
    onRefreshProviders,
}: WorkspaceCardProps) {
    const effectiveProviderId = project.providerId ?? defaultProviderId;
    const effectiveProvider = providers.find((p) => p.id === effectiveProviderId);

    // Check if provider is available: subscription type uses subscription status, API type uses apiKeys
    const isProviderAvailable = (provider: Provider | undefined): boolean => {
        if (!provider) return false;
        if (provider.type === 'subscription') return !!subscriptionAvailable;
        return !!apiKeys[provider.id];
    };

    const hasApiKey = isProviderAvailable(effectiveProvider);

    // More menu state
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const moreMenuRef = useRef<HTMLDivElement>(null);

    // Close more menu when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
                setShowMoreMenu(false);
            }
        };
        if (showMoreMenu) {
            document.addEventListener('click', handleClickOutside);
            return () => document.removeEventListener('click', handleClickOutside);
        }
    }, [showMoreMenu]);

    // Close menu when clicking outside
    useEffect(() => {
        const handleClickOutside = () => onMenuToggle(false);
        if (isMenuOpen) {
            document.addEventListener('click', handleClickOutside);
            return () => document.removeEventListener('click', handleClickOutside);
        }
    }, [isMenuOpen, onMenuToggle]);

    return (
        <div className="rounded-xl border border-[var(--line)]/70 bg-[var(--paper-strong)] p-4">
            {/* Header: folder icon + name + more menu */}
            <div className="mb-4 flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-cool)]/8">
                    <FolderOpen className="h-4 w-4 text-[var(--accent-cool)]/80" />
                </div>
                <div className="min-w-0 flex-1 pt-0.5">
                    <h3 className="truncate text-[13px] font-medium text-[var(--ink)]">
                        {project.name}
                    </h3>
                    <p className="mt-0.5 truncate text-[12px] text-[var(--ink-muted)]">
                        {project.path}
                    </p>
                </div>
                {/* More Menu */}
                <div className="relative" ref={moreMenuRef}>
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            // 关闭 provider 菜单，避免两个菜单同时打开
                            if (isMenuOpen) onMenuToggle(false);
                            setShowMoreMenu(!showMoreMenu);
                        }}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                        title="更多操作"
                        aria-label="更多操作"
                        aria-expanded={showMoreMenu}
                        aria-haspopup="menu"
                    >
                        <MoreVertical className="h-4 w-4" />
                    </button>
                    {showMoreMenu && (
                        <div
                            className="absolute right-0 top-full z-50 mt-1 w-32 rounded-lg border border-[var(--line)] bg-[var(--paper-strong)] py-1 shadow-lg"
                            role="menu"
                            aria-label="工作区操作菜单"
                        >
                            <button
                                type="button"
                                role="menuitem"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setShowMoreMenu(false);
                                    onRemove(project);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--danger)] transition-colors hover:bg-[var(--paper-contrast)]"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                                移除
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Footer: model selector + launch button */}
            <div className="flex items-center gap-2">
                {/* Model Selector (subtle style) */}
                <div className="relative">
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            // 关闭更多菜单，避免两个菜单同时打开
                            if (showMoreMenu) setShowMoreMenu(false);
                            const willOpen = !isMenuOpen;
                            onMenuToggle(willOpen);
                            // Refresh providers data when opening menu
                            if (willOpen && onRefreshProviders) {
                                onRefreshProviders();
                            }
                        }}
                        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                    >
                        <span className="max-w-[120px] truncate">
                            {effectiveProvider?.name ?? '选择模型'}
                        </span>
                        <ChevronDown className="h-3.5 w-3.5" />
                    </button>

                    {/* Dropdown Menu */}
                    {isMenuOpen && (
                        <div
                            className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-[var(--line)] bg-[var(--paper-strong)] py-1 shadow-lg"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {providers.map((p, index) => {
                                const providerAvailable = isProviderAvailable(p);
                                return (
                                    <div key={p.id}>
                                        {index > 0 && (
                                            <div className="mx-2 border-t border-[var(--line)]/50" />
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => {
                                                onUpdateProject({ ...project, providerId: p.id });
                                                onMenuToggle(false);
                                            }}
                                            className={`w-full px-3 py-2.5 text-left transition-colors ${effectiveProvider?.id === p.id
                                                ? 'bg-[var(--accent)]/10 hover:bg-[var(--accent)]/15'
                                                : 'hover:bg-[var(--paper-contrast)]'
                                                }`}
                                        >
                                            <div className="flex items-center gap-2">
                                                <span
                                                    className={`text-sm font-medium ${effectiveProvider?.id === p.id
                                                            ? 'text-[var(--accent)]'
                                                            : 'text-[var(--ink)]'
                                                        }`}
                                                >
                                                    {p.name}
                                                </span>
                                                {!providerAvailable && (
                                                    <span className="rounded bg-[var(--warning-bg)] px-1 py-0.5 text-[9px] text-[var(--warning)]">
                                                        未配置
                                                    </span>
                                                )}
                                            </div>
                                            <span className="mt-0.5 line-clamp-2 text-[11px] text-[var(--ink-muted)]">
                                                {getModelsDisplay(p)}
                                            </span>
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Provider Configuration Warning - clickable to open settings */}
                {!hasApiKey && (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onOpenSettings?.('providers');
                        }}
                        className="flex items-center gap-1.5 text-[12px] text-[var(--warning)] transition-colors hover:text-[var(--warning)]/80 hover:underline"
                        title="点击前往设置配置"
                    >
                        <AlertCircle className="h-3.5 w-3.5" />
                        <span>
                            {effectiveProvider?.type === 'subscription' ? '未检测到订阅' : '需配置 API Key'}
                        </span>
                    </button>
                )}

                {/* Spacer */}
                <div className="flex-1" />

                {/* Launch Button */}
                <button
                    onClick={() => onLaunch(project)}
                    disabled={isLoading || !hasApiKey}
                    className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium transition-all ${hasApiKey
                            ? 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]'
                            : 'cursor-not-allowed bg-[var(--paper-inset)] text-[var(--ink-muted)]'
                        } ${isLoading ? 'opacity-70' : ''}`}
                    title={!hasApiKey ? (effectiveProvider?.type === 'subscription' ? '未检测到 Anthropic 订阅凭证' : '请先在设置中配置 API Key') : undefined}
                >
                    {isLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Play className="h-3.5 w-3.5" />
                    )}
                    {isLoading ? '启动中' : '启动'}
                </button>
            </div>
        </div>
    );
}
