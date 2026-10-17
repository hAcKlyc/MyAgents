import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLI_SESSION_HEADER, cliSessionScopeError } from '../shared/cli-session-scope';
import { composeSidecarRequestHandler, resolveSidecarComposition } from './sidecar-composition';

type NativeCall = { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };
const calls: NativeCall[] = [];
const operationId = '45f36ff2-4356-4143-ae02-931ec0b057b9';
const actions = [
  ['status', {}], ['login', { connectionId: 'saved', expectedRevision: 4 }],
  ['poll', { attemptId: operationId }], ['cancel', { attemptId: operationId }],
  ['restore', { connectionId: 'saved', expectedRevision: 4, operationId }],
  ['cancel-restore', { operationId }],
] as const;
let management: Server;
let enabled = true;
let nativeResult: Record<string, unknown>;
let admitAdminRequest: typeof import('./external-cli-admission').admitAdminRequest;
let isAdminAdmissionFailure: typeof import('./external-cli-admission').isAdminAdmissionFailure;
let handleNetworkCli: typeof import('./network-cli').handleNetworkCli;

beforeAll(async () => {
  // Only the native authority is a bounded loopback fixture. Classification,
  // external admission, wire validation and management HTTP are production code.
  management = createServer(async (incoming, outgoing) => {
    try {
      let raw = '';
      for await (const chunk of incoming) raw += String(chunk);
      const body = JSON.parse(raw) as Record<string, unknown>;
      calls.push({ path: incoming.url ?? '', headers: incoming.headers, body });
      outgoing.setHeader('content-type', 'application/json');
      if (incoming.headers['x-myagents-internal-cli-token'] !== 'integration-internal-capability'
        || incoming.headers['x-myagents-sidecar-generation'] !== '17') {
        outgoing.writeHead(401).end(JSON.stringify({ ok: false }));
      } else if (incoming.url === '/api/external-cli/admit') {
        outgoing.end(JSON.stringify({ ok: true, allowed: enabled && body.token === 'integration-external-token',
          code: enabled ? 'external_cli_token_invalid' : 'external_cli_disabled' }));
      } else if (incoming.url === '/api/agent-network/cli') {
        outgoing.end(JSON.stringify(nativeResult));
      } else outgoing.writeHead(404).end(JSON.stringify({ ok: false }));
    } catch { outgoing.writeHead(500).end(JSON.stringify({ ok: false })); }
  });
  await new Promise<void>(resolve => management.listen(0, '127.0.0.1', resolve));
  const address = management.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback management address');
  vi.stubEnv('MYAGENTS_MANAGEMENT_PORT', String(address.port));
  vi.stubEnv('MYAGENTS_SIDECAR_GENERATION', '17');
  vi.stubEnv('MYAGENTS_SIDECAR_ID', '__global__');
  vi.stubEnv('MYAGENTS_INTERNAL_CLI_TOKEN', 'integration-internal-capability');
  vi.resetModules();
  ({ admitAdminRequest, isAdminAdmissionFailure } = await import('./external-cli-admission'));
  ({ handleNetworkCli } = await import('./network-cli'));
});
beforeEach(() => {
  calls.length = 0;
  enabled = true;
  nativeResult = { ok: true, data: { revision: 4, connections: [], loginAttempts: [] } };
});
afterAll(async () => {
  if (management) await new Promise<void>((resolve, reject) => management.close(error => error ? reject(error) : resolve()));
  vi.unstubAllEnvs();
  vi.resetModules();
});

function dispatch(role: 'global' | 'session', action: string, payload: unknown, token: string | null = 'integration-external-token', sessionId?: string) {
  // Exercise the same production gates in their real order without booting an
  // App, SessionEngine or user profile just to serve this common control lane.
  const handler = composeSidecarRequestHandler(resolveSidecarComposition(role, false), async incoming => {
    const route = new URL(incoming.url).pathname.slice('/api/admin/'.length);
    const admission = await admitAdminRequest(incoming, route);
    if (isAdminAdmissionFailure(admission)) return Response.json(admission.response, { status: admission.status });
    const scopeError = cliSessionScopeError(incoming.headers.get(CLI_SESSION_HEADER), undefined);
    if (scopeError) return Response.json(scopeError, { status: 409 });
    const result = await handleNetworkCli(route.slice('network/'.length), await incoming.json(), incoming.signal);
    return Response.json(result, { status: result.success ? 200 : 400 });
  });
  return handler(new Request(`http://127.0.0.1:31415/api/admin/network/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(sessionId ? { [CLI_SESSION_HEADER]: sessionId } : {}),
    }, body: JSON.stringify(payload),
  }));
}

describe.each(['global', 'session'] as const)('%s network CLI control chain', role => {
  it.each(actions)('%s reaches native authority after classification and real external admission', async (action, payload) => {
    const response = await dispatch(role, action, payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: nativeResult.data });
    expect(calls.map(call => call.path)).toEqual(['/api/external-cli/admit', '/api/agent-network/cli']);
    expect(calls[0].body).toEqual({ sidecarId: '__global__', token: 'integration-external-token' });
    expect(calls[1].body).toEqual({ sidecarId: '__global__', action, ...payload });
    for (const call of calls) {
      expect(call.headers['x-myagents-internal-cli-token']).toBe('integration-internal-capability');
      expect(call.headers['x-myagents-sidecar-generation']).toBe('17');
    }
  });

  it('normalizes macOS uuidgen output through the real forwarding chain', async () => {
    const response = await dispatch(role, 'restore', {
      connectionId: 'saved', expectedRevision: 4, operationId: operationId.toUpperCase(),
    });
    expect(response.status).toBe(200);
    expect(calls[1].body).toEqual({ sidecarId: '__global__', action: 'restore',
      connectionId: 'saved', expectedRevision: 4, operationId });
  });

  it('rejects unknown network actions before admission or native work', async () => {
    for (const action of ['create', 'login/future', 'restore-extra']) {
      expect((await dispatch(role, action, {})).status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it('reaches credential admission and rejects a missing external token', async () => {
    const response = await dispatch(role, 'status', {}, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'EXTERNAL_CLI_TOKEN_REQUIRED' });
    expect(calls).toEqual([]);
  });

  it('respects disabled external access before network mutation', async () => {
    enabled = false;
    const response = await dispatch(role, 'login', { connectionId: 'saved', expectedRevision: 4 });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'EXTERNAL_CLI_DISABLED' });
    expect(calls.map(call => call.path)).toEqual(['/api/external-cli/admit']);
  });

  it('respects external token invalidation before network mutation', async () => {
    const response = await dispatch(role, 'cancel', { attemptId: operationId }, 'expired-external-token');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'EXTERNAL_CLI_TOKEN_INVALID' });
    expect(calls.map(call => call.path)).toEqual(['/api/external-cli/admit']);
  });

  it('preserves the real CLI Session scope gate before native work', async () => {
    const response = await dispatch(role, 'status', {}, 'integration-external-token', 'other-session');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CLI_SESSION_SCOPE_MISMATCH' });
    expect(calls.map(call => call.path)).toEqual(['/api/external-cli/admit']);
  });

  it('rejects credential and caller identity injection at the real adapter', async () => {
    const response = await dispatch(role, 'login', { connectionId: 'saved', expectedRevision: 4, token: 'injected', sidecarId: 'forged' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'ARGUMENT_INVALID' });
    expect(calls.map(call => call.path)).toEqual(['/api/external-cli/admit']);
  });

  it('preserves the native code without forwarding diagnostics or retrying', async () => {
    nativeResult = { ok: false, error: { code: 'REVISION_CONFLICT', retryable: false, details: 'private-native-diagnostics' } };
    const response = await dispatch(role, 'restore', { connectionId: 'saved', expectedRevision: 3, operationId });
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result).toMatchObject({ success: false, code: 'REVISION_CONFLICT' });
    expect(JSON.stringify(result)).not.toContain('private-native-diagnostics');
    expect(calls.map(call => call.path)).toEqual(['/api/external-cli/admit', '/api/agent-network/cli']);
  });
});
