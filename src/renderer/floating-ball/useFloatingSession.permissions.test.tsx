import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseEventHandler } from '@/api/SseConnection';
import { localDate } from '../../shared/logTime';
import { useFloatingSession } from './useFloatingSession';

const harness = vi.hoisted(() => ({ handler: null as SseEventHandler | null, fetch: vi.fn(), config: vi.fn() }));
vi.mock('@/api/SseConnection', () => ({ createSseConnection: () => ({
  setEventHandler: (handler: SseEventHandler) => { harness.handler = handler; },
  connect: async () => {}, disconnect: async () => {}, getConnectionGeneration: () => 1,
}) }));
vi.mock('@/api/tauriClient', () => ({
  ensureSessionSidecar: async () => ({ isNew: false }), getSessionPort: async () => 1234,
  sessionSidecarFetch: (...args: unknown[]) => harness.fetch(...args), releaseSessionSidecar: async () => false,
}));
vi.mock('@/config/services/appConfigService', () => ({ loadAppConfig: () => harness.config(), atomicModifyConfig: vi.fn() }));
vi.mock('@/config/services/projectService', () => ({ loadProjects: async () => [{ id: 'workspace', path: '/tmp/companion-test', name: 'Test' }] }));
vi.mock('@/context/useTranscriptSaveToast', () => ({ useTranscriptSaveToast: () => vi.fn() }));
vi.mock('@/analytics', () => ({ initAnalytics: vi.fn(), setAnalyticsContext: vi.fn(), track: vi.fn() }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
const response = (body: unknown) => new Response(JSON.stringify(body));
const permission = (requestId: string) => ({
  requestId, sessionId: 'companion-test', toolName: 'Bash', input: '{}',
  defaultToNo: true, suppressAlwaysAllowRule: true,
  permissionOptions: [{ optionId: 'exact-command', name: 'Allow this command', kind: 'allow_once' as const }],
});

describe('Companion permission request projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.handler = null;
    harness.config.mockResolvedValue({ floatingBallSessionId: 'companion-test', floatingBallSessionDate: localDate(), floatingBallSessionWorkspace: '/tmp/companion-test', defaultWorkspacePath: '/tmp/companion-test' });
  });
  it.each(['live', 'restore'] as const)('preserves both constraints through %s delivery', async delivery => {
    harness.fetch.mockImplementation(async (_sid, _owner, path) => {
      if (path === '/api/permission/respond') return response({ success: true });
      if (path.startsWith('/sessions/')) return response({ success: true, session: {
        id: 'companion-test', messages: [], transcriptFormat: 2, snapshotRevision: 0,
        pendingInteractiveRequests: delivery === 'restore'
          ? [{ type: 'permission:request', data: permission('p1') }] : [],
      } });
      throw new Error(`Unexpected route: ${path}`);
    });
    const { result } = renderHook(() => useFloatingSession({ current: 'pin' }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    if (delivery === 'live') act(() => harness.handler!('permission:request', permission('p1'), { sessionId: 'companion-test', connectionGeneration: 1 }));
    await waitFor(() => expect(result.current.permReq).toMatchObject(permission('p1')));
    await act(async () => { await result.current.respondPermission('allow_once', 'p1', 'exact-command'); });
    const posted = harness.fetch.mock.calls.find((args) => args[2] === '/api/permission/respond');
    expect(JSON.parse(posted?.[3]?.body)).toEqual({ requestId: 'p1', decision: 'allow_once', optionId: 'exact-command' });
    expect(result.current.permReq).toBeNull();
  });
});
