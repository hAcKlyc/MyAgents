import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/config/types';
import type { SessionMetadata } from '@/api/sessionClient';
import type { TeamChannel, TeamPeer, TeamPeerConfig } from '@/../shared/teamAi';
import { i18n } from '@/i18n';
const mocks = vi.hoisted(() => ({ listeners: new Map<string, (event: { payload: { botId?: string } }) => void>(), projects: [] as Project[], patch: vi.fn(), channels: vi.fn(), sessions: vi.fn(), action: vi.fn(), review: vi.fn(), states: vi.fn(), enable: vi.fn(), peerConfig: vi.fn(), openPath: vi.fn(), translate: vi.fn<(key: string, options?: Record<string, unknown>) => string | undefined>() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => mocks.translate(key, options) ?? key }) }));
vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ projects: mocks.projects, config: {} }) }));
vi.mock('@/config/useConfigActions', () => ({ useConfigActions: () => ({ patchProject: mocks.patch, refreshConfig: async () => undefined }) }));
vi.mock('@/config/services/agentConfigService', () => ({ startAndEnableAgentChannel: mocks.enable, getAgentById: () => ({ id: 'agent', name: 'Agent', enabled: true, channels: [] }) }));
vi.mock('@/components/AgentSettings/sections/AgentChannelsSection', () => ({
  ChannelOverlay: ({ entry, onClose }: { entry: unknown; onClose: () => void }) => <div data-testid="channel-page" data-entry={JSON.stringify(entry)}><button onClick={onClose}>close channel page</button></div>,
}));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async (event, callback, signal) => { mocks.listeners.set(event, callback); signal?.addEventListener('abort', () => { if (mocks.listeners.get(event) === callback) mocks.listeners.delete(event); }); }) }));
vi.mock('@/hooks/useWorkspaceFileService', () => ({ useWorkspaceFileService: () => ({ openPathExternal: mocks.openPath }) }));
vi.mock('@/components/WorkspaceConfigPanel', () => ({ default: () => <div data-testid="workspace-config-panel" /> }));
vi.mock('@/api/sessionClient', () => ({ getSessions: mocks.sessions }));
vi.mock('@/features/team-ai/client', () => ({ teamChannels: mocks.channels, teamAction: mocks.action, reviewTeamGroup: mocks.review, teamStates: mocks.states, teamPeerConfig: mocks.peerConfig }));
import TeamAi from './TeamAi';

const project: Project = { id: 'workspace', agentId: 'agent', name: 'Support department', path: '/workspace', purpose: 'team-ai', providerId: null, permissionMode: null };
const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const metadata: SessionMetadata = { id: 'session-a', agentDir: '/workspace', title: 'Budget analysis', createdAt: iso(90), lastActiveAt: iso(5), runtime: 'builtin', model: 'model-a', configSnapshotAt: 'observed', mcpEnabledServers: ['mcp-a'] };
const earlier: SessionMetadata = { ...metadata, id: 'session-b', title: 'Earlier analysis', lastActiveAt: iso(3000) };
const peer: TeamPeer = { id: 'group:room', access: 'approved', sessionKey: 'agent:agent:feishu:group:room', sourceId: 'room', sourceType: 'group', name: 'Planning room', sessionId: 'session-a', sessionIds: ['session-a', 'session-b', 'session-gone'], hasProfile: false };
const privatePeer: TeamPeer = { id: 'private:u1', access: 'bound', sessionKey: 'agent:agent:feishu:private:u1', sourceId: 'u1', sourceType: 'private', name: 'Li', sessionId: null, sessionIds: [], hasProfile: false };
const channel: TeamChannel = { channelId: 'bot-a', platform: 'feishu', name: 'Department Bot', online: true, enabled: true, status: 'online', peers: [privatePeer, peer] };
const selectionA = { kind: 'product-provider', providerId: 'provider-a', model: 'model-a' } as const;
const selectionC = { kind: 'product-provider', providerId: 'provider-a', model: 'model-c' } as const;
const selectionB = { kind: 'product-provider', providerId: 'provider-b', model: 'model-b' } as const;
const view = (overrides: Partial<TeamPeerConfig> = {}): TeamPeerConfig => ({
  config: { runtime: 'builtin', providerId: 'provider-a', model: 'model-a', reasoningEffort: 'default', mcpEnabledServers: ['mcp-a'], enabledPluginIds: [], enabledOfficialToolIds: [] },
  custom: false,
  models: [
    { group: 'Department provider', name: 'Current model', isCurrent: true, appliesNow: true, selection: selectionA },
    { group: 'Department provider', name: 'Sibling model', isCurrent: false, appliesNow: true, selection: selectionC },
    { group: 'Other provider', name: 'Other model', isCurrent: false, appliesNow: false, selection: selectionB },
  ],
  effortChoices: ['low', 'high'],
  tools: { canManageExtensions: true, mcp: [{ id: 'mcp-a', name: 'Department MCP' }], plugins: [{ id: 'plugin-a', name: 'Department plugin' }], official: [{ id: 'official-a', name: 'Official tool' }] },
  ...overrides,
});
const props = () => ({ isActive: true, onCreate: vi.fn(), onSelectProject: vi.fn(), onOpenSession: vi.fn(), onOpenWorkspace: vi.fn() });
const selectPeer = async (name = 'Planning room') => fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
const row = (label: string) => screen.getByRole('group', { name: label });
const openConfig = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /teamAi.config.title/ }));
  await screen.findByRole('group', { name: 'teamAi.model' });
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listeners.clear();
  mocks.projects = [project];
  mocks.states.mockResolvedValue({ states: [] });
  mocks.channels.mockResolvedValue({ channels: [channel] });
  mocks.sessions.mockResolvedValue([metadata, earlier]);
  mocks.enable.mockResolvedValue(undefined);
  mocks.peerConfig.mockResolvedValue(view());
  mocks.openPath.mockResolvedValue(undefined);
  mocks.action.mockResolvedValue({ success: true });
});

describe('Team AI list', () => {
  it('lists every peer flat, most recent first, with its kind and Bot', async () => {
    render(<TeamAi {...props()} />);
    const options = await screen.findAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual([
      expect.stringContaining('Planning room'),
      expect.stringContaining('Li'),
    ]);
    expect(options[0]).toHaveTextContent('teamAi.group');
    expect(options[0]).toHaveTextContent('Department Bot');
    expect(screen.getByText('teamAi.selectPeer')).toBeInTheDocument();
  });

  it('marks only what needs attention and keeps disabled Bots browsable', async () => {
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, enabled: false, online: false, status: 'stopped' }] });
    mocks.states.mockResolvedValue({ states: [{ channelId: 'bot-a', sessionKey: peer.sessionKey, sessionId: 'session-a', state: 'error' }] });
    render(<TeamAi {...props()} />);
    const planning = await screen.findByRole('option', { name: /Planning room/ });
    expect(within(planning).getByLabelText('teamAi.status.error')).toBeInTheDocument();
    // Bot status is stated once, on the Bot, not repeated on each conversation.
    expect(within(screen.getByRole('region', { name: 'teamAi.connectedChannels' })).getByText('teamAi.disabled')).toBeInTheDocument();
    expect(within(planning).queryByText('teamAi.disabled')).toBeNull();
    fireEvent.click(planning);
    expect(await screen.findByText('teamAi.channelOff')).toBeInTheDocument();
    await openConfig();
    expect(within(row('teamAi.model')).getByRole('button')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'teamAi.new' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.enable' }));
    await waitFor(() => expect(mocks.enable).toHaveBeenCalledWith('agent', 'bot-a'));
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('distinguishes a failed Channel read from a Bot without conversations', async () => {
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, peers: [], loadError: 'State file unreadable' }, { ...channel, channelId: 'bot-b', name: 'Quiet Bot', peers: [] }] });
    render(<TeamAi {...props()} />);
    const bots = await screen.findByRole('region', { name: 'teamAi.connectedChannels' });
    expect(within(bots).getByText('teamAi.loadFailedRetry')).toBeInTheDocument();
    expect(within(bots).getByText('Quiet Bot')).toBeInTheDocument();
    expect(screen.getByText('teamAi.noPeers')).toBeInTheDocument();
    const reads = mocks.channels.mock.calls.length;
    fireEvent.click(within(bots).getByText('teamAi.loadFailedRetry'));
    await waitFor(() => expect(mocks.channels.mock.calls.length).toBeGreaterThan(reads));
  });

  it('keeps same-platform Bots with identical peer keys separately targeted', async () => {
    mocks.channels.mockResolvedValue({ channels: [channel, { ...channel, channelId: 'bot-b', name: 'Second Bot', peers: [{ ...peer, sessionId: 'session-b', sessionIds: ['session-a', 'session-b'] }] }] });
    render(<TeamAi {...props()} />);
    fireEvent.click(await screen.findByRole('option', { name: /Planning room.*Second Bot/ }));
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Budget analysis/ }), { clientX: 40, clientY: 70 });
    fireEvent.click(await screen.findByText('teamAi.setCurrentMenu'));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-b', expect.objectContaining({ sessionId: 'session-b' }), { kind: 'setPrimary', sessionId: 'session-a' }));
  });
});

describe('Team AI peer detail', () => {
  it('shows exact stats, a collapsed config summary and no transcript', async () => {
    mocks.sessions.mockResolvedValue([{ ...metadata, stats: { turnCount: 4, totalInputTokens: 0, totalOutputTokens: 0 } }, { ...earlier, lastActiveAt: iso(60 * 24 * 8), stats: { turnCount: 3, totalInputTokens: 0, totalOutputTokens: 0 } }]);
    render(<TeamAi {...props()} />);
    await selectPeer();
    expect(await screen.findByText('7')).toBeInTheDocument(); // total turns
    expect(screen.getByText('1')).toBeInTheDocument(); // only one Session active in the last 7 days
    const config = await screen.findByRole('button', { name: /teamAi.config.title/ });
    expect(config).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(config).toHaveTextContent('Current model'));
    expect(config).toHaveTextContent('teamAi.profile.default');
    expect(mocks.peerConfig).toHaveBeenCalledWith('agent', 'bot-a', peer.sessionKey);
  });

  it('edits the peer config and reports when only new Sessions take the change', async () => {
    mocks.action.mockResolvedValue({ success: true, peerProfile: 'saved', sessionApply: 'skipped' });
    render(<TeamAi {...props()} />);
    await selectPeer();
    await openConfig();
    fireEvent.click(within(row('teamAi.model')).getByRole('button'));
    fireEvent.click(await screen.findByRole('button', { name: 'Other provider' }));
    expect(await screen.findByText('teamAi.config.laterTag')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Other model'));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', peer, { kind: 'updateConfig', change: { selection: selectionB } }));
    expect(await screen.findByText('teamAi.done.savedAsOwnteamAi.apply.skipped')).toBeInTheDocument();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('offers a new conversation when the current Session cannot take the change', async () => {
    mocks.action.mockResolvedValueOnce({ success: true, peerProfile: 'saved', sessionApply: 'skipped' });
    render(<TeamAi {...props()} />);
    await selectPeer();
    await openConfig();
    fireEvent.click(within(row('teamAi.runtime')).getByRole('button'));
    fireEvent.click(await screen.findByText('MyAgents (DeepSeek Harness)'));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', peer, { kind: 'updateConfig', change: { runtime: 'dsh' } }));
    expect(await screen.findByText('teamAi.config.needsNewMessage')).toBeInTheDocument();
    expect(mocks.action.mock.calls.some(call => call[3].kind === 'new')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.config.needsNewConfirm' }));
    await waitFor(() => expect(mocks.action).toHaveBeenLastCalledWith('agent', 'bot-a', peer, { kind: 'new' }));
  });

  it('asks nothing when the change reached the current Session', async () => {
    mocks.action.mockResolvedValueOnce({ success: true, peerProfile: 'saved', sessionApply: 'applied' });
    render(<TeamAi {...props()} />);
    await selectPeer();
    await openConfig();
    fireEvent.click(within(row('teamAi.runtime')).getByRole('button'));
    fireEvent.click(await screen.findByText('MyAgents (DeepSeek Harness)'));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.channels.mock.calls.length).toBeGreaterThan(1));
    expect(screen.queryByText('teamAi.config.needsNewMessage')).not.toBeInTheDocument();
    expect(screen.queryByText('teamAi.config.differs')).not.toBeInTheDocument();
  });

  it('restores Agent defaults for a peer that owns its settings', async () => {
    mocks.peerConfig.mockResolvedValue(view({ custom: true }));
    render(<TeamAi {...props()} />);
    await selectPeer();
    await openConfig();
    expect(screen.getAllByText('teamAi.profile.custom').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.profile.reset' }));
    fireEvent.click(await screen.findByRole('button', { name: 'teamAi.profile.resetConfirm' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', expect.objectContaining({ sessionKey: peer.sessionKey }), { kind: 'clearProfile' }));
  });

  it('saves each tool toggle as a whole tool set and keeps native CLI extensions read-only', async () => {
    render(<TeamAi {...props()} />);
    await selectPeer();
    await openConfig();
    fireEvent.click(within(row('teamAi.tools')).getByRole('button'));
    fireEvent.click(await screen.findByRole('switch', { name: 'Official tool' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', peer, {
      kind: 'updateConfig', change: { tools: { mcpEnabledServers: ['mcp-a'], enabledPluginIds: [], enabledOfficialToolIds: ['official-a'] } },
    }));
  });

  it('builds each tool toggle on the previous one, even before the config view refreshes', async () => {
    let release!: () => void;
    mocks.action.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ success: true, peerProfile: 'saved', sessionApply: 'applied' }); }));
    render(<TeamAi {...props()} />);
    await selectPeer();
    await openConfig();
    fireEvent.click(within(row('teamAi.tools')).getByRole('button'));
    fireEvent.click(await screen.findByRole('switch', { name: 'Official tool' }));
    release();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Department plugin' })).toBeEnabled());
    fireEvent.click(screen.getByRole('switch', { name: 'Department plugin' }));
    await waitFor(() => expect(mocks.action).toHaveBeenLastCalledWith('agent', 'bot-a', peer, {
      kind: 'updateConfig', change: { tools: { mcpEnabledServers: ['mcp-a'], enabledPluginIds: ['plugin-a'], enabledOfficialToolIds: ['official-a'] } },
    }));
  });

  it('says the settings were saved when the current Session could not take them', async () => {
    mocks.action.mockResolvedValue({ success: false, peerProfile: 'saved', sessionApply: 'failed', error: 'Session Sidecar failed to start' });
    render(<TeamAi {...props()} />);
    await selectPeer();
    await openConfig();
    fireEvent.click(within(row('teamAi.effort')).getByRole('button'));
    fireEvent.click(await screen.findByText('teamAi.efforts.high'));
    expect(await screen.findByText('teamAi.apply.failed Session Sidecar failed to start')).toBeInTheDocument();
  });

  it('shows a config read failure with a retry instead of loading forever', async () => {
    mocks.peerConfig.mockRejectedValueOnce(new Error('Global Sidecar unavailable'));
    render(<TeamAi {...props()} />);
    await selectPeer();
    fireEvent.click(await screen.findByRole('button', { name: /teamAi.config.title/ }));
    expect(await screen.findByText('teamAi.config.loadFailed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.retry' }));
    expect(await screen.findByRole('group', { name: 'teamAi.model' })).toBeInTheDocument();
  });

  it('keeps native CLI MCP and plugins read-only', async () => {
    mocks.peerConfig.mockResolvedValue(view({ config: { runtime: 'codex', runtimeSource: 'system-cli', model: 'cli' }, tools: { ...view().tools, canManageExtensions: false } }));
    render(<TeamAi {...props()} />);
    await selectPeer();
    await openConfig();
    fireEvent.click(within(row('teamAi.tools')).getByRole('button'));
    expect(await screen.findByRole('switch', { name: 'Department MCP' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Official tool' })).toBeEnabled();
  });
});

describe('Team AI sessions', () => {
  const dot = (row: HTMLElement) => row.querySelector('[data-tab-activity-indicator="generating"]');

  it('lists current and earlier Sessions together: current tag first, green dot only while running, no status text', async () => {
    mocks.states.mockResolvedValue({ states: [
      { channelId: 'bot-a', sessionKey: peer.sessionKey, sessionId: 'session-a', state: null },
      { channelId: 'bot-a', sessionKey: peer.sessionKey, sessionId: 'session-b', state: 'running' },
    ] });
    const page = props();
    render(<TeamAi {...page} />);
    await selectPeer();
    const current = await screen.findByRole('button', { name: /Budget analysis/ });
    const tag = within(current).getByText('teamAi.currentTag');
    expect(tag.compareDocumentPosition(within(current).getByText('Budget analysis')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dot(current)).toBeNull();
    expect(within(current).queryByText(/teamAi.status/)).toBeNull();
    const history = screen.getByRole('button', { name: /Earlier analysis/ });
    expect(dot(history)).not.toBeNull();
    expect(screen.getByText('teamAi.deletedCount')).toBeInTheDocument();
    fireEvent.click(history);
    expect(page.onOpenSession).toHaveBeenCalledWith(earlier, project);
    fireEvent.click(current);
    expect(page.onOpenSession).toHaveBeenCalledWith(metadata, project);
  });

  it('shows session action failures next to the list, even with the config collapsed', async () => {
    mocks.action.mockResolvedValue({ success: false, error: 'Binding failed', createdSessionId: 'session-new-1234' });
    render(<TeamAi {...props()} />);
    await selectPeer();
    fireEvent.click(await screen.findByRole('button', { name: 'teamAi.new' }));
    expect(await screen.findByText('Binding failed teamAi.createdUnbound')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /teamAi.config.title/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('sets an earlier Session as current from its floating menu, only for the peer that owns it', async () => {
    render(<TeamAi {...props()} />);
    await selectPeer();
    const history = await screen.findByRole('button', { name: /Earlier analysis/ });
    fireEvent.click(within(history.parentElement!).getByTitle('teamAi.peerMenu'));
    fireEvent.click(await screen.findByRole('button', { name: 'teamAi.setCurrentMenu' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', peer, { kind: 'setPrimary', sessionId: 'session-b' }));
  });

  it.each([['zh-CN', '正在启动'], ['en-US', 'Starting']])('labels the list activity with real %s translations', async (locale, label) => {
    await i18n.changeLanguage(locale);
    mocks.translate.mockImplementation((key, options) => String(i18n.t(key, { ...options, ns: 'app' })));
    mocks.states.mockResolvedValue({ states: [{ channelId: 'bot-a', sessionKey: peer.sessionKey, sessionId: 'session-a', state: 'starting' }] });
    render(<TeamAi {...props()} />);
    expect(await screen.findByTitle(label)).toBeInTheDocument();
  });
});

describe('Team AI header and connected Channels', () => {
  it('lists connected Bots above the conversation list, without a search box, each opening its own settings', async () => {
    render(<TeamAi {...props()} />);
    const bots = await screen.findByRole('region', { name: 'teamAi.connectedChannels' });
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(within(bots).getByTitle('teamAi.channelSettings'));
    expect(await screen.findByTestId('channel-page')).toHaveAttribute('data-entry', JSON.stringify({ view: 'detail', channelId: 'bot-a' }));
    expect(screen.queryByTestId('workspace-config-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'close channel page' }));
    expect(screen.queryByTestId('channel-page')).toBeNull();
    expect(screen.queryByTestId('workspace-config-panel')).toBeNull();
  });

  it('opens the whole Agent settings panel only from Agent settings', async () => {
    render(<TeamAi {...props()} />);
    await screen.findAllByRole('option');
    fireEvent.click(screen.getByRole('button', { name: /teamAi.agentSettings/ }));
    expect(await screen.findByTestId('workspace-config-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('channel-page')).toBeNull();
  });

  it('never stacks the settings panel under a Channel page, even when reached by keyboard', async () => {
    render(<TeamAi {...props()} />);
    const bots = await screen.findByRole('region', { name: 'teamAi.connectedChannels' });
    fireEvent.click(within(bots).getByTitle('teamAi.channelSettings'));
    expect(await screen.findByTestId('channel-page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.agentSettings' }));
    expect(screen.queryByTestId('channel-page')).toBeNull();
    expect(screen.getByTestId('workspace-config-panel')).toBeInTheDocument();
  });

  it('adds a Bot from the connected Channels heading', async () => {
    render(<TeamAi {...props()} />);
    const bots = await screen.findByRole('region', { name: 'teamAi.connectedChannels' });
    fireEvent.click(within(bots).getByRole('button', { name: 'teamAi.connectBot' }));
    expect(await screen.findByTestId('channel-page')).toHaveAttribute('data-entry', JSON.stringify({ view: 'add' }));
    expect(screen.queryByTestId('workspace-config-panel')).toBeNull();
  });

  it('times each conversation by its current Session, exactly as the detail shows it', async () => {
    // An earlier Session finished more recently; the list still follows the current one.
    mocks.sessions.mockResolvedValue([{ ...metadata, lastActiveAt: iso(90) }, { ...earlier, lastActiveAt: iso(2) }]);
    render(<TeamAi {...props()} />);
    const option = await screen.findByRole('option', { name: /Planning room/ });
    const label = within(option).getByText(/ago|前/);
    fireEvent.click(option);
    const current = await screen.findByRole('button', { name: /Budget analysis/ });
    expect(within(current).getByText(label.textContent!)).toBeInTheDocument();
  });

  it('opens the workspace folder in the file manager and connects a Bot through the add-Channel page', async () => {
    render(<TeamAi {...props()} />);
    await screen.findAllByRole('option');
    fireEvent.click(screen.getByTitle('teamAi.agentMenu'));
    fireEvent.click(await screen.findByRole('button', { name: 'teamAi.openFolder' }));
    expect(mocks.openPath).toHaveBeenCalledWith({ fullPath: '/workspace', workspace: '/workspace' });
    fireEvent.click(screen.getByTitle('teamAi.agentMenu'));
    const menuItem = (await screen.findAllByRole('button', { name: 'teamAi.connectBot' })).find(button => !button.closest('[aria-label="teamAi.connectedChannels"]'))!;
    fireEvent.click(menuItem);
    expect(await screen.findByTestId('channel-page')).toHaveAttribute('data-entry', JSON.stringify({ view: 'add' }));
    expect(screen.queryByTestId('workspace-config-panel')).toBeNull();
  });
});

describe('Team AI workspaces', () => {
  it('joins an existing workspace with a usage patch and preserves its identity', async () => {
    mocks.projects = [
      { ...project, displayName: 'Support department', purpose: undefined },
      { ...project, id: 'hidden', purpose: undefined, hidden: true },
      { ...project, id: 'archived', purpose: undefined, archivedAt: '2026-10-24T00:00:00Z' },
      { ...project, id: 'no-agent', purpose: undefined, agentId: undefined },
    ];
    const page = props();
    render(<TeamAi {...page} />);
    expect(screen.getByText('teamAi.onboarding.title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.join' }));
    const dialog = screen.getByRole('dialog', { name: 'teamAi.selectWorkspaceTitle' });
    expect(within(dialog).getAllByRole('button')).toHaveLength(2); // close + sole eligible workspace
    fireEvent.click(within(dialog).getByRole('button', { name: /Support department/ }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('workspace', { purpose: 'team-ai' }));
    expect(page.onSelectProject).toHaveBeenCalledWith('workspace');
  });

  it('dismisses the workspace picker with Escape and restores focus without changing config', async () => {
    const user = userEvent.setup();
    mocks.projects = [{ ...project, purpose: undefined }];
    render(<TeamAi {...props()} />);
    const trigger = screen.getByRole('button', { name: 'teamAi.join' });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('switches Team AI from the header and removes only the usage tag', async () => {
    mocks.projects = [project, { ...project, id: 'new-team', agentId: 'new-agent', path: '/new-team', name: 'New Team' }];
    const page = props();
    render(<TeamAi {...page} projectId="new-team" />);
    await waitFor(() => expect(mocks.channels).toHaveBeenCalledWith('new-agent'));
    const switcher = screen.getByRole('button', { name: 'teamAi.switchAgent' });
    expect(switcher).toHaveTextContent('New Team');
    fireEvent.click(switcher);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Support department/ }));
    expect(page.onSelectProject).toHaveBeenCalledWith('workspace');
  });

  it('distinguishes a failed page read from an empty Channel list', async () => {
    mocks.channels.mockRejectedValue(new Error('Config unreadable'));
    render(<TeamAi {...props()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Config unreadable');
    expect(screen.queryByText('teamAi.noChannelTitle')).toBeNull();
  });

  it('offers to connect a chatbot when the Agent has none', async () => {
    mocks.channels.mockResolvedValue({ channels: [] });
    render(<TeamAi {...props()} />);
    expect(await screen.findByText('teamAi.noChannelTitle')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /teamAi.connectBot/ }).length).toBeGreaterThan(0);
  });
});


describe('Team AI live discovery', () => {
  it('refreshes discovered peers immediately on channel config changes', async () => {
    render(<TeamAi {...props()} />);
    await screen.findByRole('option', { name: /Planning room/ });
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, peers: [...channel.peers, { ...privatePeer, id: 'private:u2', name: 'Newly bound', sourceId: 'u2', sessionKey: null }] }] });
    mocks.listeners.get('im:bot-config-changed')?.({ payload: { botId: 'bot-a' } });
    expect(await screen.findByRole('option', { name: /Newly bound/ })).toBeInTheDocument();
  });

  it.each(['approve', 'reject'] as const)('handles %s for a group with no Session at the selected detail header', async decision => {
    const waiting = { ...peer, access: 'pending' as const, sessionKey: null, sessionId: null, sessionIds: [] };
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, peers: [waiting, privatePeer] }] });
    mocks.review.mockImplementation(async () => {
      mocks.channels.mockResolvedValue({ channels: [{ ...channel, peers: decision === 'approve' ? [{ ...waiting, access: 'approved' }, privatePeer] : [privatePeer] }] });
    });
    render(<TeamAi {...props()} />);
    await selectPeer();
    expect(screen.getByText('teamAi.access.noConversation')).toBeInTheDocument();
    expect(mocks.peerConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: decision === 'approve' ? 'teamAi.access.allow' : 'teamAi.access.reject' }));
    await waitFor(() => expect(mocks.review).toHaveBeenCalledWith('bot-a', 'room', decision));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'teamAi.access.allow' })).not.toBeInTheDocument());
    if (decision === 'approve') expect(screen.getByText('teamAi.access.approved')).toBeInTheDocument();
    else {
      expect(screen.queryByRole('option', { name: /Planning room/ })).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('teamAi.access.rejected');
    }
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('keeps the buttons and an inline error after a failed review', async () => {
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, peers: [{ ...peer, access: 'pending' }] }] });
    mocks.review.mockRejectedValue(new Error('Could not save approval'));
    render(<TeamAi {...props()} />); await selectPeer();
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.access.allow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save approval');
    expect(screen.getByRole('button', { name: 'teamAi.access.allow' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'teamAi.access.reject' })).toBeEnabled();
  });

  it.each(['approve', 'reject'] as const)('retains the confirmed %s result when the follow-up membership read fails', async decision => {
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, peers: [{ ...peer, access: 'pending', sessionKey: null, sessionId: null, sessionIds: [] }] }] });
    mocks.review.mockImplementation(async () => { mocks.channels.mockRejectedValue(new Error('Membership refresh failed')); });
    render(<TeamAi {...props()} />); await selectPeer();
    fireEvent.click(screen.getByRole('button', { name: decision === 'approve' ? 'teamAi.access.allow' : 'teamAi.access.reject' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Membership refresh failed');
    expect(screen.queryByRole('button', { name: 'teamAi.access.allow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'teamAi.access.reject' })).not.toBeInTheDocument();
    if (decision === 'approve') expect(screen.getByText('teamAi.access.approved')).toBeInTheDocument();
    else expect(screen.queryByRole('option', { name: /Planning room/ })).not.toBeInTheDocument();
  });

  it('disables duplicate review and leaves a newly selected peer alone on completion', async () => {
    let complete!: () => void;
    mocks.review.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, peers: [{ ...peer, access: 'pending' }, privatePeer] }] });
    render(<TeamAi {...props()} />); await selectPeer();
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.access.reject' }));
    expect(screen.getByRole('button', { name: 'teamAi.access.allow' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.access.allow' }));
    expect(mocks.review).toHaveBeenCalledTimes(1);
    await selectPeer('Li');
    complete();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Li' })).toBeInTheDocument());
    expect(screen.queryByText('teamAi.access.rejected')).not.toBeInTheDocument();
  });

  it.each(['open', 'blocked', 'approved'] as const)('does not offer pending approval for %s groups', async access => {
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, peers: [{ ...peer, access }] }] });
    render(<TeamAi {...props()} />); await selectPeer();
    expect(screen.queryByRole('button', { name: 'teamAi.access.allow' })).not.toBeInTheDocument();
  });
});
