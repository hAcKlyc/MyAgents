import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeHandler } from './handler';
import { ModelFailoverController } from './model-failover';
import type { UpstreamConfig } from './types/bridge';
import type { AnthropicRequest } from './types/anthropic';

type RecordedRequest = { path: string; body: Record<string, unknown>; authorization?: string };
type Fixture = { baseUrl: string; requests: RecordedRequest[] };
const servers: Server[] = [];
const fixtureErrors: unknown[] = [];

async function fixture(reply: (request: RecordedRequest, response: ServerResponse) => void | Promise<void>): Promise<Fixture> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = { path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        authorization: req.headers.authorization };
      requests.push(request);
      await reply(request, res);
    })().catch(error => { fixtureErrors.push(error); res.destroy(); });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback fixture failed to bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function anthropicText(text = 'task finished'): unknown {
  return { id: 'anthropic-message', type: 'message', role: 'assistant', model: 'backup-model',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 4 } };
}
function openaiText(format: 'chat_completions' | 'responses', text = 'task finished'): unknown {
  if (format === 'responses') return { id: 'response-1', object: 'response', status: 'completed', model: 'backup-model',
    output: [{ id: 'output-1', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } };
  return { id: 'completion-1', object: 'chat.completion', model: 'backup-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } };
}
function target(server: Fixture, protocol: 'anthropic' | 'openai', format?: 'chat_completions' | 'responses'): UpstreamConfig {
  return { providerId: `fixture-${protocol}`, baseUrl: server.baseUrl, apiKey: 'fixture-key',
    apiProtocol: protocol, upstreamFormat: format, model: 'backup-model', headersTimeoutMs: 500 };
}
const userText = 'Increment the counter once, then report the result.';
function request(messages: AnthropicRequest['messages'] = [{ role: 'user', content: userText }], signal?: AbortSignal, stream = false): Request {
  return new Request('http://127.0.0.1/bridge/query-token/v1/messages', { method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'primary-model', max_tokens: 128, stream, messages,
      tools: [{ name: 'increment_counter', description: 'Increment once', input_schema: { type: 'object', properties: {} } }] }) });
}
function harness(primary: UpstreamConfig, backup: UpstreamConfig, state = { scope: 'root-turn-1' as string | undefined }) {
  const notices: string[] = [];
  const controller = new ModelFailoverController({ scope: () => state.scope,
    resolveBackup: () => backup, onSwitch: selected => { notices.push(selected.providerId); } });
  const handler = createBridgeHandler({ getUpstreamConfig: () => ({ ...primary, modelFailover: controller }), logger: null });
  return { handler, controller, notices, state };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }));
  expect(fixtureErrors.splice(0)).toEqual([]);
});

describe('model failover over real loopback HTTP', () => {
  it.each(['chat_completions', 'responses'] as const)(
    'continues after one executed tool without repeating it, Anthropic to %s', async format => {
      let counter = 0;
      let primaryCalls = 0;
      const primary = await fixture((_req, res) => {
        primaryCalls++;
        if (primaryCalls > 1) return json(res, { error: { message: 'temporarily unavailable' } }, 503);
        json(res, { id: 'tool-message', type: 'message', role: 'assistant', model: 'primary-model',
          content: [{ type: 'tool_use', id: 'counter-call-1', name: 'increment_counter', input: {} }],
          stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
      });
      const backup = await fixture((_req, res) => json(res, openaiText(format)));
      const h = harness(target(primary, 'anthropic'), target(backup, 'openai', format));
      const first = await (await h.handler(request())).json();
      expect(first.stop_reason).toBe('tool_use');
      expect(first.content).toEqual([{ type: 'tool_use', id: 'counter-call-1', name: 'increment_counter', input: {} }]);
      // This is the test's actual side effect. Only an observed native tool_use can execute it.
      counter++;
      const history: AnthropicRequest['messages'] = [{ role: 'user', content: userText },
        { role: 'assistant', content: first.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'counter-call-1', content: String(counter) }] }];
      const result = await (await h.handler(request(history))).json();
      expect(result.content).toContainEqual({ type: 'text', text: 'task finished' });
      expect(counter).toBe(1);
      expect(primary.requests).toHaveLength(3);
      expect(backup.requests).toHaveLength(1);
      const forwarded = JSON.stringify(backup.requests[0].body);
      expect(forwarded.split(userText)).toHaveLength(2);
      expect(forwarded).toContain('counter-call-1');
      if (format === 'chat_completions') {
        expect(backup.requests[0].path).toBe('/chat/completions');
        expect(backup.requests[0].body.messages).toContainEqual({ role: 'tool', tool_call_id: 'counter-call-1', content: '1' });
      } else {
        expect(backup.requests[0].path).toBe('/responses');
        expect(backup.requests[0].body.input).toContainEqual({ type: 'function_call_output', call_id: 'counter-call-1', output: '1' });
      }
      expect(h.notices).toHaveLength(1);
    });

  it('translates a failed OpenAI primary request into an Anthropic backup request', async () => {
    const primary = await fixture((_req, res) => json(res, { error: { message: 'overloaded' } }, 503));
    const backup = await fixture((_req, res) => json(res, anthropicText()));
    const h = harness(target(primary, 'openai', 'chat_completions'), target(backup, 'anthropic'));
    const response = await h.handler(request());
    expect(response.status).toBe(200);
    expect((await response.json()).content[0].text).toBe('task finished');
    expect(primary.requests).toHaveLength(2);
    expect(backup.requests[0].path).toBe('/v1/messages');
    expect(backup.requests[0].body.messages).toEqual([{ role: 'user', content: userText }]);
    expect(backup.requests[0].body.model).toBe('backup-model');
  });

  it('never replays a successful SSE response after partial delivery and a socket failure', async () => {
    const finishStream = deferred();
    let streamCalls = 0;
    const primary = await fixture(async (_req, res) => {
      if (++streamCalls > 1) { json(res, anthropicText('new root finished')); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial progress"}}\n\n');
      await finishStream.promise;
      res.destroy();
    });
    const backup = await fixture((_req, res) => json(res, anthropicText()));
    const h = harness(target(primary, 'anthropic'), target(backup, 'anthropic'));
    const response = await h.handler(request(undefined, undefined, true));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('partial progress');
    finishStream.resolve();
    await expect(reader.read()).rejects.toThrow();
    const replay = await h.handler(request(undefined, undefined, true));
    expect(replay.status).toBe(409);
    await replay.text();
    const changedHistory = await h.handler(request([{ role: 'user', content: 'Recover the partial output with changed native history' }]));
    expect(changedHistory.status).toBe(409);
    await changedHistory.text();
    expect(primary.requests).toHaveLength(1);
    expect(backup.requests).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
    h.controller.endTurn();
    h.state.scope = 'root-turn-2';
    const nextRoot = await h.handler(request());
    expect(nextRoot.status).toBe(200);
    expect((await nextRoot.json()).content[0].text).toBe('new root finished');
    expect(primary.requests).toHaveLength(2);
    expect(backup.requests).toHaveLength(0);
  });

  it('publishes one switch for concurrent failures and pins subsequent inference to backup', async () => {
    const bothPrimariesArrived = deferred();
    let calls = 0;
    const primary = await fixture(async (_req, res) => {
      calls++;
      if (calls === 2) bothPrimariesArrived.resolve();
      await bothPrimariesArrived.promise;
      json(res, { error: { message: 'overloaded' } }, 503);
    });
    const backup = await fixture((_req, res) => json(res, anthropicText()));
    const h = harness(target(primary, 'anthropic'), target(backup, 'anthropic'));
    const results = await Promise.all([
      h.handler(request([{ role: 'user', content: 'Independent root inference' }])),
      h.handler(request([{ role: 'user', content: 'Independent child inference' }])),
    ]);
    for (const response of results) {
      expect(response.status).toBe(200);
      expect((await response.json()).content[0].text).toBe('task finished');
    }
    expect(h.notices).toHaveLength(1);
    const before = primary.requests.length;
    await (await h.handler(request([{ role: 'user', content: 'Next independent inference' }]))).text();
    expect(primary.requests).toHaveLength(before);
    expect(backup.requests).toHaveLength(3);
  });

  it('continues the tool loop after cancelling a completed tool-use SSE at message_stop', async () => {
    let calls = 0;
    let counter = 0;
    const tool = { type: 'tool_use' as const, id: 'completed-stream-tool', name: 'increment_counter', input: {} };
    const primary = await fixture((_req, res) => {
      if (++calls > 1) { json(res, anthropicText('counter confirmed once')); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'message_start', message: { id: 'stream-tool-message', type: 'message', role: 'assistant',
          model: 'primary-model', content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: tool },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ];
      res.write(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      // Deliberately leave HTTP open: successful protocol termination is sufficient for the SDK to cancel.
    });
    const backup = await fixture((_req, res) => json(res, anthropicText()));
    const h = harness(target(primary, 'anthropic'), target(backup, 'anthropic'));
    const response = await h.handler(request(undefined, undefined, true));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let received = '';
    const decoder = new TextDecoder();
    while (!received.includes('event: message_stop\n')) {
      const next = await reader.read();
      if (next.done) throw new Error('tool stream ended without message_stop');
      received += decoder.decode(next.value, { stream: true });
    }
    const toolEvent = received.split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6))).find(event => event.type === 'content_block_start');
    expect(toolEvent.content_block).toEqual(tool);
    await reader.cancel('SDK consumed successful message_stop');
    counter++;
    const history: AnthropicRequest['messages'] = [{ role: 'user', content: userText },
      { role: 'assistant', content: [tool] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: String(counter) }] }];
    const next = await h.handler(request(history));
    expect(next.status).toBe(200);
    expect((await next.json()).content[0].text).toBe('counter confirmed once');
    expect(primary.requests).toHaveLength(2);
    expect(primary.requests[1].body.messages).toEqual(history);
    expect(counter).toBe(1);
    expect(backup.requests).toHaveLength(0);
  });

  it.each(['initial', 'retry'] as const)('does not deliver late successful %s primary output after scope revocation', async phase => {
    const arrived = deferred();
    const release = deferred();
    let calls = 0;
    const primary = await fixture(async (_req, res) => {
      calls++;
      if (phase === 'retry' && calls === 1) {
        json(res, { error: { message: 'overloaded' } }, 503);
        return;
      }
      arrived.resolve();
      await release.promise;
      json(res, { id: 'late-message', type: 'message', role: 'assistant', model: 'primary-model',
        content: [{ type: 'tool_use', id: 'unsafe-late-tool', name: 'increment_counter', input: {} }],
        stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 4 } });
    });
    const backup = await fixture((_req, res) => json(res, anthropicText()));
    const h = harness(target(primary, 'anthropic'), target(backup, 'anthropic'));
    const inFlight = h.handler(request());
    await arrived.promise;
    h.state.scope = undefined;
    // A second late request cannot bypass the revoked scope to reach primary.
    const stale = await h.handler(request([{ role: 'user', content: 'stale request after scope revocation' }]));
    expect(stale.status).toBe(499);
    await stale.text();
    release.resolve();
    const response = await inFlight;
    expect(response.status).toBe(499);
    const body = await response.text();
    expect(body).toContain('superseded or cancelled');
    expect(body).not.toContain('unsafe-late-tool');
    expect(primary.requests).toHaveLength(phase === 'initial' ? 1 : 2);
    expect(backup.requests).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
  });

  it.each(['abort', 'scope-revocation'] as const)('does not start backup after %s during primary retry', async mode => {
    const retryArrived = deferred();
    const releaseRetry = deferred();
    let calls = 0;
    const primary = await fixture(async (_req, res) => {
      calls++;
      if (calls === 2) { retryArrived.resolve(); await releaseRetry.promise; }
      json(res, { error: { message: 'overloaded' } }, 503);
    });
    const backup = await fixture((_req, res) => json(res, anthropicText()));
    const h = harness(target(primary, 'anthropic'), target(backup, 'anthropic'));
    const cancellation = new AbortController();
    const result = h.handler(request(undefined, cancellation.signal));
    await retryArrived.promise;
    if (mode === 'abort') cancellation.abort();
    else { h.state.scope = undefined; h.controller.endTurn(); }
    releaseRetry.resolve();
    const response = await result;
    await response.text();
    expect(response.ok).toBe(false);
    expect(backup.requests).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
  });

  it('does not spend on backup for explicit Anthropic billing failures', async () => {
    let billing: unknown;
    const primary = await fixture((_req, res) => json(res, billing, 429));
    const backup = await fixture((_req, res) => json(res, anthropicText()));
    for (const error of [{ code: 'quota_exhausted', message: 'quota exhausted' },
      { code: 'quota_exceeded', message: 'quota exceeded' }, { message: '账户欠费，余额不足' }]) {
      billing = { error };
      const h = harness(target(primary, 'anthropic'), target(backup, 'anthropic'));
      const response = await h.handler(request());
      expect(response.status).toBe(429);
      await response.text();
      expect(h.notices).toHaveLength(0);
    }
    expect(primary.requests).toHaveLength(3);
    expect(backup.requests).toHaveLength(0);
  });

  it('stops after both primary and backup fail without switching back to primary', async () => {
    const primary = await fixture((_req, res) => json(res, { error: { message: 'overloaded' } }, 503));
    const backup = await fixture((_req, res) => json(res, { error: { message: 'backup overloaded' } }, 503));
    const h = harness(target(primary, 'anthropic'), target(backup, 'anthropic'));
    const result = await h.handler(request());
    expect(result.status).toBe(503);
    expect(await result.text()).toContain('backup overloaded');
    expect(primary.requests).toHaveLength(2);
    expect(backup.requests).toHaveLength(1);
    // Even a native HTTP retry of the same inference must not repeat either upstream.
    const replay = await h.handler(request());
    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain('automatic replay is blocked');
    expect(primary.requests).toHaveLength(2);
    expect(backup.requests).toHaveLength(1);
    expect(h.notices).toHaveLength(1);
  });

  it('uses backup-owned current credentials for every inference after switching', async () => {
    const primary = await fixture((_req, res) => json(res, { error: { message: 'overloaded' } }, 503));
    const backup = await fixture((_req, res) => json(res, anthropicText()));
    const primaryConfig = { ...target(primary, 'anthropic'), apiKey: 'primary-only-key' };
    let backupConfig = { ...target(backup, 'anthropic'), apiKey: 'backup-key-generation-1' };
    const controller = new ModelFailoverController({ scope: () => 'root-turn-credentials',
      resolveBackup: () => ({ ...backupConfig }), onSwitch: () => {} });
    const handler = createBridgeHandler({ getUpstreamConfig: () => ({ ...primaryConfig, modelFailover: controller }), logger: null });
    await (await handler(request())).text();
    backupConfig = { ...backupConfig, apiKey: 'backup-key-generation-2' };
    await (await handler(request([{ role: 'user', content: 'Next inference after credential rotation' }]))).text();
    expect(primary.requests.map(row => row.authorization)).toEqual(['Bearer primary-only-key', 'Bearer primary-only-key']);
    expect(backup.requests.map(row => row.authorization)).toEqual(['Bearer backup-key-generation-1', 'Bearer backup-key-generation-2']);
    expect(primary.requests).toHaveLength(2);
  });

  it('rejects the same inference while its original request is still in flight', async () => {
    const arrived = deferred();
    const release = deferred();
    const primary = await fixture(async (_req, res) => {
      arrived.resolve();
      await release.promise;
      json(res, anthropicText());
    });
    const backup = await fixture((_req, res) => json(res, anthropicText()));
    const h = harness(target(primary, 'anthropic'), target(backup, 'anthropic'));
    const original = h.handler(request());
    await arrived.promise;
    const duplicate = await h.handler(request());
    expect(duplicate.status).toBe(409);
    await duplicate.text();
    release.resolve();
    expect((await (await original).json()).content[0].text).toBe('task finished');
    expect(primary.requests).toHaveLength(1);
    expect(backup.requests).toHaveLength(0);
  });

  it.each(['anthropic', 'openai'] as const)(
    'bounds a %s error body that stalls after response headers without starting backup', async protocol => {
      const primary = await fixture((_req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.flushHeaders();
        // Keep the body open. The error-body bound, not the headers deadline, must settle this request.
      });
      const backup = await fixture((_req, res) => json(res, anthropicText()));
      const h = harness(target(primary, protocol), target(backup, 'anthropic'));
      const response = await h.handler(request());
      expect(response.status).toBe(503);
      expect(await response.text()).toMatch(/incomplete|unavailable|recovery stopped/i);
      expect(primary.requests).toHaveLength(1);
      expect(backup.requests).toHaveLength(0);
      expect(h.notices).toHaveLength(0);
      const replay = await h.handler(request());
      expect(replay.status).toBe(409);
      await replay.text();
      expect(primary.requests).toHaveLength(1);
    }, 5_000);

  it.each(['anthropic', 'openai'] as const)(
    'fails closed for an oversized %s error body', async protocol => {
      const primary = await fixture((_req, res) => json(res, {
        error: { message: 'overloaded '.repeat(4_000) },
      }, 503));
      const backup = await fixture((_req, res) => json(res, anthropicText()));
      const h = harness(target(primary, protocol), target(backup, 'anthropic'));
      const response = await h.handler(request());
      expect(response.status).toBe(503);
      expect(await response.text()).toMatch(/incomplete|unavailable|recovery stopped/i);
      expect(primary.requests).toHaveLength(1);
      expect(backup.requests).toHaveLength(0);
      expect(h.notices).toHaveLength(0);
    });
});
