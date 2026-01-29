import { AlertTriangle, ArrowLeft, History, Plus, PanelRightOpen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import DirectoryPanel, { type DirectoryPanelHandle } from '@/components/DirectoryPanel';
import DropZoneOverlay from '@/components/DropZoneOverlay';
import MessageList from '@/components/MessageList';
import SessionHistoryDropdown from '@/components/SessionHistoryDropdown';
import SimpleChatInput, { type ImageAttachment, type SimpleChatInputHandle } from '@/components/SimpleChatInput';
import SystemInfoPanel from '@/components/SystemInfoPanel';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import WorkspaceConfigPanel from '@/components/WorkspaceConfigPanel';
import { useTabState } from '@/context/TabContext';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { useConfig } from '@/hooks/useConfig';
import { useFileDropZone } from '@/hooks/useFileDropZone';
import { useTauriFileDrop } from '@/hooks/useTauriFileDrop';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';
import { type PermissionMode, type McpServerDefinition } from '@/config/types';
import {
  getAllMcpServers,
  getEnabledMcpServerIds,
  updateProjectMcpServers,
} from '@/config/configService';
import { CUSTOM_EVENTS } from '../../shared/constants';

interface ChatProps {
  onBack?: () => void;
  onNewSession?: () => void;
}

export default function Chat({ onBack, onNewSession }: ChatProps) {
  // Get state from TabContext (required - Chat must be inside TabProvider)
  const {
    agentDir,
    sessionId,
    messages,
    isLoading,
    sessionState,
    unifiedLogs,
    systemInitInfo,
    agentError,
    systemStatus,
    isActive,
    pendingPermission,
    pendingAskUserQuestion,
    toolCompleteCount,
    setMessages,
    setIsLoading,
    setAgentError,
    connectSse,
    disconnectSse,
    sendMessage,
    stopResponse,
    loadSession,
    resetSession,
    clearUnifiedLogs,
    respondPermission,
    respondAskUserQuestion,
    apiPost,
  } = useTabState();

  // Get config to find current project provider
  const { config, projects, providers, updateProject, apiKeys, providerVerifyStatus, refreshProviderData } = useConfig();
  const currentProject = projects.find((p) => p.path === agentDir);
  const currentProvider = currentProject?.providerId
    ? providers.find((p) => p.id === currentProject.providerId)
    : providers[0]; // Default to first provider

  // PERFORMANCE: inputValue is now managed internally by SimpleChatInput
  // to avoid re-rendering Chat (and MessageList) on every keystroke
  const [showLogs, setShowLogs] = useState(false);
  const [showSystemInfo, setShowSystemInfo] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(true); // Workspace panel visibility
  const [showWorkspaceConfig, setShowWorkspaceConfig] = useState(false); // Workspace config panel
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0); // Key to trigger workspace refresh
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto');
  const [selectedModel, setSelectedModel] = useState<string | undefined>(
    currentProvider?.primaryModel
  );

  // Ref for input focus
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Ref for SimpleChatInput to call processDroppedFiles
  const chatInputRef = useRef<SimpleChatInputHandle>(null);

  // Ref for DirectoryPanel to trigger refresh
  const directoryPanelRef = useRef<DirectoryPanelHandle>(null);

  // Ref for tracking previous isActive state (for config sync on tab switch)
  const prevIsActiveRef = useRef(isActive);

  // Ref for chat content area (for Tauri drop zone)
  const chatContentRef = useRef<HTMLDivElement>(null);

  // Ref for directory panel container (for Tauri drop zone)
  const directoryPanelContainerRef = useRef<HTMLDivElement>(null);

  // State to trigger workspace refresh
  const [workspaceRefreshTrigger, setWorkspaceRefreshTrigger] = useState(0);

  // Callback to refresh workspace (exposed to SimpleChatInput)
  const triggerWorkspaceRefresh = useCallback(() => {
    setWorkspaceRefreshTrigger(prev => prev + 1);
  }, []);

  // File drop zone for chat area (HTML5 drag-drop for non-Tauri/development)
  const handleFileDrop = useCallback((files: File[]) => {
    chatInputRef.current?.processDroppedFiles(files);
  }, []);

  const { isDragActive, dragHandlers } = useFileDropZone({
    onFilesDropped: handleFileDrop,
  });

  // Handle Tauri file drop on chat area (copy to myagents_files + insert reference)
  const handleTauriChatDrop = useCallback(async (paths: string[]) => {
    if (isDebugMode()) {
      console.log('[Chat] Tauri drop on chat area:', paths);
    }
    // Use the SimpleChatInput's method to process file paths
    await chatInputRef.current?.processDroppedFilePaths?.(paths);
    // Refresh workspace to show new files
    triggerWorkspaceRefresh();
  }, [triggerWorkspaceRefresh]);

  // Handle Tauri file drop on directory panel
  const handleTauriDirectoryDrop = useCallback(async (paths: string[]) => {
    if (isDebugMode()) {
      console.log('[Chat] Tauri drop on directory panel:', paths);
    }
    // DirectoryPanel handles this internally now
    await directoryPanelRef.current?.handleFileDrop(paths);
  }, []);

  // Use refs to avoid recreating onDrop callback when handlers change
  const handleTauriChatDropRef = useRef(handleTauriChatDrop);
  const handleTauriDirectoryDropRef = useRef(handleTauriDirectoryDrop);
  useEffect(() => {
    handleTauriChatDropRef.current = handleTauriChatDrop;
    handleTauriDirectoryDropRef.current = handleTauriDirectoryDrop;
  }, [handleTauriChatDrop, handleTauriDirectoryDrop]);

  const { isDragging: isTauriDragging, activeZoneId, registerZone, unregisterZone } = useTauriFileDrop({
    onDrop: (paths, zoneId) => {
      if (isDebugMode()) {
        console.log('[Chat] Tauri drop event - zoneId:', zoneId, 'paths:', paths);
      }
      if (zoneId === 'chat-content') {
        void handleTauriChatDropRef.current(paths);
      } else if (zoneId === 'directory-panel') {
        void handleTauriDirectoryDropRef.current(paths);
      } else {
        // Default: drop to chat area
        void handleTauriChatDropRef.current(paths);
      }
    },
  });

  // Register drop zones for Tauri (only for position detection, handlers are in onDrop above)
  useEffect(() => {
    if (!isTauriEnvironment()) return;

    // Register chat content drop zone (empty callback - handled in global onDrop)
    registerZone('chat-content', chatContentRef.current, () => {});

    // Register directory panel drop zone (empty callback - handled in global onDrop)
    registerZone('directory-panel', directoryPanelContainerRef.current, () => {});

    return () => {
      unregisterZone('chat-content');
      unregisterZone('directory-panel');
    };
  }, [registerZone, unregisterZone]);

  // Combined drag active state (HTML5 or Tauri)
  const isAnyDragActive = isDragActive || isTauriDragging;

  // MCP state
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [globalMcpEnabled, setGlobalMcpEnabled] = useState<string[]>([]);
  const [workspaceMcpEnabled, setWorkspaceMcpEnabled] = useState<string[]>(
    currentProject?.mcpEnabledServers ?? []
  );

  // Load MCP config on mount and sync to backend
  useEffect(() => {
    const loadMcpConfig = async () => {
      try {
        const servers = await getAllMcpServers();
        const enabledIds = await getEnabledMcpServerIds();
        setMcpServers(servers);
        setGlobalMcpEnabled(enabledIds);

        // CRITICAL: Always sync effective MCP servers to backend on initial load
        // This ensures the Agent SDK has correct MCP config (including empty = no MCP)
        // Without this, backend currentMcpServers stays null and falls back to file config
        const workspaceEnabled = currentProject?.mcpEnabledServers ?? [];
        const effectiveServers = servers.filter(s =>
          enabledIds.includes(s.id) && workspaceEnabled.includes(s.id)
        );

        // Always call /api/mcp/set, even with empty array
        // Empty array means "user explicitly disabled all MCP"
        // null (not calling) means "use file config fallback" - which we don't want
        await apiPost('/api/mcp/set', { servers: effectiveServers });
        if (isDebugMode()) {
          console.log('[Chat] Initial MCP sync:', effectiveServers.map(s => s.id).join(', ') || 'none');
        }
      } catch (err) {
        console.error('[Chat] Failed to load MCP config:', err);
      }
    };
    loadMcpConfig();
  }, [currentProject?.mcpEnabledServers]);

  // Sync workspace MCP to project config when it changes
  useEffect(() => {
    if (currentProject?.mcpEnabledServers) {
      setWorkspaceMcpEnabled(currentProject.mcpEnabledServers);
    }
  }, [currentProject?.mcpEnabledServers]);

  // Handle workspace MCP toggle
  const handleWorkspaceMcpToggle = useCallback(async (serverId: string, enabled: boolean) => {
    const newEnabled = enabled
      ? [...workspaceMcpEnabled, serverId]
      : workspaceMcpEnabled.filter(id => id !== serverId);

    setWorkspaceMcpEnabled(newEnabled);

    // Update project config
    if (currentProject) {
      await updateProjectMcpServers(currentProject.id, newEnabled);
    }

    // Get the effective MCP servers and send to backend
    const effectiveServers = mcpServers.filter(s =>
      globalMcpEnabled.includes(s.id) && newEnabled.includes(s.id)
    );

    try {
      await apiPost('/api/mcp/set', { servers: effectiveServers });
      console.log('[Chat] MCP servers synced:', effectiveServers.map(s => s.id));
    } catch (err) {
      console.error('[Chat] Failed to sync MCP servers:', err);
    }
  }, [workspaceMcpEnabled, currentProject, mcpServers, globalMcpEnabled]);

  // Sync selectedModel when provider changes
  useEffect(() => {
    if (currentProvider?.primaryModel) {
      setSelectedModel(currentProvider.primaryModel);
    }
  }, [currentProvider?.id, currentProvider?.primaryModel]);

  const { containerRef: messagesContainerRef, scrollToBottom } = useAutoScroll(isLoading, messages);

  // Auto-focus input when Tab becomes active
  useEffect(() => {
    if (isActive && inputRef.current) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isActive]);

  // Sync config when Tab becomes active (from inactive)
  // This ensures settings changes are picked up when switching back to Chat Tab
  useEffect(() => {
    const wasInactive = !prevIsActiveRef.current;
    prevIsActiveRef.current = isActive;

    // Only sync when Tab becomes active (was inactive, now active)
    if (!wasInactive || !isActive) return;

    const syncConfigOnTabActivate = async () => {
      try {
        // 1. Refresh provider data (providers list, API keys, verify status)
        await refreshProviderData();

        // 2. Reload MCP config and sync to backend
        const servers = await getAllMcpServers();
        const enabledIds = await getEnabledMcpServerIds();
        setMcpServers(servers);
        setGlobalMcpEnabled(enabledIds);

        // 3. Sync effective MCP servers to backend for next message
        const workspaceEnabled = currentProject?.mcpEnabledServers ?? [];
        const effectiveServers = servers.filter(s =>
          enabledIds.includes(s.id) && workspaceEnabled.includes(s.id)
        );
        await apiPost('/api/mcp/set', { servers: effectiveServers });

        if (isDebugMode()) {
          console.log('[Chat] Config synced on tab activate:', {
            providers: providers.length,
            mcpServers: servers.length,
            effectiveMcp: effectiveServers.map(s => s.id).join(', ') || 'none',
          });
        }
      } catch (err) {
        console.error('[Chat] Failed to sync config on tab activate:', err);
      }
    };

    void syncConfigOnTabActivate();
  }, [isActive, refreshProviderData, currentProject?.mcpEnabledServers, apiPost]);

  // Connect SSE when component mounts
  useEffect(() => {
    // Only connect if we have a valid agentDir
    if (!agentDir) return;

    void connectSse();

    // Cleanup: disconnect SSE on unmount
    return () => {
      disconnectSse();
    };
    // connectSse/disconnectSse are stable from TabProvider's useCallback
  }, [agentDir, connectSse, disconnectSse]);

  // Listen for skill copy events to refresh DirectoryPanel (file tree shows .claude/skills/)
  // Note: WorkspaceConfigPanel has its own event listener for internalRefreshKey
  useEffect(() => {
    const handleSkillCopied = () => {
      setWorkspaceRefreshTrigger(k => k + 1);
    };
    window.addEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
    return () => window.removeEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
  }, []);

  // PERFORMANCE: text is now passed from SimpleChatInput (which manages its own state)
  // This avoids re-rendering Chat on every keystroke
  const handleSendMessage = async (text: string, images?: ImageAttachment[]) => {
    // Allow sending if there's text OR images
    if ((!text && (!images || images.length === 0)) || isLoading || sessionState === 'running') {
      return;
    }

    // Scroll to bottom immediately so user sees their query
    // This also re-enables auto-scroll if user had scrolled up
    scrollToBottom();

    setIsLoading(true);

    // Note: User message is added by SSE replay from backend
    // TabProvider.sendMessage passes attachments which will be merged with the replay message

    try {
      // Build provider env from current provider config
      // For subscription type, don't send providerEnv (use SDK's default auth)
      const providerEnv = currentProvider && currentProvider.type !== 'subscription' ? {
        baseUrl: currentProvider.config.baseUrl,
        apiKey: apiKeys[currentProvider.id], // Get from stored apiKeys, not provider object
        authType: currentProvider.authType,
      } : undefined;

      const success = await sendMessage(text, images, permissionMode, selectedModel, providerEnv);
      if (!success) {
        const errorMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant' as const,
          content: 'Error: Failed to send message',
          timestamp: new Date()
        };
        setMessages((prev) => [...prev, errorMessage]);
        setIsLoading(false);
      }
    } catch (error) {
      const errorMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant' as const,
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        timestamp: new Date()
      };
      setMessages((prev) => [...prev, errorMessage]);
      setIsLoading(false);
    }
  };

  // Internal handler for starting a new session
  // This resets both frontend and backend state
  const handleNewSession = useCallback(async () => {
    if (onNewSession) {
      // Use external handler if provided
      onNewSession();
      return;
    }

    // Reset session on backend (stops any ongoing response + clears messages)
    // This also clears frontend state via resetSession()
    console.log('[Chat] Starting new session...');
    const success = await resetSession();
    if (success) {
      console.log('[Chat] New session started');
    } else {
      console.error('[Chat] Failed to start new session');
    }
  }, [onNewSession, resetSession]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--paper-strong)] text-[var(--ink)] md:flex-row">
      <div className={`flex min-w-0 flex-1 flex-col overflow-hidden border-b border-[var(--line-subtle)] md:border-r md:border-b-0 ${showWorkspace ? 'w-full md:w-3/4' : 'w-full'}`}>
        {/* Compact header - single row */}
        <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-[var(--line)] px-4">
          <div className="flex items-center gap-3">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                title="Back to projects"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            {/* Removed Session text as per PRD 0.0.8 requirement */}
          </div>
          <div className="flex items-center gap-2">
            {/* New Session button - before History */}
            <button
              type="button"
              onClick={handleNewSession}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
              title="新建对话"
            >
              <Plus className="h-3.5 w-3.5" />
              新对话
            </button>
            {/* History button */}
            <div className="relative">
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setShowHistory((prev) => !prev)}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] font-medium transition-colors ${showHistory
                  ? 'bg-[var(--paper-contrast)] text-[var(--ink)]'
                  : 'text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]'
                  }`}
              >
                <History className="h-3.5 w-3.5" />
                历史
              </button>
              <SessionHistoryDropdown
                agentDir={agentDir}
                currentSessionId={sessionId}
                onSelectSession={(id) => {
                  void loadSession(id);
                }}
                isOpen={showHistory}
                onClose={() => setShowHistory(false)}
              />
            </div>
            {/* Dev-only buttons - controlled by config.showDevTools */}
            {config.showDevTools && (
              <>
                <button
                  type="button"
                  onClick={() => setShowLogs((prev) => !prev)}
                  className={`rounded-lg px-2.5 py-1 text-[13px] font-medium transition-colors ${showLogs
                    ? 'bg-[var(--paper-contrast)] text-[var(--ink)]'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]'
                    }`}
                >
                  Logs
                </button>
                <button
                  type="button"
                  onClick={() => setShowSystemInfo(true)}
                  className="rounded-lg px-2.5 py-1 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                >
                  System Info
                </button>
              </>
            )}
            {/* Workspace toggle button - only show when workspace is hidden */}
            {!showWorkspace && (
              <button
                type="button"
                onClick={() => setShowWorkspace(true)}
                className="hidden md:flex items-center gap-1 rounded-lg px-2 py-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                title="展开工作区"
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Content area with relative positioning for floating input */}
        <div
          ref={chatContentRef}
          className="relative flex flex-1 flex-col overflow-hidden"
          {...dragHandlers}
        >
          {/* Drop zone overlay for file drag */}
          <DropZoneOverlay
            isVisible={isAnyDragActive && (!isTauriDragging || activeZoneId === 'chat-content' || activeZoneId === null)}
            message="松手将文件加入工作区"
            subtitle="非图片文件将复制到 myagents_files 并自动引用"
          />

          {agentError && (
            <div className="flex-shrink-0 border-b border-[var(--line)] bg-[#f5e4d9]/80 px-4 py-2 text-[11px] text-[var(--ink)]">
              <div className="mx-auto flex max-w-3xl items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                <div className="flex-1">
                  <span className="font-semibold text-[var(--ink)]">Agent error: </span>
                  <span className="text-[var(--ink-muted)]">{agentError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setAgentError(null)}
                  className="flex-shrink-0 rounded px-2 py-0.5 text-[10px] font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)]"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {/* Unified Logs Panel - fullscreen modal displaying logs */}
          <UnifiedLogsPanel
            sseLogs={unifiedLogs}
            isVisible={showLogs}
            onClose={() => setShowLogs(false)}
            onClearAll={clearUnifiedLogs}
          />

          {/* Message list with max-width */}
          <MessageList
            messages={messages}
            isLoading={isLoading}
            containerRef={messagesContainerRef}
            bottomPadding={140}
            pendingPermission={pendingPermission}
            onPermissionDecision={(decision) => void respondPermission(decision)}
            pendingAskUserQuestion={pendingAskUserQuestion}
            onAskUserQuestionSubmit={(_requestId, answers) => void respondAskUserQuestion(answers)}
            onAskUserQuestionCancel={() => void respondAskUserQuestion(null)}
            systemStatus={systemStatus}
          />

          {/* Floating input - manages its own state for performance */}
          <SimpleChatInput
            ref={chatInputRef}
            onSend={handleSendMessage}
            onStop={async () => {
              try {
                await stopResponse();
              } catch (error) {
                console.error('[Chat] Failed to stop message:', error);
              }
            }}
            isLoading={isLoading || sessionState === 'running'}
            systemStatus={systemStatus}
            agentDir={agentDir}
            provider={currentProvider}
            providers={providers}
            onProviderChange={(providerId) => {
              // Update project's provider (via useConfig)
              if (currentProject) {
                void updateProject({ ...currentProject, providerId });
              }
            }}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            apiKeys={apiKeys}
            providerVerifyStatus={providerVerifyStatus}
            inputRef={inputRef}
            workspaceMcpEnabled={workspaceMcpEnabled}
            globalMcpEnabled={globalMcpEnabled}
            mcpServers={mcpServers}
            onWorkspaceMcpToggle={handleWorkspaceMcpToggle}
            onRefreshProviders={refreshProviderData}
            onOpenAgentSettings={() => setShowWorkspaceConfig(true)}
            onWorkspaceRefresh={triggerWorkspaceRefresh}
          />
        </div>
      </div>

      {showWorkspace && (
        <div
          ref={directoryPanelContainerRef}
          className="flex w-full flex-col md:w-1/4"
          style={{ minWidth: 'var(--sidebar-min-width)' }}
        >
          <DirectoryPanel
            ref={directoryPanelRef}
            agentDir={agentDir}
            provider={currentProvider}
            providers={providers}
            onProviderChange={(providerId) => {
              // Update project's provider (via useConfig)
              if (currentProject) {
                void updateProject({ ...currentProject, providerId });
              }
            }}
            onCollapse={() => setShowWorkspace(false)}
            onOpenConfig={() => setShowWorkspaceConfig(true)}
            refreshTrigger={toolCompleteCount + workspaceRefreshTrigger}
            isTauriDragActive={isTauriDragging && activeZoneId === 'directory-panel'}
            onInsertReference={(paths) => chatInputRef.current?.insertReferences(paths)}
          />
        </div>
      )}

      {showSystemInfo && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          style={{ padding: '5vh 3vw' }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowSystemInfo(false);
            }
          }}
        >
          <div className="glass-panel flex h-full w-full max-w-4xl flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
              <div>
                <div className="text-[13px] font-semibold text-[var(--ink)]">System Info</div>
                <div className="text-[11px] text-[var(--ink-muted)]">
                  Init details for the current session.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSystemInfo(false)}
                className="action-button px-3 py-1 text-[11px] font-semibold"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-auto overscroll-contain px-5 py-4">
              <SystemInfoPanel info={systemInitInfo} showHeader={false} />
            </div>
          </div>
        </div>
      )}

      {/* Workspace Config Panel */}
      {showWorkspaceConfig && (
        <WorkspaceConfigPanel
          agentDir={agentDir}
          onClose={() => setShowWorkspaceConfig(false)}
          refreshKey={workspaceRefreshKey}
        />
      )}
    </div>
  );
}
