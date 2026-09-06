import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import {
  materializeProviderRouteEnv,
  resolveImProviderRouting,
  type AdminAppConfig,
} from '../utils/admin-config';
import { providerEnvEqual } from '../builtin-session/config';

const scratch = vi.hoisted(() => ({
  home: `/tmp/myagents-td-route-${process.pid}-${Date.now()}`,
}));
vi.mock('../utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/platform')>()),
  getHomeDirOrNull: () => scratch.home,
}));
beforeAll(() => mkdirSync(`${scratch.home}/.myagents`, { recursive: true }));
afterAll(() => rmSync(scratch.home, { recursive: true, force: true }));

const config: AdminAppConfig = {
  providerApiKeys: { tokendance: 'test-credential-only' },
  presetCustomModels: {
    tokendance: [
      {
        model: 'added-later',
        modelName: 'Added later',
        modelSeries: 'test',
        source: 'manual',
        supportedProtocols: ['openai:chat-completions', 'openai:responses'],
      },
    ],
  },
};

describe('Token Dance execution projections', () => {
  it('keeps simultaneous model routes independent and triggers the existing transport-change comparison', () => {
    const resolve = (model: string) =>
      materializeProviderRouteEnv(
        { kind: 'provider', providerId: 'tokendance', model },
        config,
      )!;
    const anthropic = resolve('deepseek-v4-pro-0813');
    const responses = resolve('qwen3.8-max-0902');
    const chat = resolve('kimi-k3');
    expect(anthropic.apiProtocol).toBe('anthropic');
    expect(responses).toMatchObject({
      apiProtocol: 'openai',
      upstreamFormat: 'responses',
      baseUrl: 'https://tokendance.space/gateway/v1',
    });
    expect(chat.upstreamFormat).toBe('chat_completions');
    expect(providerEnvEqual(anthropic, responses)).toBe(false);
    expect(providerEnvEqual(chat, responses)).toBe(false);
    expect(resolve('deepseek-v4-pro-0813')).toEqual(anthropic);
    expect(resolve('added-later').upstreamFormat).toBe('responses');
  });

  it('materializes IM channel model overrides through the same priority policy', () => {
    const withAgent = {
      ...config,
      agents: [
        {
          id: 'td-test',
          name: 'Token Dance test',
          enabled: true,
          workspacePath: '/tmp/myagents-tokendance-routing',
          providerId: 'tokendance',
          model: 'deepseek-v4-pro-0813',
          channels: [
            {
              id: 'test-channel',
              type: 'telegram',
              enabled: true,
              overrides: { model: 'added-later' },
            },
          ],
        },
      ],
    } as AdminAppConfig;
    const result = resolveImProviderRouting(
      '/tmp/myagents-tokendance-routing',
      'test-channel',
      { config: withAgent },
    );
    expect(result.kind).toBe('provider-route');
    if (result.kind === 'provider-route') {
      expect(result.providerEnv?.upstreamFormat).toBe('responses');
      expect(result.providerRoute.model).toBe('added-later');
    }
  });
});
