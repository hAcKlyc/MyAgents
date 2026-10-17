import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { managementApi } = vi.hoisted(() => ({ managementApi: vi.fn() }));
vi.mock('./utils/management-api-client', () => ({ managementApi }));

import { handleNetworkCli } from './network-cli';
import { admitAdminRequest } from './external-cli-admission';
import { cliRequestTimeoutMs } from '../cli/myagents';

const uuid = '45f36ff2-4356-4143-ae02-931ec0b057b9';
const actions = [
  ['status', {}], ['login', { connectionId: 'saved', expectedRevision: 3 }],
  ['poll', { attemptId: uuid }], ['cancel', { attemptId: uuid }],
  ['restore', { connectionId: 'saved', expectedRevision: 3, operationId: uuid }],
  ['cancel-restore', { operationId: uuid }],
] as const;

beforeEach(() => {
  vi.stubEnv('MYAGENTS_SIDECAR_ID', 'native-sidecar');
  vi.stubEnv('MYAGENTS_INTERNAL_CLI_TOKEN', 'internal-test-capability');
  managementApi.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('network CLI native owner adapter', () => {
  it.each(actions)('forwards %s once with the real Sidecar identity and bounded timeout', async (action, payload) => {
    const controller = new AbortController();
    const data = { revision: 4, connections: [], loginAttempts: [{ attemptId: uuid, connectionId: 'saved', expiresAt: 1_792_152_000 }] };
    managementApi.mockResolvedValue({ ok: true, data });
    expect(await handleNetworkCli(action, payload, controller.signal)).toEqual({ success: true, data });
    expect(managementApi).toHaveBeenCalledExactlyOnceWith('/api/agent-network/cli', 'POST', {
      sidecarId: 'native-sidecar', action, ...payload,
    }, { timeoutMs: action === 'restore' ? 40_000 : action === 'login' || action === 'poll' ? 80_000 : 10_000, parentSignal: controller.signal });
    expect(cliRequestTimeoutMs(`network/${action}`)).toBeGreaterThan(managementApi.mock.calls[0][3].timeoutMs);
  });

  it.each([
    ['poll', { attemptId: uuid.toUpperCase() }, { attemptId: uuid }],
    ['cancel', { attemptId: uuid.toUpperCase() }, { attemptId: uuid }],
    ['cancel-restore', { operationId: uuid.toUpperCase() }, { operationId: uuid }],
    ['restore', { connectionId: 'saved', expectedRevision: 0, operationId: uuid.toUpperCase() }, { connectionId: 'saved', expectedRevision: 0, operationId: uuid }],
  ])('canonicalizes uppercase UUID wire input for %s before native forwarding', async (action, payload, canonical) => {
    managementApi.mockResolvedValue({ ok: true, data: {} });
    expect(await handleNetworkCli(action as string, payload)).toEqual({ success: true, data: {} });
    expect(managementApi.mock.calls[0][2]).toEqual({ sidecarId: 'native-sidecar', action, ...canonical as Record<string, unknown> });
  });

  it.each([
    { status: 'pending', started: { attemptId: uuid, authorizationUrl: 'https://saved.example/authorize', expiresAt: 1_792_152_000 } },
    { status: 'authorization-required', started: { attemptId: uuid, authorizationUrl: 'https://saved.example/authorize', expiresAt: '2026-10-16T12:00:00Z' } },
    { status: 'authenticated', registry: { revision: 4, connections: [] } },
  ])('preserves the native login state without creating a second state machine', async data => {
    managementApi.mockResolvedValue({ ok: true, data });
    expect(await handleNetworkCli('poll', { attemptId: uuid })).toEqual({ success: true, data });
    expect(managementApi).toHaveBeenCalledTimes(1);
  });

  it('returns native authorization-required and restore-accepted without claiming readiness', async () => {
    const registry = { revision: 4, selfhostEnabled: true, connections: [{
      id: 'saved', name: 'Owned', official: false, removing: false,
      localDeviceId: uuid, ownedAccount: true, state: 'connecting', revision: 4,
    }] };
    const login = { status: 'authorization-required', started: {
      attemptId: uuid, authorizationUrl: 'https://saved.example/authorize', expiresAt: 1_792_152_000,
    } };
    managementApi.mockResolvedValueOnce({ ok: true, data: login });
    expect(await handleNetworkCli('login', { connectionId: 'saved', expectedRevision: 3 }))
      .toEqual({ success: true, data: login });
    managementApi.mockResolvedValueOnce({ ok: true, data: { status: 'restore-accepted', registry } });
    expect(await handleNetworkCli('restore', { connectionId: 'saved', expectedRevision: 3, operationId: uuid }))
      .toEqual({ success: true, data: { status: 'restore-accepted', registry } });
  });

  it.each(['password', 'token', 'issuer', 'sidecarId', 'action', 'deviceId', 'principal', 'unexpected'])(
    'rejects wire field %s before contacting the management owner', async field => {
      expect(await handleNetworkCli('login', { connectionId: 'saved', expectedRevision: 3, [field]: 'injected' }))
        .toMatchObject({ success: false, code: 'ARGUMENT_INVALID' });
      expect(managementApi).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['status', { connectionId: 'saved' }], ['create', {}], ['__proto__', {}],
    ['login', { connectionId: ' ', expectedRevision: 1 }],
    ['login', { connectionId: 'saved', expectedRevision: '1' }],
    ['login', { connectionId: 'saved', expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ['poll', { attemptId: 'invalid' }], ['restore', { connectionId: 'saved', expectedRevision: 1 }],
    ['cancel-restore', { operationId: 'invalid' }], ['status', null], ['status', []],
  ])('rejects malformed %s wire payloads', async (action, payload) => {
    expect(await handleNetworkCli(action as string, payload)).toMatchObject({ success: false, code: 'ARGUMENT_INVALID' });
    expect(managementApi).not.toHaveBeenCalled();
  });

  it('requires the existing Sidecar process identity', async () => {
    vi.stubEnv('MYAGENTS_SIDECAR_ID', '');
    expect(await handleNetworkCli('status', {})).toMatchObject({ success: false, code: 'NETWORK_CLI_OWNER_UNAVAILABLE' });
    expect(managementApi).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, error: { code: 'REVISION_CONFLICT', message: 'secret-native-body' } }, 'REVISION_CONFLICT'],
    [{ ok: false, code: 'transport_outcome_unknown', error: 'secret-native-body' }, 'transport_outcome_unknown'],
    [{ ok: false, error: { code: 'bad\ncode', message: 'secret-native-body' } }, 'NETWORK_CLI_OWNER_UNAVAILABLE'],
    [{ ok: false, error: { code: 'x'.repeat(97), message: 'secret-native-body' } }, 'NETWORK_CLI_OWNER_UNAVAILABLE'],
    [{ ok: true }, 'NETWORK_CLI_OWNER_UNAVAILABLE'],
    [null, 'NETWORK_CLI_OWNER_UNAVAILABLE'],
    [[], 'NETWORK_CLI_OWNER_UNAVAILABLE'],
    ['malformed', 'NETWORK_CLI_OWNER_UNAVAILABLE'],
  ])('preserves bounded error codes while excluding native diagnostics', async (native, code) => {
    managementApi.mockResolvedValue(native);
    const result = await handleNetworkCli('status', {});
    expect(result).toMatchObject({ success: false, code });
    expect(JSON.stringify(result)).not.toContain('secret-native-body');
    expect(managementApi).toHaveBeenCalledTimes(1);
  });

  it('does not leak thrown errors or retry uncertain mutations', async () => {
    managementApi.mockRejectedValue(new Error('secret-native-body'));
    const result = await handleNetworkCli('login', { connectionId: 'saved', expectedRevision: 3 });
    expect(result).toMatchObject({ success: false, code: 'NETWORK_CLI_OWNER_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('secret-native-body');
    expect(managementApi).toHaveBeenCalledTimes(1);
  });

  it.each(actions)('keeps %s behind the existing external token admission', async (action) => {
    const request = (headers: Record<string, string>) => new Request(`http://127.0.0.1:31415/api/admin/network/${action}`, { method: 'POST', headers });
    expect(await admitAdminRequest(request({}), `network/${action}`))
      .toMatchObject({ response: { code: 'EXTERNAL_CLI_TOKEN_REQUIRED' } });
    managementApi.mockResolvedValue({ ok: true, allowed: false, code: 'external_cli_disabled' });
    expect(await admitAdminRequest(request({ Authorization: 'Bearer external-test-token' }), `network/${action}`))
      .toMatchObject({ response: { code: 'EXTERNAL_CLI_DISABLED' } });
    expect(managementApi).toHaveBeenCalledTimes(1);
  });
});
