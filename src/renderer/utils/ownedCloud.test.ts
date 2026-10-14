import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ registry: vi.fn(), open: vi.fn() }));
vi.mock('@/api/agentNetwork', () => ({ networkConnections: mocks.registry }));
vi.mock('@/utils/openExternal', () => ({ openExternal: mocks.open }));
import { canonicalOwnedIssuer, openOwnedCloudPage } from './ownedCloud';

beforeEach(() => vi.clearAllMocks());
describe('owned cloud navigation', () => {
  it.each(['http://cloud.example', 'https://a:b@cloud.example', 'https://cloud.example/admin', 'https://cloud.example/?token=x', 'https://cloud.example/#x', '', null])('rejects non-origin configuration %s', (value) => {
    expect(canonicalOwnedIssuer(value)).toBeNull();
  });
  it('opens only the configured owned service, regardless of the selected peer', async () => {
    mocks.registry.mockResolvedValue({ ownedServiceUrl: 'https://cloud.example:8443/', selected: 'untrusted-peer' });
    await openOwnedCloudPage('community');
    expect(mocks.open).toHaveBeenCalledWith('https://cloud.example:8443/community');
    await openOwnedCloudPage('feedback');
    expect(mocks.open).toHaveBeenLastCalledWith('https://cloud.example:8443/feedback');
  });
  it('does not fall back to an upstream community when configuration is absent', async () => {
    mocks.registry.mockResolvedValue({ ownedServiceUrl: null });
    await expect(openOwnedCloudPage('community')).rejects.toThrow('OWNED_SERVICE_UNAVAILABLE');
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
