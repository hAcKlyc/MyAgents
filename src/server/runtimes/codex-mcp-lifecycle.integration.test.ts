import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Subprocess } from '../utils/subprocess';
import type { UnifiedEvent } from './types';

const fixture = vi.hoisted(() => ({ home: '', spawn: vi.fn() }));
vi.mock('os', async original => ({ ...await original<typeof import('os')>(), homedir: () => fixture.home }));
vi.mock('../utils/subprocess', async original => ({ ...await original<typeof import('../utils/subprocess')>(), spawn: (...args: unknown[]) => fixture.spawn(...args) }));
vi.mock('./codex-command-context', () => ({ resolveCodexCommandContext: async () => ({ commandPath: '/fixture/codex', env: {}, version: '0.162.1' }) }));

describe('Codex process MCP lifecycle', () => {
  let exit: (code: number) => void;
  let notify: (method: string, params: unknown) => void;
  let runtime: import('./codex').CodexRuntime;
  let rpcCall: MockInstance<import('./codex').JsonRpcClient['call']>;
  let events: UnifiedEvent[];

  beforeEach(async () => {
    vi.resetModules();
    fixture.home = await mkdtemp(join(tmpdir(), 'codex-mcp-lifecycle-'));
    events = [];
    const exited = new Promise<number>(resolve => { exit = resolve; });
    fixture.spawn.mockReturnValue({
      pid: 987654321,
      exited,
      stdout: new ReadableStream({ start(controller) { controller.close(); } }),
      stderr: new ReadableStream({ start(controller) { controller.close(); } }),
      stdin: { write: vi.fn(async () => {}), flush: vi.fn(async () => {}), end: async () => { exit(0); } },
      kill: () => { exit(143); },
    } as unknown as Subprocess);
    const { CodexRuntime, JsonRpcClient } = await import('./codex');
    runtime = new CodexRuntime();
    vi.spyOn(JsonRpcClient.prototype, 'startReading').mockResolvedValue();
    vi.spyOn(JsonRpcClient.prototype, 'setNotificationHandler').mockImplementation(handler => { notify = handler; });
    rpcCall = vi.spyOn(JsonRpcClient.prototype, 'call').mockImplementation(async (method) => {
      if (method === 'thread/start' || method === 'thread/resume') {
        notify('mcpServer/startupStatus/updated', { name: 'fixture', status: 'ready', threadId: null });
        return { thread: { id: 'native-thread' }, model: 'fixture-model', approvalsReviewer: 'auto_review' };
      }
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'fixture', tools: { lookup: {} }, authStatus: 'unsupported' }] };
      if (method === 'getAuthStatus') return { authMethod: 'apikey' };
      if (method === 'config/read') return { config: {} };
      return { data: [] };
    });
  });

  afterEach(async () => {
    exit?.(0);
    await Promise.resolve();
    vi.restoreAllMocks();
    await rm(fixture.home, { recursive: true, force: true });
  });

  async function start() {
    const process = await runtime.startSession({
      sessionId: 'product-session', workspacePath: fixture.home, scenario: { type: 'desktop' },
      runtimeSource: 'managed-provider',
      managedCodexExtensions: {
        revision: 'fixture', workspacePath: fixture.home, scenario: { type: 'desktop' },
        skills: [], commands: [], agents: [], dynamicTools: [], components: [], enabledPluginIds: [],
        mcpServers: [{ id: 'fixture', name: 'Fixture', type: 'http', url: 'http://127.0.0.1:1/mcp', isBuiltin: false }],
      },
    }, event => { events.push(event); });
    await vi.waitFor(() => expect(latest()?.servers[0]?.state).toBe('ready'));
    return process;
  }

  function latest() {
    return events.filter(event => event.kind === 'mcp_effective_update').at(-1);
  }

  it('invalidates callable catalogs on deliberate stop and rejects late ready events', async () => {
    const process = await start();
    expect(latest()?.tools).toEqual(['mcp__fixture__lookup']);
    await runtime.stopSession(process);
    expect(latest()).toMatchObject({
      servers: [{ id: 'fixture', desired: true, state: 'stopped', toolCount: 0 }], tools: [],
      dispatch: { state: 'released', releaseReason: 'cancelled' },
    });
    expect(latest()?.servers[0]).not.toHaveProperty('errorCode');
    expect(events.filter(event => event.kind === 'runtime_tool_catalog').at(-1)).toMatchObject({ tools: [] });
    const count = events.length;
    notify('mcpServer/startupStatus/updated', { name: 'fixture', status: 'ready', threadId: 'native-thread' });
    expect(events).toHaveLength(count);
    expect(rpcCall.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  });

  it.each([0, 1])('classifies an unrequested exit with code %i as runtime failure', async (code) => {
    await start();
    exit(code);
    await Promise.resolve();
    expect(latest()).toMatchObject({
      servers: [{ desired: true, state: 'failed', errorCode: 'MCP_RUNTIME_EXITED', toolCount: 0 }], tools: [],
    });
  });

  it('does not relabel protocol-failure cleanup as an intentional stop', async () => {
    const process = await start();
    await runtime.stopSession(process, 'failure');
    expect(latest()?.servers[0]).toMatchObject({ state: 'failed', errorCode: 'MCP_RUNTIME_EXITED' });
  });
});
