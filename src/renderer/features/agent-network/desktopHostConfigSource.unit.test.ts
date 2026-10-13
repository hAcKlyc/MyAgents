import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type AppConfig, type Project, type Provider } from '@/config/types';
import { loadAppConfig, getAllProviders } from '@/config/configService';
import { loadProjects } from '@/config/services/projectService';
import { desktopWorkspaceDirectoryHint, loadDesktopHostConfigSource, portableApiProviderForModel, resolveDesktopHostConfigSource, versionPortableHostProfile } from './desktopHostConfigSource';

vi.mock('@/config/configService', () => ({ loadAppConfig: vi.fn(), getAllProviders: vi.fn() }));
vi.mock('@/config/services/projectService', () => ({ loadProjects: vi.fn() }));

const provider = (id = 'api-example'): Provider => ({
  id, name: 'Example API', vendor: 'Example', cloudProvider: 'Example', type: 'api',
  isBuiltin: false, primaryModel: 'provider/model-default', apiProtocol: 'anthropic',
  config: { baseUrl: 'https://api.example.test/v1' },
  models: [{ model: 'provider/model-default', modelName: 'Default', modelSeries: 'example' }, { model: 'provider/model-agent', modelName: 'Agent', modelSeries: 'example' }],
});
const config = (updates: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULT_CONFIG,
  defaultWorkspacePath: '/desktop/main workspace', defaultProviderId: 'api-example',
  providerApiKeys: { 'api-example': 'synthetic-local-key' }, ...updates,
});
const project: Project = { id: 'project-main', name: 'Main workspace', path: '/desktop/main workspace', agentId: 'agent-main', providerId: null, permissionMode: null };

beforeEach(() => vi.clearAllMocks());

describe('desktop main Agent configuration source', () => {
  it('prefers the explicit main Agent and returns only portable metadata plus transient key', () => {
    const source = resolveDesktopHostConfigSource(config({ agents: [{ id: 'agent-main', name: 'Main Agent', enabled: false, permissionMode: 'plan', providerId: 'api-example', model: 'provider/model-agent', channels: [] }] }), [project], [provider()]);
    expect(source).toMatchObject({ agentName: 'Main Agent', model: 'provider/model-agent', localWorkspacePath: project.path, credential: 'synthetic-local-key', provider: { id: 'api-example', authType: 'both' } });
    expect(source.provider).not.toHaveProperty('apiKey');
    expect(source.provider).not.toHaveProperty('executionAuthorized');
  });
  it('honors the current Provider primary-model override when the Agent has no model', () => {
    expect(resolveDesktopHostConfigSource(config({ providerPrimaryModels: { 'api-example': 'provider/model-agent' } }), [], [provider()]).model).toBe('provider/model-agent');
  });
  it('matches the Agent settings legacy workspace fallback without replacing an explicit choice', () => {
    const legacy = { ...project, agentId: undefined, providerId: 'workspace-api', model: 'provider/model-agent' };
    const legacyConfig = config({ providerApiKeys: { 'workspace-api': 'synthetic-workspace-key' } });
    expect(resolveDesktopHostConfigSource(legacyConfig, [legacy], [provider(), provider('workspace-api')])).toMatchObject({ provider: { id: 'workspace-api' }, model: 'provider/model-agent', credential: 'synthetic-workspace-key' });
    expect(() => resolveDesktopHostConfigSource(legacyConfig, [{ ...legacy, providerId: 'missing' }], [provider()])).toThrow('HOST_SOURCE_PROVIDER_MISSING');
  });
  it('does not substitute another Provider for an explicit missing or disabled choice', () => {
    expect(() => resolveDesktopHostConfigSource(config({ defaultProviderId: 'missing' }), [], [provider()])).toThrow('HOST_SOURCE_PROVIDER_MISSING');
    expect(() => resolveDesktopHostConfigSource(config({ disabledProviderIds: ['api-example'] }), [], [provider()])).toThrow('HOST_SOURCE_PROVIDER_DISABLED');
  });
  it('rejects subscription/runtime-owned sources and desktop-local endpoints', () => {
    expect(() => portableApiProviderForModel({ ...provider(), type: 'subscription' }, 'model')).toThrow('HOST_SOURCE_PROVIDER_UNSUPPORTED');
    expect(() => portableApiProviderForModel({ ...provider(), config: { baseUrl: 'https://localhost/v1' } }, 'model')).toThrow('HOST_SOURCE_ENDPOINT_UNSUPPORTED');
    expect(() => resolveDesktopHostConfigSource(config({ agents: [{ id: 'agent-main', name: 'CLI', enabled: false, permissionMode: 'plan', runtimePreference: { family: 'external', id: 'codex' }, channels: [] }] }), [project], [provider()])).toThrow('HOST_SOURCE_RUNTIME_UNSUPPORTED');
  });
  it('does not export credential references or inherited object properties as real keys', () => {
    expect(() => resolveDesktopHostConfigSource(config({ providerApiKeys: { 'api-example': 'host-provider-credential:api-example' } }), [], [provider()])).toThrow('HOST_SOURCE_CREDENTIAL_UNAVAILABLE');
    expect(() => resolveDesktopHostConfigSource(config({ defaultProviderId: undefined, providerApiKeys: {} }), [], [provider('constructor')])).toThrow('HOST_SOURCE_PROVIDER_MISSING');
    expect(resolveDesktopHostConfigSource(config({ providerApiKeys: {} }), [], [provider()])).not.toHaveProperty('credential');
  });
  it('fails for ambiguous or archived source workspaces', () => {
    expect(() => resolveDesktopHostConfigSource(config(), [project, { ...project, id: 'other' }], [provider()])).toThrow('HOST_SOURCE_AGENT_AMBIGUOUS');
    expect(() => resolveDesktopHostConfigSource(config(), [{ ...project, archivedAt: '2026-10-13T00:00:00Z' }], [provider()])).toThrow('HOST_SOURCE_WORKSPACE_ARCHIVED');
  });
  it('uses the actual per-model protocol and endpoint', () => {
    const perModel: Provider = { ...provider('tokendance'), isBuiltin: true, modelRouting: 'per-model',
      models: [{ model: 'provider/model-default', modelName: 'Default', modelSeries: 'example', supportedProtocols: ['openai:responses'] }],
      modelProtocolBaseUrls: { 'openai:responses': 'https://api.example.test/responses' },
    };
    expect(portableApiProviderForModel(perModel, 'provider/model-default')).toMatchObject({ apiProtocol: 'openai', upstreamFormat: 'responses', baseUrl: 'https://api.example.test/responses' });
  });
  it('re-reads source authority when applying instead of retaining a stale key/model', async () => {
    const current = config({ providerPrimaryModels: { 'api-example': 'provider/model-agent' }, providerApiKeys: { 'api-example': 'synthetic-current-key' } });
    vi.mocked(loadAppConfig).mockResolvedValue(current);
    vi.mocked(loadProjects).mockResolvedValue([]);
    vi.mocked(getAllProviders).mockImplementation(async received => {
      expect(received).toBe(current);
      return [{ ...provider(), config: { baseUrl: 'https://current.example.test/v1' }, apiProtocol: 'openai', upstreamFormat: 'responses' }];
    });
    expect(await loadDesktopHostConfigSource()).toMatchObject({ model: 'provider/model-agent', credential: 'synthetic-current-key', provider: { baseUrl: 'https://current.example.test/v1', apiProtocol: 'openai', upstreamFormat: 'responses' } });
    expect(loadAppConfig).toHaveBeenCalledTimes(1);
  });
  it('versions profiles deterministically and freezes all four aliases without any credential', async () => {
    const plain = portableApiProviderForModel(provider(), 'provider/model-default');
    const version = await versionPortableHostProfile(plain, 'provider/model-default');
    expect(version.id).toMatch(/^api-example-v-[a-f0-9]{24}$/);
    expect(await versionPortableHostProfile(plain, 'provider/model-default')).toEqual(version);
    expect(await versionPortableHostProfile(version, 'provider/model-default')).toEqual(version);
    expect((await versionPortableHostProfile({ ...plain, baseUrl: 'https://other.example.test/v1' }, 'provider/model-default')).id).not.toBe(version.id);
    expect((await versionPortableHostProfile(plain, 'provider/model-agent')).id).not.toBe(version.id);
    expect(Object.keys(version.modelAliases ?? {}).sort()).toEqual(['fable','haiku','opus','sonnet']);
    expect(version).not.toHaveProperty('credential');
  });
  it('preserves token auth that clears the SDK API-key variable', () => {
    expect(portableApiProviderForModel({ ...provider(), authType: 'auth_token_clear_api_key' }, 'provider/model-default').authType).toBe('auth_token_clear_api_key');
  });
  it('derives only a folder-name hint from Windows and Mac paths', () => {
    expect(desktopWorkspaceDirectoryHint('C:\\Users\\Example\\research\\')).toBe('research');
    expect(desktopWorkspaceDirectoryHint('/Users/example/中文项目/')).toBe('中文项目');
    expect(desktopWorkspaceDirectoryHint('/')).toBeUndefined();
  });
});
