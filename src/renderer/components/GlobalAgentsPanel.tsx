/**
 * GlobalAgentsPanel - User-level Sub-Agent management for Settings page
 * Follows the same pattern as GlobalSkillsPanel
 */
import {
  PlusIcon,
  HelperIcon,
  LoaderIcon,
  ChevronLeftIcon,
} from '@/components/icons';
import { useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { track } from '@/analytics';
import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';
import AgentDetailPanel from './AgentDetailPanel';
import type { AgentDetailPanelRef } from './AgentDetailPanel';
import { AgentCard } from './AgentCards';
import { CreateDialog } from './SkillDialogs';
import type { AgentItem } from '../../shared/agentTypes';
import type { CapabilityInitialSelect } from '../../shared/skillsTypes';
import OverlayBackdrop from '@/components/OverlayBackdrop';

type ViewState =
    | { type: 'list' }
    | { type: 'agent-detail'; name: string; isNewAgent?: boolean };

/** Map an "open this item" intent to the matching detail ViewState.
 *  Returns null for kinds this panel doesn't handle (skill/command).
 *  Exhaustive switch — adding a new CapabilityKind triggers a TS error here. */
function viewStateForSelect(select: CapabilityInitialSelect | undefined): ViewState | null {
    if (!select || select.scope !== 'user') return null;
    switch (select.kind) {
        case 'agent': return { type: 'agent-detail', name: select.folderName };
        case 'skill': return null;
        case 'command': return null;
        default: {
            const _exhaustive: never = select;
            return _exhaustive;
        }
    }
}

export default function GlobalAgentsPanel({
    onDetailChange,
    initialSelect,
}: {
    onDetailChange?: (inDetail: boolean) => void;
    /** When set on first mount, open the matching agent's detail view directly. */
    initialSelect?: CapabilityInitialSelect;
}) {
    const { t } = useTranslation('settings');
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;

    // Initialize from initialSelect on first mount; subsequent navigation is user-driven.
    const [viewState, setViewState] = useState<ViewState>(() => viewStateForSelect(initialSelect) ?? { type: 'list' });
    const onDetailChangeRef = useRef(onDetailChange);
    onDetailChangeRef.current = onDetailChange;
    useEffect(() => { onDetailChangeRef.current?.(viewState.type !== 'list'); }, [viewState.type]);
    const [loading, setLoading] = useState(true);
    const [agents, setAgents] = useState<AgentItem[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);

    const agentDetailRef = useRef<AgentDetailPanelRef>(null);

    // Dialog states
    const [showNewDialog, setShowNewDialog] = useState(false);
    const [newItemName, setNewItemName] = useState('');
    const [newItemDescription, setNewItemDescription] = useState('');
    const [creating, setCreating] = useState(false);

    // Sync from Claude Code state
    const [canSyncFromClaude, setCanSyncFromClaude] = useState(false);
    const [syncableCount, setSyncableCount] = useState(0);
    const [syncConflicts, setSyncConflicts] = useState<string[]>([]);
    const [showSyncConflictDialog, setShowSyncConflictDialog] = useState(false);

    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const isAnyEditing = useCallback(() => {
        if (viewState.type === 'agent-detail' && agentDetailRef.current?.isEditing()) {
            return true;
        }
        return false;
    }, [viewState]);

    // Ref-guarded "open this item" effect — see GlobalSkillsPanel for the full
    // rationale. Editing-state guard mirrors the back button: never silently
    // discard unsaved edits when a new dispatch arrives.
    const lastConsumedSelectRef = useRef<CapabilityInitialSelect | undefined>(initialSelect);
    const isAnyEditingRef = useRef(isAnyEditing);
    isAnyEditingRef.current = isAnyEditing;
    useEffect(() => {
        if (initialSelect === lastConsumedSelectRef.current) return;
        lastConsumedSelectRef.current = initialSelect;
        const next = viewStateForSelect(initialSelect);
        if (!next) return;
        if (isAnyEditingRef.current()) {
            toastRef.current.warning(t('agentSettings.globalAgents.unsavedWarning'));
            return;
        }
        setViewState(next);
    }, [initialSelect, t]);

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [agentsRes, syncCheckRes] = await Promise.all([
                apiGetJson<{ success: boolean; agents: AgentItem[] }>('/api/agents?scope=user'),
                apiGetJson<{ canSync: boolean; count: number; folders: string[]; conflictFolders?: string[] }>('/api/agent/sync-check')
            ]);

            if (!isMountedRef.current) return;

            if (agentsRes.success) setAgents(agentsRes.agents);
            setCanSyncFromClaude(syncCheckRes?.canSync ?? false);
            setSyncableCount(syncCheckRes?.count ?? 0);
            setSyncConflicts(syncCheckRes?.conflictFolders ?? []);
        } catch {
            if (!isMountedRef.current) return;
            toastRef.current.error(t('agentSettings.common.loadFailed'));
        } finally {
            if (isMountedRef.current) setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        loadData();
    }, [loadData, refreshKey]);

    const handleBackToList = useCallback(() => {
        if (isAnyEditing()) {
            toastRef.current.warning(t('agentSettings.globalAgents.unsavedWarning'));
            return;
        }
        setViewState({ type: 'list' });
    }, [isAnyEditing, t]);

    const handleQuickCreateAgent = useCallback(async (tempName: string) => {
        try {
            const response = await apiPostJson<{ success: boolean; error?: string; folderName?: string }>('/api/agent/create', {
                name: tempName,
                scope: 'user',
                description: ''
            });
            if (response.success) {
                track('agent_add', { scope: 'user' });
                setViewState({ type: 'agent-detail', name: response.folderName || tempName, isNewAgent: true });
                setRefreshKey(k => k + 1);
            } else {
                toastRef.current.error(response.error || t('agentSettings.common.createFailed'));
            }
        } catch {
            toastRef.current.error(t('agentSettings.common.createFailed'));
        }
    }, [t]);

    const doSync = useCallback(async (mode: 'skip' | 'overwrite') => {
        try {
            const response = await apiPostJson<{
                success: boolean;
                synced: number;
                failed: number;
                skipped: number;
                overwritten: number;
                errors?: string[];
            }>('/api/agent/sync-from-claude', { mode });

            if (response.success) {
                const parts: string[] = [];
                if (response.synced > 0) parts.push(t('agentSettings.globalAgents.syncAdded', { count: response.synced }));
                if (response.overwritten > 0) parts.push(t('agentSettings.globalAgents.syncOverwritten', { count: response.overwritten }));
                if (response.skipped > 0) parts.push(t('agentSettings.globalAgents.syncSkipped', { count: response.skipped }));
                if (response.failed > 0) parts.push(t('agentSettings.globalAgents.syncFailedCount', { count: response.failed }));

                if (response.failed > 0) {
                    toastRef.current.warning(parts.join(t('agentSettings.globalAgents.syncSeparator')));
                } else if (parts.length > 0) {
                    toastRef.current.success(parts.join(t('agentSettings.globalAgents.syncSeparator')));
                } else {
                    toastRef.current.info(t('agentSettings.globalAgents.noSyncableAgents'));
                }
                setRefreshKey(k => k + 1);
            } else {
                toastRef.current.error(t('agentSettings.globalAgents.syncFailed'));
            }
        } catch {
            toastRef.current.error(t('agentSettings.globalAgents.syncFailed'));
        }
        setShowSyncConflictDialog(false);
    }, [t]);

    const handleSyncFromClaude = useCallback(async () => {
        if (syncConflicts.length > 0) {
            // Has conflicts - show dialog to let user choose
            setShowSyncConflictDialog(true);
        } else {
            // No conflicts - just sync directly
            await doSync('skip');
        }
    }, [syncConflicts, doSync]);

    const handleCreateAgent = useCallback(async () => {
        if (!newItemName.trim()) return;
        setCreating(true);
        try {
            const response = await apiPostJson<{ success: boolean; error?: string; folderName?: string }>('/api/agent/create', {
                name: newItemName.trim(),
                scope: 'user',
                description: newItemDescription.trim()
            });
            if (response.success) {
                track('agent_add', { scope: 'user' });
                setShowNewDialog(false);
                setNewItemName('');
                setNewItemDescription('');
                if (response.folderName) {
                    setViewState({ type: 'agent-detail', name: response.folderName, isNewAgent: true });
                }
                setRefreshKey(k => k + 1);
            } else {
                toastRef.current.error(response.error || t('agentSettings.common.createFailed'));
            }
        } catch {
            toastRef.current.error(t('agentSettings.common.createFailed'));
        } finally {
            setCreating(false);
        }
    }, [newItemName, newItemDescription, t]);

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
                <LoaderIcon className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
            </div>
        );
    }

    // Agent Detail View
    if (viewState.type === 'agent-detail') {
        return (
            <div className="space-y-4">
                <button
                    onClick={handleBackToList}
                    className="flex items-center gap-1 text-sm text-[var(--ink-muted)] hover:text-[var(--ink)]"
                >
                    <ChevronLeftIcon className="h-4 w-4" />
                    {t('agentSettings.globalAgents.backToList')}
                </button>
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] overflow-hidden" style={{ minHeight: '500px' }}>
                    <AgentDetailPanel
                        ref={agentDetailRef}
                        name={viewState.name}
                        scope="user"
                        onBack={handleBackToList}
                        onSaved={handleItemSaved}
                        onDeleted={handleItemDeleted}
                        startInEditMode={viewState.isNewAgent}
                    />
                </div>
            </div>
        );
    }

    // List View
    return (
        <div className="space-y-8">
            {/* Agents Section */}
            <div>
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <HelperIcon className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">{t('agentSettings.globalAgents.title')}</h3>
                        <span className="text-xs text-[var(--ink-muted)]">({agents.length})</span>
                    </div>
                    <div className="flex items-center gap-2">
                        {canSyncFromClaude && (
                            <button
                                onClick={handleSyncFromClaude}
                                className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            >
                                {t('agentSettings.globalAgents.syncFromClaude', { count: syncableCount })}
                            </button>
                        )}
                        <button
                            onClick={() => {
                                const tempName = `new-agent-${Date.now()}`;
                                handleQuickCreateAgent(tempName);
                            }}
                            className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                        >
                            <PlusIcon className="h-4 w-4" />
                            {t('agentSettings.common.new')}
                        </button>
                    </div>
                </div>
                {agents.length > 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                        {agents.map(agent => (
                            <AgentCard
                                key={agent.folderName}
                                agent={agent}
                                onClick={() => setViewState({ type: 'agent-detail', name: agent.folderName })}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 py-8 text-center">
                        <HelperIcon className="mx-auto h-10 w-10 text-[var(--ink-muted)]/30" />
                        <p className="mt-2 text-sm text-[var(--ink-muted)]">{t('agentSettings.globalAgents.emptyTitle')}</p>
                        <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {t('agentSettings.globalAgents.emptyDescription')}
                        </p>
                    </div>
                )}
            </div>

            {/* Dialogs */}
            {showNewDialog && (
                <CreateDialog
                    title={t('agentSettings.globalAgents.newAgentTitle')}
                    name={newItemName}
                    description={newItemDescription}
                    onNameChange={setNewItemName}
                    onDescriptionChange={setNewItemDescription}
                    onConfirm={handleCreateAgent}
                    onCancel={() => { setShowNewDialog(false); setNewItemName(''); setNewItemDescription(''); }}
                    loading={creating}
                />
            )}

            {/* Sync conflict dialog */}
            {showSyncConflictDialog && (
                <OverlayBackdrop portal className="z-[100]">
                    <div className="w-[420px] rounded-xl border border-[var(--line)] bg-[var(--paper)] p-6 shadow-xl">
                        <h3 className="text-base font-semibold text-[var(--ink)]">{t('agentSettings.globalAgents.conflictTitle')}</h3>
                        <p className="mt-2 text-sm text-[var(--ink-muted)]">
                            {t('agentSettings.globalAgents.conflictMessage', { count: syncConflicts.length })}
                        </p>
                        <div className="mt-3 max-h-32 overflow-y-auto rounded-lg bg-[var(--paper-inset)] p-2">
                            {syncConflicts.map(name => (
                                <div key={name} className="px-2 py-1 text-xs text-[var(--ink-muted)]">{name}</div>
                            ))}
                        </div>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                onClick={() => setShowSyncConflictDialog(false)}
                                className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                            >
                                {t('agentSettings.common.cancel')}
                            </button>
                            <button
                                onClick={() => doSync('skip')}
                                className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink)] hover:bg-[var(--paper-inset)]"
                            >
                                {t('agentSettings.globalAgents.skipExisting')}
                            </button>
                            <button
                                onClick={() => doSync('overwrite')}
                                className="rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                            >
                                {t('agentSettings.globalAgents.overwriteAll')}
                            </button>
                        </div>
                    </div>
                </OverlayBackdrop>
            )}

            <p className="text-center text-xs text-[var(--ink-muted)]">
                {t('agentSettings.globalAgents.storageHint')}
            </p>
        </div>
    );
}
