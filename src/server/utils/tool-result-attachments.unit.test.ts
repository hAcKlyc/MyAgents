import { describe, expect, it } from 'vitest';

import { extractToolResultRenderParts } from './tool-result-attachments';

describe('extractToolResultRenderParts', () => {
  it('extracts MCP image content blocks without leaking base64 into text', () => {
    const result = extractToolResultRenderParts([
      { type: 'text', text: 'screenshot captured' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);

    expect(result.text).toBe('screenshot captured');
    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        source: { kind: 'base64', data: 'aGVsbG8=' },
      },
    ]);
  });

  it('extracts Anthropic base64 image source blocks', () => {
    const result = extractToolResultRenderParts([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: 'ZmFrZQ==',
        },
      },
    ]);

    expect(result.text).toBe('');
    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/jpeg',
        source: { kind: 'base64', data: 'ZmFrZQ==' },
      },
    ]);
  });

  it('redacts unknown base64-like fields when falling back to JSON text', () => {
    const payload = 'a'.repeat(300);
    const result = extractToolResultRenderParts({ type: 'unknown', data: payload });

    expect(result.attachments).toEqual([]);
    expect(result.text).toContain('[300 bytes omitted]');
    expect(result.text).not.toContain(payload);
  });
});
