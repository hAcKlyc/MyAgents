import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handler: undefined as undefined | ((req: unknown, res: unknown) => Promise<void>),
  close: vi.fn(), rpcCalls: [] as Array<{ method: string; params: Record<string, unknown> }>,
  spawns: [] as Array<{ args: string[]; options: Record<string, unknown> }>,
  config: {} as Record<string, unknown>, terminalStatus: 'completed', tool: false,
  requests: [] as Array<{ url: string; options: Record<string, unknown> }>,
  fetch: vi.fn(), realNetwork: false, deferListen: false, listenResolver: undefined as undefined | (() => void),
}));
vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: (...args: Parameters<typeof actual.fetch>) => mocks.realNetwork ? actual.fetch(...args) : mocks.fetch(...args) };
});
vi.mock('node:http', async importOriginal => {
 const actual = await importOriginal<typeof import('node:http')>();
 return { ...actual, createServer: vi.fn(handler => {
  if (mocks.realNetwork) return actual.createServer(handler);
  mocks.handler = handler;
  return { once: vi.fn(), listen: (_port: number, _host: string, callback: () => void) => { if (mocks.deferListen) mocks.listenResolver = callback; else callback(); },
    address: () => ({ port: 12345 }), closeAllConnections: vi.fn(), close: (callback: () => void) => { mocks.close(); callback(); } };
}) }; });
vi.mock('./codex-command-context', () => ({ resolveCodexCommandContext: vi.fn(async args => ({
  commandPath: '/verified/codex', source: args.source ?? 'system-cli', env: { CODEX_HOME: '/original/home' },
})) }));
vi.mock('../utils/subprocess', () => ({ spawn: vi.fn((args, options) => {
  mocks.spawns.push({ args, options });
  return { pid: mocks.spawns.length, exited: new Promise(() => {}), stderr: null, kill: vi.fn() };
}) }));
vi.mock('./utils/kill-with-escalation', () => ({ killWithEscalation: vi.fn(async () => ({ exited: true })) }));
vi.mock('node:fs/promises', () => ({ mkdtemp: vi.fn(async () => '/isolated/utility'), rm: vi.fn(async () => {}) }));
vi.mock('./codex', () => ({
  initializeCodexRpc: vi.fn(async () => {}),
  buildCodexAppServerLaunchConfig: vi.fn(args => ({ args: [args.commandPath, 'app-server'] })),
  JsonRpcClient: class {
    notification?: (method: string, params: unknown) => void;
    request?: (id: number) => void;
    setNotificationHandler(callback: (method: string, params: unknown) => void) { this.notification = callback; }
    setServerRequestHandler(callback: (id: number) => void) { this.request = callback; }
    respondError() {}
    async startReading() {}
    async call(method: string, params: Record<string, unknown>) {
      mocks.rpcCalls.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'config/read') return { config: mocks.config };
      if (method === 'thread/start') return { thread: { id: 'fresh-ephemeral-thread' } };
      if (method === 'turn/start') {
        const start = mocks.rpcCalls.find(call => call.method === 'thread/start')!;
        const config = start.params.config as Record<string, unknown>;
        const provider = Object.values(config)[0] as Record<string, unknown>;
        const base = (config.openai_base_url ?? provider.base_url) as string;
        await sendGateway(new URL(base).pathname + '/responses', { model: 'session-model', tools: [{ type: 'function', name: 'bash' }] });
        this.notification?.('item/agentMessage/delta', { delta: '继续验证' });
        if (mocks.tool) this.notification?.('item/started', { item: { type: 'commandExecution' } });
        this.notification?.('turn/completed', { turn: { status: mocks.terminalStatus } });
      }
      return {};
    }
  },
}));

import { createCodexUtilityGateway, generateCodexTextUtility, resolveCodexUtilityEndpoint, resolveCodexUtilityProxy, validateCodexUtilityResponse } from './codex-text-utility';

const completed = { id: 'response-fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '继续验证' }] }] };
const stream = (response = completed) => `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;
async function sendGateway(path: string, payload: unknown, headers: Record<string, string> = {}, raw?: string) {
  const res = { status: 0, body: '', headersSent: false, writeHead(code: number) { this.status = code; this.headersSent = true; }, end(body = '') { this.body = body; } };
  const req = { method: 'POST', url: path, headers: { authorization: 'Bearer fixture-native-owned', host: 'local', 'content-length': '99', ...headers }, async *[Symbol.asyncIterator]() { yield Buffer.from(raw ?? JSON.stringify(payload)); } };
  await mocks.handler!(req, res);
  return res;
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.rpcCalls = []; mocks.spawns = []; mocks.requests = []; mocks.config = {}; mocks.terminalStatus = 'completed'; mocks.tool = false; mocks.realNetwork = false; mocks.deferListen = false; mocks.listenResolver = undefined; });
function upstream(body = stream(), contentType = 'text/event-stream') {
  mocks.fetch = vi.fn(async (url, options) => { mocks.requests.push({ url, options }); return new Response(body, { status: 200, headers: { 'content-type': contentType } }); });
}

describe('Codex utility response admission', () => {
  it('accepts only successfully completed text and rejects tool/partial/unknown streams', () => {
    expect(validateCodexUtilityResponse(stream(), true)).toBe(true);
    expect(validateCodexUtilityResponse(JSON.stringify(completed), false)).toBe(true);
    expect(validateCodexUtilityResponse('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', true)).toBe(false);
    expect(validateCodexUtilityResponse(`data: {"type":"response.output_item.added","item":{"type":"function_call","name":"bash"}}\n\n${stream()}`, true)).toBe(false);
    expect(validateCodexUtilityResponse(`data: {"type":"response.surprise"}\n\n${stream()}`, true)).toBe(false);
    expect(validateCodexUtilityResponse(JSON.stringify({ ...completed, status: 'incomplete' }), false)).toBe(false);
  });
  it('resolves only original Responses identities and never guesses custom provider endpoints', () => {
    expect(resolveCodexUtilityEndpoint({}, { account: { type: 'chatgpt' } })).toEqual({ providerId: 'openai', endpoint: 'https://chatgpt.com/backend-api/codex/responses' });
    expect(resolveCodexUtilityEndpoint({ model_provider: 'private', model_providers: { private: { base_url: 'https://original.example/v1', wire_api: 'responses' } } }, {})).toEqual({ providerId: 'private', endpoint: 'https://original.example/v1/responses' });
    expect(resolveCodexUtilityEndpoint({ model_provider: 'myagents', model_providers: { myagents: { requires_openai_auth: true, wire_api: 'responses' } } }, { account: { type: 'chatgpt' } })).toEqual({ providerId: 'myagents', endpoint: 'https://chatgpt.com/backend-api/codex/responses' });
    expect(resolveCodexUtilityEndpoint({ model_provider: 'unknown' }, {})).toBeNull();
    expect(resolveCodexUtilityEndpoint({}, {})).toBeNull();
    expect(resolveCodexUtilityEndpoint({ model_provider: 'bedrock', model_providers: { bedrock: { base_url: 'https://example.com', wire_api: 'amazon_bedrock' } } }, {})).toBeNull();
  });
});

describe('native network metadata', () => {
  it('honors native config/provider URL priority and rejects ambiguous legacy environment URLs', () => {
    const account = { account: { type: 'apiKey' } };
    expect(resolveCodexUtilityEndpoint({ openai_base_url: 'https://configured.example/v1' }, { account: { type: 'chatgpt' } })?.endpoint).toBe('https://configured.example/v1/responses');
    expect(resolveCodexUtilityEndpoint({ openai_base_url: 'https://configured.example/v1' }, account, { OPENAI_BASE_URL: 'https://different.example/v1' })).toBeNull();
    expect(resolveCodexUtilityEndpoint({}, account, { OPENAI_BASE_URL: 'https://env-only.example/v1' })).toBeNull();
    expect(resolveCodexUtilityEndpoint({ openai_base_url: 'https://configured.example/v1' }, account, { OPENAI_BASE_URL: 'https://configured.example/v1/' })?.endpoint).toBe('https://configured.example/v1/responses');
    expect(resolveCodexUtilityEndpoint({ openai_base_url: 'https://configured.example/v1', model_providers: { openai: { base_url: 'https://provider.example/v1' } } }, account)?.endpoint).toBe('https://provider.example/v1/responses');
  });
  it('prefers scheme proxy over ALL, permits http(s) fallback and rejects only selected unsupported proxies', () => {
    expect(resolveCodexUtilityProxy('https://upstream.example', { HTTPS_PROXY: 'http://specific:80', ALL_PROXY: 'socks5://unused:99' })).toMatchObject({ httpsProxy: 'http://specific:80', httpProxy: '' });
    expect(resolveCodexUtilityProxy('https://upstream.example', { ALL_PROXY: 'http://fallback:80' })).toMatchObject({ httpsProxy: 'http://fallback:80' });
    expect(resolveCodexUtilityProxy('http://upstream.example', { HTTP_PROXY: 'http://specific:80', HTTPS_PROXY: 'socks5://unused:99' })).toMatchObject({ httpProxy: 'http://specific:80', httpsProxy: '' });
    expect(() => resolveCodexUtilityProxy('https://upstream.example', { ALL_PROXY: 'socks5://used:99' })).toThrow();
  });
});

describe('one-use Responses gateway', () => {
  it('strips advertised tools and forwards native headers only to the pinned endpoint', async () => {
    upstream();
    const gate = await createCodexUtilityGateway('https://original.example/v1/responses', 'session-model', new AbortController().signal);
    const path = new URL(gate.baseUrl).pathname + '/responses';
    expect((await sendGateway(path, { model: 'session-model', tools: [{ type: 'function' }], tool_choice: 'auto' })).status).toBe(200);
    const sent = mocks.requests[0]!;
    expect(sent.url).toBe('https://original.example/v1/responses');
    expect(JSON.parse(sent.options.body as string)).toMatchObject({ tools: [], tool_choice: 'none', model: 'session-model' });
    expect((sent.options.headers as Headers).get('authorization')).toBe('Bearer fixture-native-owned');
    expect((sent.options.headers as Headers).get('host')).toBeNull();
    expect((await sendGateway(path, { model: 'session-model' })).status).toBe(502);
    expect(mocks.requests).toHaveLength(1);
    await gate.close();
  });
  it('rejects wrong paths/models, oversize payloads, and aborted requests without upstream inference', async () => {
    upstream();
    for (const scenario of ['path', 'model', 'size', 'abort']) {
      const controller = new AbortController();
      const gate = await createCodexUtilityGateway('https://original.example/responses', 'session-model', controller.signal);
      if (scenario === 'abort') controller.abort();
      const res = await sendGateway(scenario === 'path' ? '/wrong/responses' : new URL(gate.baseUrl).pathname + '/responses', { model: scenario === 'model' ? 'wrong' : 'session-model', ...(scenario === 'size' ? { input: 'x'.repeat(1_048_577) } : {}) });
      expect(res.status).toBe(scenario === 'path' ? 404 : 502); expect(res.body).toBe(''); await gate.close();
    }
    expect(mocks.requests).toHaveLength(0);
  });
  it('rejects prewarm traffic without upstream calls or poisoning the authorized inference', async () => {
    upstream(); const gate = await createCodexUtilityGateway('https://original.example/responses', 'session-model', new AbortController().signal);
    expect((await sendGateway('/models', {})).status).toBe(404); expect(gate.failed).toBe(false); expect(gate.used).toBe(false);
    expect((await sendGateway(new URL(gate.baseUrl).pathname + '/responses', { model: 'session-model' })).status).toBe(200);
    expect(gate.failed).toBe(false); expect(mocks.requests).toHaveLength(1); await gate.close();
  });
  it.each(['zstd', 'invalid-json'])('rejects %s request bodies before any upstream call', async kind => {
    upstream(); const gate = await createCodexUtilityGateway('https://original.example/responses', 'session-model', new AbortController().signal);
    const result = await sendGateway(new URL(gate.baseUrl).pathname + '/responses', { model: 'session-model' }, kind === 'zstd' ? { 'content-encoding': 'zstd' } : {}, kind === 'invalid-json' ? '{broken' : undefined);
    expect(result.status).toBe(502); expect(result.body).toBe(''); expect(mocks.requests).toHaveLength(0); await gate.close();
  });
  it.each(['text/plain', 'application/json'])('admits completely validated SSE despite %s upstream labeling', async type => {
    upstream(stream(), type); const gate = await createCodexUtilityGateway('https://original.example/responses', 'session-model', new AbortController().signal);
    const result = await sendGateway(new URL(gate.baseUrl).pathname + '/responses', { model: 'session-model' });
    expect(result.status).toBe(200); expect(result.body).toBe(stream()); await gate.close();
  });
  it('buffers and rejects injected tool output without forwarding any upstream bytes', async () => {
    upstream(`data: {"type":"response.output_item.added","item":{"type":"computer_call"}}\n\n${stream()}`);
    const gate = await createCodexUtilityGateway('https://original.example/responses', 'session-model', new AbortController().signal);
    const res = await sendGateway(new URL(gate.baseUrl).pathname + '/responses', { model: 'session-model' });
    expect(res.status).toBe(502); expect(res.body).toBe(''); expect(gate.failed).toBe(true);
    await gate.close();
  });
});

describe('actual loopback transport compatibility', () => {
  it('uses same-package undici fetch/dispatcher and never replays tool frames', async () => {
    mocks.realNetwork = true;
    const http = await vi.importActual<typeof import('node:http')>('node:http');
    let body = stream();
    let received: unknown;
    const origin = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body);
    });
    await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
    const address = origin.address() as { port: number };
    const controller = new AbortController();
    let gate: Awaited<ReturnType<typeof createCodexUtilityGateway>> | undefined;
    try {
      gate = await createCodexUtilityGateway(`http://127.0.0.1:${address.port}/responses`, 'session-model', controller.signal);
      const result = await globalThis.fetch(gate.baseUrl + '/responses', { method: 'POST', body: JSON.stringify({ model: 'session-model', tools: [{ type: 'function' }] }) });
      expect(result.status).toBe(200); expect(await result.text()).toBe(body);
      expect(received).toMatchObject({ tools: [], tool_choice: 'none' });
      await gate.close();
      body = `data: {"type":"response.output_item.added","item":{"type":"function_call"}}\n\n${stream()}`;
      gate = await createCodexUtilityGateway(`http://127.0.0.1:${address.port}/responses`, 'session-model', controller.signal);
      const blocked = await globalThis.fetch(gate.baseUrl + '/responses', { method: 'POST', body: JSON.stringify({ model: 'session-model' }) });
      expect(blocked.status).toBe(502); expect(await blocked.text()).toBe('');
    } finally {
      controller.abort(); await gate?.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  });
});

describe('native Codex utility lifecycle', () => {
  it('keeps native source/home/provider/model while isolating thread/cwd/MCP and preserving provider snapshot', async () => {
    upstream();
    mocks.config = { model_provider: 'private', model_providers: { private: { name: 'Private', wire_api: 'responses', base_url: 'https://original.example/v1', env_key: 'ORIGINAL_KEY', requires_openai_auth: false } }, mcp_servers: { 'user-server': { command: 'never-run' } } };
    expect(await generateCodexTextUtility({ prompt: 'context', systemPrompt: 'suggest', model: 'session-model', runtimeSource: 'managed-provider', workspacePath: '/original/workspace' })).toBe('继续验证');
    expect(mocks.spawns[0]!.options.cwd).toBe('/original/workspace');
    expect(mocks.spawns[1]!.options.cwd).toBe('/isolated/utility');
    expect(mocks.spawns[1]!.options.env).toMatchObject({ CODEX_HOME: '/original/home' });
    expect(mocks.spawns[1]!.args).toContain('mcp_servers.user-server.enabled=false');
    const start = mocks.rpcCalls.find(call => call.method === 'thread/start')!.params;
    expect(start).toMatchObject({ ephemeral: true, model: 'session-model', modelProvider: 'private', environments: [] });
    expect(start.config).toMatchObject({ 'model_providers.private': { env_key: 'ORIGINAL_KEY', requires_openai_auth: false, supports_websockets: false } });
    expect(mocks.rpcCalls.some(call => /resume|config\/write/.test(call.method))).toBe(false);
    expect(mocks.close).toHaveBeenCalled();
  });
  it('fails closed for inherited MCP names that native dotted overrides cannot represent', async () => {
    mocks.config = { mcp_servers: { 'has.dot': { command: 'never' } } };
    expect(await generateCodexTextUtility({ prompt: 'context', systemPrompt: 'suggest', model: 'session-model' })).toBeNull();
    expect(mocks.spawns).toHaveLength(1);
  });
  it('uses native global base override for reserved built-in OpenAI without replacing auth', async () => {
    upstream();
    expect(await generateCodexTextUtility({ prompt: 'context', systemPrompt: 'suggest', model: 'session-model' })).toBe('继续验证');
    expect(mocks.spawns[1]!.args.some(arg => arg.startsWith('openai_base_url='))).toBe(true);
    expect(mocks.spawns[1]!.args.some(arg => arg.startsWith('model_providers.openai.'))).toBe(false);
    const start = mocks.rpcCalls.find(call => call.method === 'thread/start')!.params;
    expect(start.modelProvider).toBe('openai');
    expect(Object.keys(start.config as object)).toEqual(['openai_base_url']);
  });
  it.each(['failed', 'interrupted'])('discards partial text when native terminal is %s', async status => {
    upstream(); mocks.terminalStatus = status;
    expect(await generateCodexTextUtility({ prompt: 'context', systemPrompt: 'suggest', model: 'session-model' })).toBeNull();
  });
  it('rejects native tool events even after valid text', async () => {
    upstream(); mocks.tool = true;
    expect(await generateCodexTextUtility({ prompt: 'context', systemPrompt: 'suggest', model: 'session-model' })).toBeNull();
  });
  it('times out inference, kills its own children and closes the gate without publishing partial text', async () => {
    mocks.fetch = vi.fn((_url, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))); 
    expect(await generateCodexTextUtility({ prompt: 'context', systemPrompt: 'suggest', model: 'session-model', timeoutMs: 5 })).toBeNull();
    expect(mocks.close).toHaveBeenCalled();
    const { killWithEscalation } = await import('./utils/kill-with-escalation');
    expect(killWithEscalation).toHaveBeenCalledTimes(2);
  });
  it('closes a gateway that finishes listening after timeout and never spawns a late utility child', async () => {
    mocks.deferListen = true;
    const codes: string[] = [];
    expect(await generateCodexTextUtility({ prompt: 'context', systemPrompt: 'suggest', model: 'session-model', timeoutMs: 5, onDiagnostic: code => codes.push(code) })).toBeNull();
    expect(mocks.spawns).toHaveLength(1); expect(codes).toContain('timeout');
    mocks.listenResolver!();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.close).toHaveBeenCalledTimes(1); expect(mocks.spawns).toHaveLength(1);
    expect(codes.every(code => /^[a-z_]+$/.test(code))).toBe(true);
  });
  it('does not spawn or resolve identity for an already cancelled task', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await generateCodexTextUtility({ prompt: 'context', systemPrompt: 'suggest', model: 'session-model', signal: controller.signal })).toBeNull();
    expect(mocks.spawns).toHaveLength(0);
  });
});
