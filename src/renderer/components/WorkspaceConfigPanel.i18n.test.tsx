import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import WorkspaceConfigPanel from './WorkspaceConfigPanel';

const mocks = vi.hoisted(() => ({
  refreshConfig: vi.fn(),
  patchProject: vi.fn(),
  useAgentStatuses: vi.fn(),
  invoke: vi.fn(),
  getAllMcpServers: vi.fn(),
  getEnabledMcpServerIds: vi.fn(),
  getWorkspaceCronTasks: vi.fn(),
  useCloseLayer: vi.fn(),
  toastWarning: vi.fn(),
  systemPromptsEditing: false,
  agentRuntime: 'codex',
  agentPermissionMode: 'plan',
}));

vi.mock('@/hooks/useCloseLayer', () => ({
  useCloseLayer: (...args: unknown[]) => mocks.useCloseLayer(...args),
}));

vi.mock('@/components/OverlayBackdrop', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: (...args: unknown[]) => mocks.toastWarning(...args),
  }),
}));

vi.mock('./SystemPromptsPanel', async () => {
  const React = await import('react');
  const MockSystemPromptsPanel = React.forwardRef(function MockSystemPromptsPanel(_, ref) {
    React.useImperativeHandle(ref, () => ({ isEditing: () => mocks.systemPromptsEditing }));
    return React.createElement('div', null);
  });
  return {
    default: MockSystemPromptsPanel,
  };
});

vi.mock('./IntroductionPanel', async () => {
  const React = await import('react');
  const MockIntroductionPanel = React.forwardRef(function MockIntroductionPanel(_, ref) {
    React.useImperativeHandle(ref, () => ({ isEditing: () => false }));
    return React.createElement('div', null);
  });
  return {
    default: MockIntroductionPanel,
  };
});

vi.mock('./SkillDetailPanel', async () => {
  const React = await import('react');
  const MockSkillDetailPanel = React.forwardRef(function MockSkillDetailPanel(_, ref) {
    React.useImperativeHandle(ref, () => ({ isEditing: () => false }));
    return React.createElement('div', null);
  });
  return {
    default: MockSkillDetailPanel,
  };
});

vi.mock('./CommandDetailPanel', async () => {
  const React = await import('react');
  const MockCommandDetailPanel = React.forwardRef(function MockCommandDetailPanel(_, ref) {
    React.useImperativeHandle(ref, () => ({ isEditing: () => false }));
    return React.createElement('div', null);
  });
  return {
    default: MockCommandDetailPanel,
  };
});

vi.mock('./AgentDetailPanel', async () => {
  const React = await import('react');
  const MockAgentDetailPanel = React.forwardRef(function MockAgentDetailPanel(_, ref) {
    React.useImperativeHandle(ref, () => ({ isEditing: () => false }));
    return React.createElement('div', null);
  });
  return {
    default: MockAgentDetailPanel,
  };
});

vi.mock('./SkillsCommandsList', () => ({
  default: () => <div />,
}));

vi.mock('./WorkspaceAgentsList', () => ({
  default: () => <div />,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock('@/hooks/useAgentStatuses', () => ({
  useAgentStatuses: (...args: unknown[]) => mocks.useAgentStatuses(...args),
}));

vi.mock('@/config/configService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/configService')>();
  return {
    ...actual,
    getAllMcpServers: (...args: unknown[]) => mocks.getAllMcpServers(...args),
    getEnabledMcpServerIds: (...args: unknown[]) => mocks.getEnabledMcpServerIds(...args),
  };
});

vi.mock('@/api/cronTaskClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/cronTaskClient')>();
  return {
    ...actual,
    getWorkspaceCronTasks: (...args: unknown[]) => mocks.getWorkspaceCronTasks(...args),
  };
});

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    apiKeys: {},
    config: {
      agents: [{
        id: 'agent-1',
        name: 'mino',
        enabled: true,
        workspacePath: '/Users/me/mino',
        runtime: mocks.agentRuntime,
        permissionMode: mocks.agentPermissionMode,
        runtimeConfig: { envPolicy: { proxy: 'myagents' } },
        channels: [],
        mcpEnabledServers: [],
      }],
      defaultPermissionMode: 'plan',
      enabledPlugins: {},
      plugins: [],
    },
    patchProject: mocks.patchProject,
    projects: [{
      id: 'workspace-1',
      agentId: 'agent-1',
      displayName: 'mino',
      icon: 'bolt',
      isAgent: true,
      isHidden: false,
      name: 'mino',
      path: '/Users/me/mino',
    }],
    providerVerifyStatus: {},
    providers: [],
    refreshConfig: mocks.refreshConfig,
  }),
}));

describe('WorkspaceConfigPanel i18n', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.agentRuntime = 'codex';
    mocks.agentPermissionMode = 'plan';
    mocks.systemPromptsEditing = false;
    await i18n.changeLanguage('en-US');
    mocks.invoke.mockResolvedValue({
      builtin: { installed: true },
      antigravity: { installed: true },
      'claude-code': { installed: true },
      codex: { installed: true },
    });
    mocks.useAgentStatuses.mockReturnValue({
      refresh: vi.fn(),
      statuses: { 'agent-1': { agentId: 'agent-1', agentName: 'mino', channels: [], enabled: true } },
    });
    mocks.getAllMcpServers.mockResolvedValue([]);
    mocks.getEnabledMcpServerIds.mockResolvedValue([]);
    mocks.getWorkspaceCronTasks.mockResolvedValue([]);
  });

  it('renders the Agent settings shell and General tab chrome in English', async () => {
    render(<WorkspaceConfigPanel agentDir="/Users/me/mino" onClose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Agent Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'System Prompt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skills' })).toBeInTheDocument();

    expect(screen.getByText('Basic Settings')).toBeInTheDocument();
    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('Network proxy')).toBeInTheDocument();
    expect(screen.getByText('MyAgents proxy')).toBeInTheDocument();
    expect(screen.getByText('Follow terminal')).toBeInTheDocument();
    expect(screen.getByText('Proactive Agent Mode')).toBeInTheDocument();

    await waitFor(() => expect(mocks.getWorkspaceCronTasks).toHaveBeenCalledWith('/Users/me/mino'));
    expect(screen.queryByText('Agent 设置')).not.toBeInTheDocument();
    expect(screen.queryByText('基础设置')).not.toBeInTheDocument();
  });

  it('uses the conversation permission menu style in Agent settings', async () => {
    mocks.agentRuntime = 'builtin';
    const user = userEvent.setup();
    render(<WorkspaceConfigPanel agentDir="/Users/me/mino" onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Plan' }));

    expect(screen.getByText('Session mode')).toBeInTheDocument();
    expect(document.querySelector('.composer-toolbar-menu-enter')).toBeInTheDocument();
    expect(document.querySelector('.app-icon-shield-check')).toBeInTheDocument();
    expect(document.querySelector('.app-icon-eye')).toBeInTheDocument();
    expect(document.querySelector('.app-icon-lock-open')).toBeInTheDocument();
    expect(screen.queryByText(/⚡|📋|🚀/u)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PlanAgent only researches information/ })).toHaveAttribute('aria-current', 'true');
  });

  it('routes the close layer through the unsaved-edit guard', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WorkspaceConfigPanel agentDir="/Users/me/mino" onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'System Prompt' }));
    mocks.systemPromptsEditing = true;
    const closeLayerHandler = mocks.useCloseLayer.mock.calls
      .filter(([, zIndex]) => zIndex === 200)
      .at(-1)?.[0] as (() => boolean) | undefined;
    expect(closeLayerHandler).toBeTypeOf('function');

    act(() => {
      expect(closeLayerHandler?.()).toBe(true);
    });

    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
