import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agentSessionMocks = vi.hoisted(() => ({
  agentDir: undefined as string | undefined,
  setMcpServers: vi.fn(),
  setAgents: vi.fn(),
  getMcpServers: vi.fn(() => []),
  getSidecarPort: vi.fn(() => 0),
  getQueueStatus: vi.fn(() => []),
  forceReloadActiveSession: vi.fn(),
}));

const managementApiMocks = vi.hoisted(() => ({
  managementApi: vi.fn(async (_path?: string): Promise<Record<string, unknown>> => ({ ok: true, taskUpdated: 0, cronUpdated: 0 })),
}));

const analyticsMocks = vi.hoisted(() => ({
  trackServer: vi.fn(),
}));

const runtimeModelMocks = vi.hoisted(() => ({
  queryRuntimeModels: vi.fn(async () => [{ value: 'gpt-5.6-sol' }]),
  managedInstalled: true,
}));

const providerVerifyMocks = vi.hoisted(() => ({
  verifyProviderViaSdk: vi.fn(async () => ({ success: true })),
  verifySubscription: vi.fn(async () => ({ success: true })),
}));

const adminConfigBehavior = vi.hoisted(() => ({
  failProjectWrite: false,
  failNextConfigWrite: false,
  delayNextIntent: false,
  intentGate: undefined as Promise<void> | undefined,
  onIntentBlocked: undefined as (() => void) | undefined,
}));

vi.mock('./utils/admin-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/admin-config')>();
  return {
    ...actual,
    atomicModifyConfig: async (...args: Parameters<typeof actual.atomicModifyConfig>) => {
      if (adminConfigBehavior.failNextConfigWrite) {
        adminConfigBehavior.failNextConfigWrite = false;
        throw new Error('injected config.json write failure');
      }
      return actual.atomicModifyConfig(...args);
    },
    withAgentConfigIntentLock: async <T>(fn: () => Promise<T>) => {
      if (adminConfigBehavior.delayNextIntent) {
        adminConfigBehavior.delayNextIntent = false;
        adminConfigBehavior.onIntentBlocked?.();
        await adminConfigBehavior.intentGate;
      }
      return actual.withAgentConfigIntentLock(fn);
    },
    atomicModifyProjects: async (...args: Parameters<typeof actual.atomicModifyProjects>) => {
      if (adminConfigBehavior.failProjectWrite) {
        throw new Error('injected projects.json write failure');
      }
      return actual.atomicModifyProjects(...args);
    },
  };
});

const sessionEngineMocks = vi.hoisted(() => {
  const state = {
    context: { sessionId: null as string | null, workspacePath: null as string | null },
    turnIdentity: null as { queueId: string; owner: { kind: 'goal' | 'task'; id: string } } | null,
    origins: new Map<string, unknown>(),
  };
  return {
    state,
    getStreamReplaySnapshot: vi.fn((): { sessionId: string; mcpEffectiveSnapshot: unknown } => ({ sessionId: '', mcpEffectiveSnapshot: null })),
    getCurrentSessionContext: vi.fn(() => ({ ...state.context, workspacePath: state.context.workspacePath ?? agentSessionMocks.agentDir ?? null })),
    updateMcpServers: vi.fn(async () => ({ success: true as boolean, error: undefined as string | undefined })),
    updateAgents: vi.fn(async () => ({ success: true as boolean, error: undefined as string | undefined })),
    getCurrentTurnIdentity: vi.fn(() => state.turnIdentity),
    getSessionOrigin: vi.fn((sessionId: string) => state.origins.get(sessionId)),
  };
});

vi.mock('./agent-session', () => ({
  SDK_RESERVED_MCP_NAMES: [] as string[],
  getAgentState: () => ({ agentDir: agentSessionMocks.agentDir }),
  setMcpServers: agentSessionMocks.setMcpServers,
  setAgents: agentSessionMocks.setAgents,
  getMcpServers: agentSessionMocks.getMcpServers,
  getSidecarPort: agentSessionMocks.getSidecarPort,
  getQueueStatus: agentSessionMocks.getQueueStatus,
  forceReloadActiveSession: agentSessionMocks.forceReloadActiveSession,
}));

vi.mock('./sse', () => ({
  broadcast: vi.fn(),
}));

vi.mock('./utils/management-api-client', () => ({
  ADMIN_LOOPBACK_TIMEOUT_MS: 10_000,
  managementApi: managementApiMocks.managementApi,
}));

vi.mock('./analytics', () => ({
  trackServer: analyticsMocks.trackServer,
}));

vi.mock('./runtimes/external-session', () => ({
  queryRuntimeModels: runtimeModelMocks.queryRuntimeModels,
}));

vi.mock('./runtimes/codex-command-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtimes/codex-command-context')>()),
  isManagedCodexRuntimeInstalled: () => runtimeModelMocks.managedInstalled,
}));

vi.mock('./provider-verify', () => ({
  verifyProviderViaSdk: providerVerifyMocks.verifyProviderViaSdk,
  verifySubscription: providerVerifyMocks.verifySubscription,
}));

vi.mock('./session-engine', () => ({
  inspectRuntime: vi.fn(async () => null),
  getSessionEngine: () => ({
    getCurrentSessionContext: sessionEngineMocks.getCurrentSessionContext,
    getStreamReplaySnapshot: sessionEngineMocks.getStreamReplaySnapshot,
    getCurrentTurnIdentity: sessionEngineMocks.getCurrentTurnIdentity,
    getSessionOrigin: sessionEngineMocks.getSessionOrigin,
    updateMcpServers: sessionEngineMocks.updateMcpServers,
    updateAgents: sessionEngineMocks.updateAgents,
  }),
}));

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevSidecarId: string | undefined;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(scratch, '.myagents', 'config.json'), 'utf-8')) as Record<string, unknown>;
}

function readJson(path: string): Record<string, unknown>[] {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>[];
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-admin-api-'));
  mkdirSync(join(scratch, '.myagents'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevSidecarId = process.env.MYAGENTS_SIDECAR_ID;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  process.env.MYAGENTS_SIDECAR_ID = 'test-session-sidecar';
  vi.resetModules();
  agentSessionMocks.agentDir = undefined;
  agentSessionMocks.getSidecarPort.mockReturnValue(0);
  agentSessionMocks.setMcpServers.mockClear();
  agentSessionMocks.setAgents.mockClear();
  agentSessionMocks.forceReloadActiveSession.mockClear();
  sessionEngineMocks.updateMcpServers.mockReset().mockResolvedValue({ success: true, error: undefined });
  sessionEngineMocks.updateAgents.mockReset().mockResolvedValue({ success: true, error: undefined });
  // Clear queued `mockResolvedValueOnce` entries as well as call history.
  // Some handlers make platform-dependent auxiliary calls; leaving an unused
  // one-shot response here can otherwise leak into the next test in the file.
  managementApiMocks.managementApi.mockReset();
  managementApiMocks.managementApi.mockResolvedValue({ ok: true, taskUpdated: 0, cronUpdated: 0 });
  analyticsMocks.trackServer.mockClear();
  runtimeModelMocks.queryRuntimeModels.mockClear();
  runtimeModelMocks.queryRuntimeModels.mockResolvedValue([{ value: 'gpt-5.6-sol' }]);
  runtimeModelMocks.managedInstalled = true;
  providerVerifyMocks.verifyProviderViaSdk.mockClear();
  providerVerifyMocks.verifyProviderViaSdk.mockResolvedValue({ success: true });
  providerVerifyMocks.verifySubscription.mockClear();
  providerVerifyMocks.verifySubscription.mockResolvedValue({ success: true });
  adminConfigBehavior.failProjectWrite = false;
  adminConfigBehavior.failNextConfigWrite = false;
  adminConfigBehavior.delayNextIntent = false;
  adminConfigBehavior.intentGate = undefined;
  adminConfigBehavior.onIntentBlocked = undefined;
  sessionEngineMocks.state.context = { sessionId: null, workspacePath: null };
  sessionEngineMocks.state.turnIdentity = null;
  sessionEngineMocks.state.origins.clear();
  sessionEngineMocks.getStreamReplaySnapshot.mockReset().mockReturnValue({ sessionId: '', mcpEffectiveSnapshot: null });
  sessionEngineMocks.getCurrentSessionContext.mockClear();
  sessionEngineMocks.getCurrentTurnIdentity.mockClear();
  sessionEngineMocks.getSessionOrigin.mockClear();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevSidecarId === undefined) delete process.env.MYAGENTS_SIDECAR_ID;
  else process.env.MYAGENTS_SIDECAR_ID = prevSidecarId;
  rmSync(scratch, { recursive: true, force: true });
});

describe('Record Admin routing', () => {
  it.each(['global', 'session'] as const)('forwards %s Record list results and errors through the production gate', async role => {
    const { composeSidecarRequestHandler, resolveSidecarComposition } = await import('./sidecar-composition');
    const { handleRecordList } = await import('./admin-api');
    const handler = composeSidecarRequestHandler(resolveSidecarComposition(role, false), async request =>
      Response.json(await handleRecordList(await request.json())),
    );
    for (const records of [[], [{ id: 'record-fixture', kind: 'text', content: 'Synthetic record' }]]) {
      managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, records });
      const response = await handler(new Request('http://localhost/api/admin/record/list', {
        method: 'POST', body: JSON.stringify({ kind: 'text', limit: 5 }),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, data: records });
      expect(managementApiMocks.managementApi).toHaveBeenLastCalledWith('/api/record/list?kind=text&limit=5');
    }
    const recoveryHint = { recoveryCommand: 'myagents status', message: 'Retry when storage is available' };
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: false, error: 'Record store unavailable', recoveryHint });
    const response = await handler(new Request('http://localhost/api/admin/record/list', { method: 'POST', body: '{}' }));
    expect(await response.json()).toMatchObject({ success: false, error: 'Record store unavailable', recoveryHint });
  });
});

describe('current Runtime configuration ownership', () => {
  it('reports the bundled SDK implementation version in both runtime discovery receipts', async () => {
    const { CLAUDE_AGENT_SDK_IMPLEMENTATION_VERSION } = await import('../shared/integrated-runtimes/identity');
    const { getExternalRuntime } = await import('./runtimes/factory');
    const spies = (['dsh', 'claude-code', 'codex'] as const).map(runtime => vi.spyOn(getExternalRuntime(runtime), 'detect').mockResolvedValue({ installed: false }));
    try {
      const { handleRuntimeList, handleRuntimeDescribe } = await import('./admin-api');
      expect(await handleRuntimeList()).toMatchObject({ success: true, data: expect.arrayContaining([{ runtime: 'builtin', displayName: expect.any(String), installed: true, version: CLAUDE_AGENT_SDK_IMPLEMENTATION_VERSION }]) });
      expect(await handleRuntimeDescribe({ runtime: 'builtin' })).toMatchObject({ success: true, data: { runtime: 'builtin', version: CLAUDE_AGENT_SDK_IMPLEMENTATION_VERSION } });
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it('routes reload through the SessionEngine and uses its workspace instead of dormant SDK state', async () => {
    const workspace = join(scratch, 'runtime-workspace');
    mkdirSync(workspace, { recursive: true });
    sessionEngineMocks.state.context = { sessionId: 'dsh-session', workspacePath: workspace };
    agentSessionMocks.agentDir = join(scratch, 'stale-sdk-workspace');
    const server = { id: 'runtime-mcp', name: 'Runtime MCP', type: 'http', url: 'https://synthetic.invalid/mcp' };
    writeJson(join(scratch, '.myagents', 'config.json'), { mcpServers: [server], mcpEnabledServers: [server.id] });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{ id: 'runtime-project', path: workspace, mcpEnabledServers: [server.id] }]);
    const { handleReload } = await import('./admin-api');
    expect(await handleReload()).toMatchObject({ success: true });
    expect(sessionEngineMocks.updateMcpServers).toHaveBeenCalledWith([expect.objectContaining({ id: server.id })]);
    expect(sessionEngineMocks.updateAgents).toHaveBeenCalledWith(expect.any(Object), { forceReload: true });
    expect(agentSessionMocks.setMcpServers).not.toHaveBeenCalled();
    expect(agentSessionMocks.setAgents).not.toHaveBeenCalled();
    expect(agentSessionMocks.forceReloadActiveSession).not.toHaveBeenCalled();
  });

  it.each(['mcp', 'agents'])('reports %s reload failure from the selected adapter', async component => {
    const update = component === 'mcp' ? sessionEngineMocks.updateMcpServers : sessionEngineMocks.updateAgents;
    update.mockResolvedValueOnce({ success: false, error: 'Runtime configuration rejected' });
    const { handleReload } = await import('./admin-api');
    expect(await handleReload()).toEqual({ success: false, error: 'Runtime configuration rejected' });
    if (component === 'mcp') expect(sessionEngineMocks.updateAgents).not.toHaveBeenCalled();
    expect(agentSessionMocks.forceReloadActiveSession).not.toHaveBeenCalled();
  });
});

describe('admin-api help registry', () => {
  it('lists config unset and all MCP env actions in group help', async () => {
    const { handleHelp } = await import('./admin-api');
    const config = String((handleHelp({ path: ['config'] }).data as { text?: string })?.text ?? '');
    const mcp = String((handleHelp({ path: ['mcp'] }).data as { text?: string })?.text ?? '');
    expect(config).toContain('unset <key>');
    expect(mcp).toContain('env <id> set|get|delete');
  });

  it('presents Record as canonical and Thought only as a compatibility alias', async () => {
    const { handleHelp } = await import('./admin-api');
    const record = String((handleHelp({ path: ['record'] }).data as { text?: string })?.text ?? '');
    const thought = String((handleHelp({ path: ['thought'] }).data as { text?: string })?.text ?? '');

    expect(record).toContain('Manage unified text and audio Records');
    expect(record).toContain('--kind text|audio');
    expect(record).toContain('New workflows use this command');
    expect(thought).toContain('Legacy compatibility alias');
    expect(thought).toContain("New Agent workflows use\n'myagents record'");
  });

  it('provides exact multi-level AnyDoc help without a readme command', async () => {
    const { handleHelp } = await import('./admin-api');
    const group = String((handleHelp({ path: ['anydoc'] }).data as { text?: string })?.text ?? '');
    expect(group).toContain('convert');
    expect(group).toContain('status');
    expect(group).toContain('wait');
    expect(group).toContain('cancel');
    expect(group).toContain('list');
    expect(group.toLowerCase()).not.toContain('readme');

    for (const leaf of ['convert', 'status', 'wait', 'cancel', 'list']) {
      const text = String((handleHelp({ path: ['anydoc', leaf] }).data as { text?: string })?.text ?? '');
      expect(text).toContain(`myagents anydoc ${leaf}`);
      expect(text).toContain('WHEN TO CALL');
      expect(text).toContain('EFFECT');
      expect(text).toContain('OPTIONS');
      expect(text).toContain('PATH / PASSWORD SAFETY');
      expect(text).toContain('ASYNC / EXIT');
      expect(text).toContain('OUTPUT');
      expect(text).toContain('ERROR RECOVERY');
    }
    const convert = String((handleHelp({ path: ['anydoc', 'convert'] }).data as { text?: string })?.text ?? '');
    expect(convert).toContain('shell history');
    expect(convert).toContain('local process inspection');
    expect(convert).toContain('Queue: 16 jobs');
    expect(convert).toContain('Source: 512 MiB');
    expect(convert).toContain('PDF: 500 pages');
    expect(convert).toContain('Decoded image: 100 megapixels');
    expect(convert).toContain('Published output: 128 MiB');
    expect(convert).toContain('Job deadline: 30 minutes');
  });

  it('documents speech as an exact Session-scoped async command group', async () => {
    const { handleHelp } = await import('./admin-api');
    const group = String((handleHelp({ path: ['speech'] }).data as { text?: string })?.text ?? '');
    expect(group).toContain('transcribe');
    expect(group).toContain('Session ID and Workspace are bound automatically');

    for (const leaf of ['transcribe', 'status', 'wait', 'cancel', 'list']) {
      const text = String((handleHelp({ path: ['speech', leaf] }).data as { text?: string })?.text ?? '');
      expect(text).toContain(`myagents speech ${leaf}`);
      expect(text).not.toContain('--session-id');
      expect(text).not.toMatch(/^\s*--workspace\b/m);
    }
    const transcribe = String((handleHelp({ path: ['speech', 'transcribe'] }).data as { text?: string })?.text ?? '');
    expect(transcribe).toContain('at most 4 GiB and 8 hours');
    expect(transcribe).toContain('SPEECH_RESOURCE_REQUIRED');
    expect(transcribe).toContain('does not create a Record or perform diarization');
  });

  it('documents dry-run on the exact mutation leaves that implement it', async () => {
    const { handleHelp } = await import('./admin-api');
    for (const path of [
      ['mcp', 'add'],
      ['model', 'add'],
      ['config', 'set'],
    ]) {
      const text = String((handleHelp({ path }).data as { text?: string })?.text ?? '');
      expect(text).toContain(`myagents ${path.join(' ')}`);
      expect(text).toContain('--dry-run');
      expect(text).toMatch(/without (writing|persisting)|does not (write|persist)/i);
    }
  });

  it('distinguishes API-key and subscription verification in exact model verify help', async () => {
    const { handleHelp } = await import('./admin-api');
    const text = String((handleHelp({ path: ['model', 'verify'] }).data as { text?: string })?.text ?? '');
    expect(text).toContain('myagents model verify');
    expect(text).toContain('API-key');
    expect(text).toContain('subscription');
  });

  it('provides exact Agent and Session leaf help instead of group fallback', async () => {
    const { handleHelp } = await import('./admin-api');
    const leaves = [
      ['agent', 'list'],
      ['agent', 'show'],
      ['session', 'list'],
      ['session', 'start'],
      ['session', 'send'],
      ['session', 'watch'],
      ['session', 'get'],
    ];
    for (const path of leaves) {
      const result = handleHelp({ path });
      const text = String((result.data as { text?: string })?.text ?? '');
      expect(text).toContain(`myagents ${path.join(' ')}`);
      expect(text).toContain('WHEN TO CALL');
      expect(text).toContain('EFFECT');
      expect(text).toContain('OPTIONS');
      expect(text).toContain('OUTPUT');
      expect(text).toContain('IDENTITY / PERMISSIONS');
      expect(text).toContain('EXAMPLE');
      expect(text).toContain('RECOVERY');
    }
    const sessionGroup = String((handleHelp({ path: ['session'] }).data as { text?: string })?.text ?? '');
    expect(sessionGroup).toContain('Fresh context');
    expect(sessionGroup).toContain('Reuse known context');
    expect(sessionGroup).toContain('Observe only');
  });

  it('provides specific local management help and labels remaining shared references', async () => {
    const { handleHelp } = await import('./admin-api');
    const leaves = [
      ['agent', 'create'], ['agent', 'enable'], ['agent', 'disable'],
      ['agent', 'archive'], ['agent', 'unarchive'], ['agent', 'set'],
      ['record', 'list'], ['record', 'get'], ['record', 'create'], ['record', 'delete'],
      ['skill', 'list'], ['skill', 'info'], ['skill', 'add'], ['skill', 'remove'],
      ['skill', 'enable'], ['skill', 'disable'], ['skill', 'sync'],
      ['task', 'comments'], ['task', 'comment'],
    ];
    for (const path of leaves) {
      const text = String((handleHelp({ path }).data as { text: string }).text);
      const parent = String((handleHelp({ path: path.slice(0, 1) }).data as { text: string }).text);
      expect(text).not.toBe(parent);
      expect(text).toContain(`myagents ${path.join(' ')}`);
      expect(text).toContain('--');
    }
    const shared = String((handleHelp({ path: ['model', 'list'] }).data as { text: string }).text);
    expect(shared).toContain('shared "myagents model" reference');
    expect(shared).toContain('not a separate help page');
    const agentHelp = String((handleHelp({ path: ['agent'] }).data as { text: string }).text);
    expect(agentHelp).toContain('network-diagnose');
    expect(agentHelp).toContain('other devices');
    expect(agentHelp).toContain('do not manage remote Agents');
    const get = String((handleHelp({ path: ['session', 'get'] }).data as { text: string }).text);
    expect(get).toContain('--limit <1..500>');
    expect(get).toContain('--before <messageId>');
    expect(get).toContain('liveSessionState=null');
    expect(get).toContain('hidden reminder instructions');
    for (const path of [
      ['session', 'get', 'session-id'], ['skill', 'info', 'skill-name'],
      ['record', 'get', 'record-id'], ['task', 'comments', 'task-id'],
      ['agent', 'show', 'agent-id'], ['space', 'issue', 'view', 'issue-id'],
    ]) {
      const text = String((handleHelp({ path }).data as { text: string }).text);
      expect(text).not.toContain('shared "myagents');
    }
    const info = String((handleHelp({ path: ['skill', 'info'] }).data as { text: string }).text);
    expect(info).toContain('skill list for enabled');
    expect(info).not.toContain('enabled metadata');
  });

  it('provides compact exact Task leaf help for Agent automation flows', async () => {
    const { handleHelp } = await import('./admin-api');
    const leaves = [
      ['task', 'list'],
      ['task', 'get'],
      ['task', 'create-direct'],
      ['task', 'create-attached'],
      ['task', 'update'],
      ['task', 'run'],
      ['task', 'rerun'],
      ['task', 'start'],
      ['task', 'stop'],
      ['task', 'runs'],
      ['task', 'update-status'],
      ['task', 'append-session'],
      ['task', 'exit'],
      ['task', 'run-now'],
      ['task', 'check-now'],
      ['task', 'trigger', 'validate'],
      ['task', 'trigger', 'test'],
      ['task', 'reset-checkpoint'],
      ['task', 'archive'],
      ['task', 'delete'],
      ['task', 'readme'],
    ];
    for (const path of leaves) {
      const text = String((handleHelp({ path }).data as { text?: string })?.text ?? '');
      expect(text).toContain(`myagents ${path.join(' ')}`);
      expect(text).toContain('WHEN TO CALL');
      expect(text).toContain('EFFECT');
      expect(text).toContain('OPTIONS');
      expect(text).toContain('MUTATION / AI');
      expect(text).toContain('OUTPUT');
      expect(text).toContain('EXAMPLE');
      expect(text).toContain('RECOVERY');
    }
    expect(String((handleHelp({ path: ['task', 'delete'] }).data as { text?: string }).text))
      .toContain('There is no undelete command');
    expect(String((handleHelp({ path: ['task', 'run'] }).data as { text?: string }).text))
      .toContain('about 2 seconds');
  });

  it('keeps im send-media leaf help aligned with the executable file flag contract', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['im', 'send-media'] });
    const text = (result.data as { text?: string } | undefined)?.text ?? '';

    expect(result.success).toBe(true);
    expect(text).toContain('send-media --file <path> [--caption <text>]');
    expect(text).not.toContain('send-media <path>');
  });

  it('documents the official vision command group for myagents vision --help', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['vision'] });
    const text = (result.data as { text?: string } | undefined)?.text ?? '';

    expect(result.success).toBe(true);
    expect(text).toContain('myagents vision');
    expect(text).toContain('analyze');
    expect(text).not.toContain('Unknown command group');
  });

  it('documents Goal Mode for myagents goal --help', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['goal'] });
    const text = (result.data as { text?: string } | undefined)?.text ?? '';

    expect(result.success).toBe(true);
    expect(text).toContain('myagents goal');
    expect(text).toContain('Goal Mode');
    expect(text).toContain('create --objective');
    expect(text).toContain('--deadline <ISO-8601-with-offset>');
    expect(text).toContain('--max-executions <positive-integer>');
    expect(text).toContain('--ai-can-exit <true|false>');
    expect(text).toContain('outside the current');
    expect(text).toContain('not a delayed start');
    expect(text).toContain('update --status complete');
    expect(text).toContain('Do not infer Goal Mode');
    expect(text).not.toContain('Unknown command group');
  });

  it('does not advertise loop schedule creation from ordinary cron help', async () => {
    const { handleHelp } = await import('./admin-api');

    const shortHelp = handleHelp({ path: ['cron'] });
    const readme = handleHelp({ path: ['cron', 'readme'] });
    const shortText = (shortHelp.data as { text?: string } | undefined)?.text ?? '';
    const readmeText = (readme.data as { text?: string } | undefined)?.text ?? '';

    expect(shortHelp.success).toBe(true);
    expect(readme.success).toBe(true);
    expect(shortText).not.toContain('{"kind":"loop"}');
    expect(readmeText).not.toContain('{"kind":"loop"}');
    expect(shortText).toContain('--prompt-file is supported');
    expect(handleHelp({ path: ['goal'] }).success).toBe(true);
  });

  it('exposes the unified Task automation readme while keeping cron compatible', async () => {
    const { handleReadme } = await import('./admin-api');

    const task = handleReadme({ topic: 'task' });
    const cron = handleReadme({ topic: 'cron' });
    const taskText = (task.data as { text?: string } | undefined)?.text ?? '';
    const cronText = (cron.data as { text?: string } | undefined)?.text ?? '';

    expect(task.success).toBe(true);
    expect(taskText).toContain('myagents-task-automation');
    expect(taskText).toContain('always');
    expect(taskText).toContain('command Detector');
    expect(taskText).toContain('myagents task exit');
    expect(taskText).toContain('deduplicated');
    expect(taskText).toContain('event.id was already handled');
    expect(cron.success).toBe(true);
    expect(cronText).toContain('myagents task readme');
    expect(cronText).toContain('Compatibility');
  });

  it('documents canonical Agent keys and Task provider overrides', async () => {
    const { handleHelp } = await import('./admin-api');

    const agent = handleHelp({ path: ['agent'] });
    const task = handleHelp({ path: ['task'] });
    const agentText = (agent.data as { text?: string } | undefined)?.text ?? '';
    const taskText = (task.data as { text?: string } | undefined)?.text ?? '';

    expect(agent.success).toBe(true);
    expect(agentText).toContain('providerId/model/permissionMode');
    expect(agentText).not.toContain('provider/model/permission');
    expect(task.success).toBe(true);
    expect(taskText).toContain('--providerId');
    expect(taskText).toContain('must be paired with --model');
  });

  it.each(['status', 'version', 'reload'])('serves help for the %s leaf without executing it', async command => {
    const { handleHelp } = await import('./admin-api');
    const result = handleHelp({ path: [command] });
    expect(result.success).toBe(true);
    expect((result.data as { text: string }).text).toContain(`myagents ${command}`);
    expect((result.data as { text: string }).text).toContain('--json');
  });

  it('includes vision in the derived command group list', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['definitely-not-a-command'] });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown command group "definitely-not-a-command"');
    expect(result.suggestion).toContain('vision');
  });

  it('does not expose the legacy issue alias as a help command group', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['issue'] });
    const text = (result.data as { text?: string } | undefined)?.text ?? '';

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown command group "issue"');
    expect(result.suggestion).toContain('space');
    expect(text).not.toContain('Legacy read-only alias');
  });

  it('uses the longest Space command path so leaf help is an executable Agent contract', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['space', 'issue', 'attachment', 'add'] });
    const text = (result.data as { text?: string } | undefined)?.text ?? '';

    expect(result.success).toBe(true);
    expect(text).toContain('myagents space issue attachment add');
    expect(text).toContain('WHEN TO CALL');
    expect(text).toContain('ACTOR AND PERMISSIONS');
    expect(text).toContain('FILE SAFETY');
    expect(text).toContain('--space <slug>');
    expect(text).not.toContain('myagents space — Work with');
  });

  it('provides an independent Agent contract for every Space Issue leaf', async () => {
    const { handleHelp } = await import('./admin-api');
    const leaves = [
      ['space', 'issue', 'list'],
      ['space', 'issue', 'view'],
      ['space', 'issue', 'comments'],
      ['space', 'issue', 'status'],
      ['space', 'issue', 'claim'],
      ['space', 'issue', 'close'],
      ['space', 'issue', 'cancel-claim'],
    ];
    for (const path of leaves) {
      const result = handleHelp({ path });
      const text = (result.data as { text?: string } | undefined)?.text ?? '';
      expect(text, path.join(' ')).toContain('WHEN TO CALL');
      expect(text, path.join(' ')).toContain('RECOVERY');
      expect(text, path.join(' ')).not.toContain('myagents space — Work with');
    }
  });

  it('provides exact nine-section contracts for Goal discovery and Issue metadata update', async () => {
    const { handleHelp } = await import('./admin-api');
    const sections = [
      'WHEN TO CALL',
      'EFFECT',
      'REQUIRED CONTEXT',
      'OPTIONS',
      'ACTOR AND PERMISSIONS',
      'FILE SAFETY',
      'OUTPUT',
      'EXAMPLES',
      'RECOVERY',
    ];

    const goalText = String((handleHelp({ path: ['space', 'goal', 'list'] }).data as { text?: string })?.text ?? '');
    const updateText = String((handleHelp({ path: ['space', 'issue', 'update'] }).data as { text?: string })?.text ?? '');
    for (const section of sections) {
      expect(goalText).toContain(section);
      expect(updateText).toContain(section);
    }
    expect(goalText).toContain('data.items[].id');
    expect(goalText).toContain('archived IDs cannot be assigned');
    expect(goalText).toContain('Session Goal Mode');
    expect(updateText).toContain('--clear-goal');
    expect(updateText).toContain('does not change workflow state, assignee, claim');
    expect(updateText).toContain('does not support --dry-run');
    expect(goalText).not.toContain('myagents space — Discover');
    expect(updateText).not.toContain('myagents space — Discover');
  });

  it('keeps Space group and related Issue help aligned on discovery, Inbox, and Goal output', async () => {
    const { handleHelp } = await import('./admin-api');
    const spaceText = String((handleHelp({ path: ['space'] }).data as { text?: string })?.text ?? '');
    const issueText = String((handleHelp({ path: ['space', 'issue'] }).data as { text?: string })?.text ?? '');
    const createText = String((handleHelp({ path: ['space', 'issue', 'create'] }).data as { text?: string })?.text ?? '');
    const listText = String((handleHelp({ path: ['space', 'issue', 'list'] }).data as { text?: string })?.text ?? '');
    const viewText = String((handleHelp({ path: ['space', 'issue', 'view'] }).data as { text?: string })?.text ?? '');

    expect(spaceText).toContain('DISCOVERY FLOW FOR AGENTS');
    expect(spaceText).toContain('GOAL NAMESPACES');
    expect(issueText).toContain('update <issueId>');
    expect(createText).toContain('Without --goal it enters Inbox');
    expect(createText).toContain('goalId, goalPathLabel');
    expect(listText).toContain('--goal <goalId>|inbox');
    expect(listText).toContain('--include-subtree <true|false>');
    expect(viewText).toContain('issue.goalId');
    expect(viewText).toContain('issue.goalPathLabel');
  });
});

describe('external CLI private config envelope', () => {
  it('cannot be read or mutated through generic config handlers', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      externalCliAccess: {
        enabled: true,
        token: 'mae_private',
        createdAt: '2026-09-19T00:00:00.000Z',
      },
    });
    const { handleConfigGet, handleConfigSet } = await import('./admin-api');

    expect(handleConfigGet({ key: 'externalCliAccess' })).toMatchObject({ success: false });
    await expect(handleConfigSet({
      key: 'externalCliAccess.enabled',
      value: false,
    })).resolves.toMatchObject({ success: false });
    expect(readConfig().externalCliAccess).toMatchObject({
      enabled: true,
      token: 'mae_private',
    });
  });
});

describe('admin-api Skill add preview contract', () => {
  it('keeps a single-Skill dry-run to one preview-only request', async () => {
    const cancellation = await import('./utils/cancellation');
    const requests: Array<Record<string, unknown>> = [];
    agentSessionMocks.getSidecarPort.mockReturnValue(32123);
    cancellation._setGeneralFetchTransportForTests(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        success: true,
        mode: 'single',
        preview: {
          skill: { suggestedFolderName: 'private-skill', name: 'private-skill' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    try {
      const { handleSkillAdd } = await import('./admin-api');
      const result = await handleSkillAdd({
        url: '/tmp/private-skill',
        dryRun: true,
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: '/tmp/private-skill',
        scope: 'user',
        previewOnly: true,
      });
      expect(result).toMatchObject({
        success: true,
        dryRun: true,
        preview: { action: 'install', skills: ['private-skill'] },
      });
    } finally {
      cancellation._setGeneralFetchTransportForTests();
    }
  });

  it('commits a single Skill only after a distinct preview request', async () => {
    const cancellation = await import('./utils/cancellation');
    const requests: Array<Record<string, unknown>> = [];
    agentSessionMocks.getSidecarPort.mockReturnValue(32123);
    cancellation._setGeneralFetchTransportForTests(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      const response = requests.length === 1
        ? {
            success: true,
            mode: 'single',
            preview: {
              skill: { suggestedFolderName: 'private-skill', name: 'private-skill' },
            },
          }
        : {
            success: true,
            mode: 'installed',
            installed: [{ folderName: 'private-skill' }],
          };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const { handleSkillAdd } = await import('./admin-api');
      const result = await handleSkillAdd({ url: '/tmp/private-skill' });

      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ previewOnly: true });
      expect(requests[1]).toMatchObject({
        url: '/tmp/private-skill',
        confirmedSelection: { folderNames: ['private-skill'] },
      });
      expect(requests[1]).not.toHaveProperty('previewOnly');
      expect(result.success).toBe(true);
    } finally {
      cancellation._setGeneralFetchTransportForTests();
    }
  });
});

describe('admin-api Skill scope and sync', () => {
  it('previews by default and submits only selected candidates with --apply', async () => {
    const cancellation = await import('./utils/cancellation');
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    agentSessionMocks.getSidecarPort.mockReturnValue(32123);
    cancellation._setGeneralFetchTransportForTests(async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
      const response = path.endsWith('sync-check')
        ? { canSync: true, folders: ['alpha', 'beta'] }
        : { success: true, synced: 1, failed: 0, syncedFolders: ['beta'] };
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const { handleSkillSync } = await import('./admin-api');
      expect(await handleSkillSync()).toMatchObject({ success: true, data: { applied: false, folders: ['alpha', 'beta'] } });
      expect(calls).toHaveLength(1);
      expect(await handleSkillSync({ apply: true, names: ['beta'] })).toMatchObject({ success: true, data: { applied: true, synced: ['beta'] } });
      expect(calls[2]).toMatchObject({ path: '/api/skill/sync-from-claude', body: { expectedFolders: ['alpha', 'beta'], folders: ['beta'] } });
    } finally {
      cancellation._setGeneralFetchTransportForTests();
    }
  });

  it('routes project info and enable to the workspace owner', async () => {
    const cancellation = await import('./utils/cancellation');
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    agentSessionMocks.getSidecarPort.mockReturnValue(32123);
    cancellation._setGeneralFetchTransportForTests(async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ path: `${parsed.pathname}${parsed.search}`, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
      const response = parsed.pathname === '/api/skills'
        ? { success: true, skills: [{ name: 'Alpha Display', folderName: 'alpha', scope: 'project' }] }
        : parsed.pathname === '/api/project-capabilities'
        ? { success: true, skills: [{ scope: 'project', folderName: 'alpha', capabilityId: 'project:skill:alpha', enabled: true }] }
        : parsed.pathname === '/api/project-capability/toggle'
          ? { success: true, skills: [{ capabilityId: 'project:skill:alpha', enabled: false }] }
        : parsed.pathname === '/api/skill/alpha'
          ? { success: true, skill: { name: 'alpha' } }
          : { success: true };
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const { handleSkillInfo, handleSkillToggle } = await import('./admin-api');
      expect(await handleSkillInfo({ name: 'alpha', scope: 'project', workspacePath: '/workspace/one' })).toMatchObject({ success: true });
      expect(await handleSkillToggle({ name: 'alpha', scope: 'project', workspacePath: '/workspace/one', enabled: false })).toMatchObject({ success: true });
      expect(calls[0].path).toContain('agentDir=%2Fworkspace%2Fone');
      expect(calls[4]).toMatchObject({ path: '/api/project-capability/toggle', body: { agentDir: '/workspace/one', capabilityId: 'project:skill:alpha', enabled: false } });
      expect(calls.some(call => call.path === '/api/skill/toggle-enable')).toBe(false);
    } finally {
      cancellation._setGeneralFetchTransportForTests();
    }
  });

  it('resolves a listed project skill and previews removal without deleting it', async () => {
    const cancellation = await import('./utils/cancellation');
    const calls: string[] = [];
    agentSessionMocks.getSidecarPort.mockReturnValue(32123);
    cancellation._setGeneralFetchTransportForTests(async (url, init) => {
      const parsed = new URL(String(url));
      calls.push(`${init?.method ?? 'GET'} ${parsed.pathname}${parsed.search}`);
      const response = parsed.pathname === '/api/skills'
        ? { success: true, skills: [{ name: 'Alpha Display', folderName: 'alpha', scope: 'project' }] }
        : { success: true, skill: { name: 'alpha', scope: 'project' } };
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const { handleSkillInfo, handleSkillRemove } = await import('./admin-api');
      expect(await handleSkillInfo({ name: 'Alpha Display', workspacePath: '/workspace/one' })).toMatchObject({ success: true });
      expect(await handleSkillRemove({ name: 'Alpha Display', workspacePath: '/workspace/one', dryRun: true })).toMatchObject({ success: true, data: { dryRun: true, scope: 'project', folderName: 'alpha' } });
      expect(calls.filter(call => call.includes('/api/skill/alpha'))).toEqual([
        expect.stringContaining('scope=project'),
        expect.stringContaining('scope=project'),
      ]);
      expect(calls.some(call => call.startsWith('DELETE'))).toBe(false);
    } finally {
      cancellation._setGeneralFetchTransportForTests();
    }
  });
});

describe('admin-api AnyDoc forwarding', () => {
  it('injects the Sidecar-owned Workspace and forwards the transient password only to Rust', async () => {
    agentSessionMocks.agentDir = '/workspace/authoritative';
    managementApiMocks.managementApi.mockResolvedValue({
      ok: true,
      job: { jobId: '20260815_7f3a91c2b6d4', state: 'queued' },
    });
    const { handleAnydocConvert } = await import('./admin-api');

    const result = await handleAnydocConvert({
      sourcePath: '/inputs/report.pdf',
      outputRoot: '/outputs',
      password: 'marker-secret',
    });

    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/document/convert',
      'POST',
      {
        sourcePath: '/inputs/report.pdf',
        outputRoot: '/outputs',
        password: 'marker-secret',
        currentWorkspace: '/workspace/authoritative',
      },
    );
    expect(result).toEqual({
      success: true,
      data: { job: { jobId: '20260815_7f3a91c2b6d4', state: 'queued' } },
    });
  });

  it('keeps status/list read-only and cancel as the only lifecycle mutation', async () => {
    const {
      handleAnydocCancel,
      handleAnydocList,
      handleAnydocStatus,
    } = await import('./admin-api');
    await handleAnydocStatus({ jobId: '20260815_7f3a91c2b6d4' });
    await handleAnydocList({ limit: 20 });
    await handleAnydocCancel({ jobId: '20260815_7f3a91c2b6d4' });

    expect(managementApiMocks.managementApi.mock.calls).toEqual([
      ['/api/document/status?jobId=20260815_7f3a91c2b6d4'],
      ['/api/document/list?limit=20'],
      ['/api/document/cancel', 'POST', { jobId: '20260815_7f3a91c2b6d4' }],
    ]);
  });
});

describe('admin-api speech forwarding', () => {
  function enableSpeechForCurrentSession(): void {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      enabledOfficialToolIds: ['speech-recognition'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-speech',
      name: 'Speech Workspace',
      path: '/workspace/authoritative',
      enabledOfficialToolIds: ['speech-recognition'],
    }]);
    sessionEngineMocks.state.context = {
      sessionId: 'session-speech',
      workspacePath: '/workspace/authoritative',
    };
  }

  it('injects only process identity and never accepts caller-supplied Session or Workspace scope', async () => {
    enableSpeechForCurrentSession();
    managementApiMocks.managementApi.mockResolvedValue({
      ok: true,
      job: { jobId: 'speech_01', state: 'queued' },
    });
    const { handleSpeechTranscribe } = await import('./admin-api');

    const result = await handleSpeechTranscribe({
      sourcePath: '/workspace/authoritative/meeting.m4a',
      outputRoot: '/workspace/authoritative/transcripts',
    });

    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/speech/transcribe',
      'POST',
      {
        sidecarId: 'test-session-sidecar',
        sourcePath: '/workspace/authoritative/meeting.m4a',
        outputRoot: '/workspace/authoritative/transcripts',
      },
    );
    expect(result).toEqual({
      success: true,
      data: { job: { jobId: 'speech_01', state: 'queued' } },
    });
  });

  it('forwards every management lookup as a process-bound POST', async () => {
    enableSpeechForCurrentSession();
    const { handleSpeechCancel, handleSpeechList, handleSpeechStatus } = await import('./admin-api');

    await handleSpeechStatus({ jobId: 'speech_01' });
    await handleSpeechList({ limit: 20 });
    await handleSpeechCancel({ jobId: 'speech_01' });

    expect(managementApiMocks.managementApi.mock.calls).toEqual([
      ['/api/speech/status', 'POST', { sidecarId: 'test-session-sidecar', jobId: 'speech_01' }],
      ['/api/speech/list', 'POST', { sidecarId: 'test-session-sidecar', limit: 20 }],
      ['/api/speech/cancel', 'POST', { sidecarId: 'test-session-sidecar', jobId: 'speech_01' }],
    ]);
  });

  it('rejects Global or incomplete caller context before Rust transport', async () => {
    const { handleSpeechList } = await import('./admin-api');
    const result = await handleSpeechList({ limit: 20 });

    expect(result).toMatchObject({
      success: false,
      code: 'SPEECH_SESSION_REQUIRED',
    });
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });
});

describe('admin-api Space workspace identity', () => {
  it('forwards Goal discovery and Issue update through the existing Space management bridge', async () => {
    managementApiMocks.managementApi
      .mockResolvedValueOnce({ ok: true, data: { items: [] } })
      .mockResolvedValueOnce({ ok: true, data: { issue: { id: 'iss_1' } } });
    const { handleSpaceGoalList, handleSpaceIssueUpdate } = await import('./admin-api');

    const goalResult = await handleSpaceGoalList({ spaceSlug: 'official', includeArchived: true });
    const updateResult = await handleSpaceIssueUpdate({
      spaceSlug: 'official',
      issueId: 'iss_1',
      goalUpdate: { action: 'clear' },
    });

    expect(managementApiMocks.managementApi).toHaveBeenNthCalledWith(1, '/api/space/goal-list', 'POST', {
      spaceSlug: 'official',
      includeArchived: true,
    });
    expect(managementApiMocks.managementApi).toHaveBeenNthCalledWith(2, '/api/space/issue-update', 'POST', {
      spaceSlug: 'official',
      issueId: 'iss_1',
      goalUpdate: { action: 'clear' },
    });
    expect(goalResult).toMatchObject({ success: true, hint: expect.stringContaining('data.items[].id') });
    expect(updateResult).toMatchObject({ success: true, hint: expect.stringContaining('Re-read') });
  });

  it('enriches Space commands with the stable project id for the requested workspace', async () => {
    const workspace = join(scratch, 'workspace');
    mkdirSync(workspace);
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-stable-id',
      name: 'Workspace',
      path: workspace,
    }]);
    agentSessionMocks.agentDir = workspace;
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, data: { actor: {} } });
    const { handleSpaceWhoami } = await import('./admin-api');

    await handleSpaceWhoami({ spaceSlug: 'official', workspacePath: workspace });

    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/space/whoami', 'POST', {
      spaceSlug: 'official',
      workspacePath: workspace,
      workspaceId: 'project-stable-id',
    });
  });

  it('preserves an explicit workspace id so identity mismatches fail closed downstream', async () => {
    const workspace = join(scratch, 'workspace-explicit');
    mkdirSync(workspace);
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-stable-id',
      name: 'Workspace',
      path: workspace,
    }]);
    agentSessionMocks.agentDir = workspace;
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, data: { actor: {} } });
    const { handleSpaceWhoami } = await import('./admin-api');

    await handleSpaceWhoami({
      spaceSlug: 'official',
      workspacePath: workspace,
      workspaceId: 'explicit-mismatching-id',
    });

    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/space/whoami', 'POST', {
      spaceSlug: 'official',
      workspacePath: workspace,
      workspaceId: 'explicit-mismatching-id',
    });
  });

  it('forwards only the exact persisted Registered Agent Session origin as actor authority', async () => {
    const workspace = join(scratch, 'workspace-origin');
    mkdirSync(workspace);
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-origin',
      name: 'Origin Workspace',
      path: workspace,
    }]);
    sessionEngineMocks.state.origins.set('session-agent-a', {
      kind: 'registered-agent',
      surface: 'space_issue_delivery',
      context: { spaceId: 'space-a', registeredAgentId: 'agent-a' },
    });
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, data: { actor: {} } });
    const { handleSpaceWhoami } = await import('./admin-api');

    await handleSpaceWhoami({
      spaceSlug: 'official',
      workspacePath: workspace,
      workspaceId: 'project-origin',
      sessionId: 'session-agent-a',
    });

    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/space/whoami', 'POST', {
      spaceSlug: 'official',
      workspacePath: workspace,
      workspaceId: 'project-origin',
      sessionId: 'session-agent-a',
      sessionOrigin: { spaceId: 'space-a', registeredAgentId: 'agent-a' },
    });
  });
});

describe('admin-api goal', () => {
  it('creates a current-session Goal without Cron delivery ownership', async () => {
    const { setImCronContext, clearImCronContext } = await import('./tools/im-cron-tool');
    const { handleGoalCreate } = await import('./admin-api');
    sessionEngineMocks.state.context = {
      sessionId: 'session-im-goal',
      workspacePath: '/tmp/myagents-goal-workspace',
    };
    setImCronContext({
      botId: 'bot-feishu',
      chatId: 'chat-123',
      platform: 'feishu',
      workspacePath: '/tmp/myagents-goal-workspace',
    });
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      goal: { id: 'goal_1', objective: 'Ship it', status: 'active' },
    });

    const result = await handleGoalCreate({ objective: 'Ship it' });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/goal/create', 'POST', {
      sessionId: 'session-im-goal',
      workspacePath: '/tmp/myagents-goal-workspace',
      objective: 'Ship it',
    });
    clearImCronContext();
  });

  it('forwards existing Goal end conditions to the Rust authority', async () => {
    const { handleGoalCreate } = await import('./admin-api');
    sessionEngineMocks.state.context = {
      sessionId: 'session-goal-with-limits',
      workspacePath: '/tmp/myagents-goal-workspace',
    };
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      goal: { id: 'goal_limited', objective: 'Ship it', status: 'active' },
    });

    const endConditions = {
      deadline: '2026-07-22T01:00:00.000Z',
      maxExecutions: 5,
      aiCanExit: false,
    };
    const result = await handleGoalCreate({ objective: 'Ship it', endConditions });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/goal/create', 'POST', {
      sessionId: 'session-goal-with-limits',
      workspacePath: '/tmp/myagents-goal-workspace',
      objective: 'Ship it',
      endConditions,
    });
  });

  it('forwards the active queue turn when the model terminalizes a Goal', async () => {
    const { handleGoalUpdate } = await import('./admin-api');
    sessionEngineMocks.state.context = {
      sessionId: 'session-goal-turn',
      workspacePath: '/tmp/myagents-goal-workspace',
    };
    sessionEngineMocks.state.turnIdentity = {
      queueId: 'queue-current',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, goal: { id: 'goal-1' } });

    const result = await handleGoalUpdate({ status: 'complete', reason: 'done' });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/goal/update', 'POST', {
      sessionId: 'session-goal-turn',
      workspacePath: '/tmp/myagents-goal-workspace',
      goalId: 'goal-1',
      queueId: 'queue-current',
      status: 'complete',
      reason: 'done',
    });
  });

  it('rejects a terminal update without a current Goal-owned queue turn', async () => {
    const { handleGoalUpdate } = await import('./admin-api');
    sessionEngineMocks.state.context = {
      sessionId: 'session-stale-goal-turn',
      workspacePath: '/tmp/myagents-goal-workspace',
    };

    const result = await handleGoalUpdate({ status: 'complete', reason: 'stale completion' });

    expect(result).toEqual({
      success: false,
      error: 'Goal terminal update requires the active Goal turn authority',
    });
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });
});

describe('admin-api cron create', () => {
  it('validates and forwards explicit Codex Task routing through cron create', async () => {
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      task: { id: 'cron-codex', runtime: 'codex' },
    });
    const { handleCronCreate } = await import('./admin-api');
    const payload = {
      name: 'Codex automation',
      message: 'Review the workspace',
      workspacePath: '/tmp/myagents-cron-codex',
      intervalMinutes: 30,
      runtime: 'codex',
      runtimeConfig: { source: 'managed-provider', model: 'gpt-5.6-sol' },
    };

    const result = await handleCronCreate(payload);

    expect(result.success).toBe(true);
    expect(runtimeModelMocks.queryRuntimeModels).toHaveBeenCalledWith('codex', {
      runtimeSource: 'managed-provider',
    });
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/cron/create',
      'POST',
      payload,
    );
  });

  it('validates runtime overrides before returning a cron dry-run preview', async () => {
    const { handleCronCreate } = await import('./admin-api');

    const result = await handleCronCreate({
      name: 'Invalid automation',
      message: 'Do work',
      runtime: 'imaginary-runtime',
      dryRun: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid --runtime value');
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('rejects provider/model routing mismatches before a cron dry-run preview', async () => {
    const { handleCronCreate } = await import('./admin-api');

    const missingModel = await handleCronCreate({
      name: 'Invalid provider pair',
      message: 'Do work',
      providerId: 'provider-1',
      dryRun: true,
    });
    const externalProvider = await handleCronCreate({
      name: 'Invalid external provider',
      message: 'Do work',
      runtime: 'codex',
      providerId: 'provider-1',
      model: 'gpt-5.6-sol',
      dryRun: true,
    });

    expect(missingModel.success).toBe(false);
    expect(missingModel.error).toContain('requires --model');
    expect(externalProvider.success).toBe(false);
    expect(externalProvider.error).toContain('cannot be combined with --providerId');
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('leaves execution routing unset when the caller did not request a Task override', async () => {
    const workspacePath = '/tmp/myagents-managed-codex-workspace';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      defaultProviderId: 'anthropic-sub',
      agents: [{
        id: 'agent-managed-codex',
        name: 'Managed Codex',
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        runtime: 'builtin',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-managed-codex', path: workspacePath, agentId: 'agent-managed-codex',
    }]);
    const { handleCronCreate } = await import('./admin-api');

    const result = await handleCronCreate({
      name: 'follow-agent',
      message: 'Do work',
      workspacePath,
      intervalMinutes: 5,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.preview).toMatchObject({
      name: 'follow-agent',
      message: 'Do work',
      workspacePath,
      intervalMinutes: 5,
    });
    expect(result.preview).not.toHaveProperty('providerId');
    expect(result.preview).not.toHaveProperty('model');
    expect(result.preview).not.toHaveProperty('runtime');
    expect(result.preview).not.toHaveProperty('runtimeConfig');
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('rejects loop schedules before ordinary cron creation reaches Rust', async () => {
    const { handleCronCreate } = await import('./admin-api');

    const result = await handleCronCreate({
      prompt: 'Keep going',
      schedule: { kind: 'loop' },
      workspacePath: '/tmp/myagents-goal-workspace',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Use myagents goal create');
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });
});

describe('admin-api cron update', () => {
  it('validates and forwards runtime patches after the workspace ownership guard', async () => {
    managementApiMocks.managementApi
      .mockResolvedValueOnce({ ok: true, tasks: [{ id: 'cron-codex' }] })
      .mockResolvedValueOnce({
        ok: true,
        task: {
          id: 'cron-codex',
          status: 'running',
          workspacePath: '/tmp/myagents-cron-codex',
          runtime: 'codex',
          runtimeConfig: { source: 'managed-provider', model: 'old-model' },
        },
      })
      .mockResolvedValueOnce({ ok: true, task: { id: 'cron-codex', runtime: 'codex' } });
    const { handleCronUpdate } = await import('./admin-api');
    const payload = {
      taskId: 'cron-codex',
      patch: {
        runtimeConfig: { source: 'managed-provider', model: 'gpt-5.6-sol' },
      },
    };

    const result = await handleCronUpdate(payload);

    expect(result.success).toBe(true);
    expect(runtimeModelMocks.queryRuntimeModels).toHaveBeenCalledWith('codex', {
      runtimeSource: 'managed-provider',
    });
    expect(managementApiMocks.managementApi).toHaveBeenLastCalledWith(
      '/api/cron/update',
      'POST',
      payload,
    );
  });
});

describe('admin-api accepted task attempt analytics', () => {
  it('uses the same semantic receipt path for Task create and get', async () => {
    const workspacePath = '/tmp/myagents-task-receipt';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{ id: 'agent-receipt', name: 'Receipt Agent', workspacePath }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-receipt', path: workspacePath, agentId: 'agent-receipt',
    }]);
    const persistedTask = {
      id: 'task-receipt',
      name: 'Receipt Task',
      status: 'todo',
      runMode: 'new-session',
      nextExecutionAt: null,
    };
    managementApiMocks.managementApi
      .mockResolvedValueOnce({ ok: true, task: persistedTask })
      .mockResolvedValueOnce({ ok: true, task: persistedTask });
    const { handleTaskCreateDirect, handleTaskGet } = await import('./admin-api');

    const created = await handleTaskCreateDirect({
      name: 'Receipt Task',
      workspaceId: 'project-receipt',
      workspacePath,
      taskMdContent: 'Do the work',
    });
    const fetched = await handleTaskGet({ id: 'task-receipt' });

    expect(created).toMatchObject({
      success: true,
      data: {
        receipt: {
          operation: 'create',
          taskId: 'task-receipt',
          status: 'todo',
          changed: true,
          resultAccess: { mode: 'execution-session' },
        },
      },
    });
    expect(fetched).toMatchObject({
      success: true,
      data: {
        receipt: {
          operation: 'get',
          taskId: 'task-receipt',
          status: 'todo',
          changed: false,
        },
      },
    });
  });

  it('describes Attached Task results as staying in the bound Session', async () => {
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      task: {
        id: 'task-attached-receipt',
        status: 'running',
        dispatchOrigin: 'attached-session',
        runMode: null,
        sessionIds: ['space-session'],
      },
    });
    const { handleTaskCreateAttached } = await import('./admin-api');

    const result = await handleTaskCreateAttached({
      name: 'Attached receipt',
      currentSessionId: 'space-session',
      workspacePath: '/tmp/myagents-space-attached',
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        receipt: {
          taskId: 'task-attached-receipt',
          resultAccess: {
            mode: 'bound-session',
            summary: expect.stringContaining('bound Session'),
          },
        },
      },
    });
  });

  it('reports the run ordinal returned by the accepted mutation without a task prefetch', async () => {
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      taskId: 'task-run-accepted',
      status: 'running',
      nextExecutionAt: 1_780_000_000_000,
      task: { id: 'task-run-accepted', sessionIds: ['shared-session'] },
      attemptOrdinal: 4,
    });
    const { handleTaskRun } = await import('./admin-api');

    const result = await handleTaskRun({ id: 'task-run-accepted' });

    expect(result).toMatchObject({
      success: true,
      data: {
        taskId: 'task-run-accepted',
        status: 'running',
        nextExecutionAt: 1_780_000_000_000,
        task: { id: 'task-run-accepted', sessionIds: ['shared-session'] },
        attemptOrdinal: 4,
        receipt: {
          operation: 'run',
          taskId: 'task-run-accepted',
          status: 'running',
          changed: true,
          nextExecutionAt: 1_780_000_000_000,
          statusMeaning: expect.stringContaining('scheduler is enabled'),
          resultAccess: {
            mode: 'execution-session',
            inspectTaskCommand: 'myagents task get task-run-accepted --json',
            inspectRunsCommand: 'myagents task runs task-run-accepted --limit 5 --full --json',
            inspectCommentsCommand: 'myagents task comments task-run-accepted --limit 50 --json',
          },
        },
      },
    });
    expect(managementApiMocks.managementApi).toHaveBeenCalledOnce();
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/task/run',
      'POST',
      { id: 'task-run-accepted' },
    );
    expect(analyticsMocks.trackServer).toHaveBeenCalledWith('task_run', {
      source: 'cli',
      run_count: 4,
    });
  });

  it('does not report an attempt when run admission is rejected', async () => {
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: false,
      code: 'invalid_state',
      error: 'task is busy',
    });
    const { handleTaskRun } = await import('./admin-api');

    const result = await handleTaskRun({ id: 'task-run-rejected' });

    expect(result).toEqual({ success: false, code: 'invalid_state', error: 'task is busy' });
    expect(managementApiMocks.managementApi).toHaveBeenCalledOnce();
    expect(analyticsMocks.trackServer).not.toHaveBeenCalled();
  });

  it('returns a semantic no-op receipt and skips analytics when run was already enabled', async () => {
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      taskId: 'task-already-running',
      status: 'running',
      nextExecutionAt: 1_780_000_000_000,
      changed: false,
      task: {
        id: 'task-already-running',
        status: 'running',
        runMode: 'single-session',
        sessionIds: ['bound-session'],
      },
    });
    const { handleTaskRun } = await import('./admin-api');

    const result = await handleTaskRun({ id: 'task-already-running' });

    expect(result).toMatchObject({
      success: true,
      data: {
        changed: false,
        receipt: {
          operation: 'run',
          taskId: 'task-already-running',
          status: 'running',
          changed: false,
          resultAccess: { mode: 'bound-session' },
        },
      },
    });
    expect(analyticsMocks.trackServer).not.toHaveBeenCalled();
  });

  it('uses the same accepted ordinal contract for rerun', async () => {
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      task: { id: 'task-rerun-accepted', sessionIds: ['reused-session'] },
      attemptOrdinal: 7,
    });
    const { handleTaskRerun } = await import('./admin-api');

    const result = await handleTaskRerun({ id: 'task-rerun-accepted' });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledOnce();
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/task/rerun',
      'POST',
      { id: 'task-rerun-accepted' },
    );
    expect(analyticsMocks.trackServer).toHaveBeenCalledWith('task_run', {
      source: 'cli',
      run_count: 7,
    });
  });
});

describe('admin-api Task Detector forwarding', () => {
  it('forwards validate, check-now, run-now, and reset to the Rust Task authority', async () => {
    managementApiMocks.managementApi
      .mockResolvedValueOnce({ ok: true, trigger: { source: { type: 'time' }, detector: { type: 'always' } } })
      .mockResolvedValueOnce({ ok: true, result: { state: { checkCount: 2 } } })
      .mockResolvedValueOnce({ ok: true, taskId: 'task-1', sessionId: 'session-1' })
      .mockResolvedValueOnce({ ok: true, state: { checkpoint: null, checkpointRevision: 0 } });
    const {
      handleTaskTriggerValidate,
      handleTaskCheckNow,
      handleTaskRunNow,
      handleTaskResetCheckpoint,
    } = await import('./admin-api');
    const trigger = { source: { type: 'time' }, detector: { type: 'always' } };

    expect((await handleTaskTriggerValidate({ trigger })).success).toBe(true);
    expect((await handleTaskCheckNow({ id: 'task-1' })).success).toBe(true);
    expect((await handleTaskRunNow({ id: 'task-1' })).success).toBe(true);
    expect((await handleTaskResetCheckpoint({ id: 'task-1' })).success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenNthCalledWith(
      1,
      '/api/task/trigger/validate',
      'POST',
      { trigger },
    );
    expect(managementApiMocks.managementApi).toHaveBeenNthCalledWith(
      2,
      '/api/task/check-now',
      'POST',
      { id: 'task-1' },
      { timeoutMs: 310_000 },
    );
    expect(managementApiMocks.managementApi).toHaveBeenNthCalledWith(
      3,
      '/api/task/run-now',
      'POST',
      { id: 'task-1' },
    );
    expect(managementApiMocks.managementApi).toHaveBeenNthCalledWith(
      4,
      '/api/task/reset-checkpoint',
      'POST',
      { id: 'task-1' },
    );
  });

  it('keeps test fixtures transient and turns --expect mismatch into failure', async () => {
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      result: { decision: 'activate', invocationId: 'inv-1' },
    });
    const { handleTaskTriggerTest } = await import('./admin-api');

    const result = await handleTaskTriggerTest({
      taskId: 'task-1',
      checkpoint: { cursor: 7 },
      expect: 'quiet',
    });

    expect(result).toMatchObject({
      success: false,
      error: 'Detector returned activate; expected quiet',
      data: { result: { decision: 'activate' } },
    });
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/task/trigger/test',
      'POST',
      { taskId: 'task-1', checkpoint: { cursor: 7 } },
      { timeoutMs: 310_000 },
    );
  });

  it('rejects an invalid --expect before running the Detector', async () => {
    const { handleTaskTriggerTest } = await import('./admin-api');

    const result = await handleTaskTriggerTest({
      taskId: 'task-1',
      expect: 'activte',
    });

    expect(result).toEqual({
      success: false,
      error: '--expect must be quiet or activate',
    });
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('keeps structured check-now failure diagnostics for CLI output', async () => {
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: false,
      code: 'detector_check_failed',
      error: 'Detector timed out',
      result: {
        outcome: 'error',
        state: {
          lastError: {
            code: 'detector_timeout',
            message: 'Detector timed out',
            occurredAt: 1_775_000_000_000,
            timedOut: true,
          },
        },
      },
    });
    const { handleTaskCheckNow } = await import('./admin-api');

    expect(await handleTaskCheckNow({ id: 'task-1' })).toMatchObject({
      success: false,
      code: 'detector_check_failed',
      data: { result: { outcome: 'error' } },
    });
  });
});

describe('admin-api Task Agent experience', () => {
  function configureCurrentWorkspace(): string {
    const workspacePath = join(scratch, 'current-workspace');
    mkdirSync(workspacePath, { recursive: true });
    agentSessionMocks.agentDir = workspacePath;
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{ id: 'agent-current', name: 'Current Agent', workspacePath }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-current',
      name: 'Current Project',
      path: workspacePath,
      agentId: 'agent-current',
    }]);
    return workspacePath;
  }

  it('routes exact-id Task schedule operations directly to TaskStore adapters', async () => {
    managementApiMocks.managementApi
      .mockResolvedValueOnce({ ok: true, task: { id: 'task-remote' } })
      .mockResolvedValueOnce({ ok: true, task: { id: 'task-remote' } })
      .mockResolvedValueOnce({ ok: true, runs: [{ id: 'run-1' }] });
    const { handleTaskStart, handleTaskStop, handleTaskRuns } = await import('./admin-api');

    await expect(handleTaskStart({ taskId: 'task-remote' })).resolves.toMatchObject({ success: true });
    await expect(handleTaskStop({ taskId: 'task-remote' })).resolves.toMatchObject({ success: true });
    await expect(handleTaskRuns({ taskId: 'task-remote', limit: 5 })).resolves.toMatchObject({
      success: true,
      data: [{ id: 'run-1' }],
    });

    expect(managementApiMocks.managementApi.mock.calls).toEqual([
      ['/api/cron/run', 'POST', { taskId: 'task-remote' }],
      ['/api/cron/stop', 'POST', { taskId: 'task-remote' }],
      ['/api/task/runs?taskId=task-remote&limit=5'],
    ]);
  });

  it('inherits current workspace for direct creation and preserves CLI caller provenance', async () => {
    const workspacePath = configureCurrentWorkspace();
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      task: { id: 'task-current', name: 'Current task', workspaceId: 'project-current', workspacePath },
    });
    const { handleTaskCreateDirect } = await import('./admin-api');

    const result = await handleTaskCreateDirect({
      name: 'Current task',
      taskMdContent: 'Do the work.',
      actor: 'agent',
      source: 'cli',
    });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/task/create-direct',
      'POST',
      expect.objectContaining({
        workspaceId: 'project-current',
        workspacePath,
        actor: 'agent',
        source: 'cli',
      }),
    );
  });

  it('rejects an explicit workspace id/path pair from different projects', async () => {
    const workspacePath = configureCurrentWorkspace();
    const otherPath = join(scratch, 'other-workspace');
    mkdirSync(otherPath, { recursive: true });
    writeJson(join(scratch, '.myagents', 'projects.json'), [
      {
        id: 'project-current',
        name: 'Current Project',
        path: workspacePath,
        agentId: 'agent-current',
      },
      {
        id: 'project-other',
        name: 'Other Project',
        path: otherPath,
        agentId: 'agent-other',
      },
    ]);
    const { handleTaskCreateDirect } = await import('./admin-api');

    const result = await handleTaskCreateDirect({
      name: 'Mismatched task',
      taskMdContent: 'Do not persist this.',
      workspaceId: 'project-current',
      workspacePath: otherPath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not own workspacePath');
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('resolves either explicit Task workspace selector to the canonical pair', async () => {
    const workspacePath = configureCurrentWorkspace();
    managementApiMocks.managementApi
      .mockResolvedValueOnce({
        ok: true,
        task: { id: 'task-by-id', workspaceId: 'project-current', workspacePath },
      })
      .mockResolvedValueOnce({ ok: true, tasks: [] });
    const { handleTaskCreateDirect, handleTaskList } = await import('./admin-api');

    await handleTaskCreateDirect({
      name: 'By id',
      taskMdContent: 'Do the work.',
      workspaceId: 'project-current',
    });
    await handleTaskList({ workspacePath });

    expect(managementApiMocks.managementApi.mock.calls[0]).toEqual([
      '/api/task/create-direct',
      'POST',
      expect.objectContaining({ workspaceId: 'project-current', workspacePath }),
    ]);
    expect(managementApiMocks.managementApi.mock.calls[1]).toEqual([
      '/api/task/list?workspaceId=project-current',
    ]);
  });

  it('returns a compact filtered current-workspace list without expanded session identities', async () => {
    const workspacePath = configureCurrentWorkspace();
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      tasks: [
        {
          id: 'task-release',
          name: 'Release review',
          description: 'Inspect release blockers',
          workspaceId: 'project-current',
          status: 'running',
          executionMode: 'recurring',
          sessionIds: Array.from({ length: 186 }, (_, index) => `session-${index}`),
          nextExecutionAt: 1_780_000_000_000,
          tags: ['release'],
        },
        {
          id: 'task-other',
          name: 'Other work',
          workspaceId: 'project-current',
          status: 'todo',
          sessionIds: ['session-other'],
        },
      ],
    });
    const { handleTaskList } = await import('./admin-api');

    const result = await handleTaskList({ query: 'release', limit: 1 });

    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/task/list?workspaceId=project-current');
    expect(result.scope).toEqual({
      workspacePath,
      source: 'default',
      visibility: 'current Task workspace',
    });
    expect(result.data).toEqual([expect.objectContaining({
      id: 'task-release',
      sessionCount: 186,
      nextExecutionAt: 1_780_000_000_000,
    })]);
    expect((result.data as Array<Record<string, unknown>>)[0]).not.toHaveProperty('sessionIds');
    expect((result.data as Array<Record<string, unknown>>)[0]).not.toHaveProperty('description');
  });

  it('exposes only the compact current Agent context for diagnostics', async () => {
    const workspacePath = configureCurrentWorkspace();
    sessionEngineMocks.state.context = { sessionId: 'session-current', workspacePath };
    const { handleAgentCurrent } = await import('./admin-api');

    expect(await handleAgentCurrent()).toEqual({
      success: true,
      data: {
        agentId: 'agent-current',
        name: 'Current Agent',
        workspaceId: 'project-current',
        workspacePath,
        sessionId: 'session-current',
      },
    });
  });

  it('forwards Agent archive provenance so the Rust user-only guard can reject it', async () => {
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: false,
      code: 'archive_user_only',
      error: 'archive is user-only',
    });
    const { handleTaskArchive } = await import('./admin-api');

    const result = await handleTaskArchive({
      id: 'task-1',
      actor: 'agent',
      source: 'cli',
    });

    expect(result.success).toBe(false);
    expect(result).toMatchObject({
      code: 'archive_user_only',
      error: 'archive is user-only',
    });
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/task/archive',
      'POST',
      { id: 'task-1', actor: 'agent', source: 'cli' },
    );
  });

  it('resolves an omitted comment Task ID from the exact active Session context', async () => {
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      comment: { id: 'comment-agent' },
    });
    const { setCronTaskContext } = await import('./tools/cron-tools');
    const { handleTaskComment } = await import('./admin-api');
    const previousSessionId = process.env.MYAGENTS_SESSION_ID;
    process.env.MYAGENTS_SESSION_ID = 'session-active';
    setCronTaskContext('task-active', false, 'session-active');

    try {
      expect(await handleTaskComment({
        body: 'Completed with verification evidence.',
      })).toMatchObject({ success: true });
      expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
        '/api/task/comment',
        'POST',
        {
          id: 'task-active',
          body: 'Completed with verification evidence.',
          replyToCommentId: undefined,
          sessionId: 'session-active',
        },
      );
    } finally {
      setCronTaskContext(null, false, 'session-active');
      if (previousSessionId === undefined) delete process.env.MYAGENTS_SESSION_ID;
      else process.env.MYAGENTS_SESSION_ID = previousSessionId;
    }
  });

  it('rejects an omitted comment Task ID outside an active Task turn', async () => {
    const { handleTaskComment } = await import('./admin-api');
    const previousSessionId = process.env.MYAGENTS_SESSION_ID;
    process.env.MYAGENTS_SESSION_ID = 'session-idle';
    try {
      expect(await handleTaskComment({ body: 'Ambiguous result.' })).toMatchObject({
        success: false,
        error: expect.stringContaining('Task ID is required'),
      });
      expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
    } finally {
      if (previousSessionId === undefined) delete process.env.MYAGENTS_SESSION_ID;
      else process.env.MYAGENTS_SESSION_ID = previousSessionId;
    }
  });

  it('ignores a forged client Session id and uses only the Sidecar identity', async () => {
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      comment: { id: 'comment-agent' },
    });
    const { handleTaskComment } = await import('./admin-api');
    const previousSessionId = process.env.MYAGENTS_SESSION_ID;
    process.env.MYAGENTS_SESSION_ID = 'session-trusted';
    try {
      await handleTaskComment({
        id: 'task-1',
        body: 'Persist this result.',
        sessionId: 'session-forged',
      } as Parameters<typeof handleTaskComment>[0] & { sessionId: string });
      expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
        '/api/task/comment',
        'POST',
        {
          id: 'task-1',
          body: 'Persist this result.',
          replyToCommentId: undefined,
          sessionId: 'session-trusted',
        },
      );
    } finally {
      if (previousSessionId === undefined) delete process.env.MYAGENTS_SESSION_ID;
      else process.env.MYAGENTS_SESSION_ID = previousSessionId;
    }
  });
});

describe('admin-api task runtime model identity', () => {
  it('treats an explicit Task providerId as builtin instead of inheriting an external Agent runtime', async () => {
    const workspacePath = '/tmp/myagents-task-builtin-provider';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-external-default',
        name: 'External Default',
        workspacePath,
        runtime: 'codex',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-external-default',
      path: workspacePath,
      agentId: 'agent-external-default',
    }]);
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      task: {
        id: 'task-builtin-provider',
        providerId: 'deepseek',
        model: 'deepseek-chat',
      },
    });
    const { handleTaskCreateDirect } = await import('./admin-api');

    const result = await handleTaskCreateDirect({
      name: 'Builtin provider task',
      workspacePath,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });

    expect(result.success).toBe(true);
    expect(runtimeModelMocks.queryRuntimeModels).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      overrides: {
        providerId: 'deepseek',
        model: 'deepseek-chat',
      },
      overridden: expect.arrayContaining(['providerId', 'model']),
      overridesRequested: expect.arrayContaining(['providerId', 'model']),
    });
  });

  it('rejects managed-provider when the Task runtime is not Codex', async () => {
    const { handleTaskCreateDirect } = await import('./admin-api');

    const result = await handleTaskCreateDirect({
      name: 'invalid-managed-claude-code-pair',
      runtime: 'claude-code',
      runtimeConfig: { source: 'managed-provider', model: 'sonnet' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires runtime=codex');
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('rejects unknown Task runtime source values instead of coercing them', async () => {
    const { handleTaskCreateDirect } = await import('./admin-api');

    const result = await handleTaskCreateDirect({
      name: 'invalid-runtime-source',
      runtime: 'codex',
      runtimeConfig: { source: 'mystery-owner', model: 'gpt-5.6-sol' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid runtimeConfig.source');
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('rejects Task subscription Providers because DSH admits ordinary API routes only', async () => {
    const { getExternalRuntime } = await import('./runtimes/factory');
    vi.spyOn(getExternalRuntime('dsh'), 'detect').mockResolvedValueOnce({
      installed: true, version: '0.0.0',
    });
    const { handleTaskCreateDirect } = await import('./admin-api');

    const result = await handleTaskCreateDirect({
      name: 'invalid-dsh-provider-owner',
      runtime: 'dsh',
      runtimeConfig: { source: 'integrated' },
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('enabled ordinary API route configured for DSH');
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('validates a Task update against the persisted complete runtime identity', async () => {
    managementApiMocks.managementApi
      .mockResolvedValueOnce({
        ok: true,
        task: {
          id: 'task-managed-update',
          workspacePath: '/tmp/myagents-managed-task-update',
          runtime: 'codex',
          runtimeConfig: { source: 'managed-provider', model: 'old-model' },
        },
      })
      .mockResolvedValueOnce({ ok: true, taskUpdated: 1, cronUpdated: 0 });
    const { handleTaskUpdate } = await import('./admin-api');

    const result = await handleTaskUpdate({
      id: 'task-managed-update',
      runtimeConfig: { source: 'managed-provider', model: 'gpt-5.6-sol' },
    });

    expect(result.success).toBe(true);
    expect(runtimeModelMocks.queryRuntimeModels).toHaveBeenCalledWith('codex', {
      runtimeSource: 'managed-provider',
    });
    expect(managementApiMocks.managementApi).toHaveBeenNthCalledWith(
      1,
      '/api/task/get?id=task-managed-update',
    );
    expect(managementApiMocks.managementApi).toHaveBeenNthCalledWith(
      2,
      '/api/task/update',
      'POST',
      {
        id: 'task-managed-update',
        runtimeConfig: { source: 'managed-provider', model: 'gpt-5.6-sol' },
      },
    );
  });

  it('applies clear-provider semantics before validating a Task runtime switch', async () => {
    managementApiMocks.managementApi
      .mockResolvedValueOnce({
        ok: true,
        task: {
          id: 'task-clear-provider-switch',
          workspacePath: '/tmp/myagents-clear-provider-switch',
          runtime: 'builtin',
          providerId: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
      })
      .mockResolvedValueOnce({ ok: true, taskUpdated: 1, cronUpdated: 0 });
    const { handleTaskUpdate } = await import('./admin-api');
    const payload = {
      id: 'task-clear-provider-switch',
      runtime: 'codex',
      runtimeConfig: { source: 'managed-provider' },
      clearProviderOverride: true,
    };

    const result = await handleTaskUpdate(payload);

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenNthCalledWith(
      2,
      '/api/task/update',
      'POST',
      payload,
    );
  });

  it('rejects inherited managed source when the workspace runtime is not Codex', async () => {
    const workspacePath = '/tmp/myagents-claude-code-task-source';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-claude-code-task-source',
        name: 'Claude Code Task Source',
        workspacePath,
        runtime: 'claude-code',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-claude-code-task-source', path: workspacePath, agentId: 'agent-claude-code-task-source',
    }]);
    const { handleTaskCreateDirect } = await import('./admin-api');

    const result = await handleTaskCreateDirect({
      name: 'invalid-inherited-managed-source',
      workspacePath,
      runtimeConfig: { source: 'managed-provider' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires runtime=codex');
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('validates clearRuntimeOverride against the inherited Agent identity', async () => {
    const workspacePath = '/tmp/myagents-clear-runtime-override';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-clear-runtime-override',
        name: 'Clear Runtime Override',
        workspacePath,
        runtime: 'builtin',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-clear-runtime-override', path: workspacePath, agentId: 'agent-clear-runtime-override',
    }]);
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      task: {
        id: 'task-clear-runtime-override',
        workspacePath,
        runtime: 'codex',
        runtimeConfig: { source: 'managed-provider' },
        permissionMode: 'no-restrictions',
      },
    });
    const { handleTaskUpdate } = await import('./admin-api');

    const result = await handleTaskUpdate({
      id: 'task-clear-runtime-override',
      clearRuntimeOverride: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("'no-restrictions' is not valid");
    expect(managementApiMocks.managementApi).toHaveBeenCalledTimes(1);
  });

  it('uses the managed Codex catalog when a managed Agent Task only overrides model', async () => {
    const workspacePath = '/tmp/myagents-managed-task-model';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-managed-task-model',
        name: 'Managed Task Model',
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        runtime: 'builtin',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-managed-task-model', path: workspacePath, agentId: 'agent-managed-task-model',
    }]);
    const { handleTaskCreateDirect } = await import('./admin-api');

    const result = await handleTaskCreateDirect({
      name: 'managed-model-override',
      workspacePath,
      model: 'gpt-5.6-sol',
    });

    expect(result.success).toBe(true);
    expect(runtimeModelMocks.queryRuntimeModels).toHaveBeenCalledWith('codex', {
      runtimeSource: 'managed-provider',
    });
  });

  it('validates the canonical external model from runtimeConfig', async () => {
    const { handleTaskCreateDirect } = await import('./admin-api');

    const result = await handleTaskCreateDirect({
      name: 'invalid-managed-runtime-model',
      runtime: 'codex',
      runtimeConfig: {
        source: 'managed-provider',
        model: 'not-a-managed-model',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not-a-managed-model');
    expect(runtimeModelMocks.queryRuntimeModels).toHaveBeenCalledWith('codex', {
      runtimeSource: 'managed-provider',
    });
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('rejects system-only permission values for inherited managed Codex', async () => {
    const workspacePath = '/tmp/myagents-managed-task-permission';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-managed-task-permission',
        name: 'Managed Task Permission',
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        runtime: 'builtin',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-managed-task-permission', path: workspacePath, agentId: 'agent-managed-task-permission',
    }]);
    const { handleTaskCreateDirect } = await import('./admin-api');

    const result = await handleTaskCreateDirect({
      name: 'invalid-managed-permission',
      workspacePath,
      permissionMode: 'full-auto',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("'full-auto' is not valid");
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('rejects inherited managed Codex when its runtime is not installed', async () => {
    const workspacePath = '/tmp/myagents-managed-task-missing-runtime';
    runtimeModelMocks.managedInstalled = false;
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-managed-task-missing-runtime',
        name: 'Managed Task Missing Runtime',
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        runtime: 'builtin',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-managed-task-missing-runtime', path: workspacePath, agentId: 'agent-managed-task-missing-runtime',
    }]);
    const { handleTaskCreateDirect } = await import('./admin-api');

    const result = await handleTaskCreateDirect({
      name: 'missing-managed-runtime',
      workspacePath,
      model: 'gpt-5.6-sol',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Runtime 'codex' is not installed");
    expect(runtimeModelMocks.queryRuntimeModels).not.toHaveBeenCalled();
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });
});

describe('admin-api agent set configuration intent', () => {
  it('commits an IM model default without projecting Runtime changes before the caller releases its peer fence', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      providerVerifyStatus: { 'anthropic-sub': { status: 'valid' } },
      agents: [{ id: 'im-agent', name: 'IM Agent', runtime: 'builtin', enabled: true,
        providerId: 'anthropic-sub', model: 'old', permissionMode: 'plan', mcpEnabledServers: ['owned-mcp'] }],
    });
    const { commitAgentModelSelection } = await import('./admin-api');
    expect(await commitAgentModelSelection('im-agent', { kind: 'product-provider', providerId: 'anthropic-sub', model: 'claude-sonnet-4-6' }))
      .toMatchObject({ success: true, data: { reloadPatch: { model: 'claude-sonnet-4-6' } } });
    expect(readConfig()).toMatchObject({ agents: [{ model: 'claude-sonnet-4-6', permissionMode: 'plan', mcpEnabledServers: ['owned-mcp'] }] });
    expect(managementApiMocks.managementApi.mock.calls.every(([path]) => path === '/api/app/config-changed')).toBe(true);
  });

  it('rejects unavailable default selections and new Channel execution overrides before writing', async () => {
    const config = { agents: [{ id: 'im-agent', name: 'IM Agent', permissionMode: 'auto', channels: [] }] };
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    const { commitAgentModelSelection, handleAgentChannelAdd } = await import('./admin-api');
    expect(await commitAgentModelSelection('im-agent', { kind: 'product-provider', providerId: 'anthropic-sub', model: 'claude-sonnet-4-6' }))
      .toMatchObject({ success: false });
    expect(await handleAgentChannelAdd({ agentId: 'im-agent', channel: { type: 'telegram', overrides: { model: 'override' } } }))
      .toMatchObject({ success: false, error: expect.stringContaining('no longer supported') });
    expect(readConfig()).toEqual(config);
  });
  it.each([
    ['provider', 'providerId'],
    ['permission', 'permissionMode'],
    ['totallyUnknownField', 'Supported fields'],
  ])('rejects unsupported field %s before writing config', async (key, recoveryText) => {
    const config = {
      agents: [{
        id: 'agent-unknown-field',
        name: 'Unknown Field Guard',
        enabled: true,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    };
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({
      id: 'agent-unknown-field',
      key,
      value: 'ignored-value',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(recoveryText);
    expect(readConfig()).toEqual(config);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('stores managed Codex product permission without changing provider or model', async () => {
    const workspacePath = '/tmp/myagents-agent-set-managed-codex';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-managed-codex',
        name: 'Managed Codex',
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        runtime: 'builtin',
        permissionMode: 'auto',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-managed-codex',
      name: 'Managed Codex',
      path: workspacePath,
      agentId: 'agent-managed-codex',
      providerId: 'codex-sub',
      model: 'gpt-5.6-sol',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({
      id: 'agent-managed-codex',
      key: 'permissionMode',
      value: 'fullAgency',
    });

    expect(result.success).toBe(true);
    const agent = (readConfig().agents as Record<string, unknown>[])[0];
    expect(agent).toMatchObject({
      providerId: 'codex-sub',
      model: 'gpt-5.6-sol',
      runtime: 'builtin',
      permissionMode: 'fullAgency',
    });
    expect(readJson(join(scratch, '.myagents', 'projects.json'))[0]).toMatchObject({
      providerId: 'codex-sub',
      model: 'gpt-5.6-sol',
      permissionMode: 'fullAgency',
    });
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/reload-config',
      'POST',
      { agentId: 'agent-managed-codex', patch: { permissionMode: 'fullAgency' } },
    );
  });

  it('writes DSH runtimePreference atomically with the legacy Runtime projection', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-runtime-dsh',
        name: 'DSH Intent',
        workspacePath: '/tmp/myagents-agent-runtime-dsh',
        runtime: 'codex',
        runtimePreference: { family: 'external', id: 'codex' },
        runtimeConfig: { model: 'gpt-5.6-sol', permissionMode: 'full-auto' },
      }],
    });
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({
      id: 'agent-runtime-dsh',
      key: 'runtime',
      value: 'dsh',
    });

    expect(result.success).toBe(true);
    expect((readConfig().agents as Record<string, unknown>[])[0]).toMatchObject({
      runtime: 'dsh',
      runtimePreference: { family: 'integrated', id: 'dsh' },
    });
    expect((readConfig().agents as Record<string, unknown>[])[0]).not.toHaveProperty('runtimeConfig');
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/reload-config',
      'POST',
      {
        agentId: 'agent-runtime-dsh',
        patch: {
          runtime: 'dsh',
          runtimeConfig: null,
          runtimePreference: { family: 'integrated', id: 'dsh' },
        },
      },
    );
  });

  it('rejects an invalid permission mode without mutating either config store', async () => {
    const workspacePath = '/tmp/myagents-agent-set-invalid';
    const config = {
      agents: [{
        id: 'agent-invalid',
        name: 'Invalid Guard',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-opus-4-6',
        permissionMode: 'auto',
      }],
    };
    const projects = [{
      id: 'project-invalid',
      name: 'Invalid Guard',
      path: workspacePath,
      agentId: 'agent-invalid',
      providerId: 'anthropic-sub',
      model: 'claude-opus-4-6',
      permissionMode: 'auto',
    }];
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    writeJson(join(scratch, '.myagents', 'projects.json'), projects);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({
      id: 'agent-invalid',
      key: 'permissionMode',
      value: 'unlimited-magic',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Valid');
    expect(readConfig()).toEqual(config);
    expect(readJson(join(scratch, '.myagents', 'projects.json'))).toEqual(projects);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('rejects managed Codex full-auto instead of escalating it to no-restrictions', async () => {
    const workspacePath = '/tmp/myagents-agent-set-full-auto';
    const config = {
      agents: [{
        id: 'agent-full-auto',
        name: 'Full Auto Guard',
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        permissionMode: 'auto',
      }],
    };
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-full-auto',
      name: 'Full Auto Guard',
      path: workspacePath,
      agentId: 'agent-full-auto',
      providerId: 'codex-sub',
      model: 'gpt-5.6-sol',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({
      id: 'agent-full-auto',
      key: 'permissionMode',
      value: 'full-auto',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Valid: auto, plan, fullAgency');
    expect(readConfig()).toEqual(config);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('rejects runtimeConfig permission values outside the selected system runtime vocabulary', async () => {
    const workspacePath = '/tmp/myagents-agent-runtime-config-invalid';
    const config = {
      agents: [{
        id: 'agent-runtime-config-invalid',
        name: 'Runtime Config Guard',
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        runtime: 'codex',
        runtimeConfig: { source: 'system-cli', permissionMode: 'full-auto' },
        permissionMode: 'auto',
      }],
    };
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    const { handleAgentSet } = await import('./admin-api');

    const invalid = await handleAgentSet({
      id: 'agent-runtime-config-invalid',
      key: 'runtimeConfig',
      value: { source: 'system-cli', permissionMode: 'no-such-mode' },
    });
    expect(invalid.success).toBe(false);
    expect(readConfig()).toEqual(config);

    const valid = await handleAgentSet({
      id: 'agent-runtime-config-invalid',
      key: 'runtimeConfig',
      value: { source: 'system-cli', permissionMode: 'no-restrictions' },
    });
    expect(valid.success).toBe(true);
    expect((readConfig().agents as Record<string, unknown>[])[0]).toMatchObject({
      runtimeConfig: { source: 'system-cli', permissionMode: 'no-restrictions' },
    });
  });

  it('keeps managed Agent permission out of runtimeConfig', async () => {
    const config = {
      agents: [{
        id: 'agent-managed-runtime-config',
        name: 'Managed Runtime Config Guard',
        workspacePath: '/tmp/myagents-agent-managed-runtime-config',
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        runtime: 'builtin',
        permissionMode: 'auto',
      }],
    };
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({
      id: 'agent-managed-runtime-config',
      key: 'runtimeConfig',
      value: { permissionMode: 'no-restrictions' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('product fields');
    expect(readConfig()).toEqual(config);
  });

  it.each([
    ['providerId', 'provider-that-does-not-exist', 'Unknown providerId'],
    ['model', 'claude-typo-does-not-exist', 'is not registered'],
  ])('rejects invalid %s before either store or live state changes', async (key, value, errorText) => {
    const workspacePath = '/tmp/myagents-agent-set-invalid-provider-model';
    const config = {
      providerVerifyStatus: {
        'anthropic-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
      },
      agents: [{
        id: 'agent-invalid-route',
        name: 'Invalid Route Guard',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    };
    const projects = [{
      id: 'project-invalid-route',
      name: 'Invalid Route Guard',
      path: workspacePath,
      agentId: 'agent-invalid-route',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }];
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    writeJson(join(scratch, '.myagents', 'projects.json'), projects);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({ id: 'agent-invalid-route', key, value });

    expect(result.success).toBe(false);
    expect(result.error).toContain(errorText);
    expect(readConfig()).toEqual(config);
    expect(readJson(join(scratch, '.myagents', 'projects.json'))).toEqual(projects);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it.each([
    ['custom-added-model', ['claude-opus-4-6'], true],
    ['claude-opus-4-6', ['claude-opus-4-6'], false],
  ])('validates model %s against preset additions/removals shared with the product catalog', async (
    value,
    removedModels,
    addCustomModel,
  ) => {
    const workspacePath = `/tmp/myagents-agent-effective-model-${value}`;
    writeJson(join(scratch, '.myagents', 'config.json'), {
      providerVerifyStatus: {
        'anthropic-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
      },
      presetCustomModels: addCustomModel
        ? {
            'anthropic-sub': [{
              model: 'custom-added-model',
              modelName: 'Custom Added Model',
              modelSeries: 'claude',
              source: 'manual',
            }],
          }
        : undefined,
      presetRemovedModels: { 'anthropic-sub': removedModels },
      agents: [{
        id: 'agent-effective-model',
        name: 'Effective Model',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-effective-model',
      name: 'Effective Model',
      path: workspacePath,
      agentId: 'agent-effective-model',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({ id: 'agent-effective-model', key: 'model', value });

    expect(result.success).toBe(addCustomModel);
    if (addCustomModel) {
      expect((readConfig().agents as Record<string, unknown>[])[0]).toMatchObject({ model: value });
      expect(readJson(join(scratch, '.myagents', 'projects.json'))[0]).toMatchObject({ model: value });
    } else {
      expect(result.error).toContain('not registered');
    }
  });

  it('rolls back the Agent write when the Project mirror cannot be saved', async () => {
    const workspacePath = '/tmp/myagents-agent-set-project-failure';
    const config = {
      agents: [{
        id: 'agent-project-failure',
        name: 'Project Failure',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    };
    const projects = [{
      id: 'project-failure',
      name: 'Project Failure',
      path: workspacePath,
      agentId: 'agent-project-failure',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }];
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    writeJson(join(scratch, '.myagents', 'projects.json'), projects);
    const { handleAgentSet } = await import('./admin-api');
    adminConfigBehavior.failProjectWrite = true;

    const result = await handleAgentSet({
      id: 'agent-project-failure',
      key: 'permissionMode',
      value: 'plan',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Project mirror could not be saved');
    expect((readConfig().agents as Record<string, unknown>[])[0]).toEqual(config.agents[0]);
    expect(readJson(join(scratch, '.myagents', 'projects.json'))).toEqual(projects);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('serializes concurrent Agent intents so Agent and Project end on the same value', async () => {
    const workspacePath = '/tmp/myagents-agent-set-concurrent';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      providerVerifyStatus: {
        'anthropic-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
      },
      agents: [{
        id: 'agent-concurrent',
        name: 'Concurrent',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-concurrent',
      name: 'Concurrent',
      path: workspacePath,
      agentId: 'agent-concurrent',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const results = await Promise.all([
      handleAgentSet({ id: 'agent-concurrent', key: 'model', value: 'claude-opus-4-6' }),
      handleAgentSet({ id: 'agent-concurrent', key: 'model', value: 'claude-haiku-4-5' }),
    ]);

    expect(results.every(result => result.success)).toBe(true);
    const agentModel = ((readConfig().agents as Record<string, unknown>[])[0]).model;
    const projectModel = readJson(join(scratch, '.myagents', 'projects.json'))[0].model;
    expect(projectModel).toBe(agentModel);
    expect(['claude-opus-4-6', 'claude-haiku-4-5']).toContain(agentModel);
  });

  it('validates a delayed model intent against the provider committed before its lock turn', async () => {
    const workspacePath = '/tmp/myagents-agent-set-validation-lock';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      providerVerifyStatus: {
        'anthropic-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
        'xai-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
      },
      agents: [{
        id: 'agent-validation-lock',
        name: 'Validation Lock',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-validation-lock',
      name: 'Validation Lock',
      path: workspacePath,
      agentId: 'agent-validation-lock',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');
    let releaseIntent!: () => void;
    let markIntentBlocked!: () => void;
    adminConfigBehavior.intentGate = new Promise<void>(resolve => { releaseIntent = resolve; });
    const intentBlocked = new Promise<void>(resolve => { markIntentBlocked = resolve; });
    adminConfigBehavior.onIntentBlocked = markIntentBlocked;
    adminConfigBehavior.delayNextIntent = true;

    const delayedModel = handleAgentSet({
      id: 'agent-validation-lock',
      key: 'model',
      value: 'claude-haiku-4-5',
    });
    await intentBlocked;
    const providerResult = await handleAgentSet({
      id: 'agent-validation-lock',
      key: 'providerId',
      value: 'xai-sub',
    });
    releaseIntent();
    const modelResult = await delayedModel;

    expect(providerResult.success).toBe(true);
    expect(modelResult.success).toBe(false);
    expect(modelResult.error).toContain("not registered for provider 'xai-sub'");
    expect((readConfig().agents as Record<string, unknown>[])[0]).toMatchObject({
      providerId: 'xai-sub',
      model: 'claude-sonnet-4-6',
    });
    expect(readJson(join(scratch, '.myagents', 'projects.json'))[0]).toMatchObject({
      providerId: 'xai-sub',
      model: 'claude-sonnet-4-6',
    });
  });

  it.each([
    ['providerId', 'anthropic-sub'],
    ['model', 'claude-opus-4-6'],
  ])('mirrors %s to the Project compatibility store and reloads the live Agent', async (key, value) => {
    const workspacePath = '/tmp/myagents-agent-set-mirror';
    const initialProviderId = key === 'model' ? 'anthropic-sub' : 'codex-sub';
    const initialModel = key === 'model' ? 'claude-sonnet-4-6' : 'gpt-5.6-sol';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      providerVerifyStatus: {
        'anthropic-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
      },
      agents: [{
        id: 'agent-mirror',
        name: 'Mirror',
        workspacePath,
        providerId: initialProviderId,
        model: initialModel,
        permissionMode: 'fullAgency',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-mirror',
      name: 'Mirror',
      path: workspacePath,
      agentId: 'agent-mirror',
      providerId: initialProviderId,
      model: initialModel,
      permissionMode: 'fullAgency',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({ id: 'agent-mirror', key, value });

    expect(result.success).toBe(true);
    expect(readJson(join(scratch, '.myagents', 'projects.json'))[0]).toMatchObject({ [key]: value });
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/reload-config',
      'POST',
      {
        agentId: 'agent-mirror',
        patch: {
          [key]: value,
          ...(key === 'providerId' ? { providerEnvJson: null } : {}),
        },
      },
    );
  });

  it.each([
    ['providerId', 'codex-sub'],
    ['model', 'gpt-5.6-sol'],
  ])('accepts managed Codex %s changes through the product provider catalog', async (key, value) => {
    const workspacePath = `/tmp/myagents-agent-managed-${key}`;
    const settingProvider = key === 'providerId';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      managedCodexProviderDevGate: true,
      managedCodexRuntimeInstall: { status: 'installed', usable: true },
      managedCodexAuth: { status: 'valid', authMethod: 'chatgpt' },
      agents: [{
        id: 'agent-managed-set',
        name: 'Managed Set',
        workspacePath,
        providerId: settingProvider ? 'anthropic-sub' : 'codex-sub',
        model: settingProvider ? 'claude-sonnet-4-6' : 'gpt-5.4-codex',
        permissionMode: 'auto',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-managed-set',
      name: 'Managed Set',
      path: workspacePath,
      agentId: 'agent-managed-set',
      providerId: settingProvider ? 'anthropic-sub' : 'codex-sub',
      model: settingProvider ? 'claude-sonnet-4-6' : 'gpt-5.4-codex',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({ id: 'agent-managed-set', key, value });

    expect(result.success).toBe(true);
    expect((readConfig().agents as Record<string, unknown>[])[0]).toMatchObject({ [key]: value });
    expect(readJson(join(scratch, '.myagents', 'projects.json'))[0]).toMatchObject({ [key]: value });
  });

  it('rejects an unverified subscription provider before mutating either store', async () => {
    const workspacePath = '/tmp/myagents-agent-unverified-subscription';
    const config = {
      agents: [{
        id: 'agent-unverified-subscription',
        name: 'Unverified Subscription',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    };
    const projects = [{
      id: 'project-unverified-subscription',
      name: 'Unverified Subscription',
      path: workspacePath,
      agentId: 'agent-unverified-subscription',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }];
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    writeJson(join(scratch, '.myagents', 'projects.json'), projects);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({
      id: 'agent-unverified-subscription',
      key: 'providerId',
      value: 'xai-sub',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not verified');
    expect(readConfig()).toEqual(config);
    expect(readJson(join(scratch, '.myagents', 'projects.json'))).toEqual(projects);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('shows managed Codex as its effective runtime instead of the stored builtin carrier', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-managed-show',
        name: 'Managed Show',
        workspacePath: '/tmp/myagents-agent-managed-show',
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        runtime: 'builtin',
        permissionMode: 'fullAgency',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-managed-show',
      name: 'Managed Show',
      path: '/tmp/myagents-agent-managed-show',
      agentId: 'agent-managed-show',
    }]);
    const { handleAgentShow } = await import('./admin-api');

    const result = await handleAgentShow({ id: 'agent-managed-show' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      effectiveDefaults: {
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        permissionMode: 'no-restrictions',
      },
    });
  });
});

describe('admin-api model add', () => {
  it('expands custom provider models from repeated and comma-separated CLI inputs', async () => {
    const { handleModelAdd } = await import('./admin-api');

    const result = await handleModelAdd({
      dryRun: true,
      provider: {
        id: 'sensenova',
        name: 'SensNova',
        baseUrl: 'https://token.sensenova.cn/v1',
        apiProtocol: 'openai',
        authType: 'api_key',
        models: ['sensenova-6.7-flash-lite, deepseek-v4-flash', 'glm-5.2', 'deepseek-v4-flash'],
        modelNames: ['Flash Lite', 'DeepSeek Flash', 'GLM 5.2', 'Duplicate Name'],
        primaryModel: 'deepseek-v4-flash',
      },
    });

    expect(result.success).toBe(true);
    const preview = result.preview as { models: Array<{ model: string; modelName: string }>; primaryModel: string };
    expect(preview.primaryModel).toBe('deepseek-v4-flash');
    expect(preview.models).toEqual([
      { model: 'sensenova-6.7-flash-lite', modelName: 'Flash Lite', modelSeries: 'sensenova' },
      { model: 'deepseek-v4-flash', modelName: 'DeepSeek Flash', modelSeries: 'sensenova' },
      { model: 'glm-5.2', modelName: 'GLM 5.2', modelSeries: 'sensenova' },
    ]);
  });

  it('keeps GUI invalidation, CLI model detail, and IM provider projection aligned', async () => {
    const {
      handleModelAdd,
      handleModelList,
      handleModelSetKey,
      handleModelRemove,
    } = await import('./admin-api');

    const added = await handleModelAdd({
      provider: {
        id: 'snapshot-provider',
        name: 'Snapshot Provider',
        baseUrl: 'https://provider.example/v1',
        apiProtocol: 'openai',
        authType: 'api_key',
        models: ['model-primary', 'model-secondary'],
        modelNames: ['Primary', 'Secondary'],
        primaryModel: 'model-secondary',
      },
    });
    expect(added.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenLastCalledWith(
      '/api/app/config-changed',
      'POST',
      {},
      { timeoutMs: 2_000 },
    );

    const keyed = await handleModelSetKey({ id: 'snapshot-provider', apiKey: 'secret-key' });
    expect(keyed.success).toBe(true);
    const projection = JSON.parse(String(readConfig().availableProvidersJson)) as Array<Record<string, unknown>>;
    expect(projection).toContainEqual(expect.objectContaining({
      id: 'snapshot-provider',
      primaryModel: 'model-secondary',
      apiKey: 'secret-key',
      models: [
        { model: 'model-primary', modelName: 'Primary' },
        { model: 'model-secondary', modelName: 'Secondary' },
      ],
    }));

    const listed = handleModelList();
    expect(listed.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'snapshot-provider',
        primaryModel: 'model-secondary',
        models: [
          { model: 'model-primary', modelName: 'Primary' },
          { model: 'model-secondary', modelName: 'Secondary' },
        ],
      }),
    ]));

    const removed = await handleModelRemove({ id: 'snapshot-provider' });
    expect(removed.success).toBe(true);
    const projectionAfterRemove = readConfig().availableProvidersJson;
    const remaining = typeof projectionAfterRemove === 'string'
      ? JSON.parse(projectionAfterRemove) as Array<Record<string, unknown>>
      : [];
    expect(remaining.some(provider => provider.id === 'snapshot-provider')).toBe(false);
    expect(managementApiMocks.managementApi).toHaveBeenCalledTimes(3);
  });

  it('does not report mutation success when app-wide invalidation fails', async () => {
    const { handleModelSetDefault } = await import('./admin-api');
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: false, error: 'management offline' });

    await expect(handleModelSetDefault({ id: 'provider-a' })).rejects.toThrow(
      "Model configuration was saved, but app-wide refresh failed",
    );
    expect(readConfig().defaultProviderId).toBe('provider-a');
  });

  it('keeps the provider definition when remove config cleanup fails', async () => {
    const { handleModelAdd, handleModelRemove } = await import('./admin-api');
    const providerPath = join(scratch, '.myagents', 'providers', 'transaction-provider.json');
    const providerPayload = {
      id: 'transaction-provider',
      name: 'Transaction Provider',
      baseUrl: 'https://provider.example/v1',
      models: ['model-a'],
    };

    expect((await handleModelAdd({ provider: providerPayload })).success).toBe(true);
    expect(existsSync(providerPath)).toBe(true);

    adminConfigBehavior.failNextConfigWrite = true;
    await expect(handleModelRemove({ id: 'transaction-provider' })).rejects.toThrow(
      'injected config.json write failure',
    );
    expect(existsSync(providerPath)).toBe(true);
    expect(JSON.parse(readFileSync(providerPath, 'utf-8'))).toMatchObject({ id: 'transaction-provider' });
  });
});

describe('admin-api model verify credential authority', () => {
  it('verifies sdk-native subscriptions without requiring an API key', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {});
    const { handleModelVerify } = await import('./admin-api');

    const result = await handleModelVerify({ id: 'anthropic-sub', model: 'claude-sonnet-5' });

    expect(result).toMatchObject({ success: true, data: { id: 'anthropic-sub' } });
    expect(providerVerifyMocks.verifySubscription).toHaveBeenCalledWith('claude-sonnet-5');
    expect(providerVerifyMocks.verifyProviderViaSdk).not.toHaveBeenCalled();
    expect(readConfig()).toMatchObject({
      providerVerifyStatus: { 'anthropic-sub': { status: 'valid' } },
    });
  });

  it('rejects host-managed subscriptions at their credential owner before the API-key path', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {});
    const { handleModelVerify } = await import('./admin-api');

    const result = await handleModelVerify({ id: 'xai-sub' });

    expect(result).toMatchObject({
      success: false,
      code: 'SUBSCRIPTION_AUTH_OWNER_REQUIRED',
      error: expect.not.stringContaining('No API key'),
      recoveryHint: { message: expect.stringContaining('Settings') },
    });
    expect(providerVerifyMocks.verifyProviderViaSdk).not.toHaveBeenCalled();
  });

  it('redirects runtime-managed subscriptions to the managed-provider owner', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), { managedCodexProviderDevGate: true });
    const { handleModelVerify } = await import('./admin-api');

    const result = await handleModelVerify({ id: 'codex-sub' });

    expect(result).toMatchObject({
      success: false,
      code: 'SUBSCRIPTION_AUTH_OWNER_REQUIRED',
      recoveryHint: {
        message: expect.stringContaining('Settings → Model Providers → Codex'),
      },
    });
    expect((result.recoveryHint as { recoveryCommand?: string }).recoveryCommand).toBeUndefined();
    expect(providerVerifyMocks.verifyProviderViaSdk).not.toHaveBeenCalled();
    expect(providerVerifyMocks.verifySubscription).not.toHaveBeenCalled();
  });
});

describe('admin-api config dry-run contract', () => {
  it('previews config set without writing config.json', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), { uiLanguage: 'zh-CN' });
    const before = readFileSync(join(scratch, '.myagents', 'config.json'), 'utf-8');
    const { handleConfigSet } = await import('./admin-api');

    const result = await handleConfigSet({ key: 'uiLanguage', value: 'en-US', dryRun: true });

    expect(result).toMatchObject({ success: true, dryRun: true, preview: { key: 'uiLanguage', value: 'en-US' } });
    expect(readFileSync(join(scratch, '.myagents', 'config.json'), 'utf-8')).toBe(before);
  });

  it('rejects unknown keys in both dry-run and write, and removes an old stray key', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), { appearanceMode: 'system', notARealKey: 'x' });
    const { handleConfigSet, handleConfigUnset } = await import('./admin-api');
    for (const dryRun of [true, false]) {
      await expect(handleConfigSet({ key: 'appearanceMod', value: 'dark', dryRun })).resolves.toMatchObject({
        success: false, error: expect.stringContaining("Did you mean 'appearanceMode'?"),
      });
    }
    expect(readConfig().appearanceMode).toBe('system');
    await expect(handleConfigSet({ key: 'notARealKey', value: 'y' })).resolves.toMatchObject({ success: false });
    await expect(handleConfigUnset({ key: 'notARealKey', dryRun: true })).resolves.toMatchObject({ success: true, dryRun: true });
    expect(readConfig().notARealKey).toBe('x');
    await expect(handleConfigUnset({ key: 'notARealKey' })).resolves.toMatchObject({ success: true });
    expect(readConfig().notARealKey).toBeUndefined();
    await expect(handleConfigUnset({ key: 'providerApiKeys.deepseek' })).resolves.toMatchObject({ success: false });
  });
});

describe('admin-api MCP add contract', () => {
  it.each([
    ['playwright', 'myagents-browser'],
    ['myagents-browser', 'playwright'],
  ])('selects %s via CLI without leaving %s selected for the project', async (selected, previous) => {
    const workspace = join(scratch, 'browser-project');
    agentSessionMocks.agentDir = workspace;
    writeJson(join(scratch, '.myagents', 'projects.json'), [{ id: 'browser-project', path: workspace, mcpEnabledServers: [previous, 'ddg-search'] }]);
    writeJson(join(scratch, '.myagents', 'config.json'), { mcpEnabledServers: ['playwright', 'myagents-browser', 'ddg-search'] });
    const { handleMcpEnable } = await import('./admin-api');
    expect(await handleMcpEnable({ id: selected, scope: 'project' })).toMatchObject({ success: true });
    expect(readJson(join(scratch, '.myagents', 'projects.json'))[0].mcpEnabledServers).toEqual(['ddg-search', selected]);
    expect(readConfig().mcpEnabledServers).toEqual(['playwright', 'myagents-browser', 'ddg-search']);
  });

  it.each(['playwright', 'myagents-browser'])('rejects the reserved built-in Browser id %s', async id => {
    const { handleMcpAdd } = await import('./admin-api');

    const result = await handleMcpAdd({
      server: { id, type: 'stdio', command: 'shadow' },
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('reserved by a built-in Browser tool'),
    });
    expect(existsSync(join(scratch, '.myagents', 'config.json'))).toBe(false);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('creates a new server and fans out app-wide config invalidation', async () => {
    const { handleMcpAdd } = await import('./admin-api');

    const result = await handleMcpAdd({
      server: {
        id: 'new-server',
        name: 'New Server',
        type: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        env: { TOKEN: 'secret' },
      },
    });

    expect(result.success).toBe(true);
    expect(readConfig().mcpServers).toEqual([
      expect.objectContaining({
        id: 'new-server',
        command: 'node',
        args: ['server.mjs'],
        env: { TOKEN: 'secret' },
      }),
    ]);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/app/config-changed',
      'POST',
      {},
      { timeoutMs: 2_000 },
    );
  });

  it('rejects a duplicate custom id without replacing any stored fields', async () => {
    const original = {
      id: 'existing-server',
      name: 'Existing Server',
      description: 'keep me',
      type: 'stdio',
      command: 'node',
      args: ['old.mjs', '--verbose'],
      env: { TOKEN: 'original-secret', MODE: 'production' },
      isBuiltin: false,
    };
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [original],
      mcpEnabledServers: ['existing-server'],
    });
    const { handleMcpAdd } = await import('./admin-api');

    const result = await handleMcpAdd({
      server: {
        id: 'existing-server',
        type: 'stdio',
        command: 'different-command',
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('mcp add only creates new servers'),
      recoveryHint: { recoveryCommand: 'myagents mcp show existing-server' },
    });
    expect(readConfig()).toMatchObject({
      mcpServers: [original],
      mcpEnabledServers: ['existing-server'],
    });
    expect(sessionEngineMocks.updateMcpServers).not.toHaveBeenCalled();
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('does not report add success when app-wide invalidation fails', async () => {
    const { handleMcpAdd } = await import('./admin-api');
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: false,
      error: 'management offline',
    });

    await expect(handleMcpAdd({
      server: {
        id: 'saved-without-refresh',
        type: 'stdio',
        command: 'node',
      },
    })).rejects.toThrow('MCP configuration was saved, but app-wide refresh failed');
    expect(readConfig().mcpServers).toEqual([
      expect.objectContaining({ id: 'saved-without-refresh' }),
    ]);
  });
});

describe('admin-api MCP connectivity test', () => {
  it('explains global disablement without attempting a connection', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [{ id: 'ddg-search', type: 'stdio', command: 'uvx', isBuiltin: false }],
      mcpEnabledServers: [],
    });
    const { handleMcpTest } = await import('./admin-api');
    expect(await handleMcpTest({ id: 'ddg-search' })).toMatchObject({
      success: false,
      error: expect.stringContaining('disabled globally'),
      recoveryHint: { recoveryCommand: 'myagents mcp enable ddg-search --scope global' },
    });
  });

  it('diagnoses the managed Browser through its Session capability instead of spawning the sentinel', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpEnabledServers: ['myagents-browser'],
    });
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      url: 'http://127.0.0.1:31415/mcp/playwright',
      token: 'a'.repeat(32),
      hostGeneration: 7,
    });

    const { handleMcpTest } = await import('./admin-api');
    const result = await handleMcpTest({ id: 'myagents-browser' });

    expect(result).toMatchObject({
      success: true,
      data: {
        id: 'myagents-browser',
        type: 'application-host',
        state: 'ready',
        sessionScoped: true,
        hostGeneration: 7,
      },
    });
    expect(result.hint).toContain('internal projection marker');
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/browser/capability/acquire',
      'POST',
      { sidecarId: 'test-session-sidecar' },
      { parentSignal: undefined },
    );
  });

  it('rejects a configured stdio command that exists but exits before MCP initialize', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpEnabledServers: ['broken-stdio'],
      mcpServers: [{
        id: 'broken-stdio',
        name: 'Broken stdio fixture',
        type: 'stdio',
        command: process.execPath,
        args: ['-e', "process.stderr.write('fixture package version missing\\n'); process.exit(1)"],
        isBuiltin: false,
      }],
    });

    const { handleMcpTest } = await import('./admin-api');
    const result = await handleMcpTest({ id: 'broken-stdio' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('fixture package version missing');
  });

  it('handshakes with the merged stdio args and env used by persisted MCP config', async () => {
    agentSessionMocks.agentDir = process.cwd();
    const expectedManagedBin = process.platform === 'win32'
      ? join(scratch, '.myagents', 'npm-global')
      : join(scratch, '.myagents', 'npm-global', 'bin');
    const serverCode = [
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
      "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
      "import { delimiter } from 'node:path';",
      `const executablePath = process.env[${JSON.stringify(process.platform === 'win32' ? 'Path' : 'PATH')}] || '';`,
      `if (process.argv[1] !== 'legacy-extra' || process.env.MCP_TEST_TOKEN !== 'from-override' || process.cwd() !== ${JSON.stringify(process.cwd())} || !executablePath.split(delimiter).includes(${JSON.stringify(expectedManagedBin)})) {`,
      "  process.stderr.write('merged stdio config missing\\n');",
      '  process.exit(1);',
      '}',
      "const server = new Server({ name: 'issue-504-fixture', version: '1.0.0' }, { capabilities: {} });",
      'await server.connect(new StdioServerTransport());',
    ].join('\n');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpEnabledServers: ['merged-stdio'],
      mcpServers: [{
        id: 'merged-stdio',
        name: 'Merged stdio fixture',
        type: 'stdio',
        command: process.execPath,
        args: ['--input-type=module', '-e', serverCode],
        env: { MCP_TEST_TOKEN: 'stale-inline' },
        isBuiltin: false,
      }],
      mcpServerArgs: { 'merged-stdio': ['legacy-extra'] },
      mcpServerEnv: { 'merged-stdio': { MCP_TEST_TOKEN: 'from-override' } },
    });

    const { handleMcpTest } = await import('./admin-api');
    const result = await handleMcpTest({ id: 'merged-stdio' });

    expect(result.success).toBe(true);
    expect(result.hint).toContain('MCP configuration initialize succeeded');
    expect(result.data).toEqual(expect.objectContaining({
      id: 'merged-stdio',
      type: 'stdio',
      serverName: 'issue-504-fixture',
      serverVersion: '1.0.0',
    }));
  });

  it('redacts even short configured MCP environment values from stdio handshake diagnostics', async () => {
    const secret = 'z9';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpEnabledServers: ['redacted-stdio'],
      mcpServers: [{
        id: 'redacted-stdio',
        name: 'Redacted stdio fixture',
        type: 'stdio',
        command: process.execPath,
        args: ['-e', "process.stderr.write(process.env.MCP_TEST_SECRET || 'missing'); process.exit(1)"],
        env: { MCP_TEST_SECRET: secret },
        isBuiltin: false,
      }],
    });

    const { handleMcpTest } = await import('./admin-api');
    const result = await handleMcpTest({ id: 'redacted-stdio' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Server stderr:\n****');
    expect(result.error).not.toContain(secret);
  });

  it.each(['http', 'sse'] as const)(
    'rejects a 200 response that does not complete an MCP initialize handshake for %s',
    async (type) => {
      writeJson(join(scratch, '.myagents', 'config.json'), {
        mcpEnabledServers: [`invalid-${type}`],
        mcpServers: [{
          id: `invalid-${type}`,
          name: `Invalid ${type} fixture`,
          type,
          url: `https://mcp.invalid/${type}`,
          isBuiltin: false,
        }],
      });
      const cancellation = await import('./utils/cancellation');
      cancellation._setGeneralFetchTransportForTests(async () => new Response('not an MCP response', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

      try {
        const { handleMcpTest } = await import('./admin-api');
        const result = await handleMcpTest({ id: `invalid-${type}` });
        expect(result.success).toBe(false);
        expect(result.error).toContain('MCP initialize failed');
      } finally {
        cancellation._setGeneralFetchTransportForTests();
      }
    },
  );

  it('handshakes with resolved HTTP URL placeholders and configured headers', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpEnabledServers: ['resolved-http'],
      mcpServers: [{
        id: 'resolved-http',
        name: 'Resolved HTTP fixture',
        type: 'http',
        url: 'https://mcp.invalid/{{MCP_PATH}}',
        env: { MCP_PATH: 'stale-path', MCP_TOKEN: 'stale-token' },
        headers: { Authorization: 'Bearer {{MCP_TOKEN}}' },
        isBuiltin: false,
      }],
      mcpServerEnv: {
        'resolved-http': { MCP_PATH: 'resolved-path', MCP_TOKEN: 'resolved-token' },
      },
    });
    const cancellation = await import('./utils/cancellation');
    let observedUrl = '';
    let observedHeader = '';
    cancellation._setGeneralFetchTransportForTests(async (url, init) => {
      observedUrl = String(url);
      observedHeader = new Headers(init?.headers as HeadersInit | undefined).get('Authorization') ?? '';
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { id?: string | number; method?: string; params?: { protocolVersion?: string } }
        : {};
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: body.params?.protocolVersion,
            capabilities: {},
            serverInfo: { name: 'issue-504-http-fixture', version: '2.0.0' },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 202 });
    });

    try {
      const { handleMcpTest } = await import('./admin-api');
      const result = await handleMcpTest({ id: 'resolved-http' });
      expect(result.success).toBe(true);
      expect(result.hint).toContain('MCP configuration initialize succeeded');
      expect(result.data).toEqual(expect.objectContaining({
        serverName: 'issue-504-http-fixture',
        serverVersion: '2.0.0',
      }));
      expect(observedUrl).toBe('https://mcp.invalid/resolved-path');
      expect(observedHeader).toBe('Bearer resolved-token');
    } finally {
      cancellation._setGeneralFetchTransportForTests();
    }
  });

  it('completes the endpoint and initialize exchange for an SSE server', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpEnabledServers: ['valid-sse'],
      mcpServers: [{
        id: 'valid-sse',
        name: 'Valid SSE fixture',
        type: 'sse',
        url: 'https://mcp.invalid/events',
        isBuiltin: false,
      }],
    });
    const cancellation = await import('./utils/cancellation');
    const encoder = new TextEncoder();
    let events: ReadableStreamDefaultController<Uint8Array> | undefined;
    cancellation._setGeneralFetchTransportForTests(async (_url, init) => {
      if (init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as {
          id?: string | number;
          method?: string;
          params?: { protocolVersion?: string };
        };
        if (request.method === 'initialize') {
          queueMicrotask(() => events?.enqueue(encoder.encode([
            'data: ' + JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                protocolVersion: request.params?.protocolVersion,
                capabilities: {},
                serverInfo: { name: 'issue-504-sse-fixture', version: '3.0.0' },
              },
            }),
            '',
            '',
          ].join('\n'))));
        }
        return new Response(null, { status: 202 });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          events = controller;
          controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'));
          init?.signal?.addEventListener('abort', () => {
            try {
              controller.close();
            } catch {
              // The client may already have closed the stream.
            }
          }, { once: true });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    try {
      const { handleMcpTest } = await import('./admin-api');
      const result = await handleMcpTest({ id: 'valid-sse' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual(expect.objectContaining({
        type: 'sse',
        serverName: 'issue-504-sse-fixture',
        serverVersion: '3.0.0',
      }));
    } finally {
      cancellation._setGeneralFetchTransportForTests();
    }
  });

  it('matches Session OAuth precedence when a canonical configured header is empty', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpEnabledServers: ['oauth-http'],
      mcpServers: [{
        id: 'oauth-http',
        name: 'OAuth HTTP fixture',
        type: 'http',
        url: 'https://mcp.invalid/oauth',
        headers: { Authorization: '' },
        isBuiltin: false,
      }],
    });
    const resolveAuthHeaders = vi.fn(async () => ({ Authorization: 'Bearer persisted-token' }));
    vi.doMock('./mcp-oauth', () => ({ resolveAuthHeaders }));
    const cancellation = await import('./utils/cancellation');
    let observedAuthorization = '';
    cancellation._setGeneralFetchTransportForTests(async (_url, init) => {
      observedAuthorization = new Headers(init?.headers as HeadersInit | undefined).get('Authorization') ?? '';
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      const request = JSON.parse(String(init?.body)) as {
        id?: string | number;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (request.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion,
            capabilities: {},
            serverInfo: { name: 'oauth-http-fixture', version: '1.0.0' },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 202 });
    });

    try {
      const { handleMcpTest } = await import('./admin-api');
      const result = await handleMcpTest({ id: 'oauth-http' });
      expect(result.success).toBe(true);
      expect(resolveAuthHeaders).toHaveBeenCalledWith('oauth-http');
      expect(observedAuthorization).toBe('Bearer persisted-token');
    } finally {
      cancellation._setGeneralFetchTransportForTests();
      vi.doUnmock('./mcp-oauth');
    }
  });

  it('bounds stored OAuth resolution within the overall 15 second test deadline', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpEnabledServers: ['stalled-oauth-http'],
      mcpServers: [{
        id: 'stalled-oauth-http',
        name: 'Stalled OAuth fixture',
        type: 'http',
        url: 'https://mcp.invalid/stalled-oauth',
        isBuiltin: false,
      }],
    });
    let markAuthStarted: (() => void) | undefined;
    const authStarted = new Promise<void>(resolve => {
      markAuthStarted = resolve;
    });
    vi.doMock('./mcp-oauth', () => ({
      resolveAuthHeaders: vi.fn(() => {
        markAuthStarted?.();
        return new Promise<Record<string, string>>(() => {});
      }),
    }));
    vi.useFakeTimers();

    try {
      const { handleMcpTest } = await import('./admin-api');
      const resultPromise = handleMcpTest({ id: 'stalled-oauth-http' });
      await authStarted;
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(resultPromise).resolves.toMatchObject({
        success: false,
        error: 'MCP initialize failed: Connection timed out (15s)',
      });
    } finally {
      vi.useRealTimers();
      vi.doUnmock('./mcp-oauth');
    }
  });

  it('rejects an unknown persisted transport type instead of falling through to valid', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpEnabledServers: ['unknown-transport'],
      mcpServers: [{
        id: 'unknown-transport',
        name: 'Unknown transport fixture',
        type: 'websocket',
        url: 'ws://mcp.invalid',
        isBuiltin: false,
      }],
    });

    const { handleMcpTest } = await import('./admin-api');
    const result = await handleMcpTest({ id: 'unknown-transport' });

    expect(result.success).toBe(false);
    expect(result.error).toContain("unsupported transport type 'websocket'");
  });
});

describe('admin-api MCP project scope', () => {
  it('fails project-only enable when the current workspace is not registered', async () => {
    const { handleMcpEnable } = await import('./admin-api');
    agentSessionMocks.agentDir = 'c:/users/me/project/';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [{
        id: 'win-custom',
        name: 'Windows Custom',
        type: 'stdio',
        command: 'node',
      }],
      mcpEnabledServers: [],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), []);

    const result = await handleMcpEnable({ id: 'win-custom', scope: 'project' });

    expect(result.success).toBe(false);
    expect(readConfig().mcpEnabledServers).toEqual([]);
    expect(sessionEngineMocks.updateMcpServers).not.toHaveBeenCalled();
  });

  it('keeps global enable effective when project scope is skipped for an unregistered workspace', async () => {
    const { handleMcpEnable } = await import('./admin-api');
    agentSessionMocks.agentDir = 'c:/users/me/project/';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [{
        id: 'win-custom',
        name: 'Windows Custom',
        type: 'stdio',
        command: 'node',
      }],
      mcpEnabledServers: [],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), []);

    const result = await handleMcpEnable({ id: 'win-custom', scope: 'both' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ id: 'win-custom', projectScope: 'project-not-found' });
    expect(readConfig().mcpEnabledServers).toEqual(['win-custom']);
    expect(sessionEngineMocks.updateMcpServers).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'win-custom' }),
    ]);
  });
});

describe('admin-api MCP remove/disable legacy HTTP servers', () => {
  const remoteHttp = {
    id: 'yuandian-law',
    name: 'YuanDian Law',
    type: 'http',
    url: 'https://mcp.example.com/yuandian-law',
    headers: { Authorization: 'Bearer token' },
    isBuiltin: false,
  };

  it('removes HTTP MCP definitions from global config and Agent legacy payloads', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [remoteHttp],
      mcpEnabledServers: ['yuandian-law'],
      mcpServerEnv: { 'yuandian-law': { TOKEN: 'secret' } },
      mcpServerArgs: { 'yuandian-law': ['--stale'] },
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
    });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const agent = (config.agents as Array<Record<string, unknown>>)[0];

    expect(result.success).toBe(true);
    expect(config.mcpServers).toEqual([]);
    expect(config.mcpEnabledServers).toEqual([]);
    expect(config.mcpServerEnv).toEqual({});
    expect(config.mcpServerArgs).toEqual({});
    expect(agent.mcpEnabledServers).toEqual([]);
    expect(agent.mcpServersJson).toBeUndefined();
  });

  it('removes Agent-only legacy HTTP MCP servers after Admin API load-boundary promotion', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [],
      mcpEnabledServers: [],
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
    });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const agent = (config.agents as Array<Record<string, unknown>>)[0];

    expect(result.success).toBe(true);
    expect(config.mcpServers).toEqual([]);
    expect(config.mcpEnabledServers).toEqual([]);
    expect(agent.mcpEnabledServers).toEqual([]);
    expect(agent.mcpServersJson).toBeUndefined();
  });

  it('cascades custom MCP remove across config, projects, sessions, legacy Bot payloads, and Rust stores', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [remoteHttp],
      mcpEnabledServers: ['yuandian-law', 'keep'],
      mcpServerEnv: { 'yuandian-law': { TOKEN: 'secret' } },
      mcpServerArgs: { 'yuandian-law': ['--stale'] },
      launcherLastUsed: { mcpEnabledServers: ['yuandian-law', 'keep'] },
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
      imBotConfigs: [{
        id: 'bot-1',
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Project',
      path: '/tmp/workspace',
      mcpEnabledServers: ['yuandian-law'],
    }]);
    writeJson(join(scratch, '.myagents', 'sessions.json'), [{
      id: 'session-1',
      agentDir: '/tmp/workspace',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mcpEnabledServers: ['yuandian-law'],
    }]);
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, taskUpdated: 1, cronUpdated: 2 });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const project = readJson(join(scratch, '.myagents', 'projects.json'))[0];
    const session = readJson(join(scratch, '.myagents', 'sessions.json'))[0];
    const agent = (config.agents as Array<Record<string, unknown>>)[0];
    const bot = (config.imBotConfigs as Array<Record<string, unknown>>)[0];

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ taskUpdated: 1, cronUpdated: 2, projectUpdated: 1, sessionUpdated: 1 });
    expect(config.mcpServers).toEqual([]);
    expect(config.mcpEnabledServers).toEqual(['keep']);
    expect(config.mcpServerEnv).toEqual({});
    expect(config.mcpServerArgs).toEqual({});
    expect((config.launcherLastUsed as Record<string, unknown>).mcpEnabledServers).toEqual(['keep']);
    expect(agent.mcpEnabledServers).toEqual([]);
    expect(agent.mcpServersJson).toBeUndefined();
    expect(bot.mcpEnabledServers).toEqual([]);
    expect(bot.mcpServersJson).toBeUndefined();
    expect(project.mcpEnabledServers).toEqual([]);
    expect(session.mcpEnabledServers).toEqual([]);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/mcp/remove-references', 'POST', { serverId: 'yuandian-law' });
  });

  it('keeps AppConfig definition when Rust Task/Cron cleanup fails', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [remoteHttp],
      mcpEnabledServers: ['yuandian-law'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Project',
      path: '/tmp/workspace',
      mcpEnabledServers: ['yuandian-law'],
    }]);
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: false,
      error: 'Task store unavailable',
      recoveryHint: { recoveryCommand: 'myagents status', message: 'retry later' },
    });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const project = readJson(join(scratch, '.myagents', 'projects.json'))[0];

    expect(result.success).toBe(false);
    expect(result.recoveryHint).toEqual({ recoveryCommand: 'myagents status', message: 'retry later' });
    expect((config.mcpServers as Array<Record<string, unknown>>).map(s => s.id)).toEqual(['yuandian-law']);
    expect(config.mcpEnabledServers).toEqual(['yuandian-law']);
    expect(project.mcpEnabledServers).toEqual(['yuandian-law']);
  });

  it('keeps AppConfig definition when session snapshot cleanup cannot be written', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [remoteHttp],
      mcpEnabledServers: ['yuandian-law'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Project',
      path: '/tmp/workspace',
      mcpEnabledServers: ['yuandian-law'],
    }]);
    writeJson(join(scratch, '.myagents', 'sessions.json'), [{
      id: 'session-1',
      agentDir: '/tmp/workspace',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mcpEnabledServers: ['yuandian-law'],
    }]);
    mkdirSync(join(scratch, '.myagents', 'sessions.json.tmp'));

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const project = readJson(join(scratch, '.myagents', 'projects.json'))[0];

    expect(result.success).toBe(false);
    expect((config.mcpServers as Array<Record<string, unknown>>).map(s => s.id)).toEqual(['yuandian-law']);
    expect(config.mcpEnabledServers).toEqual(['yuandian-law']);
    expect(project.mcpEnabledServers).toEqual(['yuandian-law']);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('does not delete a new same-id definition added during cleanup-only remove', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [],
      mcpEnabledServers: ['yuandian-law'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Project',
      path: '/tmp/workspace',
      mcpEnabledServers: ['yuandian-law'],
    }]);
    writeJson(join(scratch, '.myagents', 'sessions.json'), []);
    managementApiMocks.managementApi.mockImplementationOnce(async () => {
      writeJson(join(scratch, '.myagents', 'config.json'), {
        mcpServers: [remoteHttp],
        mcpEnabledServers: ['yuandian-law'],
      });
      return { ok: true, taskUpdated: 0, cronUpdated: 0 };
    });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const project = readJson(join(scratch, '.myagents', 'projects.json'))[0];

    expect(result.success).toBe(false);
    expect(result.error).toContain('re-added during cleanup-only remove');
    expect((config.mcpServers as Array<Record<string, unknown>>).map(s => s.id)).toEqual(['yuandian-law']);
    expect(config.mcpEnabledServers).toEqual(['yuandian-law']);
    expect(project.mcpEnabledServers).toEqual(['yuandian-law']);
  });

  it('disables Agent-only legacy HTTP MCP servers without letting promotion re-enable them', async () => {
    const { handleMcpDisable } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [],
      mcpEnabledServers: [],
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
    });

    const result = await handleMcpDisable({ id: 'yuandian-law', scope: 'both' });
    const config = readConfig();

    expect(result.success).toBe(true);
    expect((config.mcpServers as Array<Record<string, unknown>>).map(s => s.id)).toEqual(['yuandian-law']);
    expect(config.mcpEnabledServers).toEqual([]);
  });
});

describe('admin-api Agent runtime lifecycle convergence', () => {
  it('removes the durable channel before stopping that exact Rust runtime', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-channel-remove',
        name: 'Channel Remove',
        enabled: true,
        channels: [
          { id: 'channel-remove', type: 'openclaw:weixin', enabled: true },
          { id: 'channel-keep', type: 'telegram', enabled: true },
        ],
      }],
    });
    let persistedChannelsAtStop: unknown;
    managementApiMocks.managementApi.mockImplementation(async () => {
      const agent = (readConfig().agents as Record<string, unknown>[])[0];
      persistedChannelsAtStop = agent.channels;
      return { ok: true, stopped: true };
    });
    const { handleAgentChannelRemove } = await import('./admin-api');

    const result = await handleAgentChannelRemove({
      agentId: 'agent-channel-remove',
      channelId: 'channel-remove',
    });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/stop-channel',
      'POST',
      { agentId: 'agent-channel-remove', channelId: 'channel-remove' },
      expect.any(Object),
    );
    expect(persistedChannelsAtStop).toEqual([
      { id: 'channel-keep', type: 'telegram', enabled: true },
    ]);
  });

  it('retries exact runtime cleanup after the durable channel is already absent', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-channel-retry',
        name: 'Channel Retry',
        enabled: true,
        channels: [],
      }],
    });
    const { handleAgentChannelRemove } = await import('./admin-api');

    const result = await handleAgentChannelRemove({
      agentId: 'agent-channel-retry',
      channelId: 'historically-deleted-channel',
    });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/stop-channel',
      'POST',
      {
        agentId: 'agent-channel-retry',
        channelId: 'historically-deleted-channel',
      },
      expect.any(Object),
    );
  });

  it('reports a truthful partial failure when config deletion lands but runtime stop fails', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-channel-stop-fails',
        name: 'Channel Stop Fails',
        enabled: true,
        channels: [{ id: 'channel-stop-fails', type: 'openclaw:weixin', enabled: true }],
      }],
    });
    managementApiMocks.managementApi.mockResolvedValue({
      ok: false,
      error: 'injected Rust lifecycle failure',
    });
    const { handleAgentChannelRemove } = await import('./admin-api');

    const result = await handleAgentChannelRemove({
      agentId: 'agent-channel-stop-fails',
      channelId: 'channel-stop-fails',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('was removed');
    expect(result.error).toContain('injected Rust lifecycle failure');
    const agent = (readConfig().agents as Record<string, unknown>[])[0];
    expect(agent.channels).toEqual([]);
  });

  it.each([
    ['agent disable', async (api: typeof import('./admin-api')) => api.handleAgentDisable({ id: 'agent-disable' })],
    ['agent set enabled=false', async (api: typeof import('./admin-api')) => api.handleAgentSet({
      id: 'agent-disable',
      key: 'enabled',
      value: false,
    })],
  ])('%s resets proactive children without stopping Channel runtimes', async (_label, run) => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-disable',
        name: 'Disable',
        enabled: true,
        channels: [{ id: 'channel-1', type: 'openclaw:weixin', enabled: true }],
      }],
    });
    managementApiMocks.managementApi.mockResolvedValue({ ok: true });
    const api = await import('./admin-api');

    const result = await run(api);

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/reload-config',
      'POST',
      expect.objectContaining({
        agentId: 'agent-disable',
        patch: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(managementApiMocks.managementApi).not.toHaveBeenCalledWith(
      '/api/agent/stop-channels',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    const agent = (readConfig().agents as Record<string, unknown>[])[0];
    expect(agent).toMatchObject({
      enabled: false,
      heartbeat: { enabled: false },
      memoryAutoUpdate: { enabled: false },
      memoryEvolution: { enabled: false },
      channels: [{ id: 'channel-1', enabled: true }],
    });
  });

  it('returns failure when proactive config saves but runtime or managed tasks do not converge', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-reconcile-fails',
        name: 'Reconcile Fails',
        enabled: true,
        channels: [],
      }],
    });
    managementApiMocks.managementApi.mockResolvedValue({
      ok: false,
      error: 'managed task reconcile failed',
    });
    const { handleAgentDisable } = await import('./admin-api');

    const result = await handleAgentDisable({ id: 'agent-reconcile-fails' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('managed task reconcile failed');
    expect(result.data).toMatchObject({ configSaved: true });
    expect((readConfig().agents as Record<string, unknown>[])[0]).toMatchObject({
      enabled: false,
      heartbeat: { enabled: false },
      memoryAutoUpdate: { enabled: false },
      memoryEvolution: { enabled: false },
    });
  });

  it('agent enable resets all proactive children while preserving their settings', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-enable',
        name: 'Enable',
        enabled: false,
        heartbeat: { enabled: false, intervalMinutes: 48 },
        memoryEvolution: { enabled: false, lastGardenerStatus: 'completed' },
        channels: [{ id: 'channel-off', type: 'telegram', enabled: false }],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-enable',
      name: 'Enable',
      path: '/tmp/enable',
      agentId: 'agent-enable',
    }]);
    const { handleAgentEnable } = await import('./admin-api');

    const result = await handleAgentEnable({ id: 'agent-enable' });

    expect(result.success).toBe(true);
    expect((readConfig().agents as Record<string, unknown>[])[0]).toMatchObject({
      enabled: true,
      heartbeat: { enabled: true, intervalMinutes: 48 },
      memoryAutoUpdate: { enabled: true, intervalHours: 24 },
      memoryEvolution: { enabled: true, lastGardenerStatus: 'completed' },
      channels: [{ id: 'channel-off', enabled: false }],
    });
  });

  it('still converges runtime state when archiving an already-disabled Agent', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-archive-disabled',
        name: 'Archive Disabled',
        enabled: false,
        workspacePath: '/tmp/archive-disabled',
        channels: [{ id: 'channel-1', type: 'openclaw:weixin', enabled: true }],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-archive-disabled',
      name: 'Archive Disabled',
      path: '/tmp/archive-disabled',
      agentId: 'agent-archive-disabled',
    }]);
    managementApiMocks.managementApi.mockResolvedValue({ ok: true, stoppedChannels: 1 });
    const { handleAgentArchive } = await import('./admin-api');

    const result = await handleAgentArchive({ id: 'agent-archive-disabled' });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/stop-channels',
      'POST',
      { agentId: 'agent-archive-disabled' },
      expect.any(Object),
    );
  });
});

describe('admin-api Agent / Session discovery', () => {
  it('projects only valid visible Workspace identities into the network catalog without leaking execution credentials', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), { agents: [
      { id: 'active', name: 'Active', enabled: false, channels: [{ id: 'secret-channel', botToken: 'do-not-expose' }] },
      { id: 'archived', name: 'Archived', enabled: true, channels: [] },
      { id: 'orphan', name: 'Orphan', enabled: true, workspacePath: '/orphan', channels: [] },
      { id: 'conflicted', name: 'Conflicted', channels: [] },
    ] });
    writeJson(join(scratch, '.myagents', 'projects.json'), [
      { id: 'active-workspace', name: 'Active', path: '/active', agentId: 'active', icon: 'lightning' },
      { id: 'archived-workspace', name: 'Archived', path: '/archived', agentId: 'archived', archivedAt: '2026-10-01T00:00:00Z' },
      { id: 'hidden-workspace', name: 'Hidden', path: '/hidden', hidden: true },
      { id: 'conflict-one', name: 'Conflict One', path: '/one', agentId: 'conflicted' },
      { id: 'conflict-two', name: 'Conflict Two', path: '/two', agentId: 'conflicted' },
    ]);
    const { handleAgentNetworkCatalog } = await import('./admin-api');
    const result = await handleAgentNetworkCatalog();
    expect(result).toMatchObject({ success: true, data: {
      items: [
        { localAgentId: 'active', localWorkspaceId: 'active-workspace', name: 'Active', path: '/active', lifecycle: 'active', exposureRevision: 0, icon: 'lightning' },
        { localAgentId: 'archived', localWorkspaceId: 'archived-workspace', name: 'Archived', path: '/archived', lifecycle: 'archived', exposureRevision: 0, icon: null },
      ], diagnostics: [{ code: 'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS', projectIds: ['conflict-one', 'conflict-two'], agentIds: ['conflicted'] }],
    } });
    expect(JSON.stringify(result)).not.toContain('do-not-expose');
    expect(JSON.stringify(result)).not.toContain('enabled');
  });
  it('lists healthy Agents and exposes conflicted targets with paths but no credentials', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), { agents: [
      { id: 'shared', name: 'Shared', channels: [{ id: 'secret-channel', botToken: 'do-not-expose' }] },
      { id: 'healthy', name: 'Healthy', channels: [] },
    ] });
    writeJson(join(scratch, '.myagents', 'projects.json'), [
      { id: 'one', name: 'One', path: '/one', agentId: 'shared' },
      { id: 'two', name: 'Two', path: '/two', agentId: 'shared', hidden: true },
      { id: 'three', name: 'Three', path: '/three', agentId: 'healthy' },
    ]);
    const { handleAgentList } = await import('./admin-api');
    const listed = await handleAgentList();
    expect(listed.success).toBe(true);
    expect(listed.data).toEqual([expect.objectContaining({ agentId: 'healthy' })]);
    expect(listed.diagnostics).toEqual([expect.objectContaining({ code: 'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS',
      projects: [{ id: 'one', name: 'One', path: '/one' }, { id: 'two', name: 'Two', path: '/two' }],
    })]);
    expect(JSON.stringify(listed)).not.toContain('do-not-expose');
  });

  it('returns visible Project-backed and legacy orphan Agents while marking only the selected Project Agent current', async () => {
    agentSessionMocks.agentDir = '/tmp/current-workspace';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [
        { id: 'agent-current', name: 'Current', enabled: false, workspacePath: '/tmp/current-workspace', channels: [] },
        { id: 'agent-other', name: 'Other', enabled: true, workspacePath: '/tmp/other-workspace', channels: [] },
        { id: 'agent-orphan', name: 'Orphan', enabled: true, workspacePath: '/tmp/orphan', channels: [] },
      ],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [
      { id: 'project-current', name: 'Current', path: '/tmp/current-workspace', agentId: 'agent-current' },
      { id: 'project-other', name: 'Other', path: '/tmp/other-workspace', agentId: 'agent-other' },
      { id: 'project-hidden', name: 'Hidden', path: '/tmp/hidden', hidden: true },
    ]);
    const { handleAgentList, handleAgentShow } = await import('./admin-api');

    const listed = await handleAgentList();
    expect(listed.success).toBe(true);
    expect(listed.data).toEqual([
      expect.objectContaining({ agentId: 'agent-current', enabled: false, isCurrent: true }),
      expect.objectContaining({ agentId: 'agent-other', enabled: true, isCurrent: false }),
      expect.objectContaining({
        agentId: 'agent-orphan',
        projectId: null,
        association: 'legacy-orphan',
        isCurrent: false,
      }),
    ]);
    expect((listed.data as Array<Record<string, unknown>>).filter(item => item.isCurrent)).toHaveLength(1);

    const shown = await handleAgentShow({ agentId: 'agent-current' });
    expect(shown.data).toMatchObject({
      agentId: 'agent-current',
      projectId: 'project-current',
      isCurrent: true,
      effectiveDefaults: {
        runtime: 'builtin',
        mcpEnabledServers: [],
        enabledPluginIds: [],
        enabledOfficialToolIds: [],
      },
    });
    expect(shown.data).not.toHaveProperty('id');
  });

  it('counts exactly the visible active Agent list, including disabled and legacy orphan Agents', async () => {
    const agents = ['active', 'disabled', 'archived', 'internal', 'orphan'].map(id => ({
      id, name: id, enabled: id !== 'disabled', workspacePath: `/tmp/${id}`, channels: [],
    }));
    writeJson(join(scratch, '.myagents', 'config.json'), { agents });
    writeJson(join(scratch, '.myagents', 'projects.json'), agents.filter(agent => agent.id !== 'orphan').map(agent => ({
      id: `project-${agent.id}`, name: agent.name, path: agent.workspacePath, agentId: agent.id,
      ...(agent.id === 'archived' ? { archivedAt: '2026-09-01T00:00:00.000Z' } : {}),
      ...(agent.id === 'internal' ? { internal: true } : {}),
    })));
    const { handleAgentList, handleStatus } = await import('./admin-api');
    const list = await handleAgentList();
    expect((list.data as Array<{ agentId: string }>).map(agent => agent.agentId)).toEqual(['active', 'disabled', 'orphan']);
    expect(await handleStatus()).toMatchObject({ success: true, data: { agents: 3 } });
  });

  it('lists persisted history only, newest first, without exposing prepared Sessions', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{ id: 'agent-1', name: 'Workspace', enabled: true, workspacePath: '/tmp/workspace', channels: [] }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1', name: 'Workspace', path: '/tmp/workspace', agentId: 'agent-1',
    }]);
    writeJson(join(scratch, '.myagents', 'sessions.json'), [
      {
        id: 'session-old', agentDir: '/tmp/workspace', title: 'Old',
        createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-01T00:00:00.000Z',
        lastMessagePreview: 'existing preview', runtime: 'builtin',
      },
      {
        id: 'session-new', agentDir: '/tmp/workspace', title: 'New',
        createdAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
        runtime: 'codex', runtimeSource: 'system-cli', model: 'gpt-5',
      },
      {
        id: 'session-prepared', agentDir: '/tmp/workspace', title: 'Prepared',
        createdAt: '2026-08-02T00:00:00.000Z', lastActiveAt: '2026-08-02T00:00:00.000Z',
        materializationState: 'prepared',
      },
    ]);
    const { handleSessionList } = await import('./admin-api');

    const result = await handleSessionList({ agentId: 'agent-1', limit: 2 });

    expect(result).toMatchObject({
      success: true,
      agentId: 'agent-1',
      projectId: 'project-1',
      limit: 2,
    });
    expect(result.data).toEqual([
      expect.objectContaining({
        sessionId: 'session-new',
        lastMessagePreview: null,
        runtime: 'codex',
        runtimeSource: 'system-cli',
      }),
      expect.objectContaining({
        sessionId: 'session-old',
        lastMessagePreview: 'existing preview',
      }),
    ]);
  });

  it('reports DSH Agent defaults and Session history as Integrated Product identity', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-dsh',
        name: 'DSH Workspace',
        enabled: true,
        workspacePath: '/tmp/dsh-workspace',
        runtime: 'dsh',
        runtimePreference: { family: 'integrated', id: 'dsh' },
        providerId: 'deepseek',
        model: 'deepseek-v4-flash',
        permissionMode: 'fullAgency',
        channels: [],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-dsh',
      name: 'DSH Workspace',
      path: '/tmp/dsh-workspace',
      agentId: 'agent-dsh',
    }]);
    writeJson(join(scratch, '.myagents', 'sessions.json'), [{
      id: 'session-dsh',
      agentDir: '/tmp/dsh-workspace',
      title: 'DSH Session',
      createdAt: '2026-08-01T00:00:00.000Z',
      lastActiveAt: '2026-08-01T00:00:00.000Z',
      runtime: 'dsh',
      model: 'deepseek-v4-flash',
    }]);
    const { handleAgentShow, handleSessionList } = await import('./admin-api');

    expect(await handleAgentShow({ id: 'agent-dsh' })).toMatchObject({
      success: true,
      data: {
        effectiveDefaults: {
          scope: 'agent-default-for-future-sessions',
          permissionModeSource: 'agent-config',
          runtime: 'dsh',
          runtimeSource: 'integrated',
          providerId: 'deepseek',
          model: 'deepseek-v4-flash',
          permissionMode: 'fullAgency',
        },
      },
    });
    expect(await handleSessionList({ agentId: 'agent-dsh' })).toMatchObject({
      success: true,
      data: [{
        sessionId: 'session-dsh',
        runtime: 'dsh',
        runtimeSource: 'integrated',
      }],
    });
  });
});

describe('admin-api Agent workspace archive', () => {
  it('archives a linked agent workspace and pauses proactive agent state', async () => {
    const { handleAgentArchive, handleAgentList } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Workspace',
        enabled: true,
        workspacePath: '/tmp/workspace',
        channels: [{ id: 'channel-1', type: 'telegram', enabled: true }],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Workspace',
      path: '/tmp/workspace',
      agentId: 'agent-1',
      pinnedAt: '2026-07-01T00:00:00.000Z',
    }]);
    managementApiMocks.managementApi.mockResolvedValue({ ok: true, stoppedChannels: 1 });

    const result = await handleAgentArchive({ id: 'agent-1' });

    expect(result.success).toBe(true);
    const config = readConfig();
    expect((config.agents as Array<Record<string, unknown>>)[0].enabled).toBe(false);
    const projects = readJson(join(scratch, '.myagents', 'projects.json'));
    expect(projects[0].archivedAt).toEqual(expect.any(String));
    expect(projects[0].archivedAgentEnabledBeforeArchive).toBe(true);
    expect(projects[0]).not.toHaveProperty('pinnedAt');
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/reload-config',
      'POST',
      { agentId: 'agent-1', patch: { enabled: false } },
      expect.any(Object),
    );
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/stop-channels',
      'POST',
      { agentId: 'agent-1' },
      expect.any(Object),
    );

    const archivedList = await handleAgentList({ lifecycle: 'archived' });
    expect((archivedList.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      agentId: 'agent-1',
      archived: true,
      projectId: 'project-1',
    });
  });

  it('keeps restore intent when archive is called repeatedly', async () => {
    const { handleAgentArchive, handleAgentUnarchive } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Workspace',
        enabled: true,
        workspacePath: '/tmp/workspace',
        heartbeat: { enabled: false, intervalMinutes: 48 },
        memoryAutoUpdate: { enabled: true, intervalHours: 72 },
        memoryEvolution: { enabled: false, lastGardenerStatus: 'completed' },
        channels: [{ id: 'channel-1', type: 'telegram', enabled: true }],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Workspace',
      path: '/tmp/workspace',
      agentId: 'agent-1',
    }]);

    expect((await handleAgentArchive({ id: 'agent-1' })).success).toBe(true);
    expect((await handleAgentArchive({ id: 'agent-1' })).success).toBe(true);
    let projects = readJson(join(scratch, '.myagents', 'projects.json'));
    expect(projects[0].archivedAgentEnabledBeforeArchive).toBe(true);

    expect((await handleAgentUnarchive({ id: 'agent-1' })).success).toBe(true);
    const config = readConfig();
    expect((config.agents as Array<Record<string, unknown>>)[0]).toMatchObject({
      enabled: true,
      heartbeat: { enabled: false, intervalMinutes: 48 },
      memoryAutoUpdate: { enabled: true, intervalHours: 72 },
      memoryEvolution: { enabled: false, lastGardenerStatus: 'completed' },
      channels: [{ id: 'channel-1', enabled: true }],
    });
    projects = readJson(join(scratch, '.myagents', 'projects.json'));
    expect(projects[0]).not.toHaveProperty('archivedAt');
  });

  it('rejects plain enable for archived agent workspaces', async () => {
    const { handleAgentEnable } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Workspace',
        enabled: false,
        workspacePath: '/tmp/workspace',
        channels: [],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Workspace',
      path: '/tmp/workspace',
      agentId: 'agent-1',
      archivedAt: '2026-07-03T00:00:00.000Z',
      archivedAgentEnabledBeforeArchive: true,
    }]);

    const result = await handleAgentEnable({ id: 'agent-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('archived workspace');
    expect(result.recoveryHint).toMatchObject({
      recoveryCommand: 'myagents agent unarchive agent-1',
    });
    const config = readConfig();
    expect((config.agents as Array<Record<string, unknown>>)[0].enabled).toBe(false);
  });

  it('unarchives a workspace and restores proactive state only when recorded', async () => {
    const { handleAgentUnarchive } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Workspace',
        enabled: false,
        workspacePath: '/tmp/workspace',
        channels: [],
        mcpEnabledServers: '[playwright,tavily-search]',
        mcpServersJson: '[]',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Workspace',
      path: '/tmp/workspace',
      agentId: 'agent-1',
      archivedAt: '2026-07-03T00:00:00.000Z',
      archivedAgentEnabledBeforeArchive: true,
    }]);

    const result = await handleAgentUnarchive({ id: 'agent-1' });

    expect(result.success).toBe(true);
    const agents = readConfig().agents as Array<Record<string, unknown>>;
    expect(agents[0].mcpEnabledServers).toEqual(['playwright', 'tavily-search']);
    expect(agents[0].mcpServersJson).toBe('[]');
    const config = readConfig();
    expect((config.agents as Array<Record<string, unknown>>)[0].enabled).toBe(true);
    const projects = readJson(join(scratch, '.myagents', 'projects.json'));
    expect(projects[0]).not.toHaveProperty('archivedAt');
    expect(projects[0]).not.toHaveProperty('archivedAgentEnabledBeforeArchive');
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/reload-config',
      'POST',
      { agentId: 'agent-1', patch: { enabled: true } },
      expect.any(Object),
    );
  });

  it('reports projection failure after unarchive without hiding the saved lifecycle change', async () => {
    const { handleAgentUnarchive } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Workspace',
        enabled: false,
        workspacePath: '/tmp/workspace',
        channels: [],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Workspace',
      path: '/tmp/workspace',
      agentId: 'agent-1',
      archivedAt: '2026-07-03T00:00:00.000Z',
      archivedAgentEnabledBeforeArchive: false,
    }]);
    managementApiMocks.managementApi.mockImplementation(async (path) => path === '/api/agent/reload-config'
      ? { ok: false, error: 'task store unavailable' }
      : { ok: true });

    const result = await handleAgentUnarchive({ id: 'agent-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('was unarchived');
    const projects = readJson(join(scratch, '.myagents', 'projects.json'));
    expect(projects[0]).not.toHaveProperty('archivedAt');
  });
});


describe('admin config discovery and MCP observations', () => {
  it('redacts serialized Agent credentials and secret maps through both parent and leaf reads', async () => {
    const secret = 'synthetic-provider-credential-123456789';
    const snapshot = JSON.stringify({ apiKey: secret, baseUrl: 'https://fixture.invalid' });
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{ id: 'agent-fixture', name: 'Fixture', providerEnvJson: snapshot,
        channels: [{ overrides: { providerEnvJson: snapshot, mcpServersJson: snapshot } }] }],
      providerApiKeys: { fixture: secret },
      mcpServerEnv: { fixture: { CUSTOM_AUTH: secret } },
    });
    const { handleConfigGet } = await import('./admin-api');
    for (const key of ['agents', 'agents.0.providerEnvJson', 'agents.0.channels.0.overrides',
      'providerApiKeys', 'mcpServerEnv', 'mcpServerEnv.fixture.CUSTOM_AUTH']) {
      const result = handleConfigGet({ key });
      expect(result.success).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(handleConfigGet({ key: 'agents' })).toMatchObject({
      data: { value: [expect.objectContaining({ name: 'Fixture', providerEnvJson: '****' })] },
    });
    expect(handleConfigGet({ key: 'agents.0.providerEnvJson' })).toMatchObject({ data: { value: '****' } });
  });

  it('lists stored keys and types without exposing secrets, including nested credentials', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      theme: 'dark', providerApiKeys: { deepseek: 'synthetic-private-value' },
      custom: { count: 3, nested: { password: 'synthetic-password' } },
    });
    const { handleConfigList } = await import('./admin-api');
    const top = handleConfigList();
    expect(top).toMatchObject({ success: true, data: { keys: expect.arrayContaining([
      expect.objectContaining({ key: 'appearanceMode', type: 'string', sensitive: false, settable: true, description: expect.any(String) }),
      expect.objectContaining({ key: 'providerApiKeys', type: 'object', sensitive: true, settable: false, description: expect.any(String) }),
    ]) } });
    expect(JSON.stringify(top)).not.toContain('synthetic-private-value');
    expect(handleConfigList({ prefix: 'custom' })).toMatchObject({ success: true, data: { keys: expect.arrayContaining([
      expect.objectContaining({ key: 'custom.count', type: 'number' }),
    ]) } });
    expect(handleConfigList({ prefix: 'providerApiKeys' }).success).toBe(false);
    expect(handleConfigList({ prefix: '__proto__' }).success).toBe(false);
    expect(handleConfigList({ prefix: 'appearanceMode' }).success).toBe(false);
    expect(JSON.stringify(handleConfigList({ prefix: 'custom.nested' }))).not.toContain('synthetic-password');
  });

  it('reads workspace MCP selection from the Session facade independently of global configuration', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), { agents: [], mcpEnabledServers: ['one'] });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{ id: 'project', name: 'Fixture', path: '/fixture/current', mcpEnabledServers: ['one', 'two'] }]);
    sessionEngineMocks.state.context = { sessionId: 'current', workspacePath: '/fixture/current' };
    agentSessionMocks.agentDir = '/fixture/old-builtin';
    const { handleStatus } = await import('./admin-api');
    expect(await handleStatus()).toMatchObject({ data: { workspaceMcp: { selection: ['one', 'two'], enabled: ['one'] } } });
  });

  it('counts only current ready MCP servers and keeps unknown observations distinct from zero', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), { agents: [] });
    writeJson(join(scratch, '.myagents', 'projects.json'), []);
    const { handleStatus } = await import('./admin-api');
    expect(await handleStatus()).toMatchObject({ data: {
      activeMcpInSession: null,
      defaultProviderScope: 'global-fallback',
      sessionMcp: { scope: 'current-session', observation: 'unavailable' },
    } });
    const snapshot = { sessionId: 'session-1', servers: [{ id: 'ready', state: 'ready' }, { id: 'failed', state: 'failed' }] };
    sessionEngineMocks.getStreamReplaySnapshot.mockReturnValue({ sessionId: 'session-1', mcpEffectiveSnapshot: snapshot });
    expect(await handleStatus()).toMatchObject({ data: { activeMcpInSession: 1, sessionMcp: { observation: 'current' } } });
    sessionEngineMocks.getStreamReplaySnapshot.mockReturnValue({ sessionId: 'session-2', mcpEffectiveSnapshot: snapshot });
    expect(await handleStatus()).toMatchObject({ data: { activeMcpInSession: null, sessionMcp: { observation: 'stale' } } });
    sessionEngineMocks.getStreamReplaySnapshot.mockReturnValue({ sessionId: 'session-1', mcpEffectiveSnapshot: { ...snapshot, observationStale: true } });
    expect(await handleStatus()).toMatchObject({ data: { activeMcpInSession: null } });
  });
});


describe('Record details and deletion owner routing', () => {
  it('reads full content and delegates deletion to the Rust Record owner', async () => {
    const { handleRecordGet, handleRecordDelete } = await import('./admin-api');
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, record: { id: 'record-fixture', content: '完整正文' } });
    await expect(handleRecordGet({ id: 'record-fixture' })).resolves.toMatchObject({ success: true, data: { record: { content: '完整正文' } } });
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, id: 'record-fixture' });
    await expect(handleRecordDelete({ id: 'record-fixture' })).resolves.toMatchObject({ success: true });
    expect(managementApiMocks.managementApi.mock.calls).toEqual([
      ['/api/record/get?id=record-fixture'],
      ['/api/record/delete', 'POST', { id: 'record-fixture' }],
    ]);
  });
  it('unwraps an existing structured Task error without dropping its code', async () => {
    const { handleTaskGet } = await import('./admin-api');
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: false, error: JSON.stringify({ code: 'not_found', message: 'Task not found: missing' }) });
    await expect(handleTaskGet({ id: 'missing' })).resolves.toMatchObject({ success: false, code: 'not_found', error: 'Task not found: missing' });
  });
});
