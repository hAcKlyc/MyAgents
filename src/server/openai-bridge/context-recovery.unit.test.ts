import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ContextRecoveryController } from './context-recovery';
import type { AnthropicRequest } from './types/anthropic';

function history(): AnthropicRequest {
  return { model: 'fixture-model', max_tokens: 128,
    system: [{ type: 'text', text: 'Keep the same Session and Goal; never repeat a completed action.' }],
    tools: [{ name: 'increment_counter', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: 'Increment exactly once. Preserve this user constraint in full.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'increment_counter', input: { delta: 1, account: 'test' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: `counter=1\n${'old evidence '.repeat(2400)}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Older analysis. '.repeat(1000) }] },
      { role: 'user', content: 'Continue the existing Goal. Do not increment again.' },
      { role: 'user', content: '/compact Preserve the checkpoint and successful tool results.' },
    ] };
}

function req(signal?: AbortSignal): Request {
  return new Request('http://127.0.0.1/bridge/fixture/v1/messages', { method: 'POST', signal });
}

function overflow(message = 'Context window is full'): Response {
  return Response.json({ error: { type: 'invalid_request_error', message } }, { status: 400 });
}

function ok(): Response { return Response.json({ type: 'message', content: [{ type: 'text', text: 'continued' }] }); }

function fixture() {
  const owner = { scope: 'session:goal:turn-1' as string | undefined, active: true, canRecover: true };
  const backup = vi.fn(async (_body: AnthropicRequest, metadata: { digest: string; scope: string }) => `/private/archive/${metadata.digest}.json`);
  const onRecovery = vi.fn();
  const controller = new ContextRecoveryController({ scope: () => owner.scope, isActive: () => owner.active,
    canRecover: () => owner.canRecover, backup, onRecovery });
  return { owner, backup, onRecovery, controller };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('bounded inference context recovery', () => {
  it('archives before retry, preserves constraints and complete tool pairs, and guards a new-ID repeated action', async () => {
    const h = fixture();
    const body = history();
    const saved = structuredClone(body);
    const inputs: AnthropicRequest[] = [];
    const execute = vi.fn(async (input: AnthropicRequest) => {
      inputs.push(input);
      if (inputs.length === 1) return overflow();
      expect(h.backup).toHaveBeenCalledTimes(1);
      return ok();
    });
    const response = await h.controller.run(req(), body, execute);
    expect(response.status).toBe(200);
    await response.text();
    expect(body).toEqual(saved);
    expect(inputs).toHaveLength(2);
    const projected = inputs[1];
    expect(projected.system).toEqual(body.system);
    expect(projected.tools).toEqual(body.tools);
    expect(projected.messages[0]).toEqual(body.messages[0]);
    expect(projected.messages[1]).toEqual(body.messages[1]);
    expect(projected.messages.slice(-2)).toEqual(body.messages.slice(-2));
    expect(projected.messages[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1' }] });
    const projection = JSON.stringify(projected);
    expect(projection).toContain('counter=1');
    expect(projection).toContain('Original SHA-256');
    expect(projection).toContain('/private/archive/');
    expect(projection.length).toBeLessThan(JSON.stringify(body).length * 0.85);
    expect(h.backup.mock.calls[0][0]).toEqual(saved);
    expect(h.onRecovery).toHaveBeenCalledTimes(1);
    // A model can emit the same operation under a NEW native tool id. The existing
    // tool owner consults this guard; recovery itself never executes a tool.
    let counter = 1;
    const newToolUse = { id: 'new-call-id', name: 'increment_counter', input: { account: 'test', delta: 1 } };
    const denial = h.controller.beforeTool(newToolUse.name, newToolUse.input);
    if (!denial) counter++;
    expect(counter).toBe(1);
    expect(denial).toContain('already completed');
    expect(denial).toContain('/private/archive/');
    expect(h.controller.beforeTool('Read', { file_path: 'test' })).toBeUndefined();
    expect(h.controller.beforeTool('increment_counter', { account: 'different', delta: 1 })).toBeUndefined();
  });

  it.each([
    { type: 'context_length_exceeded', message: 'request rejected' },
    { code: 'context_length_exceeded', message: 'request rejected' },
    { message: 'This model has a maximum context length of 65536 tokens' },
    { message: 'Prompt is too long' },
  ])('recovers only an explicit overflow diagnosis: %j', async error => {
    const h = fixture();
    let calls = 0;
    const response = await h.controller.run(req(), history(), async () => ++calls === 1
      ? Response.json({ error }, { status: 400 }) : ok());
    expect(response.status).toBe(200);
    await response.text();
    expect(calls).toBe(2);
  });

  it.each(['invalid schema', 'context_length_exceeded is mentioned in an unrelated schema field', 'too many requests'])('does not recover generic 400: %s', async message => {
    const h = fixture();
    const execute = vi.fn(async () => overflow(message));
    const response = await h.controller.run(req(), history(), execute);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { type: 'invalid_request_error', message } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.backup).not.toHaveBeenCalled();
  });

  it('does not retry when durable backup fails', async () => {
    const h = fixture();
    h.backup.mockRejectedValue(new Error('disk failure'));
    const execute = vi.fn(async () => overflow());
    const response = await h.controller.run(req(), history(), execute);
    expect(response.status).toBe(409);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(await response.json()).toMatchObject({ error: { code: 'context_recovery_required' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.onRecovery).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'unpaired', 'failed'] as const)('fails closed for %s history', async mode => {
    const h = fixture();
    const body = history();
    if (mode === 'unknown') body.messages[3].content = [{ type: 'document' }] as unknown as AnthropicRequest['messages'][number]['content'];
    if (mode === 'unpaired') body.messages.splice(2, 1);
    if (mode === 'failed') {
      const content = body.messages[2].content;
      if (Array.isArray(content) && content[0].type === 'tool_result') content[0].is_error = true;
    }
    const execute = vi.fn(async () => overflow());
    const response = await h.controller.run(req(), body, execute);
    expect(response.status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.backup).not.toHaveBeenCalled();
    expect(h.controller.beforeTool('increment_counter', { account: 'test', delta: 1 })).toContain('blocked');
  });

  it('refuses insufficient reduction instead of truncating user constraints or latest evidence', async () => {
    const h = fixture();
    const body: AnthropicRequest = { model: 'fixture', max_tokens: 128,
      messages: [{ role: 'user', content: 'Protected constraint. '.repeat(4000) }] };
    const original = structuredClone(body);
    const execute = vi.fn(async () => overflow());
    expect((await h.controller.run(req(), body, execute)).status).toBe(409);
    expect(body).toEqual(original);
    expect(h.backup).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('omits archived old tool images while preserving the pair and newest images', async () => {
    const h = fixture();
    const body = history();
    body.messages[2].content = [{ type: 'tool_result', tool_use_id: 'call-1', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'X'.repeat(15000) } },
      { type: 'text', text: 'counter=1' },
    ] }];
    body.messages[5].content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Y'.repeat(200) } }];
    const inputs: AnthropicRequest[] = [];
    const response = await h.controller.run(req(), body, async input => { inputs.push(input); return inputs.length === 1 ? overflow() : ok(); });
    await response.text();
    expect(inputs[1].messages[2]).toMatchObject({ content: [{ type: 'tool_result', tool_use_id: 'call-1' }] });
    expect(JSON.stringify(inputs[1].messages[2])).not.toContain('X'.repeat(100));
    expect(inputs[1].messages[5]).toEqual(body.messages[5]);
  });

  it('cancels during backup without retrying inference or activating recovery', async () => {
    const h = fixture();
    const archive = deferred<string>();
    const entered = deferred<void>();
    h.backup.mockImplementation(async () => { entered.resolve(); return archive.promise; });
    const abort = new AbortController();
    const execute = vi.fn(async () => overflow());
    const result = h.controller.run(req(abort.signal), history(), execute);
    await entered.promise;
    abort.abort();
    archive.resolve('/private/archive/original.json');
    expect((await result).status).toBe(499);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.onRecovery).not.toHaveBeenCalled();
  });

  it('a superseded backup cannot activate or block the next scope', async () => {
    const h = fixture();
    const archive = deferred<string>();
    const entered = deferred<void>();
    h.backup.mockImplementation(async () => { entered.resolve(); return archive.promise; });
    const old = h.controller.run(req(), history(), async () => overflow());
    await entered.promise;
    h.controller.endTurn();
    h.owner.scope = 'session:goal:turn-2';
    const next = await h.controller.run(req(), history(), async () => ok());
    expect(next.status).toBe(200);
    await next.text();
    archive.resolve('/private/archive/old.json');
    expect((await old).status).toBe(499);
    expect(h.onRecovery).not.toHaveBeenCalled();
    expect(h.controller.beforeTool('increment_counter', { account: 'test', delta: 1 })).toBeUndefined();
  });

  it('rejects duplicate and delivered requests while preserving distinct concurrent child inferences', async () => {
    const h = fixture();
    const pending = deferred<void>();
    const execute = vi.fn(async () => { await pending.promise; return ok(); });
    const body = history();
    const first = h.controller.run(req(), body, execute);
    expect((await h.controller.run(req(), body, execute)).status).toBe(409);
    const child = history(); child.messages[0].content = 'Independent child inference';
    const concurrentChild = h.controller.run(req(), child, execute);
    pending.resolve();
    const response = await first;
    await response.text();
    expect((await concurrentChild).status).toBe(200);
    await (await concurrentChild).text();
    body.metadata = { retry_nonce: 'changed' };
    expect((await h.controller.run(req(), body, execute)).status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('refuses recovery while another inference is active, leaving that inference and future root turns live', async () => {
    const h = fixture();
    const pending = deferred<void>();
    const normal = h.controller.run(req(), history(), async () => { await pending.promise; return ok(); });
    const child = history(); child.messages.push({ role: 'user', content: 'Independent child inference' });
    const execute = vi.fn(async () => overflow());
    const blocked = await h.controller.run(req(), child, execute);
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain('context_recovery_required');
    expect(h.backup).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    pending.resolve();
    const response = await normal;
    expect(response.status).toBe(200);
    await response.text();
    h.controller.endTurn(); h.owner.scope = 'session:goal:turn-2';
    const next = await h.controller.run(req(), history(), async () => ok());
    expect(next.status).toBe(200);
    await next.text();
  });

  it('allows normal requests with background work but refuses context recovery', async () => {
    const h = fixture(); h.owner.canRecover = false;
    const normal = await h.controller.run(req(), history(), async () => ok());
    expect(normal.status).toBe(200); await normal.text();
    const child = history(); child.messages.push({ role: 'user', content: 'Distinct request' });
    const execute = vi.fn(async () => overflow());
    const blocked = await h.controller.run(req(), child, execute);
    expect(blocked.status).toBe(409);
    expect(h.backup).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('locks out competing requests during archive/recovery without replaying them', async () => {
    const h = fixture();
    const pending = deferred<string>(); const entered = deferred<void>();
    h.backup.mockImplementation(async () => { entered.resolve(); return pending.promise; });
    let calls = 0;
    const execute = vi.fn(async () => ++calls === 1 ? overflow() : ok());
    const recovering = h.controller.run(req(), history(), execute);
    await entered.promise;
    const competing = history(); competing.messages.push({ role: 'user', content: 'Competing inference' });
    expect((await h.controller.run(req(), competing, execute)).status).toBe(409);
    pending.resolve('/private/archive/first.json');
    const result = await recovering; expect(result.status).toBe(200); await result.text();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('retains the active Query projection across endTurn while releasing root replay sets', async () => {
    const h = fixture();
    let calls = 0;
    const first = await h.controller.run(req(), history(), async () => ++calls === 1 ? overflow() : ok());
    await first.text();
    h.controller.endTurn(); h.owner.scope = 'session:goal:turn-2';
    const execute = vi.fn(async (input: AnthropicRequest) => {
      expect(JSON.stringify(input).length).toBeLessThan(JSON.stringify(history()).length * 0.85);
      return ok();
    });
    const next = await h.controller.run(req(), history(), execute);
    expect(next.status).toBe(200); await next.text();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.backup).toHaveBeenCalledTimes(2);
    expect(h.onRecovery).toHaveBeenCalledTimes(1);
    expect(h.controller.beforeTool('increment_counter', { account: 'test', delta: 1 })).toContain('automatic_replay_blocked');
  });

  it('retains the archived success ledger across native compact, endTurn and a new-ID action in the next root', async () => {
    const h = fixture();
    let calls = 0;
    const first = await h.controller.run(req(), history(), async () => ++calls === 1 ? overflow() : ok());
    await first.text();
    h.controller.endTurn(); h.owner.scope = 'session:goal:turn-2';
    const input = { delta: 1, account: 'test' };
    // There may be no current product turn yet. An armed Query must fail closed.
    h.owner.scope = undefined;
    expect(h.controller.beforeTool('increment_counter', input)).toContain('automatic_replay_blocked');
    h.owner.scope = 'session:goal:turn-2';
    expect(h.controller.beforeTool('increment_counter', input)).toContain('already completed');
    const nativeCompacted: AnthropicRequest = { model: 'fixture-model', max_tokens: 128,
      messages: [{ role: 'user', content: 'Native compact summary: counter=1. Continue the same Goal.' }] };
    const next = await h.controller.run(req(), nativeCompacted, async () => ok());
    await next.text();
    let counter = 1;
    if (!h.controller.beforeTool('increment_counter', input)) counter++;
    expect(counter).toBe(1);
    h.owner.active = false;
    expect(h.controller.beforeTool('increment_counter', { delta: 7 })).toContain('automatic_replay_blocked');
  });

  it('restores an explicitly selected same-Goal checkpoint into a replacement Query', async () => {
    const source = history();
    const checkpoint = { body: source, archive: '/private/archive/restored.json',
      digest: createHash('sha256').update(JSON.stringify(source)).digest('hex') };
    const replacement = new ContextRecoveryController({ scope: () => 'replacement-query:same-session:same-goal',
      isActive: () => true, backup: async () => '/private/archive/next.json', initialCheckpoint: checkpoint });
    expect(replacement.beforeTool('increment_counter', { account: 'test', delta: 1 })).toContain('/private/archive/restored.json');
    replacement.endTurn();
    expect(replacement.beforeTool('increment_counter', { account: 'test', delta: 1 })).toContain('already completed');
    const fresh = fixture();
    fresh.controller.recordToolResult('increment_counter', { account: 'test', delta: 1 }, 'counter=1');
    expect(fresh.controller.beforeTool('increment_counter', { account: 'test', delta: 1 })).toBeUndefined();
  });

  it('rejects a corrupt checkpoint and remains fail closed for business tools and inference', async () => {
    const h = fixture();
    expect(() => h.controller.restoreCheckpoint(history(), '/private/archive/corrupt.json', 'bad-digest')).toThrow('context_recovery_required');
    expect(h.controller.beforeTool('increment_counter', { delta: 1 })).toContain('automatic_replay_blocked');
    const execute = vi.fn(async () => ok());
    expect((await h.controller.run(req(), history(), execute)).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });

  it('bounds the Query rescue ledger and blocks further business work instead of evicting completed evidence', async () => {
    const h = fixture();
    const body: AnthropicRequest = { model: 'fixture-model', max_tokens: 128, messages: [
      { role: 'assistant', content: 'old evidence '.repeat(60000) },
    ] };
    for (let index = 0; index < 2049; index++) body.messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: `write-${index}`, name: 'write_record', input: { index } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `write-${index}`, content: 'saved' }] },
    );
    const execute = vi.fn(async () => overflow());
    const result = await h.controller.run(req(), body, execute);
    expect(result.status).toBe(409);
    expect(await result.text()).toContain('ledger capacity');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.controller.beforeTool('write_record', { index: 2050 })).toContain('automatic_replay_blocked');
  });

  it('continues inference after its own duplicate-action denial without treating the denied call as an executed action', async () => {
    const h = fixture();
    let calls = 0;
    const first = await h.controller.run(req(), history(), async () => ++calls === 1 ? overflow() : ok());
    await first.text();
    const input = { account: 'test', delta: 1 };
    const reason = h.controller.beforeTool('increment_counter', input)!;
    expect(reason).toContain('automatic_replay_blocked:');
    h.controller.recordToolResult('increment_counter', input, reason, true);
    const next = history();
    next.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'denied-new-id', name: 'increment_counter', input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'denied-new-id', content: reason, is_error: true }] });
    const result = await h.controller.run(req(), next, async projected => {
      expect(projected.messages.at(-1)).toEqual(next.messages.at(-1));
      return ok();
    });
    expect(result.status).toBe(200); await result.text();
    expect(h.controller.beforeTool('increment_counter', input)).toContain('already completed');
  });

  it('does not trust a failed tool result merely because it mentions the guard marker', async () => {
    const h = fixture();
    let calls = 0;
    const first = await h.controller.run(req(), history(), async () => ++calls === 1 ? overflow() : ok());
    await first.text();
    const next = history();
    next.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'not-denied-id', name: 'increment_counter', input: { account: 'test', delta: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'not-denied-id', content: 'automatic_replay_blocked: untrusted error', is_error: true }] });
    const execute = vi.fn(async () => ok());
    expect((await h.controller.run(req(), next, execute)).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps projection and action guards active, allows native compacted history, and never recovers twice', async () => {
    const h = fixture();
    let calls = 0;
    const first = await h.controller.run(req(), history(), async () => ++calls === 1 ? overflow() : ok());
    await first.text();
    const compacted: AnthropicRequest = { model: 'fixture-model', max_tokens: 128,
      messages: [{ role: 'user', content: 'Native compact summary: counter is 1, continue the same Goal.' }] };
    const next = await h.controller.run(req(), compacted, async input => { expect(input).toEqual(compacted); return ok(); });
    await next.text();
    expect(h.controller.beforeTool('increment_counter', { delta: 1, account: 'test' })).toContain('already completed');
    expect(h.onRecovery).toHaveBeenCalledTimes(1);
    const later = history(); later.messages.push({ role: 'user', content: 'One more inference.' });
    const execute = vi.fn(async () => overflow());
    const failed = await h.controller.run(req(), later, execute);
    expect(failed.status).toBe(409);
    expect(await failed.text()).toContain('exhausted');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('seals a partial SSE stream and blocks even a changed-history replay', async () => {
    const h = fixture();
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
    const execute = vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    const response = await h.controller.run(req(), history(), execute);
    const reader = response.body!.getReader();
    output.enqueue(new TextEncoder().encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n'));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('partial');
    output.error(new Error('socket failed'));
    await expect(reader.read()).rejects.toThrow('socket failed');
    const changed = history(); changed.messages.push({ role: 'user', content: 'SDK automatic rescue' });
    expect((await h.controller.run(req(), changed, execute)).status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.backup).not.toHaveBeenCalled();
  });
  it('preserves native SDK internal system messages without reducing their instructions', async () => {
    const h = fixture();
    const body = history();
    const internal = { role: 'system', content: 'Protected native SDK instructions' };
    body.messages.splice(1, 0, internal as unknown as typeof body.messages[number]);
    let calls = 0;
    const response = await h.controller.run(req(), body, async projected => {
      if (++calls === 1) return overflow();
      expect(projected.messages[1]).toEqual(internal);
      return ok();
    });
    expect(response.status).toBe(200); await response.text();
  });

  it('durably reserves new actions, restores completed results, and blocks uncertain crash outcomes', async () => {
    let saved: unknown;
    const persistLedger = vi.fn(async value => { saved = structuredClone(value); });
    const create = (initialLedger?: unknown) => new ContextRecoveryController({
      scope: () => 'new-turn-same-goal', isActive: () => true,
      backup: async () => '/private/immutable-request.json', persistLedger, initialLedger,
    });
    const controller = create();
    let calls = 0;
    await (await controller.run(req(), history(), async () => ++calls === 1 ? overflow() : ok())).text();
    expect(persistLedger).toHaveBeenCalledTimes(1);
    expect(await controller.authorizeTool('write_record', { id: 'new' })).toBeUndefined();
    // Crash before a result: the next Query must refuse to repeat the action.
    const crashed = create(saved);
    expect(await crashed.authorizeTool('write_record', { id: 'new' })).toContain('uncertain');
    await controller.commitToolResult('write_record', { id: 'new' }, 'saved exactly once');
    const restarted = create(saved);
    expect(await restarted.authorizeTool('write_record', { id: 'new' })).toContain('already completed');
    expect(await restarted.authorizeTool('increment_counter', { delta: 1, account: 'test' })).toContain('already completed');
    expect(await restarted.authorizeTool('Read', { file_path: 'receipt' })).toBeUndefined();
  });

  it('continues after denying a duplicate of a newly committed post-recovery action', async () => {
    const controller = new ContextRecoveryController({ scope: () => 'same-goal', isActive: () => true,
      backup: async () => '/private/request.json', persistLedger: async () => {} });
    let calls = 0;
    await (await controller.run(req(), history(), async () => ++calls === 1 ? overflow() : ok())).text();
    const input = { id: 'new-record' };
    expect(await controller.authorizeTool('write_record', input)).toBeUndefined();
    await controller.commitToolResult('write_record', input, 'committed');
    const denial = await controller.authorizeTool('write_record', input);
    expect(denial).toContain('already completed');
    const compacted: AnthropicRequest = { model: 'fixture-model', max_tokens: 128, messages: [
      { role: 'user', content: 'Continue original Goal' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'new-write', name: 'write_record', input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new-write', content: 'committed' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'duplicate-new-id', name: 'write_record', input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'duplicate-new-id', is_error: true, content: denial }] },
    ] };
    const response = await controller.run(req(), compacted, async () => ok());
    expect(response.status).toBe(200); await response.text();
  });

  it('never authorizes a business action when its reservation cannot be committed', async () => {
    let fail = false;
    const controller = new ContextRecoveryController({ scope: () => 'same-goal', isActive: () => true,
      backup: async () => '/private/request.json', persistLedger: async () => { if (fail) throw new Error('disk full'); } });
    let calls = 0;
    await (await controller.run(req(), history(), async () => ++calls === 1 ? overflow() : ok())).text();
    fail = true;
    expect(await controller.authorizeTool('write_record', { id: 2 })).toContain('execution stopped');
    expect(await controller.authorizeTool('write_record', { id: 3 })).toContain('automatic_replay_blocked');
  });

  it('rejects corrupt or oversized persisted ledgers before inference starts', () => {
    expect(() => new ContextRecoveryController({ scope: () => 'turn', isActive: () => true,
      backup: async () => 'unused', initialLedger: { version: 2 } })).toThrow('context_recovery_required');
  });

});
