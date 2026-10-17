/** Real SDK/native child + local synthetic suppliers. No account or paid inference. */
import { strict as assert } from 'node:assert';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { createBridgeHandler } from '../src/server/openai-bridge/handler';
import { ContextRecoveryController } from '../src/server/openai-bridge/context-recovery';

const automatic = process.argv.includes('--auto');
const failCompact = process.argv.includes('--fail-compact');
const scratch = await mkdtemp(join(tmpdir(), 'moxbots-context-native-'));
let counter = 0;
let phase: 'initial' | 'compact' | 'continue' = 'initial';
let calls = 0;
let initialTextSent = false;
let duplicateRequested = false;
let backups = 0;
let denied = 0;
let observedNativeTrigger: string | undefined;
let compactFailed = false;
let savedLedger: unknown;
let nativeSessionId: string | undefined;
let scope = 'original-goal-turn';
const results: unknown[] = [];
const makeController = (initialLedger?: unknown) => new ContextRecoveryController({
  scope: () => scope, isActive: () => true, initialLedger,
  persistLedger: async ledger => { savedLedger = structuredClone(ledger); await writeFile(join(scratch, 'ledger.json'), JSON.stringify(ledger), { mode: 0o600 }); },
  backup: async (body, metadata) => {
    backups++; const archive = join(scratch, `${metadata.digest}.json`);
    await writeFile(archive, JSON.stringify(body), { mode: 0o600 }); return archive;
  },
});
let recovery = makeController();
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function message(res: ServerResponse, useTool: boolean) {
  const reply = phase === 'compact' ? 'Goal checkpoint: counter completed once, count=1. Continue by reporting completion. Do not increment again.' : (!initialTextSent && phase === 'initial' && calls >= 3 ? 'old synthetic analysis '.repeat(6000) : 'Resumed from count=1. Task complete.');
  if (!useTool && phase === 'initial' && calls >= 3) initialTextSent = true;
  const content = useTool ? { type: 'tool_use', id: phase === 'continue' ? 'new-id-same-action' : 'count-once', name: 'mcp__counter__increment', input: {} }
    : { type: 'text', text: reply };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(frame('message_start', { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant',
    model: 'primary-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: automatic && reply.length > 100000 ? 190000 : 100, output_tokens: 0 } } })
    + frame('content_block_start', { type: 'content_block_start', index: 0, content_block: useTool ? { ...content, input: {} } : { type: 'text', text: '' } })
    + (useTool ? frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
      : frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }))
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + frame('message_delta', { type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
    + frame('message_stop', { type: 'message_stop' }));
}
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls++;
  console.log(JSON.stringify({ phase, model: body.model, messages: body.messages?.length, size: JSON.stringify(body.messages).length }));
  const text = JSON.stringify(body.messages);
  if (phase === 'compact' && failCompact) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'fixture invalid request' } })); return;
  }
  if (phase === 'compact' && text.length > 50000) {
    console.log(JSON.stringify(body.messages.map((m: {role:string;content:unknown}) => ({role:m.role, content: Array.isArray(m.content) ? m.content.map(b => ({type:b.type,id:b.id,name:b.name,tool_use_id:b.tool_use_id,is_error:b.is_error, contentKind:typeof b.content})) : typeof m.content}))));
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Context window is full' } }));
    return;
  }
  const useTool = phase === 'initial' ? counter === 0 : phase === 'continue' && !duplicateRequested;
  if (phase === 'continue' && useTool) duplicateRequested = true;
  message(res, useTool);

});
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamAddress = upstream.address();
if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('No fixture port');
const base = `http://127.0.0.1:${upstreamAddress.port}`;
const handler = createBridgeHandler({ logger: null, getUpstreamConfig: () => ({ providerId: 'fixture',
  baseUrl: base, apiProtocol: 'anthropic', model: 'primary-fixture', apiKey: 'fixture',
  contextRecovery: recovery }) });
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
const deadline = setTimeout(() => abort.abort(), 90_000);
try {
  const counterServer = createSdkMcpServer({ name: 'counter', version: '1.0.0', tools: [
    tool('increment', 'Increment the local fixture counter exactly once', {}, async () => {
      counter++;
      await writeFile(join(scratch, 'counter.txt'), String(counter));
      return { content: [{ type: 'text', text: `count=${counter}\n${'old synthetic evidence '.repeat(6000)}` }] };
    }),
  ] });
  async function run(prompt: string, resume?: string) {
    const native = query({ prompt, options: {
      cwd: scratch, model: 'primary-fixture', settingSources: [], tools: [], resume,
      mcpServers: { counter: counterServer }, allowedTools: ['mcp__counter__increment'],
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
      hooks: {
        PreToolUse: [{ hooks: [async input => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          const reason = await recovery.authorizeTool(input.tool_name, input.tool_input);
          if (!reason) return {};
          denied++;
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
        }] }],
        PostToolUse: [{ hooks: [async input => {
          if (input.hook_event_name === 'PostToolUse') await recovery.commitToolResult(input.tool_name, input.tool_input, input.tool_response);
          return {};
        }] }],
      },
      abortController: abort, maxTurns: 5, persistSession: true,
      env: { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${gatewayAddress.port}/bridge/fixture`,
        ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
      },
    } });
    try {
      for await (const event of native) {
        if (event.type === 'system' && event.subtype === 'init') {
          if (nativeSessionId) assert.equal(event.session_id, nativeSessionId);
          nativeSessionId = event.session_id;
        }
        if (event.type === 'result') { results.push({ phase, ...event }); console.log(JSON.stringify({ phase, type: event.type, subtype: event.subtype, result: 'result' in event ? event.result.slice(0, 250) : undefined })); }
        if (event.type === 'system' && event.subtype === 'compact_boundary') observedNativeTrigger = event.compact_metadata.trigger;
        if (event.type === 'system' && event.subtype === 'status' && event.compact_result === 'failed') compactFailed = true;
        if (event.type === 'system' && event.subtype !== 'init') console.log(JSON.stringify({ phase, ...event }));
      }
    } finally { native.close(); recovery.endTurn(); }
  }
  await run('Increment the fixture counter once, then report its result.');
  assert.equal(counter, 1);
  if (!automatic) await run('Record the checkpoint without another increment.', nativeSessionId);
  phase = 'compact'; scope = 'same-goal-native-compact';
  await run(automatic ? 'Continue from the checkpoint without another increment.' : '/compact Preserve the same Goal and the counter result; never repeat the increment.', nativeSessionId);
  if (failCompact) {
    assert.equal(compactFailed, true, 'native SDK must explicitly report compaction failure');
    assert.equal((results.at(-1) as { subtype: string }).subtype, 'success', 'regression fixture reproduces misleading outer SDK success');
    assert.equal(backups, 0, 'generic HTTP400 must never trigger context repair');
    assert.equal(counter, 1);
    await writeFile(join(scratch, 'receipt.json'), JSON.stringify({ passed: true, failCompact,
      compactFailed, outerSdkSuccess: true, counter, backups, realSdk: true, paidCalls: 0 }));
    console.log(JSON.stringify({ passed: true, failCompact, compactFailed, outerSdkSuccess: true, counter, backups, evidence: scratch }));
  } else {
  assert(backups > 0, 'native compact must cross the recovery checkpoint');
  assert(savedLedger, 'recovery must leave a durable ledger');
  // Simulate a Sidecar/Query restart after native compaction removed the old tool pair.
  recovery = makeController(JSON.parse(await readFile(join(scratch, 'ledger.json'), 'utf8')));
  phase = 'continue'; scope = 'same-goal-next-root';
  await run('Continue the original Goal from its saved progress.', nativeSessionId);
  assert.equal(counter, 1, 'a newly emitted tool ID must not repeat the business action');
  assert(denied > 0, 'the real SDK PreToolUse hard gate must deny the duplicate');
  assert.equal(results.length, automatic ? 3 : 4);
  assert(results.every(value => (value as { subtype: string }).subtype === 'success'));
  const nativeFiles = await readdir(scratch, { recursive: true });
  let compactBoundary = false;
  for (const file of nativeFiles.filter(path => path.endsWith('.jsonl'))) {
    if ((await readFile(join(scratch, file), 'utf8')).includes('compact_boundary')) compactBoundary = true;
  }
  assert(compactBoundary, 'SDK must persist its authentic compact boundary');
  assert.equal(compactFailed, false);
  assert.equal(observedNativeTrigger, automatic ? 'auto' : 'manual');
  const receipt = { passed: true, automatic, counter, denied, backups, calls, nativeSessionId, compactBoundary,
    sameGoalFixture: true, realSdk: true, queryRestart: true, upstream: 'synthetic-loopback-only', paidCalls: 0 };
  await writeFile(join(scratch, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, evidence: scratch }));

  }
} finally {
  clearTimeout(deadline);
  for (const server of [gateway, upstream]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
