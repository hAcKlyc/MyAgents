import { describe, expect, it, vi } from 'vitest';

import {
  credentialProvisioningRequiresRestart,
  hasProvisionedCredentials,
  restartProvisionedChannelIfRunning,
  runCredentialQrProvisioning,
  type CredentialQrPollResult,
  type CredentialQrStartResult,
} from './credentialQrProvisioning';

describe('credential QR provisioning', () => {
  it('checks the promoted plugin required fields instead of provider-specific names', () => {
    expect(hasProvisionedCredentials(['appId', 'appSecret'], {
      appId: 'cli_test',
      appSecret: 'secret',
      domain: 'feishu',
    })).toBe(true);
    expect(hasProvisionedCredentials(['appId', 'appSecret'], { appId: 'cli_test' })).toBe(false);
  });

  it('returns normalized credentials and carries the switched registration domain', async () => {
    const start: CredentialQrStartResult = {
      sessionKey: 'device-code',
      qrUrl: 'https://accounts.feishu.cn/oauth/device?code=abc',
      sessionDomain: 'feishu',
      pollIntervalMs: 1,
      expiresInMs: 1_000,
    };
    const waiting: CredentialQrPollResult = {
      status: 'waiting',
      sessionDomain: 'lark',
      nextPollIntervalMs: 6,
    };
    const success: CredentialQrPollResult = {
      status: 'success',
      sessionDomain: 'lark',
      configValues: { appId: 'cli_app', appSecret: 'secret', domain: 'lark' },
      allowedUserId: 'ou_scanner',
    };
    const invoke = vi.fn()
      .mockResolvedValueOnce(start)
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce(success);
    const onQrUrl = vi.fn();

    const result = await runCredentialQrProvisioning({
      provider: 'feishu',
      invoke,
      isCancelled: () => false,
      onPhase: vi.fn(),
      onQrUrl,
      delay: async () => undefined,
    });

    expect(result).toEqual({ kind: 'success', result: success, refreshCount: 0 });
    expect(onQrUrl).toHaveBeenCalledWith(start.qrUrl, 0);
    expect(invoke).toHaveBeenNthCalledWith(3, 'cmd_channel_credential_qr_poll', expect.objectContaining({
      provider: 'feishu',
      sessionDomain: 'lark',
      pollIntervalMs: 6,
    }));
  });

  it('refreshes an expired QR with a new provider session', async () => {
    const start = (key: string): CredentialQrStartResult => ({
      sessionKey: key,
      qrUrl: `https://work.weixin.qq.com/qr/${key}`,
      pollIntervalMs: 1,
      expiresInMs: 1_000,
    });
    const invoke = vi.fn()
      .mockResolvedValueOnce(start('first'))
      .mockResolvedValueOnce({ status: 'expired' } satisfies CredentialQrPollResult)
      .mockResolvedValueOnce(start('second'))
      .mockResolvedValueOnce({
        status: 'success',
        configValues: { botId: 'bot', secret: 'secret' },
      } satisfies CredentialQrPollResult);
    const phases: Array<[string, number]> = [];

    const result = await runCredentialQrProvisioning({
      provider: 'wecom',
      invoke,
      isCancelled: () => false,
      onPhase: (phase, refreshCount) => phases.push([phase, refreshCount]),
      onQrUrl: vi.fn(),
      delay: async () => undefined,
    });

    expect(result.kind).toBe('success');
    expect(phases).toEqual([
      ['loading', 0], ['waiting', 0],
      ['loading', 1], ['waiting', 1],
    ]);
  });

  it('stops without another poll when the owning UI lifecycle is cancelled', async () => {
    let cancelled = false;
    const invoke = vi.fn().mockResolvedValueOnce({
      sessionKey: 'device-code',
      qrUrl: 'https://accounts.feishu.cn/oauth/device?code=abc',
      sessionDomain: 'feishu',
      pollIntervalMs: 1,
      expiresInMs: 1_000,
    } satisfies CredentialQrStartResult);

    const result = await runCredentialQrProvisioning({
      provider: 'feishu',
      invoke,
      isCancelled: () => cancelled,
      onPhase: vi.fn(),
      onQrUrl: () => { cancelled = true; },
      delay: async () => undefined,
    });

    expect(result.kind).toBe('cancelled');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('restarts only a freshly observed active Channel', async () => {
    expect(credentialProvisioningRequiresRestart({ status: 'online' })).toBe(true);
    expect(credentialProvisioningRequiresRestart({ status: 'connecting' })).toBe(true);
    expect(credentialProvisioningRequiresRestart({ status: 'stopped' })).toBe(false);
    expect(credentialProvisioningRequiresRestart(null)).toBe(false);

    const stopped = vi.fn(async () => undefined);
    const started = vi.fn(async () => undefined);
    await expect(restartProvisionedChannelIfRunning(
      { status: 'stopped' },
      stopped,
      started,
    )).resolves.toBe(false);
    expect(stopped).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();

    await expect(restartProvisionedChannelIfRunning(
      { status: 'online' },
      stopped,
      started,
    )).resolves.toBe(true);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('propagates a restart failure after credentials are provisioned', async () => {
    const restartError = new Error('restart failed');
    await expect(restartProvisionedChannelIfRunning(
      { status: 'connecting' },
      async () => undefined,
      async () => { throw restartError; },
    )).rejects.toBe(restartError);
  });
});


describe('QR failure stages and opaque sessions', () => {
  it.each(['start', 'poll'] as const)('distinguishes %s failure without assuming a network cause', async stage => {
    const invoke = vi.fn();
    if (stage === 'poll') invoke.mockResolvedValueOnce({
      sessionKey: 'code_with-dash', qrUrl: 'https://work.weixin.qq.com/qr/test',
      pollIntervalMs: 3_000, expiresInMs: 600_000,
    });
    invoke.mockRejectedValueOnce(new Error('Invalid QR provisioning session'));
    const delay = vi.fn(async () => undefined);
    const result = await runCredentialQrProvisioning({
      provider: 'wecom', invoke, isCancelled: () => false,
      onPhase: vi.fn(), onQrUrl: vi.fn(), delay,
    });
    expect(result).toMatchObject({ kind: 'error', reason: `${stage}-failed` });
    if (stage === 'poll') expect(delay).toHaveBeenCalledWith(3_000);
  });

  it('preserves the provider code through first poll and expiry refresh', async () => {
    const start = (sessionKey: string) => ({ sessionKey,
      qrUrl: 'https://work.weixin.qq.com/qr/test', pollIntervalMs: 3_000, expiresInMs: 600_000 });
    const invoke = vi.fn().mockResolvedValueOnce(start('old_code-1'))
      .mockResolvedValueOnce({ status: 'expired' })
      .mockResolvedValueOnce(start('new_code+/%=&2'))
      .mockResolvedValueOnce({ status: 'waiting' })
      .mockResolvedValueOnce({ status: 'success', configValues: { botId: 'bot', secret: 'fake-secret' } });
    const result = await runCredentialQrProvisioning({
      provider: 'wecom', invoke, isCancelled: () => false,
      onPhase: vi.fn(), onQrUrl: vi.fn(), delay: async () => undefined,
    });
    expect(result.kind).toBe('success');
    expect(invoke).toHaveBeenNthCalledWith(2, 'cmd_channel_credential_qr_poll', expect.objectContaining({ sessionKey: 'old_code-1' }));
    for (const call of [4, 5]) expect(invoke).toHaveBeenNthCalledWith(call, 'cmd_channel_credential_qr_poll', expect.objectContaining({ sessionKey: 'new_code+/%=&2' }));
  });
});
