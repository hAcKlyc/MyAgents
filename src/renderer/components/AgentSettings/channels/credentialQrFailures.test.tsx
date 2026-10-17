import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '../../../../shared/types/agent';
import ChannelDetailView from './ChannelDetailView';
import ChannelWizard from './ChannelWizard';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), persist: vi.fn(), failAt: 'poll', starts: 0 }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,dGVzdA==' } }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ config: { agents: [] }, refreshConfig: vi.fn() }) }));
vi.mock('@/config/services/agentConfigService', () => ({
  applyAgentChannelCredentialProvisioning: mocks.persist,
  channelHasCredentials: () => true,
  invokeStartAgentChannel: vi.fn(),
  patchAgentChannelConfig: vi.fn(),
  patchAgentChannelOpenClawConfig: vi.fn(),
  modifyAgentChannelConfig: mocks.persist,
  removeAgentChannelConfig: vi.fn(),
  startAndEnableAgentChannel: vi.fn(),
  stopAndDisableAgentChannel: vi.fn(),
}));
vi.mock('./credentialQrProvisioning', async importOriginal => {
  const actual = await importOriginal<typeof import('./credentialQrProvisioning')>();
  return { ...actual, runCredentialQrProvisioning: (options: Parameters<typeof actual.runCredentialQrProvisioning>[0]) =>
    actual.runCredentialQrProvisioning({ ...options, delay: async () => undefined }) };
});

const agent: AgentConfig = {
  id: 'agent-test', name: 'Agent', enabled: true, permissionMode: 'auto',
  channels: [{ id: 'channel-test', type: 'openclaw:wecom-openclaw-plugin', enabled: false,
    openclawPluginId: 'wecom-openclaw-plugin', openclawPluginConfig: { botId: 'existing-bot', secret: 'existing-secret' },
    allowedUsers: [] }],
};

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: mocks.invoke });
  mocks.persist.mockClear();
  mocks.starts = 0;
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'cmd_list_openclaw_plugins') return [{ pluginId: 'wecom-openclaw-plugin' }];
    if (command === 'cmd_channel_credential_qr_start') {
      mocks.starts += 1;
      if (mocks.failAt === 'start') throw new Error('failure with secret-session-code');
      return { sessionKey: 'code_with-dash', qrUrl: 'https://work.weixin.qq.com/qr/test', pollIntervalMs: 3_000, expiresInMs: 600_000 };
    }
    if (command === 'cmd_channel_credential_qr_poll') {
      if (mocks.failAt === 'after-refresh' && mocks.starts === 1) return { status: 'expired' };
      throw new Error('failure with secret-session-code');
    }
    return null;
  });
});

describe.each(['wizard', 'detail'] as const)('%s credential QR errors', surface => {
  it.each(['start', 'poll', 'after-refresh'])('shows the actual failure stage for %s', async failAt => {
    mocks.failAt = failAt;
    if (surface === 'wizard') {
      render(<ChannelWizard agent={agent} platform="openclaw:wecom-openclaw-plugin" onComplete={vi.fn()} onCancel={vi.fn()} />);
    } else {
      render(<ChannelDetailView agent={agent} channelId="channel-test" onBack={vi.fn()} onChanged={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /企业微信机器人凭证/ }));
      fireEvent.click(screen.getByRole('button', { name: '重新扫码' }));
    }
    expect(await screen.findByText(failAt === 'start' ? '获取二维码失败' : '查询扫码状态失败，请重新扫码')).toBeInTheDocument();
    if (failAt !== 'start') expect(screen.queryByText('获取二维码失败')).not.toBeInTheDocument();
    expect(screen.queryByText('二维码多次过期')).not.toBeInTheDocument();
    expect(screen.queryByText(/secret-session-code/)).not.toBeInTheDocument();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(agent.channels[0].openclawPluginConfig).toEqual({ botId: 'existing-bot', secret: 'existing-secret' });
  });
});
