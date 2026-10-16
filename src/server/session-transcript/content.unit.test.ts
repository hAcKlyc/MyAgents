import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTranscriptBatch, createTranscriptProjection, transcriptMessages } from '../../shared/sessionTranscript';
import { ProductTranscriptContent } from './content';
import { TranscriptWriter } from './writer';

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const durable = createTranscriptProjection();
  const append = vi.fn(async (_expected, batch) => { applyTranscriptBatch(durable, batch.operations); });
  const writer = new TranscriptWriter({
    sessionId: 's1', generation: 'g1', revision: 0, projection: createTranscriptProjection(),
    storage: { append, replace: vi.fn() },
  });
  const content = new ProductTranscriptContent(writer);
  const user = (id: string) => content.admitUser({ id, role: 'user', content: id, timestamp: '2026-09-12T00:00:00Z' });
  return { writer, content, user, durable, append };
}

describe('adapter product content identities', () => {
  it('bounds activity timing updates to one per epoch second while preserving exact start and finish', async () => {
    const { writer, content, user } = setup();
    vi.setSystemTime(10_123);
    user('u1');
    const tool = content.startTool('stream', 'Bash')!;
    const observed: import('../../shared/sessionTranscript').TranscriptOperation[] = [];
    writer.subscribeOperations(operation => observed.push(operation));
    const timingCount = () => observed.filter(operation => operation.kind === 'block-update' && operation.details.executionTiming).length;
    for (let index = 0; index < 1_000; index++) {
      vi.setSystemTime(10_124 + index % 876);
      content.append(tool, 'result', 'x');
    }
    console.info(`[timing-sample] deltas=1000 same-second timing-updates=${timingCount()}`);
    expect(timingCount()).toBe(0);
    vi.setSystemTime(11_321);
    content.append(tool, 'result', 'next second');
    expect(timingCount()).toBe(1);
    expect(content.readTool(tool)?.executionTiming).toEqual({ startedAt: 10_123, lastActivityAt: 11_321, source: 'observed' });
    vi.setSystemTime(11_876);
    content.append(tool, 'result', 'same second');
    expect(timingCount()).toBe(1);
    content.updateTool(tool, { isLoading: false }, true);
    expect(timingCount()).toBe(2);
    expect(content.readTool(tool)?.executionTiming).toEqual({ startedAt: 10_123, lastActivityAt: 11_876, finishedAt: 11_876, source: 'observed' });
    vi.setSystemTime(12_500);
    content.confirmAttachments(tool, [{ path: 'ready' }]);
    expect(timingCount()).toBe(2);
    await writer.close();
  });

  it('persists backend observation timing without treating input completion or late attachments as execution completion', async () => {
    const { writer, content, user, durable } = setup();
    vi.setSystemTime(10_000);
    user('u1');
    const tool = content.startTool('read', 'Read')!;
    const child = content.startTool('child', 'Bash', {}, 'read')!;
    const text = content.block('text', 'text', { text: '', isComplete: false });
    expect(content.readTool(tool)?.executionTiming).toEqual({ startedAt: 10_000, lastActivityAt: 10_000, source: 'observed' });
    vi.setSystemTime(10_100);
    content.confirmInput(tool, { path: 'file' });
    expect(content.readTool(tool)?.executionTiming).toMatchObject({ lastActivityAt: 10_000 });
    expect((content.readTool(tool)?.executionTiming as Record<string, unknown>).finishedAt).toBeUndefined();
    vi.setSystemTime(10_200);
    content.append(text, 'text', 'answer');
    content.append(child, 'result', 'partial');
    expect(content.readTool(child)?.executionTiming).toMatchObject({ startedAt: 10_000, lastActivityAt: 10_000 });
    vi.setSystemTime(10_300);
    content.updateTool(tool, { isLoading: false, isError: true }, true);
    content.updateBlock(text, { isComplete: true });
    expect(content.readTool(tool)?.executionTiming).toMatchObject({ finishedAt: 10_300 });
    expect(content.readBlock(text)?.executionTiming).toMatchObject({ finishedAt: 10_300 });
    vi.setSystemTime(10_400);
    content.confirmAttachments(tool, [{ pendingId: 'a' }]);
    content.updateAttachment(tool, 'a', { path: 'ready' });
    content.updateTool(tool, { isLoading: false });
    expect(content.readTool(tool)?.executionTiming).toMatchObject({ finishedAt: 10_300, lastActivityAt: 10_300 });
    // Parent terminal does not claim a still-running child's completion.
    content.finishTurn('error');
    expect((content.readTool(child)?.executionTiming as Record<string, unknown>).finishedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(transcriptMessages(durable)).toEqual(transcriptMessages(writer.projection));
    const restored = new ProductTranscriptContent(writer);
    vi.setSystemTime(20_000);
    expect(restored.startTool('read', 'Read')).toEqual(tool);
    expect(restored.readTool(tool)?.executionTiming).toMatchObject({ startedAt: 10_000, finishedAt: 10_300 });
    await writer.close();
  });

  it('keeps timing unknown for legacy blocks and does not invent a start on late result completion', async () => {
    const { writer, content, user } = setup();
    user('u1');
    const target = content.block('legacy', 'tool_use', { tool: { id: 'legacy', name: 'Read', isLoading: true } });
    content.append(target, 'result', 'late');
    content.updateTool(target, { isLoading: false }, true);
    expect(content.readTool(target)?.executionTiming).toBeUndefined();
    const restored = new ProductTranscriptContent(writer);
    expect(restored.startTool('legacy', 'Read')).toEqual(target);
    expect(restored.readTool(target)?.executionTiming).toBeUndefined();
    await writer.close();
  });

  it.each(['complete','stopped','error','interrupted'] as const)('exposes only running turn start and clears it after %s', async status => {
    const {content,writer,user} = setup();
    expect(content.executionStartedAt).toBeUndefined();
    user('u1');
    expect(content.executionStartedAt).toBe('2026-09-12T00:00:00Z');
    content.finishTurn(status);
    expect(content.executionStartedAt).toBeUndefined();
    content.admitUser({id:'u2',role:'user',content:'next',timestamp:'2026-09-12T01:00:00Z'});
    expect(content.executionStartedAt).toBe('2026-09-12T01:00:00Z');
    await writer.close();
  });
  it('keeps diagnostics independent while native text, attachments and usage settle on their original targets', async () => {
    const { writer, content, user, durable } = setup();
    user('u1');
    const text = content.block('native:text', 'text', { text: '' });
    content.append(text, 'text', 'partial');
    const tool = content.startTool('native-tool', 'Read')!;
    content.confirmAttachments(tool, [{ pendingId: 'attachment' }]);
    const nativeId = content.currentAssistantId;
    writer.observe({ kind: 'message-update', messageId: nativeId!, details: { sdkUuid: 'native-a' } });
    content.appendDiagnostic('Error: failed');
    expect(content.currentAssistantId).toBe(nativeId);
    expect(content.currentTurn?.id).toBe('u1');
    content.confirmText(text, 'text', 'complete native text');
    expect(content.block('native:text', 'text')).toEqual(text);
    content.finishTurn('error', { usage: { inputTokens: 2, outputTokens: 3 } });
    expect(content.updateAttachment(tool, 'attachment', { id: 'saved', path: 'file' })).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    const rows = transcriptMessages(durable);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ id: nativeId, sdkUuid: 'native-a', usage: { inputTokens: 2, outputTokens: 3 } });
    expect(JSON.parse(rows[1].content)[0].text).toBe('complete native text');
    expect(content.readTool(tool)?.attachments).toEqual([{ id: 'saved', path: 'file' }]);
    expect(rows[2]).toMatchObject({ messageKind: 'diagnostic', content: 'Error: failed', turnId: 'u1', transcriptState: 'complete' });
    expect(rows[2].sdkUuid).toBeUndefined();
    expect(rows[2].usage).toBeUndefined();
    expect([...durable.turns.values()]).toMatchObject([{ status: 'error', usage: { inputTokens: 2, outputTokens: 3 } }]);
    content.removeMessages([nativeId!]);
    expect(content.updateAttachment(tool, 'attachment', { id: 'late' })).toBe(false);
    expect(writer.projection.messages.has(nativeId!)).toBe(false);
    await writer.close();
  });

  it('does not create a native assistant or duplicate usage for a diagnostic-only turn', async () => {
    const { writer, content, user, durable } = setup();
    user('u1');
    content.appendDiagnostic('Error: before native output');
    expect(content.currentAssistantId).toBeNull();
    content.finishTurn('error', { usage: { inputTokens: 1, outputTokens: 0 } });
    await vi.advanceTimersByTimeAsync(100);
    expect(transcriptMessages(durable)[1].usage).toBeUndefined();
    expect([...durable.turns.values()]).toMatchObject([{ usage: { inputTokens: 1, outputTokens: 0 } }]);
    await writer.close();
  });

  it('retains interleaved segments and updates a preceding tool after a steer and terminal', async () => {
    const { writer, content, user, durable } = setup();
    const started: string[] = [];
    writer.subscribeOperations(operation => {
      if (operation.kind === 'message-create' && operation.message.role === 'assistant') started.push(operation.message.id);
    });
    user('u1');
    const text1 = content.block('text', 'text', { text: '' });
    content.append(text1, 'text', 'before steer');
    const tool = content.startTool('tool-1', 'Read')!;
    user('u2');
    const text2 = content.block('text', 'text', { text: '' });
    content.append(text2, 'text', 'after steer');
    content.finishTurn('complete', { usage: { inputTokens: 10, outputTokens: 20 } });
    content.confirmText(tool, 'result', 'late result');
    content.updateTool(tool, { isLoading: false }, true);
    await vi.advanceTimersByTimeAsync(100);
    expect([...durable.messages.keys()]).toEqual(['u1', started[0], 'u2', started[1]]);
    expect(content.readTool(tool)?.result).toBe('late result');
    expect(durable.turns.size).toBe(1);
    expect(transcriptMessages(durable)).toEqual(transcriptMessages(writer.projection));
    await writer.close();
  });

  it('confirms the same block without duplicating partial text and preserves nested input/results', async () => {
    const { writer, content, user, durable } = setup();
    user('u1');
    const text = content.block('native-1:block-0', 'text', { text: '' });
    content.append(text, 'text', 'hel');
    content.confirmText(text, 'text', 'hello');
    content.confirmText(text, 'text', 'hello');
    content.confirmText(text, 'text', 'corrected');
    const parent = content.startTool('parent', 'Agent')!;
    const child = content.startTool('child', 'Read', {}, 'parent')!;
    content.append(child, 'inputJson', '{"path":');
    content.confirmInput(child, { path: '/file' });
    content.confirmText(child, 'result', 'result');
    content.updateTool(child, { isLoading: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(content.readBlock(text)?.text).toBe('corrected');
    expect(content.readTool(parent)?.subagentCalls).toHaveLength(1);
    const stored = JSON.parse(transcriptMessages(durable)[1].content);
    expect(stored[1].tool.subagentCalls[0]).toMatchObject({ input: { path: '/file' }, result: 'result', isLoading: false });
    await writer.close();
  });

  it('continues accepting content while product IO is unresolved', async () => {
    const { writer, content, user, append } = setup();
    let release!: () => void;
    append.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    user('u1');
    const block = content.block('text', 'text', { text: '' });
    content.append(block, 'text', 'first');
    await vi.advanceTimersByTimeAsync(100);
    user('u2');
    content.append(content.block('text', 'text', { text: '' }), 'text', 'continues');
    content.appendDiagnostic('Error: optional product IO is still pending');
    content.finishTurn('complete');
    expect(writer.projection.messages.size).toBe(5);
    expect(content.currentTurn?.status).toBe('complete');
    expect(append).toHaveBeenCalledTimes(1);
    release();
    await writer.close();
  });
});
