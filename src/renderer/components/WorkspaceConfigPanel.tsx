/**
 * WorkspaceConfigPanel - Full-screen configuration overlay for workspace
 * Manages CLAUDE.md, Skills, and Commands for the current project
 */
import { X, Settings, FileText, Sparkles, ChevronLeft } from 'lucide-react';
import { useCallback, useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';

import { CUSTOM_EVENTS } from '../../shared/constants';
import { useToast } from '@/components/Toast';
import ClaudeMdEditor from './ClaudeMdEditor';
import type { ClaudeMdEditorRef } from './ClaudeMdEditor';
import SkillsCommandsList from './SkillsCommandsList';
import SkillDetailPanel from './SkillDetailPanel';
import type { SkillDetailPanelRef } from './SkillDetailPanel';
import CommandDetailPanel from './CommandDetailPanel';
import type { CommandDetailPanelRef } from './CommandDetailPanel';

interface WorkspaceConfigPanelProps {
    agentDir: string;
    onClose: () => void;
    /** External refresh key from parent - when changed, triggers list refresh */
    refreshKey?: number;
}

type Tab = 'claude-md' | 'skills-commands';
type DetailView =
    | { type: 'none' }
    | { type: 'skill'; name: string; scope: 'user' | 'project'; isNewSkill?: boolean }
    | { type: 'command'; name: string; scope: 'user' | 'project' };

export default function WorkspaceConfigPanel({ agentDir, onClose, refreshKey: externalRefreshKey = 0 }: WorkspaceConfigPanelProps) {
    const toast = useToast();
    const [activeTab, setActiveTab] = useState<Tab>('claude-md');
    const [detailView, setDetailView] = useState<DetailView>({ type: 'none' });
    const [internalRefreshKey, setInternalRefreshKey] = useState(0);

    // Combine external and internal refresh keys
    const refreshKey = externalRefreshKey + internalRefreshKey;

    // Refs for checking editing state
    const claudeMdRef = useRef<ClaudeMdEditorRef>(null);
    const skillDetailRef = useRef<SkillDetailPanelRef>(null);
    const commandDetailRef = useRef<CommandDetailPanelRef>(null);

    // Check if any component is in editing mode
    const isAnyEditing = useCallback(() => {
        if (activeTab === 'claude-md' && claudeMdRef.current?.isEditing()) {
            return true;
        }
        if (detailView.type === 'skill' && skillDetailRef.current?.isEditing()) {
            return true;
        }
        if (detailView.type === 'command' && commandDetailRef.current?.isEditing()) {
            return true;
        }
        return false;
    }, [activeTab, detailView]);

    // Handle close with editing check
    const handleClose = useCallback(() => {
        if (isAnyEditing()) {
            toast.warning('请先保存或取消编辑');
            return;
        }
        onClose();
    }, [isAnyEditing, onClose, toast]);

    // Handle back with editing check
    const handleBackFromDetail = useCallback(() => {
        if (isAnyEditing()) {
            toast.warning('请先保存或取消编辑');
            return;
        }
        setDetailView({ type: 'none' });
    }, [isAnyEditing, toast]);

    // Close on Escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (detailView.type !== 'none') {
                    handleBackFromDetail();
                } else {
                    handleClose();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleClose, handleBackFromDetail, detailView]);

    // Prevent background scroll
    useEffect(() => {
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = '';
        };
    }, []);

    // Listen for skill copy events to refresh the list
    useEffect(() => {
        const handleSkillCopied = () => {
            setInternalRefreshKey(k => k + 1);
        };
        window.addEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
        return () => window.removeEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
    }, []);

    const handleSelectSkill = useCallback((name: string, scope: 'user' | 'project', isNewSkill?: boolean) => {
        setDetailView({ type: 'skill', name, scope, isNewSkill });
    }, []);

    const handleSelectCommand = useCallback((name: string, scope: 'user' | 'project') => {
        setDetailView({ type: 'command', name, scope });
    }, []);

    const handleItemSaved = useCallback((autoClose?: boolean) => {
        setInternalRefreshKey(k => k + 1);
        if (autoClose) {
            setDetailView({ type: 'none' });
        }
    }, []);

    const handleItemDeleted = useCallback(() => {
        setDetailView({ type: 'none' });
        setInternalRefreshKey(k => k + 1);
    }, []);

    // Get workspace name from path
    const workspaceName = agentDir.split('/').pop() || 'Workspace';

    return createPortal(
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 backdrop-blur-md"
            onClick={handleClose}
        >
            {/* Main Panel */}
            <div
                className="relative flex h-[90vh] w-[90vw] max-w-5xl flex-col overflow-hidden rounded-2xl bg-[var(--paper)] shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] bg-gradient-to-r from-[var(--paper-contrast)] to-[var(--paper)] px-6 py-4">
                    <div className="flex items-center gap-3">
                        {detailView.type !== 'none' && (
                            <button
                                type="button"
                                onClick={handleBackFromDetail}
                                className="mr-2 rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                                title="返回列表"
                            >
                                <ChevronLeft className="h-5 w-5" />
                            </button>
                        )}
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--accent-warm)] to-[var(--accent-cool)] shadow-lg">
                            <Settings className="h-5 w-5 text-white" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-[var(--ink)]">项目设置</h2>
                            <p className="text-xs text-[var(--ink-muted)]">{workspaceName}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={handleClose}
                        className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                        title="关闭 (Esc)"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* Tab Bar - only show when not in detail view */}
                {detailView.type === 'none' && (
                    <div className="flex flex-shrink-0 border-b border-[var(--line)] bg-[var(--paper)]">
                        <button
                            type="button"
                            onClick={() => setActiveTab('claude-md')}
                            className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors ${activeTab === 'claude-md'
                                ? 'border-b-2 border-[var(--accent-warm)] text-[var(--accent-warm)]'
                                : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                }`}
                        >
                            <FileText className="h-4 w-4" />
                            CLAUDE.md
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveTab('skills-commands')}
                            className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors ${activeTab === 'skills-commands'
                                ? 'border-b-2 border-[var(--accent-warm)] text-[var(--accent-warm)]'
                                : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                }`}
                        >
                            <Sparkles className="h-4 w-4" />
                            Skills & Commands
                        </button>
                    </div>
                )}

                {/* Content Area */}
                <div className="flex-1 overflow-hidden">
                    {detailView.type === 'none' ? (
                        <>
                            {activeTab === 'claude-md' && (
                                <ClaudeMdEditor ref={claudeMdRef} agentDir={agentDir} />
                            )}
                            {activeTab === 'skills-commands' && (
                                <SkillsCommandsList
                                    scope="project"
                                    agentDir={agentDir}
                                    onSelectSkill={handleSelectSkill}
                                    onSelectCommand={handleSelectCommand}
                                    refreshKey={refreshKey}
                                />
                            )}
                        </>
                    ) : detailView.type === 'skill' ? (
                        <SkillDetailPanel
                            ref={skillDetailRef}
                            name={detailView.name}
                            scope={detailView.scope}
                            onBack={handleBackFromDetail}
                            onSaved={handleItemSaved}
                            onDeleted={handleItemDeleted}
                            startInEditMode={detailView.isNewSkill}
                            agentDir={agentDir}
                        />
                    ) : (
                        <CommandDetailPanel
                            ref={commandDetailRef}
                            name={detailView.name}
                            scope={detailView.scope}
                            onBack={handleBackFromDetail}
                            onSaved={handleItemSaved}
                            onDeleted={handleItemDeleted}
                            agentDir={agentDir}
                        />
                    )}
                </div>

                {/* Footer hint */}
                <div className="flex-shrink-0 border-t border-[var(--line)] bg-[var(--paper-contrast)] px-6 py-2">
                    <p className="text-center text-xs text-[var(--ink-muted)]">
                        按 Esc 关闭 · 配置修改会立即生效
                    </p>
                </div>
            </div>
        </div>,
        document.body
    );
}
