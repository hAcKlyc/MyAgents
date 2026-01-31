import { useCallback, useEffect, useState, useRef } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { startTabSidecar, stopTabSidecar, startGlobalSidecar, stopAllSidecars, initGlobalSidecarReadyPromise, markGlobalSidecarReady, getGlobalServerUrl, resetGlobalSidecarReadyPromise } from '@/api/tauriClient';
import CustomTitleBar from '@/components/CustomTitleBar';
import TabBar from '@/components/TabBar';
import TabProvider from '@/context/TabProvider';
import { useUpdater } from '@/hooks/useUpdater';
import Chat from '@/pages/Chat';
import Launcher from '@/pages/Launcher';
import Settings from '@/pages/Settings';
import {
  type Project,
  type Provider,
} from '@/config/types';
import { type Tab, createNewTab, getFolderName, MAX_TABS } from '@/types/tab';
import { isBrowserDevMode, isTauriEnvironment } from '@/utils/browserMock';
import { forceFlushLogs, setLogServerUrl, clearLogServerUrl } from '@/utils/frontendLogger';
import { CUSTOM_EVENTS } from '../shared/constants';

export default function App() {
  // Auto-update state (silent background updates)
  const { updateReady, updateVersion, restartAndUpdate } = useUpdater();

  // Multi-tab state
  const [tabs, setTabs] = useState<Tab[]>(() => [createNewTab()]);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => tabs[0]?.id ?? null);

  // Per-tab loading state (keyed by tabId)
  const [loadingTabs, setLoadingTabs] = useState<Record<string, boolean>>({});
  const [tabErrors, setTabErrors] = useState<Record<string, string | null>>({});

  // Global Sidecar silent retry mechanism
  const mountedRef = useRef(true);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  // Silent background retry with exponential backoff
  const startGlobalSidecarSilent = useCallback(async () => {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 2000; // 2 seconds

    try {
      // Reset and reinitialize the ready promise for retry
      if (retryCountRef.current > 0) {
        resetGlobalSidecarReadyPromise();
        initGlobalSidecarReadyPromise();
      }

      await startGlobalSidecar();

      if (!mountedRef.current) return;

      markGlobalSidecarReady();
      retryCountRef.current = 0; // Reset on success

      // Set log server URL to global sidecar for unified logging
      try {
        const globalUrl = await getGlobalServerUrl();
        setLogServerUrl(globalUrl);
        console.log('[App] Global sidecar started, log URL set:', globalUrl);
      } catch (e) {
        console.warn('[App] Failed to set log server URL:', e);
      }
    } catch (error) {
      if (!mountedRef.current) return;

      retryCountRef.current += 1;
      const currentRetry = retryCountRef.current;

      if (currentRetry <= MAX_RETRIES) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s
        const delay = BASE_DELAY * Math.pow(2, currentRetry - 1);
        console.log(`[App] Global sidecar failed, retry ${currentRetry}/${MAX_RETRIES} in ${delay}ms`);

        retryTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            void startGlobalSidecarSilent();
          }
        }, delay);
      } else {
        // Max retries reached, mark as ready to unblock waiting components
        markGlobalSidecarReady();
        console.error('[App] Global sidecar failed after max retries:', error);
      }
    }
  }, []);

  // Start Global Sidecar on mount, cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    retryCountRef.current = 0;

    // Initialize the ready promise BEFORE starting the sidecar
    // This allows other components to wait for it
    initGlobalSidecarReadyPromise();

    // Start Global Sidecar immediately on app launch
    // This ensures MCP and other global API calls work from any page
    void startGlobalSidecarSilent();

    return () => {
      mountedRef.current = false;
      // Clear any pending retry
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      // Flush any pending frontend logs before shutdown
      forceFlushLogs();
      clearLogServerUrl();
      void stopAllSidecars();
    };
  }, [startGlobalSidecarSilent]);

  // Update tab isGenerating state (called from TabProvider via callback)
  const updateTabGenerating = useCallback((tabId: string, isGenerating: boolean) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, isGenerating } : t
    ));
  }, []);

  // Close tab with confirmation if generating
  const closeTabWithConfirmation = useCallback((tabId: string) => {
    // Step 1: Read current tab state (outside setState to avoid side effects in updater)
    const tab = tabs.find(t => t.id === tabId);

    // Step 2: Execute side effect (window.confirm) outside setState
    if (tab?.isGenerating) {
      const confirmed = window.confirm('内容生成中，确认要关闭么？');
      if (!confirmed) {
        // User cancelled - abort the close operation
        return;
      }
    }

    // Step 3: Pure function state update
    setTabs((currentTabs) => {
      // Double-check: tab might have been removed during confirmation
      const latestTab = currentTabs.find(t => t.id === tabId);
      if (!latestTab) return currentTabs;

      // Stop this Tab's Sidecar when closing (only if it has an agentDir)
      if (latestTab.agentDir) {
        void stopTabSidecar(tabId);
      }

      // Perform close
      const newTabs = currentTabs.filter((t) => t.id !== tabId);

      // If closing the active tab, switch to the last remaining tab
      if (tabId === activeTabId && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }

      // If no tabs left, create a new launcher tab
      if (newTabs.length === 0) {
        const newTab = createNewTab();
        setActiveTabId(newTab.id);
        return [newTab];
      }

      return newTabs;
    });
  }, [tabs, activeTabId]);

  // Close current active tab (for Cmd+W)
  const closeCurrentTab = useCallback(() => {
    if (!activeTabId) return;

    const activeTab = tabs.find(t => t.id === activeTabId);

    // Special case: If on launcher page and it's the only tab, close the window
    if (activeTab?.view === 'launcher' && tabs.length === 1) {
      if (isTauriEnvironment()) {
        void getCurrentWindow().close();
      }
      return;
    }

    // Special case: If this is the last tab (non-launcher), replace with launcher instead of closing
    // This prevents the app from closing on Windows when the last tab is closed
    if (tabs.length === 1) {
      // Check if generating - ask for confirmation first
      if (activeTab?.isGenerating) {
        const confirmed = window.confirm('内容生成中，确认要关闭么？');
        if (!confirmed) return;
      }

      // Create new launcher tab first (before cleanup to avoid empty state)
      const newTab = createNewTab();
      setTabs([newTab]);
      setActiveTabId(newTab.id);

      // Clean up the old tab's sidecar if needed
      if (activeTab?.agentDir) {
        void stopTabSidecar(activeTabId);
      }
      return;
    }

    // Normal case: close with confirmation (multiple tabs exist)
    closeTabWithConfirmation(activeTabId);
  }, [activeTabId, tabs, closeTabWithConfirmation]);

  // Keyboard shortcuts: Cmd+T (new tab), Cmd+W (close tab)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      if (!modKey) return;

      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        // New tab
        if (tabs.length < MAX_TABS) {
          const newTab = createNewTab();
          setTabs((prev) => [...prev, newTab]);
          setActiveTabId(newTab.id);
        }
      } else if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        closeCurrentTab();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tabs, closeCurrentTab]);

  const handleLaunchProject = useCallback(async (
    project: Project,
    _provider: Provider,
    sessionId?: string
  ) => {
    if (!activeTabId) return;

    setTabErrors((prev) => ({ ...prev, [activeTabId]: null }));
    setLoadingTabs((prev) => ({ ...prev, [activeTabId]: true }));

    try {
      console.log('[App] Starting sidecar for project:', project.path, 'sessionId:', sessionId);

      // Start a Tab-specific Sidecar instance
      const status = await startTabSidecar(activeTabId, project.path);
      console.log('[App] Tab sidecar started:', status);

      // Update tab to chat view with project info and optional sessionId
      // SSE will be connected by TabProvider, which will load the session if sessionId is provided
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? {
              ...t,
              agentDir: project.path,
              sessionId: sessionId ?? null,
              view: 'chat',
              title: getFolderName(project.path),
            }
            : t
        )
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[App] Failed to start:', errorMsg);
      setTabErrors((prev) => ({ ...prev, [activeTabId]: errorMsg }));

      // In browser dev mode, still allow navigation
      if (isBrowserDevMode()) {
        console.log('[App] Browser mode: continuing despite error');
        setTabs((prev) =>
          prev.map((t) =>
            t.id === activeTabId
              ? {
                ...t,
                agentDir: project.path,
                view: 'chat',
                title: getFolderName(project.path),
              }
              : t
          )
        );
      }
    } finally {
      setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
    }
  }, [activeTabId]);

  const handleBackToLauncher = useCallback(() => {
    if (!activeTabId) return;

    // Stop this Tab's Sidecar
    void stopTabSidecar(activeTabId);

    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, agentDir: null, sessionId: null, view: 'launcher', title: 'New Tab' }
          : t
      )
    );
  }, [activeTabId]);

  const handleSelectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  const handleCloseTab = useCallback((tabId: string) => {
    closeTabWithConfirmation(tabId);
  }, [closeTabWithConfirmation]);

  const handleNewTab = useCallback(() => {
    if (tabs.length >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    const newTab = createNewTab();
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [tabs.length]);

  // Handle tab reordering via drag and drop
  const handleReorderTabs = useCallback((activeId: string, overId: string) => {
    setTabs((prev) => {
      const oldIndex = prev.findIndex((t) => t.id === activeId);
      const newIndex = prev.findIndex((t) => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  // Settings initial section state (for deep linking to specific section)
  const [settingsInitialSection, setSettingsInitialSection] = useState<string | undefined>(undefined);

  // Open Settings as a new tab (or switch to existing one)
  // Optional initialSection parameter to open a specific section (e.g., 'providers')
  const handleOpenSettings = useCallback(async (initialSection?: string) => {
    // Set initial section for Settings component
    setSettingsInitialSection(initialSection);

    // Check if there's already a Settings tab
    const existingSettingsTab = tabs.find((t) => t.view === 'settings');
    if (existingSettingsTab) {
      // Switch to existing Settings tab
      setActiveTabId(existingSettingsTab.id);
      return;
    }

    // Create new Settings tab
    if (tabs.length >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }

    // Create Tab first (instant UI response)
    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: null,
      sessionId: null,
      view: 'settings',
      title: '设置',
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);

    // Global Sidecar is now started on App mount, no need to start here
  }, [tabs]);

  // Listen for OPEN_SETTINGS custom event from child components
  useEffect(() => {
    const handleOpenSettingsEvent = (event: CustomEvent<{ section?: string }>) => {
      handleOpenSettings(event.detail?.section);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, handleOpenSettingsEvent as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, handleOpenSettingsEvent as EventListener);
    };
  }, [handleOpenSettings]);

  return (
    <div className="flex h-screen flex-col bg-[var(--paper)]">
      {/* Chrome-style titlebar with tabs */}
      <CustomTitleBar
        onSettingsClick={handleOpenSettings}
        updateReady={updateReady}
        updateVersion={updateVersion}
        onRestartAndUpdate={() => void restartAndUpdate()}
      >
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
          onReorderTabs={handleReorderTabs}
        />
      </CustomTitleBar>

      {/* Tab content - only Chat views need TabProvider for sidecar communication */}
      <div className="relative flex-1 overflow-hidden">
        {tabs.map((tab) => {
          const isLoading = loadingTabs[tab.id] ?? false;
          const error = tabErrors[tab.id] ?? null;
          const isActive = tab.id === activeTabId;

          return (
            <div
              key={tab.id}
              className={`absolute inset-0 ${isActive ? '' : 'pointer-events-none invisible'}`}
            >
              {/* Launcher and Settings use Global Sidecar - no TabProvider needed */}
              {tab.view === 'launcher' ? (
                <Launcher
                  onLaunchProject={handleLaunchProject}
                  isStarting={isLoading}
                  startError={error}
                  onOpenSettings={handleOpenSettings}
                />
              ) : tab.view === 'settings' ? (
                <Settings
                  initialSection={settingsInitialSection}
                  onSectionChange={() => setSettingsInitialSection(undefined)}
                />
              ) : (
                /* Chat views use Tab Sidecar - wrapped in TabProvider */
                <TabProvider
                  tabId={tab.id}
                  agentDir={tab.agentDir ?? ''}
                  sessionId={tab.sessionId}
                  isActive={isActive}
                  onGeneratingChange={(isGenerating) => updateTabGenerating(tab.id, isGenerating)}
                >
                  <Chat onBack={handleBackToLauncher} />
                </TabProvider>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
