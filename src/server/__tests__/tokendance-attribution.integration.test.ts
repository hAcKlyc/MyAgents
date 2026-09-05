import { createServer, type Server } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TOKENDANCE_APP_URL } from '../../shared/tokendance';
import { buildClaudeSessionEnv } from '../agent-session';
import { createBridgeHandler } from '../openai-bridge/handler';
import { probeAnthropicProviderDirect } from '../provider-probe';

const scratch = vi.hoisted(() => ({
  directory: `/tmp/myagents-td-attribution-${process.pid}-${Date.now()}`,
}));
vi.mock('../utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/platform')>()),
  getHomeDirOrNull: () => scratch.directory,
}));
beforeAll(() => mkdirSync(`${scratch.directory}/.myagents`, { recursive: true }));
afterAll(() => rmSync(scratch.directory, { recursive: true, force: true }));

describe('Token Dance fixed request attribution', () => {
  let server: Server | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  it('replaces duplicate attribution only in the Token Dance child environment and leaves concurrent providers untouched', () => {
    const inherited = 'X-Trace: keep\r\nx-app-url: https://other.example\r\nX-App-URL: https://stale.example';
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', inherited);
    const td = buildClaudeSessionEnv({
      providerId: 'tokendance', baseUrl: 'https://tokendance.space/gateway',
      apiKey: 'fixture', authType: 'api_key', apiProtocol: 'anthropic',
    }, 'deepseek-v4-pro-0813');
    expect(td.ANTHROPIC_CUSTOM_HEADERS).toBe(`X-Trace: keep\nX-App-URL: ${TOKENDANCE_APP_URL}`);
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(inherited);
    const other = buildClaudeSessionEnv({
      providerId: 'other-provider', baseUrl: 'https://other.example',
      apiKey: 'fixture', authType: 'api_key',
    }, 'other-model');
    expect(other.ANTHROPIC_CUSTOM_HEADERS).toBe(inherited);
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', undefined);
    expect(buildClaudeSessionEnv({ providerId: 'anthropic-sub' }).ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(td.ANTHROPIC_CUSTOM_HEADERS).toContain('X-App-URL: https://myagents.io');
  });

  it('attributes the independent Anthropic verification diagnostic while keeping other diagnostics unchanged', async () => {
    const captured: Array<{ url?: string; app?: string }> = [];
    server = createServer((req, res) => {
      req.resume();
      captured.push({ url: req.url, app: req.headers['x-app-url'] as string | undefined });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'diagnostic fixture' } }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    await Promise.all(['tokendance', 'other-provider'].map(providerId => probeAnthropicProviderDirect({
      providerEnv: { providerId, baseUrl: `http://127.0.0.1:${address.port}/gateway`, apiKey: 'fixture', authType: 'api_key' },
      model: 'fixture', getProxyForProviderUrl: () => undefined,
    })));
    expect(captured).toHaveLength(2);
    expect(captured.map(item => item.app)).toEqual(expect.arrayContaining([TOKENDANCE_APP_URL, undefined]));
    expect(captured.every(item => item.url === '/gateway/v1/messages')).toBe(true);
  });

  it.each(['chat_completions', 'responses'] as const)('sends fixed attribution over %s and ignores the caller header for other providers', async (upstreamFormat) => {
    const captured: Array<{ url?: string; app?: string; authorization?: string }> = [];
    server = createServer((req, res) => {
      req.resume();
      captured.push({ url: req.url, app: req.headers['x-app-url'] as string | undefined, authorization: req.headers.authorization });
      // The wire contract is the subject; no model output fixture is needed.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture response' } }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    const invoke = async (providerId: string) => {
      const handler = createBridgeHandler({
        getUpstreamConfig: () => ({
          providerId, baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: 'fixture', upstreamFormat,
        }), logger: null,
      });
      const response = await handler(new Request('http://127.0.0.1/bridge/fixture/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-App-URL': 'https://wrong.example' },
        body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 }),
      }));
      await response.text();
    };
    await Promise.all([invoke('tokendance'), invoke('other-provider')]);
    expect(captured).toHaveLength(2);
    expect(captured.map(item => item.app)).toEqual(expect.arrayContaining([TOKENDANCE_APP_URL, undefined]));
    for (const item of captured) {
      expect(item.url).toBe(upstreamFormat === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      expect(item.authorization).toBe('Bearer fixture');
    }
  });
});
