import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESET_PROVIDERS } from '../../shared/config-types';
import { getSessionMetadata } from '../SessionStore';
import { findEffectiveProvider, loadConfig, resolveProviderEnv } from '../utils/admin-config';
import { compileConfiguration } from '../integrated-runtimes/dsh/runtime';
import type { SessionStartOptions } from '../runtimes/types';
vi.mock('../SessionStore', () => ({ getSessionMetadata: vi.fn() }));
vi.mock('../utils/admin-config', () => ({ findEffectiveProvider: vi.fn(), findProjectAgentByWorkspacePath: vi.fn(), loadConfig: vi.fn(), resolveProviderEnv: vi.fn(), resolveWorkspaceConfig: vi.fn() }));
vi.mock('../utils/managed-proxy-binding', () => ({ prepareProviderBinding: vi.fn(), getPreparedModelPolicy: vi.fn() }));
const provider = structuredClone(PRESET_PROVIDERS.find(row => row.id === 'moonshot-coding')!);
const options: SessionStartOptions = { sessionId: 'synthetic-admission', workspacePath: '/synthetic-workspace', model: 'k3', runtimeSource: 'integrated', providerRoute: { kind: 'provider', providerId: provider.id, model: 'k3' }, scenario: { type: 'desktop' } };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionMetadata).mockReturnValue(null);
  vi.mocked(loadConfig).mockReturnValue({} as ReturnType<typeof loadConfig>);
  vi.mocked(findEffectiveProvider).mockReturnValue(provider as unknown as NonNullable<ReturnType<typeof findEffectiveProvider>>);
  vi.mocked(resolveProviderEnv).mockReturnValue({ providerId: provider.id, providerName: provider.name, apiProtocol: 'anthropic', authType: 'api_key', apiKey: 'synthetic-never-sent', baseUrl: provider.config.baseUrl });
});
describe('modelqa DSH native configuration admission (no process/model/config I/O)', () => {
  it('reproduces CLI plan permission rejection before credential resolution', async () => {
    await expect(compileConfiguration({ ...options, permissionMode: 'plan' })).rejects.toThrow('Unsupported MyAgents DSH permission mode: plan');
    expect(resolveProviderEnv).not.toHaveBeenCalled();
  });
  it('admits the real Kimi k3 profile with the restrictive DSH approval policy', async () => {
    const compiled = await compileConfiguration({ ...options, permissionMode: 'approval-required' });
    expect(compiled.productPermissionMode).toBe('approval-required');
    expect(compiled.profile.modelId).toBe('k3');
    expect(resolveProviderEnv).toHaveBeenCalledOnce();
  });
});
