// Presentation behavior tests for registry-backed content slots. Restored
// Sessions always mount TabProvider, while the heavy Chat child may stay
// deferred until the active shell has painted.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PendingAppRoute } from '@/../shared/appRoute';
import type { RecordingSnapshot, RecordingSourceSelection } from '@/../shared/types/record';
import type { CapabilitiesTab, ChatTab, SettingsTab, TaskCenterTab } from '@/types/tab';
import type { MainWindowPresentation } from '@/utils/mainWindowPresentation';
import { BuiltinTabSlot, type BuiltinTabBindings } from '@/tab-workspace/BuiltinTabSlot';

const tabProviderSpy = vi.fn();
vi.mock('@/context/TabProvider', () => ({
  default: ({ children }: { children: ReactNode }) => {
    tabProviderSpy();
    return <div data-testid="tab-provider">{children}</div>;
  },
}));

const chatRenderSpy = vi.hoisted(() => vi.fn());
const taskCenterRenderSpy = vi.hoisted(() => vi.fn());
const taskCenterSnapshotSpy = vi.hoisted(() => vi.fn());
vi.mock('@/pages/Chat', () => ({
  default: ({ windowPresentation }: { windowPresentation: MainWindowPresentation }) => {
    chatRenderSpy(windowPresentation);
    return <div data-testid="chat" />;
  },
}));
vi.mock('@/pages/Launcher', () => ({
  default: () => <div data-testid="launcher" />,
}));
vi.mock('@/pages/Settings', () => ({
  default: function MockSettings({ mode = 'settings' }: { mode?: 'settings' | 'capabilities' }) {
    const [draft, setDraft] = useState('');
    return <input data-testid={`${mode}-draft`} value={draft} onChange={(event) => setDraft(event.target.value)} />;
  },
}));
vi.mock('@/pages/TaskCenter', () => ({
  default: ({
    pendingRoute,
    activeRecordingSnapshot,
    onStartRecording,
  }: {
    pendingRoute?: PendingAppRoute | null;
    activeRecordingSnapshot?: RecordingSnapshot | null;
    onStartRecording?: (selection: RecordingSourceSelection) => Promise<void>;
  }) => {
    taskCenterRenderSpy(pendingRoute ?? null);
    taskCenterSnapshotSpy(activeRecordingSnapshot ?? null);
    return (
      <div data-testid="taskcenter">
        <button
          type="button"
          data-testid="taskcenter-start-recording"
          onClick={() => void onStartRecording?.({ microphone: true, system: false })}
        />
      </div>
    );
  },
}));
vi.mock('@/components/ChatBootOverlay', () => ({
  default: () => <div data-testid="chat-boot-overlay" />,
}));

const AVAILABLE_PRESENTATION: MainWindowPresentation = {
  surfaceAvailable: true,
  generation: 0,
};
const SUSPENDED_PRESENTATION: MainWindowPresentation = {
  surfaceAvailable: false,
  generation: 1,
};
const startRecordingSpy = vi.fn(async () => {});

function bindings(overrides: Partial<BuiltinTabBindings> = {}): BuiltinTabBindings {
  const updater = {
    updateReady: false,
    updateVersion: null,
    updateChecking: false,
    updateDownloading: false,
    updateInstalling: false,
    updatePreparing: false,
    onCheckForUpdate: vi.fn(async () => 'up-to-date' as const),
    onRestartAndUpdate: vi.fn(),
  };
  return {
    launcher: {
      isStarting: () => false,
      startError: () => null,
      onWorkspaceSelectionChange: vi.fn(),
      onLaunchProject: vi.fn(async () => true),
      onStartRecording: startRecordingSpy,
      onOpenRecord: vi.fn(),
      onOpenNewAgentPanel: vi.fn(),
    },
    chat: {
      windowPresentation: AVAILABLE_PRESENTATION,
      onOpenHistorySession: vi.fn(async () => {}),
      onNewSession: vi.fn(async () => true),
      onLaunchRuntimeBackedProviderSession: vi.fn(async () => null),
      onUpdateGenerating: vi.fn(),
      onUpdateTitle: vi.fn(),
      onUpdateUnread: vi.fn(),
      onRenameSession: vi.fn(),
      onForkSession: vi.fn(async () => true),
      onUpdateSessionId: vi.fn(async () => true),
      claimSessionOpeningTransition: vi.fn(() => () => undefined),
      onClearInitialMessage: vi.fn(),
      onSidecarConfigAdopted: vi.fn(),
      onFilePreviewIntentConsumed: vi.fn(),
    },
    settings: { ...updater, onNavigationConsumed: vi.fn() },
    capabilities: { ...updater, onNavigationConsumed: vi.fn(), onOpenToolMarket: vi.fn() },
    taskcenter: {
      activeRecordingSnapshot: null,
      onStartRecording: startRecordingSpy,
      onOpenRecord: vi.fn(),
      onSearchIntentConsumed: vi.fn(),
      onRouteConsumed: vi.fn(),
    },
    space: { onRouteConsumed: vi.fn() },
    agentnetwork: { onOpenRemoteSession: vi.fn() },
    'remote-session': { onOpen: vi.fn(), onBound: vi.fn() },
    projectboard: null,
    record: {
      onRecordingSnapshotChange: vi.fn(),
      onTitleChange: vi.fn(),
      onDeleted: vi.fn(),
    },
    ...overrides,
  };
}

function restoredTab(): ChatTab {
  return {
    id: 'restored-1',
    agentDir: '/ws/a',
    sessionId: '11111111-2222-3333-4444-555555555555',
    view: 'chat',
    title: 'Restored',
    sidecarConfigDisposition: 'pending',
  };
}

describe('registry-backed tab content', () => {
  it('mounts TabProvider immediately for the active restored tab', async () => {
    tabProviderSpy.mockClear();
    render(<BuiltinTabSlot tab={restoredTab()} isActive isDeferred={false} bindings={bindings()} />);
    expect(tabProviderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('tab-provider')).toBeInTheDocument();
    expect(await screen.findByTestId('chat')).toBeInTheDocument();
  });

  it('keeps deferred restored tabs lifecycle-live without mounting Chat', () => {
    tabProviderSpy.mockClear();
    render(<BuiltinTabSlot tab={restoredTab()} isActive isDeferred bindings={bindings()} />);
    expect(tabProviderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('tab-provider')).toBeInTheDocument();
    expect(screen.getByTestId('chat-boot-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
  });

  it('mounts Chat when deferral clears and keeps it mounted while inactive', async () => {
    const tab = restoredTab();
    const liveBindings = bindings();
    const view = render(<BuiltinTabSlot tab={tab} isActive isDeferred bindings={liveBindings} />);
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
    view.rerender(<BuiltinTabSlot tab={tab} isActive isDeferred={false} bindings={liveBindings} />);
    expect(await screen.findByTestId('chat')).toBeInTheDocument();
    view.rerender(<BuiltinTabSlot tab={tab} isActive={false} isDeferred={false} bindings={liveBindings} />);
    expect(screen.getByTestId('chat')).toBeInTheDocument();
  });

  it('keeps inactive Chat out of presentation-only rerenders', async () => {
    chatRenderSpy.mockClear();
    const tab = restoredTab();
    const first = bindings();
    const view = render(<BuiltinTabSlot tab={tab} isActive={false} isDeferred={false} bindings={first} />);
    await screen.findByTestId('chat');
    const inactiveRenderCount = chatRenderSpy.mock.calls.length;
    const suspended = bindings({
      chat: { ...first.chat, windowPresentation: SUSPENDED_PRESENTATION },
    });
    view.rerender(<BuiltinTabSlot tab={tab} isActive={false} isDeferred={false} bindings={suspended} />);
    expect(chatRenderSpy).toHaveBeenCalledTimes(inactiveRenderCount);
    view.rerender(<BuiltinTabSlot tab={tab} isActive isDeferred={false} bindings={suspended} />);
    await waitFor(() => expect(chatRenderSpy).toHaveBeenLastCalledWith(SUSPENDED_PRESENTATION));
  });

  it('keeps Settings and Capabilities local UI state mounted across switches', async () => {
    const settingsTab: SettingsTab = {
      id: 'settings-tab',
      view: 'settings',
      title: 'Settings',
    };
    const capabilitiesTab: CapabilitiesTab = {
      id: 'capabilities-tab',
      view: 'capabilities',
      title: 'Capabilities',
    };
    const liveBindings = bindings();
    const contents = (active: 'settings' | 'capabilities') => (
      <>
        <BuiltinTabSlot tab={settingsTab} isActive={active === 'settings'} isDeferred={false} bindings={liveBindings} />
        <BuiltinTabSlot
          tab={capabilitiesTab}
          isActive={active === 'capabilities'}
          isDeferred={false}
          bindings={liveBindings}
        />
      </>
    );
    const view = render(contents('settings'));
    fireEvent.change(await screen.findByTestId('settings-draft'), {
      target: { value: 'provider draft' },
    });
    view.rerender(contents('capabilities'));
    fireEvent.change(await screen.findByTestId('capabilities-draft'), {
      target: { value: 'mcp draft' },
    });
    view.rerender(contents('settings'));
    expect(screen.getByTestId('settings-draft')).toHaveValue('provider draft');
    expect(screen.getByTestId('capabilities-draft')).toHaveValue('mcp draft');
  });

  it('projects repeated Task routes from the exact singleton tab', async () => {
    taskCenterRenderSpy.mockClear();
    const route = (generation: number): PendingAppRoute => ({
      generation,
      route: {
        version: 1,
        name: 'task.comment',
        params: { taskId: 'task-1', commentId: 'comment-1' },
      },
    });
    const taskTab = (generation?: number): TaskCenterTab => ({
      id: 'task-center-tab',
      view: 'taskcenter',
      title: 'Task Center',
      ...(generation ? { routeIntent: route(generation) } : {}),
    });
    const liveBindings = bindings();
    const view = render(<BuiltinTabSlot tab={taskTab()} isActive isDeferred={false} bindings={liveBindings} />);
    view.rerender(<BuiltinTabSlot tab={taskTab(1)} isActive isDeferred={false} bindings={liveBindings} />);
    await waitFor(() =>
      expect(taskCenterRenderSpy).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 1 })),
    );
    view.rerender(<BuiltinTabSlot tab={taskTab(2)} isActive isDeferred={false} bindings={liveBindings} />);
    await waitFor(() =>
      expect(taskCenterRenderSpy).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 2 })),
    );
  });

  it('projects recording ticks and admission through the Task binding', async () => {
    taskCenterSnapshotSpy.mockClear();
    startRecordingSpy.mockClear();
    const tab: TaskCenterTab = {
      id: 'task-center-recording',
      view: 'taskcenter',
      title: 'Task Center',
    };
    const snapshot: RecordingSnapshot = {
      recordId: 'record-1',
      revision: 1,
      generation: 1,
      captureStatus: 'recording',
      startedAtWallTime: 1_700_000_000_000,
      mediaDurationMs: 1_000,
      pausedWallMs: 0,
      sources: [],
      sourceActivity: [],
      warnings: [],
    };
    const taskBinding = bindings().taskcenter;
    const first = bindings({
      taskcenter: {
        ...taskBinding,
        activeRecordingSnapshot: snapshot,
        onStartRecording: startRecordingSpy,
      },
    });
    const view = render(<BuiltinTabSlot tab={tab} isActive isDeferred={false} bindings={first} />);
    fireEvent.click(screen.getByTestId('taskcenter-start-recording'));
    expect(startRecordingSpy).toHaveBeenCalledWith(tab.id, {
      microphone: true,
      system: false,
    });
    const second = bindings({
      taskcenter: {
        ...first.taskcenter,
        activeRecordingSnapshot: {
          ...snapshot,
          revision: 2,
          mediaDurationMs: 2_000,
        },
      },
    });
    view.rerender(<BuiltinTabSlot tab={tab} isActive isDeferred={false} bindings={second} />);
    await waitFor(() =>
      expect(taskCenterSnapshotSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ revision: 2, mediaDurationMs: 2_000 }),
      ),
    );
  });
});
