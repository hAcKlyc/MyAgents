import { describe, expect, it, vi } from 'vitest';
import { EXTERNAL_CLI_PUBLIC_CAPABILITIES } from '../shared/externalCliCapabilities';
import { hasValidInternalCliCredential } from './external-cli-admission';
import {
  classifySidecarRequest,
  composeSidecarRequestHandler,
  resolveSidecarComposition,
  runSidecarBootstrap,
  type SidecarCapability,
} from './sidecar-composition';

function request(path: string, method = 'GET'): Request {
  return new Request(`http://127.0.0.1:31415${path}`, { method });
}

describe('Sidecar production composition', () => {
  it.each(['global', 'session'] as const)('%s reaches update lifecycle credential admission', async role => {
    const control = request('/api/process/update-quiesce', 'POST');
    const credentialGate = vi.fn(async (incoming: Request) =>
      Response.json({ success: false, error: hasValidInternalCliCredential(incoming)
        ? 'UPDATE_ACTIVITY_UNKNOWN' : 'INTERNAL_CALLER_REQUIRED' }, { status: 401 }));
    const dispatch = composeSidecarRequestHandler(resolveSidecarComposition(role, false), credentialGate);
    expect(classifySidecarRequest(control)).toBe('common');
    const response = await dispatch(control);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: 'INTERNAL_CALLER_REQUIRED' });
    expect(credentialGate).toHaveBeenCalledExactlyOnceWith(control);
    credentialGate.mockClear();
    expect((await dispatch(request('/api/process/update-quiesce/other', 'POST'))).status).toBe(404);
    expect(credentialGate).not.toHaveBeenCalled();
  });
  it('keeps omitted role fail-safe Session and requires an explicit development union', () => {
    expect([...resolveSidecarComposition(null, false).capabilities]).toEqual(['common', 'session']);
    expect([...resolveSidecarComposition(null, true).capabilities]).toEqual(['common', 'global', 'session']);
    expect(() => resolveSidecarComposition('global', true)).toThrow(
      '--dev-union cannot be combined with --sidecar-role',
    );
  });

  it.each(EXTERNAL_CLI_PUBLIC_CAPABILITIES)(
    'Global dispatches the public $command route before external caller admission', async ({ route }) => {
      const cliRequest = request(`/api/admin/${route}`, 'POST');
      const admission = vi.fn(async () => Response.json({
        success: false, code: 'EXTERNAL_CLI_TOKEN_REQUIRED',
      }, { status: 401 }));

      const response = await composeSidecarRequestHandler(
        resolveSidecarComposition('global', false), admission,
      )(cliRequest);

      expect(classifySidecarRequest(cliRequest)).toBe('common');
      expect(response.status).toBe(401);
      expect(admission).toHaveBeenCalledExactlyOnceWith(cliRequest);
    },
  );

  it.each([
    ['GET', '/health', 'common'],
    ['GET', '/refs/12345678', 'common'],
    ['POST', '/api/provider/verify', 'global'],
    ['POST', '/api/cliproxy/control', 'common'],
    ['POST', '/api/process/graceful-shutdown', 'global'],
    ['POST', '/api/process/update-quiesce', 'common'],
    ['POST', '/api/browser/session/retire', 'global'],
    ['POST', '/api/mcp/oauth/discover', 'global'],
    ['POST', '/mcp/playwright', 'global'],
    ['GET', '/api/runtime/models?type=codex', 'common'],
    ['GET', '/api/runtime/permission-modes?type=codex', 'common'],
    ['GET', '/api/runtime/type', 'session'],
    ['GET', '/sessions', 'global'],
    ['POST', '/sessions', 'global'],
    ['POST', '/api/session/birth', 'session'],
    ['POST', '/api/internal/session/text-page', 'session'],
    ['POST', '/api/session-watch/register', 'session'],
    ['POST', '/api/session-watch/manage', 'session'],
    ['POST', '/api/session-watch/network-remove', 'session'],
    ['GET', '/api/session-tags', 'global'],
    ['POST', '/api/session-tags/assign', 'global'],
    ['POST', '/api/session-tags/manage', 'global'],
    ['GET', '/sessions/session-1', 'common'],
    ['PATCH', '/sessions/session-1', 'common'],
    ['POST', '/chat/send', 'session'],
    ['POST', '/cron/execute-sync', 'session'],
    ['POST', '/goal/execute-sync', 'session'],
    ['POST', '/api/im/enqueue', 'session'],
    ['GET', '/api/im/model-options', 'common'],
    ['POST', '/api/im/model-options', 'common'],
    ['POST', '/api/im/model-selection', 'session'],
    ['POST', '/api/inbox/drain', 'session'],
    ['POST', '/api/runtime/config', 'session'],
    ['POST', '/api/admin/session/send', 'common'],
    ['POST', '/api/admin/session/get', 'common'],
    ['POST', '/api/admin/session/state', 'common'],
    ['POST', '/api/admin/goal/update', 'session'],
    ['POST', '/api/admin/task/create-attached', 'session'],
    ['POST', '/api/admin/status', 'common'],
    ['POST', '/api/admin/anydoc/convert', 'common'],
    ['POST', '/api/admin/anydoc/status', 'common'],
    ['POST', '/api/admin/reload', 'session'],
    ['POST', '/api/admin/task/run', 'common'],
    ['POST', '/api/admin/mcp/remove', 'common'],
    ['POST', '/api/cc-plugin/session-enable', 'session'],
    ['GET', '/api/cc-plugin/list', 'common'],
    ['GET', '/api/project-capabilities', 'common'],
    ['POST', '/api/project-capability/toggle', 'common'],
  ] as const)('%s %s is owned by %s', (method, path, capability) => {
    expect(classifySidecarRequest(request(path, method))).toBe(capability);
  });

  it.each(['session', 'development-union'] as const)(
    '%s dispatches the Rust-delegated live transcript read to its Session owner', async role => {
      const composition = role === 'development-union'
        ? resolveSidecarComposition(null, true)
        : resolveSidecarComposition(role, false);
      const ownerRead = request('/api/internal/session/text-page', 'POST');
      const realHandler = vi.fn(async () => Response.json({ success: true, session: { id: 'target' } }));

      const response = await composeSidecarRequestHandler(composition, realHandler)(ownerRead);

      expect(classifySidecarRequest(ownerRead)).toBe('session');
      expect(response.status).toBe(200);
      expect(realHandler).toHaveBeenCalledExactlyOnceWith(ownerRead);
    },
  );

  it('keeps delegated transcript reads out of Global and unknown internal endpoints unowned', async () => {
    const realHandler = vi.fn(async () => Response.json({ success: true }));
    const response = await composeSidecarRequestHandler(
      resolveSidecarComposition('global', false), realHandler,
    )(request('/api/internal/session/text-page', 'POST'));

    expect(response.status).toBe(404);
    expect(realHandler).not.toHaveBeenCalled();
    expect(classifySidecarRequest(request('/api/internal/session/future-owner', 'POST'))).toBeNull();
  });

  it('does not grant unknown control routes a default capability', () => {
    expect(classifySidecarRequest(request('/api/admin/future-owner', 'POST'))).toBeNull();
    expect(classifySidecarRequest(request('/api/future-owner', 'POST'))).toBeNull();
  });

  it.each(['global', 'session'] as const)('%s admits canonical Record commands and proxy propagation', async role => {
    for (const path of [
      '/api/admin/record/list',
      '/api/admin/record/create',
      '/api/admin/thought/list',
      '/api/admin/thought/create',
      '/api/proxy/set',
    ]) {
      const downstream = vi.fn(async () => Response.json({ success: true, data: [] }));
      const response = await composeSidecarRequestHandler(
        resolveSidecarComposition(role, false), downstream,
      )(request(path, 'POST'));
      expect(response.status, path).toBe(200);
      expect(downstream, path).toHaveBeenCalledOnce();
      expect(await response.json()).toEqual({ success: true, data: [] });
    }
  });
  describe.each(['global', 'session', 'development-union'] as const)(
    '%s Record CLI admission',
    (role) => {
      it.each([
        ['record', 'list'],
        ['record', 'create'],
        ['thought', 'list'],
        ['thought', 'create'],
      ] as const)('dispatches %s/%s through the common management surface', async (group, action) => {
        const realHandler = vi.fn(async () => Response.json({ success: true }));
        const composition = role === 'development-union'
          ? resolveSidecarComposition(null, true)
          : resolveSidecarComposition(role, false);
        const cliRequest = request(`/api/admin/${group}/${action}`, 'POST');

        const response = await composeSidecarRequestHandler(composition, realHandler)(cliRequest);

        expect(response.status).toBe(200);
        expect(classifySidecarRequest(cliRequest)).toBe('common');
        expect(realHandler).toHaveBeenCalledExactlyOnceWith(cliRequest);
      });
    },
  );

  it('routes one-shot Grok verification through the Global provider owner', async () => {
    const grokVerification = request('/api/grok/verify', 'POST');
    expect(classifySidecarRequest(grokVerification)).toBe('global');

    const globalHandler = vi.fn(async () => new Response('verified', { status: 202 }));
    const globalResponse = await composeSidecarRequestHandler(
      resolveSidecarComposition('global', false),
      globalHandler,
    )(grokVerification);
    expect(globalResponse.status).toBe(202);
    expect(globalHandler).toHaveBeenCalledOnce();

    const sessionHandler = vi.fn(async () => new Response('wrong owner'));
    const sessionResponse = await composeSidecarRequestHandler(
      resolveSidecarComposition('session', false),
      sessionHandler,
    )(request('/api/grok/verify', 'POST'));
    expect(sessionResponse.status).toBe(404);
    expect(sessionHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['global', 'POST', '/chat/send'],
    ['global', 'POST', '/api/session/birth'],
    ['session', 'POST', '/sessions'],
    ['global', 'POST', '/cron/execute-sync'],
    ['global', 'POST', '/goal/execute-sync'],
    ['global', 'POST', '/api/im/enqueue'],
    ['global', 'POST', '/api/inbox/drain'],
    ['global', 'GET', '/api/session-state'],
    ['global', 'POST', '/api/admin/session/watch'],
    ['global', 'POST', '/api/admin/session/watches'],
    ['global', 'POST', '/api/admin/session/unwatch'],
    ['session', 'POST', '/api/provider/verify'],
    ['session', 'POST', '/api/cliproxy/verify'],
    ['session', 'POST', '/api/mcp/oauth/start'],
    ['session', 'POST', '/mcp/playwright'],
    ['session', 'POST', '/api/browser/session/retire'],
    ['session', 'DELETE', '/sessions/session-1'],
  ] as const)('%s rejects wrong-role %s %s before the real handler', async (role, method, path) => {
    const realHandler = vi.fn(async () => new Response('handled'));
    const handler = composeSidecarRequestHandler(
      resolveSidecarComposition(role, false),
      realHandler,
    );

    const response = await handler(request(path, method));

    expect(response.status).toBe(404);
    expect(realHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['global', 'POST', '/api/provider/verify'],
    ['global', 'POST', '/api/cliproxy/control'],
    ['session', 'POST', '/api/cliproxy/control'],
    ['global', 'POST', '/api/mcp/oauth/start'],
    ['global', 'POST', '/mcp/playwright'],
    ['global', 'POST', '/api/browser/session/retire'],
    ['session', 'POST', '/chat/send'],
    ['session', 'POST', '/api/session/birth'],
    ['session', 'PATCH', '/sessions/session-1'],
    ['global', 'PATCH', '/sessions/session-1'],
    ['session', 'POST', '/cron/execute-sync'],
    ['session', 'POST', '/goal/execute-sync'],
    ['session', 'POST', '/api/im/enqueue'],
    ['session', 'POST', '/api/inbox/drain'],
  ] as const)('%s dispatches real-role %s %s', async (role, method, path) => {
    const realHandler = vi.fn(async () => new Response('handled', { status: 202 }));
    const handler = composeSidecarRequestHandler(
      resolveSidecarComposition(role, false),
      realHandler,
    );

    const response = await handler(request(path, method));

    expect(response.status).toBe(202);
    expect(realHandler).toHaveBeenCalledOnce();
  });

  it('runs common plus only the selected production boot capability', async () => {
    const calls: SidecarCapability[] = [];
    const steps = (['common', 'global', 'session'] as const).map(capability => ({
      capability,
      run: () => { calls.push(capability); },
    }));

    await runSidecarBootstrap(resolveSidecarComposition('global', false), steps);
    expect(calls).toEqual(['common', 'global']);

    calls.length = 0;
    await runSidecarBootstrap(resolveSidecarComposition('session', false), steps);
    expect(calls).toEqual(['common', 'session']);
  });

  it('runs both production capability groups only in the explicit dev harness', async () => {
    const calls: SidecarCapability[] = [];
    await runSidecarBootstrap(resolveSidecarComposition(null, true), [
      { capability: 'common', run: () => { calls.push('common'); } },
      { capability: 'global', run: () => { calls.push('global'); } },
      { capability: 'session', run: () => { calls.push('session'); } },
    ]);
    expect(calls).toEqual(['common', 'global', 'session']);
  });
});
