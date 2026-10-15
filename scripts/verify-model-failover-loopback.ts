/** Real SDK/native child + local synthetic suppliers. No account or paid inference. */
import { strict as assert } from 'node:assert';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { createBridgeHandler } from '../src/server/openai-bridge/handler';
import { ModelFailoverController } from '../src/server/openai-bridge/model-failover';

const streamFailure = process.argv.includes('--stream-failure');
const scratch = await mkdtemp(join(tmpdir(), 'moxbots-failover-native-'));
let counter = 0;
let primaryCalls = 0;
let backupCalls = 0;
let switches = 0;
let restoredResult = false;
let nativeSessionId: string | undefined;
const results: unknown[] = [];
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function message(res: ServerResponse, useTool: boolean) {
  const content = useTool ? { type: 'tool_use', id: 'count-once', name: 'mcp__counter__increment', input: {} }
    : { type: 'text', text: 'Resumed from count=1. Task complete.' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(frame('message_start', { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant',
    model: 'primary-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
    + frame('content_block_start', { type: 'content_block_start', index: 0, content_block: useTool ? { ...content, input: {} } : { type: 'text', text: '' } })
    + (useTool ? frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
      : frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Resumed from count=1. Task complete.' } }))
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + frame('message_delta', { type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
    + frame('message_stop', { type: 'message_stop' }));
}
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (req.url?.startsWith('/backup/')) {
    backupCalls++;
    restoredResult = JSON.stringify(body.messages).includes('count=1');
    assert(restoredResult, 'backup must receive the completed tool result');
    message(res, false);
  } else {
    primaryCalls++;
    if (JSON.stringify(body.messages).includes('count=1')) {
      if (streamFailure) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(frame('message_start', { type: 'message_start', message: { id: 'partial', type: 'message', role: 'assistant',
          model: 'primary-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
          + frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          + frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial response' } }));
        setTimeout(() => res.destroy(), 25);
        return;
      }
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'fixture outage' } }));
    } else message(res, true);
  }
});
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamAddress = upstream.address();
if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('No fixture port');
const base = `http://127.0.0.1:${upstreamAddress.port}`;
const failover = new ModelFailoverController({ scope: () => 'native-root',
  resolveBackup: () => ({ providerId: 'backup', baseUrl: `${base}/backup`, apiProtocol: 'anthropic', model: 'backup-fixture', apiKey: 'fixture-backup' }),
  onSwitch: () => { switches++; } });
const handler = createBridgeHandler({ logger: null, getUpstreamConfig: () => ({ providerId: 'primary',
  baseUrl: `${base}/primary`, apiProtocol: 'anthropic', model: 'primary-fixture', apiKey: 'fixture-main', modelFailover: failover }) });
const gateway = createServer(async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    if (req.url?.endsWith('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await handler(new Request(`http://127.0.0.1${req.url}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks), signal: controller.signal }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
});
await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
const gatewayAddress = gateway.address();
if (!gatewayAddress || typeof gatewayAddress === 'string') throw new Error('No gateway port');
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(), 45_000);
try {
  const counterServer = createSdkMcpServer({ name: 'counter', version: '1.0.0', tools: [
    tool('increment', 'Increment the local fixture counter exactly once', {}, async () => {
      counter++;
      await writeFile(join(scratch, 'counter.txt'), String(counter));
      return { content: [{ type: 'text', text: `count=${counter}` }] };
    }),
  ] });
  const run = query({ prompt: 'Call the counter once, then report its result. Never increment twice.', options: {
    cwd: scratch, model: 'primary-fixture', settingSources: [], tools: [],
    mcpServers: { counter: counterServer }, allowedTools: ['mcp__counter__increment'],
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    abortController: abort, maxTurns: 4, persistSession: true,
    env: { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${gatewayAddress.port}/bridge/fixture`,
      ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    },
  } });
  let nativeFailed = false;
  try {
    for await (const event of run) {
      if (event.type === 'system' && event.subtype === 'init') nativeSessionId = event.session_id;
      if (event.type === 'result') results.push(event);
    }
  } catch (error) { nativeFailed = true; if (!streamFailure) throw error; } finally { run.close(); }
  assert.equal(counter, 1);
  assert.equal(primaryCalls, streamFailure ? 2 : 3); // first tool, then two availability failures
  assert.equal(backupCalls, streamFailure ? 0 : 1);
  assert.equal(switches, streamFailure ? 0 : 1);
  if (streamFailure) assert(nativeFailed || results.some(value => (value as { subtype?: string }).subtype !== 'success'));
  else { assert(restoredResult); assert(results.some(value => (value as { subtype?: string }).subtype === 'success')); }
  const receipt = { passed: true, streamFailure, nativeSessionId, counter, primaryCalls, backupCalls, switches,
    restoredResult, realSdk: true, upstream: 'synthetic-loopback-only', paidCalls: 0 };
  await writeFile(join(scratch, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, evidence: scratch }));
} finally {
  clearTimeout(deadline);
  for (const server of [gateway, upstream]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
