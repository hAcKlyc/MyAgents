import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeHandler } from './handler';
import { ContextRecoveryController } from './context-recovery';
import type { BridgeModelFailover } from './model-failover';
import type { AnthropicRequest } from './types/anthropic';

const servers: Server[] = [];
const errors: unknown[] = [];

async function fixture(reply: (body: AnthropicRequest, response: ServerResponse) => void | Promise<void>) {
  const requests: AnthropicRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AnthropicRequest;
      requests.push(body);
      await reply(body, res);
    })().catch(error => { errors.push(error); res.destroy(); });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function message(content: unknown, stopReason = 'end_turn') {
  return { id: 'fixture-response', type: 'message', role: 'assistant', model: 'fixture-model', content,
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 } };
}

function request(body: AnthropicRequest, signal?: AbortSignal): Request {
  return new Request('http://127.0.0.1/bridge/exact-query-token/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
}

function history(): AnthropicRequest {
  return { model: 'fixture-model', max_tokens: 128, system: 'Continue the same Goal and never repeat a completed action.',
    tools: [{ name: 'increment_counter', input_schema: { type: 'object', properties: {} } }], messages: [
      { role: 'user', content: 'Increment once, then report the counter.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'first-tool-id', name: 'increment_counter', input: { delta: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'first-tool-id', content: `counter=1\n${'archived evidence '.repeat(2500)}` }] },
      { role: 'assistant', content: 'Counter execution is complete.' },
      { role: 'user', content: '/compact Preserve the completed counter result and current Goal.' },
    ] };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }));
  expect(errors.splice(0)).toEqual([]);
});

describe('context recovery over the existing bridge handler', () => {
  it('continues the native compact inference path through outer recovery and inner failover, with archived pairs intact', async () => {
    const order: string[] = [];
    const upstream = await fixture((body, res) => {
      if (JSON.stringify(body).length > 10000) {
        json(res, { error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'Maximum context length exceeded' } }, 400);
      } else {
        json(res, message([{ type: 'text', text: 'Compaction summary: counter completed once, value=1. Continue the existing Goal.' }]));
      }
    });
    const archives: Array<{ body: AnthropicRequest; digest: string; scope: string }> = [];
    let scope = 'same-session:same-goal:same-turn';
    const recovery = new ContextRecoveryController({ scope: () => scope, isActive: () => true,
      backup: async (body, metadata) => { order.push('backup'); archives.push({ body: structuredClone(body), ...metadata }); return '/private/archive/native-compact.json'; } });
    const failover: BridgeModelFailover = { async run(_request, primary, execute) { order.push('failover'); return execute(primary); } };
    const handler = createBridgeHandler({ logger: null, getUpstreamConfig: () => ({ providerId: 'fixture-provider',
      apiProtocol: 'anthropic', baseUrl: upstream.baseUrl, apiKey: 'fixture', model: 'fixture-model',
      contextRecovery: recovery, modelFailover: failover }) });
    const original = history();
    const response = await handler(request(original));
    expect(response.status).toBe(200);
    expect((await response.json()).content[0].text).toContain('Compaction summary');
    expect(order).toEqual(['failover', 'backup', 'failover']);
    expect(upstream.requests).toHaveLength(2);
    expect(archives).toHaveLength(1);
    expect(archives[0].body).toEqual(original);
    expect(archives[0].scope).toBe('same-session:same-goal:same-turn');
    expect(archives[0].digest).toMatch(/^[a-f0-9]{64}$/);
    const retry = upstream.requests[1];
    expect(retry.system).toEqual(original.system);
    expect(retry.messages[1]).toEqual(original.messages[1]);
    expect(retry.messages.slice(-2)).toEqual(original.messages.slice(-2));
    expect(JSON.stringify(retry.messages[2])).toContain('first-tool-id');
    expect(JSON.stringify(retry.messages[2])).toContain('counter=1');
    expect(JSON.stringify(retry.messages[2])).toContain('/private/archive/native-compact.json');
    // Once SDK consumes this response it owns writing compact_boundary. A later
    // request may already contain the native compact summary instead of the prefix.
    recovery.endTurn(); scope = 'same-session:same-goal:next-turn';
    const nativeCompacted: AnthropicRequest = { model: 'fixture-model', max_tokens: 128,
      messages: [{ role: 'user', content: 'Native compact summary: counter already completed once. Report it.' }] };
    const next = await handler(request(nativeCompacted));
    expect(next.status).toBe(200);
    await next.text();
    expect(recovery.beforeTool('increment_counter', { delta: 1 })).toContain('already completed');
  });

  it('executes the side effect once even when recovery emits the same business operation under a new tool id', async () => {
    let calls = 0;
    let counter = 0;
    const upstream = await fixture((_body, res) => {
      calls++;
      if (calls === 2) return json(res, { error: { message: 'Prompt is too long' } }, 400);
      json(res, message([{ type: 'tool_use', id: calls === 1 ? 'first-tool-id' : 'new-native-id',
        name: 'increment_counter', input: { delta: 1 } }], 'tool_use'));
    });
    const recovery = new ContextRecoveryController({ scope: () => 'session:goal:turn', isActive: () => true,
      backup: async () => '/private/archive/successful-counter.json' });
    const handler = createBridgeHandler({ logger: null, getUpstreamConfig: () => ({ providerId: 'fixture', apiProtocol: 'anthropic',
      baseUrl: upstream.baseUrl, apiKey: 'fixture', model: 'fixture-model', contextRecovery: recovery }) });
    const initial: AnthropicRequest = { model: 'fixture-model', max_tokens: 128,
      messages: [{ role: 'user', content: 'Increment once.' }] };
    const first = await (await handler(request(initial))).json();
    expect(first.content[0].id).toBe('first-tool-id');
    if (!recovery.beforeTool(first.content[0].name, first.content[0].input)) counter++;
    recovery.recordToolResult(first.content[0].name, first.content[0].input, 'counter=1');
    const recovered = await (await handler(request(history()))).json();
    expect(recovered.content[0].id).toBe('new-native-id');
    const denied = recovery.beforeTool(recovered.content[0].name, recovered.content[0].input);
    if (!denied) counter++;
    expect(counter).toBe(1);
    expect(denied).toContain('counter=1');
    expect(denied).toContain('/private/archive/successful-counter.json');
    expect(upstream.requests).toHaveLength(3);
  });

  it('does not interpret a partial successful SSE response as a recoverable context failure', async () => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const upstream = await fixture(async (_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n');
      await finished;
      res.destroy();
    });
    let backups = 0;
    const recovery = new ContextRecoveryController({ scope: () => 'same-turn', isActive: () => true,
      backup: async () => { backups++; return '/private/archive/unused'; } });
    const handler = createBridgeHandler({ logger: null, getUpstreamConfig: () => ({ providerId: 'fixture', apiProtocol: 'anthropic',
      baseUrl: upstream.baseUrl, apiKey: 'fixture', contextRecovery: recovery }) });
    const response = await handler(request({ ...history(), stream: true }));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('partial');
    finish();
    await expect(reader.read()).rejects.toThrow();
    const replay = history(); replay.messages.push({ role: 'user', content: 'SDK rescue after interrupted output' });
    const blocked = await handler(request(replay));
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain('context_recovery_required');
    expect(upstream.requests).toHaveLength(1);
    expect(backups).toBe(0);
  });
});
