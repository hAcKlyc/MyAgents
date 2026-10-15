import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('App Shell chrome contract', () => {
  it('keeps Runtime switching in model selection and never gates send on input chrome', () => {
    const chat = source('src/renderer/pages/Chat.tsx');
    const send = chat.slice(chat.indexOf('const handleSendMessage = useCallback'), chat.indexOf('// Ref-stabilize handleSendMessage'));
    expect(send).toContain('sendMessage(');
    const admissionChecks = send.slice(0, send.indexOf('scrollToBottom()'));
    expect(admissionChecks).not.toContain('inputUsesExternalRuntimeControls');
    expect(send).not.toContain('codexSubscriptionNeedsSession');
    expect(send).not.toContain('onLaunchNewSession');
  });

  it('saves an active Record note before tab close, app exit, or update restart', () => {
    const app = source('src/renderer/App.tsx');
    const recordLifecycle = source(
      'src/renderer/features/record/useRecordTabLifecycle.tsx',
    );
    const recordClose = recordLifecycle.slice(
      recordLifecycle.indexOf('const confirm = useCallback'),
      recordLifecycle.indexOf('const adapter = useMemo'),
    );
    const exitConfirm = app.slice(
      app.indexOf('{exitConfirmState && ('),
      app.indexOf('{/* Windows: startup dialog'),
    );
    const updateGuard = app.slice(
      app.indexOf('const handleRestartAndUpdate = useCallback'),
      app.indexOf('// System tray event handling'),
    );

    expect(recordClose.indexOf('flushPendingNote')).toBeLessThan(
      recordClose.indexOf('stopRecording'),
    );
    expect(exitConfirm.indexOf('flushPendingRecordNote')).toBeLessThan(
      exitConfirm.indexOf('pending.resolve(true)'),
    );
    const myagentsUpdateGuard = updateGuard.slice(updateGuard.indexOf('if (!(await requestLifecycleExitConfirmation()))'));
    expect(
      myagentsUpdateGuard.indexOf('requestLifecycleExitConfirmation()'),
    ).toBeLessThan(myagentsUpdateGuard.indexOf('performRestartAndUpdate()'));
    const moxbotUpdateGuard = updateGuard.slice(0, updateGuard.indexOf('if (!(await requestLifecycleExitConfirmation()))'));
    expect(moxbotUpdateGuard).not.toContain('requestLifecycleExitConfirmation()');
    const checkpoint = moxbotUpdateGuard.indexOf('await checkpoint.persist(');
    const restart = moxbotUpdateGuard.indexOf('await performRestartAndUpdate(checkpoint, true)');
    const recordSave = moxbotUpdateGuard.indexOf('pendingRecordNoteSubmittersRef.current.values()');
    const fileSave = moxbotUpdateGuard.indexOf('fileEditSubmittersRef.current.values()');
    expect(recordSave).toBeGreaterThanOrEqual(0);
    expect(fileSave).toBeGreaterThanOrEqual(0);
    expect(checkpoint).toBeGreaterThanOrEqual(0);
    const confirmation = moxbotUpdateGuard.indexOf('if (!confirmed)');
    expect(confirmation).toBeGreaterThanOrEqual(0);
    expect(confirmation).toBeLessThan(recordSave);
    expect(restart).toBeGreaterThan(checkpoint);
    expect(recordSave).toBeLessThan(checkpoint);
    expect(fileSave).toBeLessThan(checkpoint);
    expect(app).toContain('onExitRequested: requestLifecycleExitConfirmation');
  });

  it('keeps Chat navigation tab-owned instead of exposing a back-to-launcher path', () => {
    const chat = source('src/renderer/pages/Chat.tsx');
    const app = source('src/renderer/App.tsx');

    expect(chat).not.toContain('ArrowLeft');
    expect(chat).not.toContain('onBack');
    expect(chat).not.toContain('shell.header.backToProjects');
    expect(app).not.toContain('handleBackToLauncher');
    expect(app).not.toContain('onBack={');
  });

  it('keeps the Chat owner subtree mounted while its existing boot surface covers startup', () => {
    const chat = source('src/renderer/pages/Chat.tsx');
    const app = source('src/renderer/App.tsx');
    const chatTabModule = source('src/renderer/features/chat/tabModule.tsx');
    const tabProvider = source('src/renderer/context/TabProvider.tsx');

    expect(chatTabModule).toContain(
      '<Suspense fallback={<ChatBootOverlay />}>',
    );
    expect(app).not.toContain(') : isLoading ? (\n        <ChatBootOverlay />');
    expect(chat).toContain('show={showStartupOverlay || isSessionLoading}');
    // The launch query belongs only to MessageList, underneath the boot shell.
    expect(chat).not.toContain('initialMessage={showStartupOverlay');
    expect(chat).toContain('onItemsRendered={handleStartupItemsRendered}');
    expect(chat).toContain('error={sessionRestoreError}');
    expect(chat).not.toContain(
      "isSessionLoading && sessionRestoreMode === 'live-recovery'",
    );
    expect(chat).toMatch(/if\s*\(\s*isSessionLoading\s*\|\|\s*\(!text/);
    expect(chat).toContain('sendBlocked={isSessionLoading}');
    expect(
      tabProvider.match(/isRestoreActionBlocked/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(6);
    const replacementHandler = tabProvider.slice(
      tabProvider.indexOf(
        "listenWithCleanup<{ sessionId: string; port: number }>('session-sidecar:restarted'",
      ),
      tabProvider.indexOf('// Send message with optional images'),
    );
    expect(replacementHandler).not.toContain("restore.phase === 'failed'");
  });

  it('uses one simple right-panel glyph and custom tips at the stable far-right slot', () => {
    const chat = source('src/renderer/pages/Chat.tsx');
    const directory = source(
      'src/renderer/components/directory-panel/DirectoryPanel.tsx',
    );
    const rightActions = directory.slice(
      directory.indexOf('{/* Right side buttons */}'),
      directory.indexOf('{/* Collapsible content'),
    );

    expect(chat).toContain('<PanelRightIcon className="h-4 w-4" />');
    expect(chat).not.toContain('PanelRightOpen');
    expect(directory).toContain('<PanelRightIcon className="h-4 w-4" />');
    expect(directory).not.toContain('PanelRightClose');
    expect(
      rightActions.indexOf('workspaceFiles.directory.agentSettings'),
    ).toBeLessThan(
      rightActions.indexOf('workspaceFiles.directory.collapseWorkspace'),
    );
    expect(rightActions).toContain(
      'className="compact-action ',
    );
    expect(chat).toContain(
      'className="flex h-7 w-7 items-center justify-center rounded-lg',
    );
    expect(rightActions).toContain('aria-label={isCollapsed');
    expect(rightActions).toContain('<Tip');
    expect(rightActions).not.toContain('title=');
  });

  it('keeps the Chat workspace header focused on identity instead of inventory counts', () => {
    const directory = source(
      'src/renderer/components/directory-panel/DirectoryPanel.tsx',
    );
    const locales = [
      source('src/renderer/i18n/locales/zh-CN/chat.json'),
      source('src/renderer/i18n/locales/en-US/chat.json'),
    ];

    expect(directory).not.toContain('workspaceFiles.directory.stats');
    expect(
      locales.every((locale) => !locale.includes('"stats": "{{files}}')),
    ).toBe(true);
  });

  it('gives the workspace name priority while keeping the git branch badge on one line', () => {
    const directory = source(
      'src/renderer/components/directory-panel/DirectoryPanel.tsx',
    );
    const identityRow = directory.slice(
      directory.indexOf('{/* First row: name and git branch */}'),
      directory.indexOf('{/* Second row: path */}'),
    );

    expect(identityRow).toContain(
      'className="min-w-0 flex-1 truncate text-sm font-medium',
    );
    expect(identityRow).toContain('max-w-[45%] shrink-0');
    expect(identityRow).toContain('overflow-hidden whitespace-nowrap');
    expect(identityRow).toContain(
      '<span className="min-w-0 truncate">{gitBranch}</span>',
    );
  });

  it('uses the global new-chat glyph for the matching Chat header action', () => {
    const chat = source('src/renderer/pages/Chat.tsx');
    const newSessionAction = chat.slice(
      chat.indexOf('{/* New Session button - before History */}'),
      chat.indexOf('{/* History button */}'),
    );

    expect(newSessionAction).toContain(
      '<ComposeIcon className="h-3.5 w-3.5 flex-shrink-0" />',
    );
    expect(newSessionAction).not.toContain('<PlusIcon ');
  });

  it('gates the legacy Chat history entry behind its default-off developer setting', () => {
    const chat = source('src/renderer/pages/Chat.tsx');
    const settings = source('src/renderer/pages/settings/SettingsPage.tsx');
    const config = source('src/shared/config-types.ts');

    expect(config).toContain('showChatHistoryEntry: false,');
    expect(chat).toContain(
      'const isChatHistoryEntryVisible = config.showChatHistoryEntry === true;',
    );
    expect(chat).toContain(
      'if (!isChatHistoryEntryVisible) setShowHistory(false);',
    );
    expect(chat).toContain('{isChatHistoryEntryVisible && (');
    expect(chat).toContain('<SessionHistoryDropdown');
    expect(chat).toContain("handleSelectSession(id, title, 'chat_dropdown')");
    expect(settings).toContain('about.developer.chatHistoryEntryTitle');
    expect(settings).toMatch(
      /updateConfig\(\{\s*showChatHistoryEntry:\s*config\.showChatHistoryEntry !== true,?\s*\}\)/,
    );
    expect(settings.indexOf('about.developer.devModeTitle')).toBeLessThan(
      settings.indexOf('about.developer.chatHistoryEntryTitle'),
    );
  });

  it('keeps the right workspace toolbar free of a redundant text heading', () => {
    const directory = source(
      'src/renderer/components/directory-panel/DirectoryPanel.tsx',
    );

    expect(directory).not.toContain('workspaceFiles.directory.title');
    expect(directory).toContain('workspaceFiles.directory.fileSearch');
    expect(directory).toContain('workspaceFiles.directory.openAgentSettings');
  });

  it('wires layout-aware pointer leave handling to the forced-rail workspace flyout', () => {
    const sidebar = source(
      'src/renderer/components/global-sidebar/GlobalSidebar.tsx',
    );

    expect(sidebar).toContain('onPointerLeave={handleFlyoutPointerLeave}');
    expect(sidebar).toContain(
      'isPointerWithinBounds(bounds, event.clientX, event.clientY)',
    );
    expect(sidebar).toContain('previousActiveTabIdRef');
    expect(sidebar).not.toContain('pendingSessionNavigationRef');
  });

  it('animates the sidebar material without continuously resizing the Tab workspace', () => {
    const sidebar = source(
      'src/renderer/components/global-sidebar/GlobalSidebar.tsx',
    );
    const titlebar = source('src/renderer/components/CustomTitleBar.tsx');
    const tabbar = source('src/renderer/components/TabBar.tsx');
    const app = source('src/renderer/App.tsx');
    const styles = source('src/renderer/index.css');

    expect(sidebar).toContain(
      '[--global-sidebar-surface:var(--global-sidebar-bg)]',
    );
    expect(titlebar).toContain('bg-[var(--global-sidebar-bg)]');
    expect(titlebar).not.toContain('border-b border-[var(--line)]');
    expect(tabbar).toMatch(
      /background:\s*["']var\(--global-sidebar-bg\)["']/,
    );
    expect(tabbar).toMatch(
      /maskImage:\s*["']linear-gradient\(to right, #000 0%, rgba\(0, 0, 0, 0\) 100%\)["']/,
    );
    expect(tabbar).not.toContain('var(--paper-a0)');
    expect(sidebar).toContain(
      'data-global-sidebar-motion={sidebarMotion ?? undefined}',
    );
    expect(sidebar).toMatch(
      /data-global-sidebar-titlebar-follow=\{isWindows \? ["']full["'] : ["']toggle-slot["']\}/,
    );
    expect(sidebar).not.toContain('transition-[width]');
    expect(app).toContain('data-tab-content-workspace');
    expect(styles).toContain('.global-sidebar::before');
    expect(styles).toContain(
      'transition: clip-path var(--duration-normal) var(--ease-in-out)',
    );
    expect(styles).toContain(
      ".global-sidebar[data-global-sidebar-mode='rail']::before",
    );
    expect(styles).toContain(
      "[data-global-sidebar-motion='collapse'] ~ [data-tab-workspace]",
    );
    expect(styles).toContain(
      "[data-global-sidebar-motion='expand'] ~ [data-tab-workspace]",
    );
    expect(styles).toContain(
      "[data-global-sidebar-titlebar-follow='full'][data-global-sidebar-motion='collapse']",
    );
    expect(styles).toContain('@keyframes app-shell-sidebar-follow');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('--global-sidebar-rail-width: 64px;');
    expect(styles).toContain('--global-sidebar-tabbar-toggle-inset: 60px;');
    expect(styles).toContain('--global-sidebar-tab-content-shift: 140px;');
    expect(styles).toContain('--global-sidebar-content-center-shift: 96px;');
    expect(styles).toContain('--global-sidebar-brand-icon-left: 22px;');
  });

  it('mirrors real Chat workspace disclosure edges without replaying them for reveal navigation', () => {
    const chat = source('src/renderer/pages/Chat.tsx');
    const styles = source('src/renderer/index.css');
    const workspaceStylesStart = styles.indexOf(
      '/* Chat mirrors the App Shell choreography',
    );
    const workspaceStylesEnd = styles.indexOf(
      '@media (prefers-reduced-motion: reduce)',
      workspaceStylesStart,
    );
    const workspaceStyles = styles.slice(
      workspaceStylesStart,
      workspaceStylesEnd,
    );

    expect(chat).toMatch(/const \[workspacePanelDisclosure, dispatchWorkspacePanelDisclosure\]\s*=\s*useReducer\(/);
    expect(chat).toContain('reduceWorkspacePanelDisclosure,');
    expect(chat).toMatch(/\(\) =>\s*createWorkspacePanelDisclosureState\(shouldShowWorkspaceByDefault\(\)\),/);
    expect(chat).toContain("dispatchWorkspacePanelDisclosure({ type: 'open' });");
    expect(chat).toContain("dispatchWorkspacePanelDisclosure({ type: 'close' });");
    expect(chat).toContain("dispatchWorkspacePanelDisclosure({ type: 'settle-close' });");
    expect(chat).not.toContain("setWorkspacePanelMotion('expand')");
    expect(chat).toContain('clearWorkspacePanelUnmountTimer();');
    expect(chat).toContain('{workspacePanelMounted && (');
    expect(chat).toContain('data-chat-workspace-motion=');
    expect(chat).toContain('data-chat-conversation');
    expect(chat).toMatch(/data-chat-workspace-panel-motion=\{\s*workspacePanelMotion \?\? undefined\s*\}/);
    expect(chat).toContain('data-chat-workspace-divider');
    expect(chat).toContain('absolute bottom-4 left-0 top-4 z-20 w-px');
    expect(chat).not.toContain('flex-col border-l border-[var(--line-subtle)]');
    expect(chat).toContain('<OverlayBackdrop');
    expect(styles).toContain('@keyframes chat-workspace-panel-expand');
    expect(styles).toContain('@keyframes chat-workspace-panel-collapse');
    expect(styles).toContain('@keyframes chat-workspace-conversation-follow');
    expect(styles).toContain("[data-chat-workspace-panel-motion='collapse'] {");
    expect(workspaceStyles).not.toContain('transition: width');
  });

  it('lets the capabilities heading scroll away while only its subtabs stick', () => {
    const settings = source('src/renderer/pages/settings/SettingsPage.tsx');
    const pageHeaderIndex = settings.indexOf('data-capabilities-page-header');
    const stickyTabsIndex = settings.indexOf('data-capabilities-sticky-tabs');

    expect(pageHeaderIndex).toBeGreaterThan(-1);
    expect(stickyTabsIndex).toBeGreaterThan(pageHeaderIndex);
    expect(
      settings.slice(pageHeaderIndex - 160, pageHeaderIndex),
    ).not.toContain('sticky');
    expect(settings.slice(stickyTabsIndex - 180, stickyTabsIndex)).toContain(
      'sticky top-0',
    );
    expect(settings).toContain(
      'className="h-full flex-1 overflow-y-auto overscroll-contain"',
    );
  });

  it('opens history search with immediate chrome and virtualizes the empty-query archive', () => {
    const sidebar = source(
      'src/renderer/components/global-sidebar/GlobalSidebar.tsx',
    );
    const overlay = source(
      'src/renderer/components/HistorySearchOverlayContent.tsx',
    );
    const storeProjection = source('src/renderer/hooks/useTaskCenterData.ts');

    expect(sidebar).toMatch(
      /const loadHistorySearchOverlayContent = \(\) =>\s*import/,
    );
    for (const event of ['onPointerEnter', 'onFocus']) {
      expect(sidebar).toMatch(new RegExp(
        `${event}=\\{\\(\\) => \\{\\s*void loadHistorySearchOverlayContent\\(\\);\\s*\\}\\}`,
      ));
    }
    expect(sidebar).toContain(
      '<HistorySearchOverlayFrame onClose={handleSearchClose}>',
    );
    expect(sidebar).toMatch(
      /<Suspense\s+fallback=\{\s*<HistorySearchOverlayFallback onClose=\{handleSearchClose\} \/>\s*\}\s*>/,
    );
    expect(sidebar).not.toContain(
      '<Suspense fallback={null}>\n          <HistorySearchOverlayContent',
    );
    expect(sidebar).toContain('data-history-search-fallback-filters');
    expect(sidebar).toContain('data-history-search-fallback-compact');
    expect(sidebar).not.toContain('initialMode="search"');

    expect(overlay).toContain("import { Virtuoso } from 'react-virtuoso'");
    expect(overlay).not.toContain('<OverlayBackdrop');
    expect(overlay).not.toContain('overlayFadeIn');
    expect(overlay).not.toContain('overlayPanelIn');
    expect(overlay).toContain('data={browseRows}');
    expect(overlay).toContain('data-history-search-compact-trigger');
    expect(overlay).toContain('data-history-search-expanding-surface');
    expect(overlay).not.toContain('filteredSessions.map');
    expect(overlay).not.toContain('task-center-overlay-open');
    expect(storeProjection).toContain(
      "reason: 'global-sidebar-search', silent: true",
    );
  });

  it('owns macOS traffic-light geometry at the native window layout boundary', () => {
    const app = source('src-tauri/src/lib.rs');
    const trafficLights = source('src-tauri/src/macos_traffic_light.rs');
    const nativeOwnerSources = `${app}\n${trafficLights}`;

    expect(app).toContain('macos_traffic_light::install_native_layout_owner(');
    expect(nativeOwnerSources).not.toContain('.traffic_light_position(');
    expect(trafficLights).toContain('NSWindowDidResizeNotification');
    expect(trafficLights).toContain('NSWindowDidEnterFullScreenNotification');
    expect(trafficLights).toContain('NSWindowDidExitFullScreenNotification');
    expect(trafficLights).toContain(
      'NSWindowDidChangeBackingPropertiesNotification',
    );
    expect(trafficLights).toContain('let ns_window_ptr = window.ns_window()');
    expect(trafficLights).toContain('Some(ns_window),');
    expect(trafficLights).toContain('objc_setAssociatedObject(');
    expect(nativeOwnerSources).not.toContain('WindowEvent::Resized');
    expect(app).toContain('const MAIN_TRAFFIC_LIGHT_X: f64 = 15.0;');
  });
});
