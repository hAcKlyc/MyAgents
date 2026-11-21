/**
 * WorkspaceConfigPanel - Full-screen configuration overlay for workspace
 * Two tabs: 「系统提示词」(CLAUDE.md + rules) and 「技能 Skills」(skills + commands + agents)
 */
import { useOverlayOwnerActive } from '@/context/OverlayOwnerActiveContext';
import { isImeComposingEvent } from '@/utils/imeKeyboard';
import { CloseIcon, SlidersIcon, ChevronLeftIcon } from '@/components/icons';
import { useCallback, useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { dismissTopmost } from '@/utils/closeLayer';

import { CUSTOM_EVENTS } from '../../shared/constants';
import { useToast } from '@/components/Toast';
import SystemPromptsPanel from './SystemPromptsPanel';
import type { SystemPromptsPanelRef } from './SystemPromptsPanel';
import SkillsCommandsList from './SkillsCommandsList';
import SkillDetailPanel from './SkillDetailPanel';
import type { SkillDetailPanelRef } from './SkillDetailPanel';
import CommandDetailPanel from './CommandDetailPanel';
import type { CommandDetailPanelRef } from './CommandDetailPanel';
import WorkspaceAgentsList from './WorkspaceAgentsList';
import AgentDetailPanel from './AgentDetailPanel';
import type { AgentDetailPanelRef } from './AgentDetailPanel';
import IntroductionPanel from './IntroductionPanel';
import type { IntroductionPanelRef } from './IntroductionPanel';
import { WorkspaceGeneralTab } from './AgentSettings';
import type { CapabilityInitialSelect } from '../../shared/skillsTypes';
import type { ChannelType } from '../../shared/types/agent';

interface WorkspaceConfigPanelProps {
    agentDir: string;
    onClose: () => void;
    /** External refresh key from parent - when changed, triggers list refresh */
    refreshKey?: number;
    /** Initial tab to show when opening */
    initialTab?: Tab;
    /** When set on first mount, open the matching item's detail view directly.
     *  Project-scoped items only — global items are routed through the Settings page. */
    initialSelect?: CapabilityInitialSelect;
    /** Called when the user clicks "智能生成" in the system-prompts empty state. The
     *  parent (Chat) is expected to close this overlay and dispatch `/init` to its
     *  current Tab session. Omit to hide the action. */
    onRequestInit?: () => void;
    /** Open the General tab directly in the selected Channel wizard. */
    initialAddChannelPlatform?: ChannelType;
    /** Acknowledge the one-shot Channel deep-link after General consumes it. */
    onInitialAddChannelPlatformConsumed?: () => void;
}

export type Tab = 'general' | 'system-prompts' | 'introduction' | 'skills' | 'agent';
type DetailView =
    | { type: 'none' }
    | { type: 'skill'; name: string; scope: 'user' | 'project'; isNewSkill?: boolean }
    | { type: 'command'; name: string; scope: 'user' | 'project' }
    | { type: 'agent'; name: string; scope: 'user' | 'project'; isNewAgent?: boolean };

/** Map a (kind, identifier, scope) selection to the matching DetailView shape.
 *  Returns 'none' for selections this panel doesn't accept (e.g. user scope).
 *  Exhaustive switch — adding a new CapabilityKind triggers a TS error here. */
function detailViewForSelect(select: CapabilityInitialSelect | undefined): DetailView {
    if (!select || select.scope !== 'project') return { type: 'none' };
    switch (select.kind) {
        case 'skill': return { type: 'skill', name: select.folderName, scope: 'project' };
        case 'command': return { type: 'command', name: select.fileName, scope: 'project' };
        case 'agent': return { type: 'agent', name: select.folderName, scope: 'project' };
        default: {
            const _exhaustive: never = select;
            return _exhaustive;
        }
    }
}

const TAB_ITEMS: { key: Tab; labelKey: string }[] = [
    { key: 'general', labelKey: 'agentSettings.panel.tabs.general' },
    { key: 'system-prompts', labelKey: 'agentSettings.panel.tabs.systemPrompts' },
    { key: 'introduction', labelKey: 'agentSettings.panel.tabs.introduction' },
    { key: 'skills', labelKey: 'agentSettings.panel.tabs.skills' },
];

export default function WorkspaceConfigPanel({ agentDir, onClose, refreshKey: externalRefreshKey = 0, initialTab, initialSelect, onRequestInit, initialAddChannelPlatform, onInitialAddChannelPlatformConsumed }: WorkspaceConfigPanelProps) {
    const ownerActive = useOverlayOwnerActive();
    const { t } = useTranslation('settings');
    const toast = useToast();
    // Stabilize toast reference to avoid unnecessary effect re-runs
    const toastRef = useRef(toast);

    // Update ref in useEffect to comply with React rules
    useEffect(() => {
        toastRef.current = toast;
    }, [toast]);

    // Map legacy 'agent' tab to 'general' for backward compat (Settings page passes 'agent')
    const resolvedInitialTab: Tab = initialTab === 'agent' ? 'general' : (initialTab ?? 'general');
    const [activeTab, setActiveTab] = useState<Tab>(resolvedInitialTab);
    // Lazy-init from initialSelect — overlay re-mounts on each open, so first-mount
    // capture is enough; the user cannot trigger a second "设置" while the overlay
    // is up (it grabs focus via OverlayBackdrop).
    const [detailView, setDetailView] = useState<DetailView>(() => detailViewForSelect(initialSelect));
    const [internalRefreshKey, setInternalRefreshKey] = useState(0);

    // Combine external and internal refresh keys
    const refreshKey = externalRefreshKey + internalRefreshKey;

    // Refs for checking editing state
    const systemPromptsRef = useRef<SystemPromptsPanelRef>(null);
    const introductionRef = useRef<IntroductionPanelRef>(null);
    const skillDetailRef = useRef<SkillDetailPanelRef>(null);
    const commandDetailRef = useRef<CommandDetailPanelRef>(null);
    const agentDetailRef = useRef<AgentDetailPanelRef>(null);

    // Check if any component is in editing mode
    const isAnyEditing = useCallback(() => {
        if (activeTab === 'system-prompts' && systemPromptsRef.current?.isEditing()) {
            return true;
        }
        if (activeTab === 'introduction' && introductionRef.current?.isEditing()) {
            return true;
        }
        if (detailView.type === 'skill' && skillDetailRef.current?.isEditing()) {
            return true;
        }
        if (detailView.type === 'command' && commandDetailRef.current?.isEditing()) {
            return true;
        }
        if (detailView.type === 'agent' && agentDetailRef.current?.isEditing()) {
            return true;
        }
        return false;
    }, [activeTab, detailView]);

    // Handle close with editing check
    const handleClose = useCallback(() => {
        if (isAnyEditing()) {
            toastRef.current.warning(t('agentSettings.panel.unsavedWarning'));
            return;
        }
        onClose();
    }, [isAnyEditing, onClose, t]);
    useCloseLayer(() => { handleClose(); return true; }, 200);

    // Handle back with editing check
    const handleBackFromDetail = useCallback(() => {
        if (isAnyEditing()) {
            toastRef.current.warning(t('agentSettings.panel.unsavedWarning'));
            return;
        }
        setDetailView({ type: 'none' });
    }, [isAnyEditing, t]);

    // Close on Escape key
    useEffect(() => {
        if (!ownerActive) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isImeComposingEvent(e)) return;
            if (e.key === 'Escape') {
                if (detailView.type !== 'none') {
                    handleBackFromDetail();
                } else if (dismissTopmost()) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleClose, handleBackFromDetail, detailView, ownerActive]);

    // Prevent background scroll
    useEffect(() => {
        if (!ownerActive) return;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = '';
        };
    }, [ownerActive]);

    // Keep this panel on the same persisted capability generation as Chat.
    useEffect(() => {
        const handleCapabilitiesChanged = () => {
            setInternalRefreshKey(k => k + 1);
        };
        window.addEventListener(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED, handleCapabilitiesChanged);
        return () => window.removeEventListener(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED, handleCapabilitiesChanged);
    }, []);

    const handleSelectSkill = useCallback((name: string, scope: 'user' | 'project', isNewSkill?: boolean) => {
        setDetailView({ type: 'skill', name, scope, isNewSkill });
    }, []);

    const handleSelectCommand = useCallback((name: string, scope: 'user' | 'project') => {
        setDetailView({ type: 'command', name, scope });
    }, []);

    const handleSelectAgent = useCallback((name: string, scope: 'user' | 'project', isNewAgent?: boolean) => {
        setDetailView({ type: 'agent', name, scope, isNewAgent });
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

    const handleCapabilityItemSaved = useCallback((autoClose?: boolean) => {
        handleItemSaved(autoClose);
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
    }, [handleItemSaved]);

    const handleCapabilityItemDeleted = useCallback(() => {
        handleItemDeleted();
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
    }, [handleItemDeleted]);

    // Handle tab switch with editing check
    const handleTabSwitch = useCallback((tab: Tab) => {
        if (isAnyEditing()) {
            toastRef.current.warning(t('agentSettings.panel.unsavedWarning'));
            return;
        }
        setActiveTab(tab);
    }, [isAnyEditing, t]);

    return createPortal(
        <OverlayBackdrop onClose={handleClose} className="z-[200]">
            {/* Main Panel */}
            <div
                className="relative flex h-[90vh] w-[90vw] max-w-5xl flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] shadow-2xl"
            >
                {/* Header — three zones: left (icon+title), center (tabs), right (close) */}
                <div className="flex flex-shrink-0 items-center border-b border-[var(--line)] bg-gradient-to-r from-[var(--paper-inset)] to-[var(--paper)] px-6 py-3">
                    {/* Left zone */}
                    <div className="flex min-w-0 items-center gap-2.5">
                        {detailView.type !== 'none' && (
                            <button
                                type="button"
                                onClick={handleBackFromDetail}
                                className="mr-1 rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                title={t('agentSettings.panel.backToList')}
                            >
                                <ChevronLeftIcon className="h-5 w-5" />
                            </button>
                        )}
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--button-dark-bg)] shadow">
                            <SlidersIcon className="h-4 w-4 text-[var(--button-dark-text)]" />
                        </div>
                        <h2 className="text-lg font-semibold text-[var(--ink)]">{t('agentSettings.panel.title')}</h2>
                    </div>

                    {/* Tab switcher — left-aligned after title (only in list view) */}
                    {detailView.type === 'none' && (
                        <div className="ml-6 flex items-center gap-1">
                            {TAB_ITEMS.map(item => (
                                <button
                                    key={item.key}
                                    type="button"
                                    onClick={() => handleTabSwitch(item.key)}
                                    className={`relative pb-0.5 text-sm font-medium transition-colors ${
                                        activeTab === item.key
                                            ? 'text-[var(--accent-warm)]'
                                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                    } ${item.key !== TAB_ITEMS[0].key ? 'ml-4' : ''}`}
                                >
                                    {t(item.labelKey)}
                                    {activeTab === item.key && (
                                        <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-[var(--accent-warm)]" />
                                    )}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Spacer to push close button to right */}
                    <div className="flex-1" />

                    {/* Right zone */}
                    <button
                        type="button"
                        onClick={handleClose}
                        className="shrink-0 rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                        title={t('agentSettings.panel.closeEsc')}
                    >
                        <CloseIcon className="h-5 w-5" />
                    </button>
                </div>

                {/* Content Area — paper base so elevated cards stand out */}
                <div className="flex-1 overflow-hidden bg-[var(--paper)]">
                    {detailView.type === 'none' ? (
                        <>
                            {activeTab === 'general' && (
                                <WorkspaceGeneralTab
                                    agentDir={agentDir}
                                    initialAddChannelPlatform={initialAddChannelPlatform}
                                    onInitialAddChannelPlatformConsumed={onInitialAddChannelPlatformConsumed}
                                />
                            )}
                            {activeTab === 'system-prompts' && (
                                <SystemPromptsPanel ref={systemPromptsRef} agentDir={agentDir} onRequestInit={onRequestInit} />
                            )}
                            {activeTab === 'introduction' && (
                                <IntroductionPanel ref={introductionRef} agentDir={agentDir} />
                            )}
                            {activeTab === 'skills' && (
                                <div className="h-full overflow-auto">
                                    <SkillsCommandsList
                                        scope="project"
                                        agentDir={agentDir}
                                        onSelectSkill={handleSelectSkill}
                                        onSelectCommand={handleSelectCommand}
                                        refreshKey={refreshKey}
                                    />
                                    <WorkspaceAgentsList
                                        scope="project"
                                        agentDir={agentDir}
                                        onSelectAgent={handleSelectAgent}
                                        refreshKey={refreshKey}
                                        onClose={onClose}
                                    />
                                </div>
                            )}
                        </>
                    ) : detailView.type === 'skill' ? (
                        <SkillDetailPanel
                            ref={skillDetailRef}
                            name={detailView.name}
                            scope={detailView.scope}
                            onBack={handleBackFromDetail}
                            onSaved={handleCapabilityItemSaved}
                            onDeleted={handleCapabilityItemDeleted}
                            startInEditMode={detailView.isNewSkill}
                            agentDir={agentDir}
                        />
                    ) : detailView.type === 'command' ? (
                        <CommandDetailPanel
                            ref={commandDetailRef}
                            name={detailView.name}
                            scope={detailView.scope}
                            onBack={handleBackFromDetail}
                            onSaved={handleCapabilityItemSaved}
                            onDeleted={handleCapabilityItemDeleted}
                            agentDir={agentDir}
                        />
                    ) : detailView.type === 'agent' ? (
                        <AgentDetailPanel
                            ref={agentDetailRef}
                            name={detailView.name}
                            scope={detailView.scope}
                            onBack={handleBackFromDetail}
                            onSaved={handleItemSaved}
                            onDeleted={handleItemDeleted}
                            startInEditMode={detailView.isNewAgent}
                            agentDir={agentDir}
                        />
                    ) : null}
                </div>

                {/* Footer hint */}
                <div className="flex-shrink-0 border-t border-[var(--line)] bg-[var(--paper-inset)] px-6 py-2">
                    <p className="text-center text-xs text-[var(--ink-muted)]">
                        {t('agentSettings.panel.footer')}
                    </p>
                </div>
            </div>
        </OverlayBackdrop>,
        document.body
    );
}
