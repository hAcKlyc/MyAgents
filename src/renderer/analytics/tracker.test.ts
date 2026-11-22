import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
}));

vi.mock('@/utils/browserMock', () => ({
  isTauriEnvironment: () => false,
}));

vi.mock('./config', () => ({
  isAnalyticsEnabled: () => true,
  getApiKey: () => 'key',
  getEndpoint: () => 'https://analytics.example.test/events',
}));

vi.mock('./device', () => ({
  getDeviceId: () => 'device-1',
  getPlatform: () => 'darwin-aarch64',
  getAppVersionSync: () => '0.2.36-test',
  preloadAppVersion: vi.fn(async () => undefined),
  preloadPlatform: vi.fn(async () => undefined),
  preloadDeviceId: vi.fn(async () => undefined),
}));

vi.mock('./queue', () => ({
  enqueue: mocks.enqueue,
  flush: vi.fn(async () => undefined),
  flushSync: vi.fn(),
}));

import { clearAnalyticsContext, setAnalyticsContext, track } from './tracker';

describe('analytics tracker active context', () => {
  afterEach(() => {
    clearAnalyticsContext();
    mocks.enqueue.mockClear();
  });

  it('injects session_id only for session-scoped events and tab_id for all events', () => {
    setAnalyticsContext({ sessionId: 'session-active', tabId: 'tab-active' });

    track('message_send', {
      runtime: 'builtin',
      mode: 'auto',
      model: 'claude',
      skill: false,
      has_image: false,
      has_file: false,
      is_cron: false,
    });
    track('workspace_open', {
      surface: 'global_sidebar',
      agent_hash: null,
      runtime: 'builtin',
      entry_intent: 'open_workspace',
      has_initial_message: false,
      session_id: null,
    });

    expect(mocks.enqueue).toHaveBeenNthCalledWith(1, expect.objectContaining({
      event: 'message_send',
      params: expect.objectContaining({
        session_id: 'session-active',
        tab_id: 'tab-active',
      }),
    }));
    expect(mocks.enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event: 'workspace_open',
      params: expect.objectContaining({
        session_id: null,
        tab_id: 'tab-active',
        surface: 'global_sidebar',
      }),
    }));
  });

  it.each([
    ['tool_use', 'printf SYNTHETIC_PRIVATE_MARKER', 'Tool'],
    ['permission_grant', 'File /private/SYNTHETIC_PRIVATE_MARKER', 'Tool'],
    ['permission_deny', 'mcp__private_server__private_tool', 'MCP'],
    ['tool_use', 'Bash', 'Bash'],
  ])('transmits only the Antigravity tool category for %s', (event, tool, expected) => {
    track(event, { runtime: 'antigravity', tool });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      event,
      params: { runtime: 'antigravity', tool: expected },
    }));
  });

  it('preserves the explicit target session id on history_open', () => {
    setAnalyticsContext({ sessionId: 'session-active', tabId: 'tab-active' });

    track('history_open', {
      session_id: 'session-target',
      agent_hash: 'agent-hash',
      runtime: 'codex',
      runtime_source: 'system-cli',
      entry_source: 'chat_dropdown',
      origin_kind: 'desktop',
      origin_surface: 'new_chat_button',
    });

    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      event: 'history_open',
      params: expect.objectContaining({
        session_id: 'session-target',
        tab_id: 'tab-active',
        entry_source: 'chat_dropdown',
      }),
    }));
  });

});
