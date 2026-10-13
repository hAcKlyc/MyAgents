import { describe, expect, it } from 'vitest';
import { projectHostProviderCatalog } from './admin-config';

const profile = { id: 'api-example', name: 'Example API', apiProtocol: 'openai', baseUrl: 'https://api.example.test/v1', authType: 'api_key', upstreamFormat: 'responses', modelAliases: { haiku: 'model/fast' } };
const current = { revision: 2, providerId: 'api-example', model: 'model/new', workspace: '/host/workspace', executionAuthorized: false };
const record = { hostProviderProfiles: { 'api-example': profile }, hostSettings: current,
  hostProviderConfigReceipts: { entries: [{ providerId: 'api-example', receipt: { status: 'persisted', settings: { providerId: 'api-example', model: 'model/old' } } }] },
};

describe('Host API profile registry projection', () => {
  it('is inactive for normal desktop processes', () => {
    const base = [{ id: 'api-example', type: 'api', config: { baseUrl: 'https://original.example.test' } }];
    expect(projectHostProviderCatalog(record, base, false)).toEqual(base);
  });
  it('uses validated Host metadata and retains past Session models without enabling Agents', () => {
    const result = projectHostProviderCatalog(record, [{ id: 'api-example', config: { baseUrl: 'https://original.example.test' } }, { id: 'other' }], true);
    expect(result).toHaveLength(2);
    expect(result.find(item => item.id === 'api-example')).toMatchObject({ type: 'api', enabled: true, config: { baseUrl: profile.baseUrl }, primaryModel: 'model/new', models: [{ model: 'model/new' }, { model: 'model/old' }, { model: 'model/fast' }] });
    expect(record.hostSettings.executionAuthorized).toBe(false);
    expect(result.find(item => item.id === 'api-example')).not.toHaveProperty('apiKey');
  });
  it('fails closed on forged runtime owners, invalid endpoints and malformed ledgers', () => {
    expect(() => projectHostProviderCatalog({ ...record, hostProviderProfiles: { 'codex-sub': { ...profile, id: 'codex-sub' } } }, [], true)).toThrow('HOST_PROVIDER_REGISTRY_INVALID');
    expect(() => projectHostProviderCatalog({ ...record, hostProviderProfiles: { 'api-example': { ...profile, baseUrl: 'https://localhost/v1' } } }, [], true)).toThrow('HOST_PROVIDER_REGISTRY_INVALID');
    expect(() => projectHostProviderCatalog({ ...record, hostProviderConfigReceipts: { entries: [null] } }, [], true)).toThrow('HOST_PROVIDER_REGISTRY_INVALID');
  });
});
