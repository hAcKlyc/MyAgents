import { describe, expect, it } from 'vitest';
import type { TranscriptBlock, TranscriptObject } from '../../shared/sessionTranscript';
import { CLIENT_HISTORY_AUXILIARY_MAX_BYTES, shrinkReplayContentForClient } from '../utils/session-message-preview';
import { toClientTranscriptOperation } from './client';

describe('V2 transcript display transport', () => {
  it('keeps tool identity and state without duplicating the existing large-value payload channel', () => {
    const large = 'x'.repeat(8 * 1024 * 1024);
    expect(toClientTranscriptOperation({ kind: 'text-append', messageId: 'a', blockId: 'b', field: 'result', offset: 0, text: large })).toBeNull();
    expect(toClientTranscriptOperation({ kind: 'text-append', messageId: 'a', blockId: 'b', field: 'inputJson', offset: 0, text: large })).toBeNull();
    const projected = toClientTranscriptOperation({ kind: 'block-upsert', messageId: 'old-assistant', block: {
      id: 'original-block', type: 'tool_use', tool: {
        id: 'tool', name: 'Task', input: { body: large }, result: large, isLoading: false,
        subagentCalls: [{ id: 'child', name: 'Read', inputJson: large, result: large, isLoading: false }],
      },
    } });
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(1024);
    expect(projected).toMatchObject({ messageId: 'old-assistant', block: { id: 'original-block', tool: {
      id: 'tool', name: 'Task', isLoading: false, subagentCalls: [{ id: 'child', name: 'Read', isLoading: false }],
    } } });
    expect(toClientTranscriptOperation({ kind: 'block-update', messageId: 'a', blockId: 'b', target: 'tool', details: { result: large, inputComplete: true } })).toBeNull();
  });

  it('preserves full body through V2 message creation and content confirmation', () => {
    const content = [{ id: 'body', type: 'text' as const, text: '正文😀'.repeat(100_000) }];
    expect(toClientTranscriptOperation({ kind: 'message-create', message: {
      id: 'message', role: 'assistant', timestamp: '2026-10-14T00:00:00Z', content,
    } })).toMatchObject({ message: { content } });
    expect(toClientTranscriptOperation({ kind: 'content-confirm', messageId: 'message', content })).toMatchObject({ content });
  });

  it('preserves stable IDs for blocks retained in an extreme REST preview', () => {
    const blocks: TranscriptBlock[] = Array.from({ length: 1800 }, (_, index) => ({
      id: `block-${index}`, type: 'tool_use', tool: { id: `tool-${index}`, name: 'Read', result: 'x'.repeat(2048) },
    }));
    const projected = shrinkReplayContentForClient(blocks) as TranscriptObject[];
    expect(Array.isArray(projected)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(CLIENT_HISTORY_AUXILIARY_MAX_BYTES);
    const tools = projected.filter(block => block.type === 'tool_use');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThan(blocks.length);
    for (const block of tools) {
      const original = blocks.find(value => value.id === block.id);
      expect(original).toBeDefined();
      expect((block.tool as TranscriptObject).id).toBe((original!.tool as TranscriptObject).id);
    }
  });
});
