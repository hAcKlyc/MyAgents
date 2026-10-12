import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESET_PROVIDERS } from '../../../shared/config-types';
import type { UnifiedEvent } from '../../runtimes/types';
import { getLogContext } from '../../logger-context';
import { DshRuntime, startDshStorageManagement } from './runtime';
import type { DshRuntimeProcessHostOptions } from './process-host';
import { DshAttachmentRegistry } from './attachments';
import { dshSessionOwnedPaths } from './owned-paths';
import type { DshRpcObject } from './protocol-types';

const fixture = vi.hoisted(() => ({ home: '', phase: '', revision: '', host: undefined as DshRuntimeProcessHostOptions | undefined }));
vi.mock('../../utils/platform', async original => ({ ...await original<typeof import('../../utils/platform')>(), getHomeDir: () => fixture.home }));
vi.mock('../../utils/runtime', () => ({ getBundledNodePath: () => join(fixture.home, 'node') }));
vi.mock('../../utils/shell', () => ({ ensureShellPath: async () => '' }));
vi.mock('../../session-core/sidecar-port', () => ({ getSidecarPort: () => 12345 }));
vi.mock('../../SessionStore', () => ({ getSessionMetadata: () => ({ providerRoute: { kind: 'provider', providerId: 'deepseek', model: 'deepseek-flash' } }) }));
vi.mock('../../utils/admin-config', () => ({
  loadConfig: () => ({}), findProjectAgentByWorkspacePath: () => undefined,
  findEffectiveProvider: () => PRESET_PROVIDERS.find(provider => provider.id === 'deepseek'),
  resolveProviderEnv: () => ({ providerId: 'deepseek', apiProtocol: 'anthropic', authType: 'api_key', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1' }),
}));
vi.mock('./installation', () => ({ resolveDshRuntimeInstallation: async (options: unknown) => options }));
vi.mock('../../session-engine/dsh-mutation-recovery', () => ({ recoverPendingDshMutation: async () => ({ recovered: false }) }));
vi.mock('../../session-engine/dsh-turn-reconciliation', () => ({ reconcileDshTurnsAtStartup: async () => { throw new Error('reconciliation failed'); } }));
vi.mock('./process-host', async original => ({
  ...await original<typeof import('./process-host')>(),
  DshRuntimeProcessHost: class {
    constructor(options: DshRuntimeProcessHostOptions) { fixture.host = options; }
    start = async () => {
      fixture.host!.onStderrLine?.('before admission');
      if (fixture.phase === 'handshake') throw new Error('handshake failed');
      return { runtimeGeneration: 'diagnostic-generation' };
    };
    request = async (method: string, params: DshRpcObject) => {
      if (method === 'extension/replace') {
        const registry = new DshAttachmentRegistry(dshSessionOwnedPaths(join(fixture.home, '.myagents'), 'product-diagnostics').attachmentRoot);
        await registry.initialize();
        const snapshot = await registry.readJson(params.snapshotAttachment as { attachmentId: string; mimeType: string; sizeBytes: number; sha256: string }) as DshRpcObject;
        fixture.revision = String(snapshot.revision);
        return { state: 'applied', desiredRevision: snapshot.revision, effectiveRevision: snapshot.revision };
      }
      if (method === 'extension/catalog') return { revision: fixture.revision, digest: 'a'.repeat(64), skills: [], tools: [] };
      if (method === 'session/resume' || method === 'session/create') {
        fixture.host!.onFailure?.(new Error('Protocol input reached EOF; token=synthetic-secret'));
        if (fixture.phase !== 'reconciliation') throw new Error('binding failed');
        return { state: 'ready', runtimeSessionId: 'native-diagnostics' };
      }
      throw new Error(`Unexpected request ${method}`);
    };
    stop = async () => {
      fixture.host!.onExit?.({ code: 23, signal: null, hostTermination: null });
      fixture.host!.onStderrLine?.('cleanup tail');
    };
  },
}));

afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (fixture.home) await rm(fixture.home, { recursive: true, force: true });
});

describe('DSH failed admission diagnostics', () => {
  it('initializes storage management without credentials or a Session CLI capability', async () => {
    fixture.phase = 'storage';
    fixture.home = await mkdtemp(join(tmpdir(), 'dsh-storage-bootstrap-'));
    await writeFile(join(fixture.home, 'node'), 'synthetic');
    await mkdir(join(fixture.home, 'integrated-runtimes/dsh/runtime-artifact'), { recursive: true });
    const workspacePath = join(fixture.home, 'workspace'); await mkdir(workspacePath);
    vi.stubEnv('MYAGENTS_INTERNAL_CLI_TOKEN', 'must-not-be-forwarded');
    const host = await startDshStorageManagement({ sessionId: 'storage-only', workspacePath });
    expect(fixture.host?.childEnvironment.env.MYAGENTS_INTERNAL_CLI_TOKEN).toBeUndefined();
    expect(() => fixture.host?.hostHandlers['host/credential/resolve']({} as never, {} as never)).toThrow('cannot execute');
    await host.stop();
  });

  it.each(['handshake', 'create', 'resume', 'reconciliation'])('retains %s diagnostics without admitting product events', async phase => {
    fixture.phase = phase;
    fixture.home = await mkdtemp(join(tmpdir(), 'dsh-diagnostics-'));
    await writeFile(join(fixture.home, 'node'), 'synthetic');
    await mkdir(join(fixture.home, 'integrated-runtimes/dsh/runtime-artifact'), { recursive: true });
    const workspacePath = join(fixture.home, 'workspace'); await mkdir(workspacePath);
    vi.stubEnv('MYAGENTS_INTERNAL_CLI_TOKEN', 'synthetic');
    const logs: Array<{ message: string; sessionId?: string; runtime?: string }> = [];
    const capture = (...args: unknown[]) => logs.push({ message: args.join(' '), ...getLogContext() });
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    const events: UnifiedEvent[] = [];
    await expect(new DshRuntime().startSession({ sessionId: 'product-diagnostics', workspacePath,
      resumeSessionId: phase === 'resume' || phase === 'reconciliation' ? 'native-diagnostics' : undefined,
      permissionMode: 'full-autonomous', scenario: { type: 'desktop' },
      dshExtensions: { revision: 'empty', workspacePath, skills: [], commands: [], agents: [], mcpServers: [], dynamicTools: [] },
    }, event => events.push(event))).rejects.toThrow(/failed/);
    // This callback can also fire after a replacement retires the product receiver.
    fixture.host!.onStderrLine?.('late stream tail');
    const expectedPhase = phase === 'create' ? 'native-create' : phase === 'resume' ? 'native-resume' : phase === 'reconciliation' ? 'turn-reconciliation' : 'handshake';
    expect(logs.some(log => log.message.includes(`phase=${expectedPhase} admission failed:`))).toBe(true);
    for (const tail of ['before admission', 'cleanup tail', 'late stream tail', 'Process exited']) {
      expect(logs.some(log => log.message.includes(tail))).toBe(true);
    }
    expect(logs.filter(log => log.message.startsWith('[dsh]')).every(log => log.sessionId === 'product-diagnostics' && log.runtime === 'dsh')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('synthetic-secret');
    if (phase !== 'handshake') expect(logs.some(log => log.message.includes('Protocol input reached EOF'))).toBe(true);
    expect(events).toEqual([]); // No session_complete/history/turn escapes admission.
  });
});
