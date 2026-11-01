import { describe, expect, it } from 'vitest';

import { parseCompatibleServerSearchContent } from './canonical-web-search-content';

describe('compatible server-search data content', () => {
  it.each(['nodes', 'depth', 'bytes', 'fragments', 'unknown-envelope'] as const)(
    'omits uninspected error data at the %s boundary without losing earlier valid hits', boundary => {
      const blocked = { type: 'web_search_tool_result_error', error_code: 'invalid_tool_input', error_message: 'Synthetic rejection (1301)' };
      const privateError = { ...blocked, error_message: 'synthetic-error-secret-canary (1301)' };
      const source = { title: 'Source', url: 'https://example.com/source' };
      let tail: unknown;
      if (boundary === 'nodes') tail = [...Array.from({ length: 1998 }, () => source), privateError];
      else if (boundary === 'depth') {
        tail = privateError;
        for (let index = 0; index < 10; index += 1) tail = { content: tail };
      } else if (boundary === 'bytes') tail = JSON.stringify({ ...privateError, padding: 'x'.repeat(262145) });
      else if (boundary === 'fragments') tail = `${'[]'.repeat(100)}${JSON.stringify(privateError)}${JSON.stringify(privateError)}`;
      else tail = { diagnostics: privateError };
      const value = boundary === 'nodes' ? [blocked, ...tail as unknown[]] : [blocked, source, tail];
      const parsed = parseCompatibleServerSearchContent(value, 'zhipu');
      expect(parsed.results.length).toBeGreaterThan(0);
      expect(parsed.unverified).toBe(true);
      expect(JSON.stringify(parsed)).not.toContain('synthetic-error-secret-canary');
    },
  );

  it.each(['', '  \n '])('uses provider content when snippet is blank (%#)', (snippet) => {
    expect(parseCompatibleServerSearchContent({ url: 'https://example.com', snippet, content: 'Source excerpt' }).results)
      .toEqual([{ url: 'https://example.com', snippet: 'Source excerpt' }]);
  });

  it('preserves a meaningful snippet over content', () => {
    expect(parseCompatibleServerSearchContent({ url: 'https://example.com', snippet: 'Summary', content: 'Full text' }).results)
      .toEqual([{ url: 'https://example.com', snippet: 'Summary' }]);
  });

  it('decodes a single-quoted data envelope and preserves escaped source strings', () => {
    expect(parseCompatibleServerSearchContent("[{'text': [{'title': 'Reader\\'s source', 'link': 'https://example.com', 'content': 'First\\nSecond'}]}]"))
      .toEqual({ results: [{ title: "Reader's source", url: 'https://example.com', snippet: 'First\nSecond' }], unverified: false, text: [] });
  });

  it('accepts explicit empty arrays as completed searches without hits', () => {
    expect(parseCompatibleServerSearchContent('[]')).toEqual({ results: [], unverified: false, text: [] });
    expect(parseCompatibleServerSearchContent("[{'text': []}]")).toEqual({ results: [], unverified: false, text: [] });
  });

  it('decodes concatenated result containers with quoted brackets and preserves a trailing unknown fragment', () => {
    expect(parseCompatibleServerSearchContent(
      "[{'text': [{'title': 'Source [one]', 'link': 'https://example.com/1'}]}]"
      + JSON.stringify([[{ title: 'Source two', link: 'https://example.com/2', content: 'A "]" in text' }]])
      + 'Unparsed trailing service text',
    )).toEqual({
      results: [
        { title: 'Source [one]', url: 'https://example.com/1', snippet: '' },
        { title: 'Source two', url: 'https://example.com/2', snippet: 'A "]" in text' },
      ],
      unverified: true, text: ['Unparsed trailing service text'],
    });
  });

  it.each([
    'Search found https://example.com',
    "[{'text': 'Opaque provider commentary'}]",
    "[{'text': [{'title': 'Missing URL'}]}]",
    "[{'text': [], 'sideEffect': (() => { throw Error('never execute') })()}]",
    '['.repeat(262145),
  ])('retains unknown data without evaluating it or inventing citations (%#)', (value) => {
    expect(parseCompatibleServerSearchContent(value)).toMatchObject({ results: [], unverified: true, text: [expect.any(String)] });
  });

  it.each(['results', 'search_result', 'search_results'])('accepts the %s envelope and preserves partial results', (field) => {
    expect(parseCompatibleServerSearchContent({ [field]: [
      { title: 'Source', url: 'https://example.com', content: {} },
      { text: 'Opaque service response' },
    ] })).toEqual({
      results: [{ title: 'Source', url: 'https://example.com', snippet: '' }],
      unverified: true, text: ['Opaque service response'],
    });
  });

  it.each([
    "[{'error': 'synthetic private provider message'}]",
    { type: 'web_search_tool_result_error', error_code: 'unavailable' },
    [{ url: 'https://example.com' }, { type: 'error', message: 'private service error' }],
  ])('keeps explicit service errors as sanitized failures (%#)', (value) => {
    const parsed = parseCompatibleServerSearchContent(value);
    expect(parsed.failures).toEqual([expect.objectContaining({ message: expect.stringContaining('Provider WebSearch failed') })]);
    expect(parsed.failures?.[0]?.message).not.toContain('synthetic private provider message');
    expect(parsed.text).toEqual([]);
  });

  it('keeps valid hits while collecting errors from nested compatible containers', () => {
    const parsed = parseCompatibleServerSearchContent({ results: [
      { type: 'web_search_tool_result_error', error_code: 'invalid_tool_input',
        error_message: 'Synthetic details with https://private.example/ignored (1301)' },
      { title: 'Source', url: 'https://example.com/source' },
    ] }, 'zhipu');
    expect(parsed.results).toEqual([{ title: 'Source', url: 'https://example.com/source', snippet: '' }]);
    expect(parsed.failures?.[0]).toMatchObject({ providerErrorCode: '1301', message: expect.stringContaining('input or generated content') });
    expect(JSON.stringify(parsed)).not.toContain('private.example');
    expect(parsed.text).toEqual([]);
  });

  it('does not apply Zhipu business-code meanings to another Provider', () => {
    const parsed = parseCompatibleServerSearchContent({ type: 'web_search_tool_result_error',
      error_code: 'invalid_tool_input', error_message: 'Synthetic details (1301)' }, 'another-provider');
    expect(parsed.failures?.[0]).toMatchObject({ providerErrorCode: 'invalid_tool_input' });
    expect(parsed.failures?.[0]?.message).not.toContain('1301');
  });
});
