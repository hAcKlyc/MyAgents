import { describe, expect, it } from 'vitest';
import { buildNextPromptContext, cleanNextPromptSuggestion, eligibleNextPromptAnchor, parseNextPromptSuggestionRequest } from './nextPromptSuggestion';
import type { SessionMessage } from './types/session-message';
const assistant: SessionMessage = { id: 'a', role: 'assistant', content: '完成分析，下一步可测试', timestamp: '', transcriptState: 'complete' };
describe('next prompt contract', () => {
  it('accepts only anchor identifiers, rejects renderer transcript and provider injection', () => {
    expect(parseNextPromptSuggestionRequest({ sessionId: 's', anchorMessageId: 'a' })).toEqual({ sessionId: 's', anchorMessageId: 'a' });
    expect(parseNextPromptSuggestionRequest({ sessionId: 's', anchorMessageId: 'a', transcript: 'override' })).toBeNull();
    expect(parseNextPromptSuggestionRequest({ sessionId: '', anchorMessageId: 'a' })).toBeNull();
  });
  it('never skips newer user, interrupted, diagnostic or failed replies', () => {
    expect(eligibleNextPromptAnchor([assistant], 'a')).toBe(assistant);
    expect(eligibleNextPromptAnchor([assistant, { ...assistant, id: 'u', role: 'user' }], 'a')).toBeNull();
    for (const patch of [{ completionState: 'partial' as const }, { terminalStatus: 'error' as const }, { transcriptState: 'interrupted' as const }, { messageKind: 'diagnostic' as const }]) {
      expect(eligibleNextPromptAnchor([{ ...assistant, ...patch }], 'a')).toBeNull();
    }
  });
  it('keeps short Unicode plain text and refuses multi-line, oversized and null output', () => {
    expect(cleanNextPromptSuggestion('"请测试刚才的改动。"')).toBe('请测试刚才的改动。');
    expect(cleanNextPromptSuggestion('😀'.repeat(420))).toHaveLength(840);
    for (const text of ['😀'.repeat(421), 'null', 'a\nb']) expect(cleanNextPromptSuggestion(text)).toBeNull();
  });
  it('projects text blocks only and bounds recent context', () => {
    const context = buildNextPromptContext(Array.from({ length: 20 }, (_, i) => ({ ...assistant, id: String(i), content: JSON.stringify([{ type: 'text', text: 'x'.repeat(6000) }, { type: 'tool_use', input: 'secret' }]) })));
    expect(context.length).toBeLessThanOrEqual(10_000);
    expect(context).not.toContain('secret');
    expect(new TextEncoder().encode(buildNextPromptContext([{ ...assistant, content: '\u0000'.repeat(6000) }])).length).toBeLessThanOrEqual(10_000);
  });
});
