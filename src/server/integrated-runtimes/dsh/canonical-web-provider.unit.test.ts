import { describe, expect, it, vi } from 'vitest';

import { DshCanonicalWebProvider } from './canonical-web-provider';
import { DshCanonicalWebError } from './canonical-web-errors';
import { OFFICIAL_DEEPSEEK_ANTHROPIC_BASE_URL } from '../../../shared/integrated-runtimes/provider-constraints';
import type { DshModelExecutionProfile } from './profile-compiler';
import type { DshRawHttpResponse, DshSafeHttpTransport } from './safe-http';

const anthropicProfile: DshModelExecutionProfile = Object.freeze({
  revision: 'anthropic-profile-v1',
  providerRouteId: 'myagents-anthropic-api-anthropic-messages',
  api: 'anthropic-messages',
  provider: 'anthropic-api',
  modelId: 'claude-sonnet-4-6',
  baseUrl: 'https://api.anthropic.com',
  credentialRef: 'MYAGENTS_PROVIDER_ANTHROPIC_API_API_KEY',
  contextWindow: 200_000,
  maxTokens: 64_000,
});

const zhipuProfile: DshModelExecutionProfile = Object.freeze({
  revision: 'zhipu-profile-v1',
  providerRouteId: 'myagents-zhipu-ai-openai-completions',
  api: 'openai-completions',
  provider: 'zhipu-ai',
  modelId: 'glm-5.3',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  credentialRef: 'MYAGENTS_PROVIDER_ZHIPU_AI_API_KEY',
  contextWindow: 1_000_000,
  maxTokens: 131_072,
});

const zhipuAnthropicProfile: DshModelExecutionProfile = Object.freeze({
  revision: 'zhipu-anthropic-profile-v1',
  providerRouteId: 'myagents-zhipu-anthropic-messages',
  api: 'anthropic-messages',
  provider: 'zhipu',
  modelId: 'glm-5.3',
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  credentialRef: 'MYAGENTS_PROVIDER_ZHIPU_API_KEY',
  contextWindow: 1_000_000,
  maxTokens: 131_072,
});

function json(value: unknown): DshRawHttpResponse {
  return Object.freeze({
    statusCode: 200,
    headers: Object.freeze({ 'content-type': 'application/json' }),
    bytes: Buffer.from(JSON.stringify(value)),
  });
}

function jsonStatus(statusCode: number, value: unknown): DshRawHttpResponse {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ 'content-type': 'application/json' }),
    bytes: Buffer.from(JSON.stringify(value)),
  });
}

function providerWith(dispatch: DshSafeHttpTransport['dispatch']): DshCanonicalWebProvider {
  return new DshCanonicalWebProvider({
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]),
    transport: { dispatch },
  });
}

describe('DshCanonicalWebProvider', () => {
  it('uses local Provider endpoints and accepts explicit localhost search domains', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async () => json({
      stop_reason: 'end_turn', content: [{ type: 'web_search_tool_result', content: [
        { title: 'Local documentation', url: 'http://localhost:3000/docs', snippet: 'Local evidence' },
      ] }],
    }));
    const provider = new DshCanonicalWebProvider({
      lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]),
      transport: { dispatch },
    });
    try {
      const result = await provider.runSearch({
        profile: { ...anthropicProfile, baseUrl: 'http://localhost:3000' },
        apiKey: 'synthetic-key', authType: 'api_key', query: 'Local documentation',
        allowedDomains: ['localhost'], operationId: 'local-search', signal: new AbortController().signal,
      });
      expect(result.results).toEqual([expect.objectContaining({ url: 'http://localhost:3000/docs' })]);
      expect(dispatch.mock.calls[0]?.[0].origin).toBe('http://localhost:3000');
    } finally {
      await provider.close();
    }
  });

  it.each(['anthropic-messages', 'openai-completions', 'openai-responses'] as const)(
    'keeps a valid WebFetch answer without usage on %s', async api => {
      const payload = {
        content: [{ type: 'text', text: 'Grounded answer' }],
        choices: [{ message: { content: 'Grounded answer' } }],
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Grounded answer' }] }],
      };
      const result = await providerWith(vi.fn(async () => json(payload))).runUtility({
        profile: { ...anthropicProfile, api }, apiKey: 'synthetic-key', authType: 'api_key',
        source: 'Fixture source', prompt: 'Summarize', finalUrl: 'https://example.com/',
        statusCode: 200, signal: new AbortController().signal,
      });
      expect(result.answer).toBe('Grounded answer');
      expect(result.usage).toBeUndefined();
    },
  );

  it.each([null, { input_tokens: 2, output_tokens: 'unknown', server_tool_use: 'unknown' }])(
    'keeps valid WebSearch results when usage is unavailable: %j', async usage => {
      const provider = providerWith(vi.fn(async () => json({
        stop_reason: 'end_turn', usage,
        content: [
          { type: 'server_tool_use', id: 'search-1', name: 'web_search', input: {} },
          { type: 'web_search_tool_result', tool_use_id: 'search-1', content: [{ title: 'Source', url: 'https://example.com/' }] },
        ],
      })));
      const result = await provider.runSearch({
        profile: anthropicProfile, apiKey: 'synthetic-key', authType: 'api_key',
        query: 'Fixture search', operationId: 'search-1', signal: new AbortController().signal,
      });
      expect(result.results).toEqual([expect.objectContaining({ title: 'Source', url: 'https://example.com/' })]);
      expect(result.usage).toBeUndefined();
    },
  );

  it('merges repeated server result blocks and retains partial opaque text without fabricating citations', async () => {
    const provider = providerWith(vi.fn(async () => json({
      stop_reason: 'end_turn',
      content: [
        { type: 'server_tool_use', id: 'server-1', name: 'vendor_search_v2', input: {} },
        { type: 'tool_result', tool_use_id: 'server-1', content: { results: [{ title: 'Source', url: 'https://example.com/source' }] } },
        { type: 'tool_result', tool_use_id: 'server-1', content: [{ title: 'Source', link: 'https://example.com/source' }, { text: 'Unconfirmed https://unconfirmed.test' }] },
        { type: 'text', text: 'Service summary' },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    })));
    await expect(provider.runSearch({
      profile: zhipuAnthropicProfile, apiKey: 'synthetic-key', authType: 'both', query: 'synthetic search',
      operationId: 'partial-search', signal: new AbortController().signal,
    })).resolves.toMatchObject({
      results: [{ title: 'Source', url: 'https://example.com/source', snippet: '' }],
      citations: [{ title: 'Source', url: 'https://example.com/source' }], searchCount: 1,
      answer: 'Unconfirmed https://unconfirmed.test\n\nService summary', warnings: ['unverified_search_results'],
    });
  });

  it('bounds the complete output including JSON escaping, source links and retained text', async () => {
    const provider = providerWith(vi.fn(async () => json({
      stop_reason: 'max_tokens',
      content: [{ type: 'web_search_tool_result', content: [
        ...Array.from({ length: 120 }, (_, index) => ({ title: `Source ${index}`, url: `https://example.com/${index}`, snippet: '字'.repeat(2700) })),
        { text: '\u0000'.repeat(65000) },
      ] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })));
    const result = await provider.runSearch({
      profile: zhipuAnthropicProfile, apiKey: 'synthetic-key', authType: 'both', query: 'synthetic search',
      operationId: 'large-search', signal: new AbortController().signal,
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(262144);
    expect(result).toMatchObject({ truncated: true, warnings: ['unverified_search_results'] });
    expect((result.results as unknown[]).length).toBeGreaterThan(0);
    expect((result.results as unknown[]).length).toBeLessThan(100);
    expect((result.citations as unknown[]).length).toBe((result.results as unknown[]).length);
  });

  it('projects only a correlated compatible search result and applies domain policy', async () => {
    const provider = providerWith(vi.fn(async () => json({
      stop_reason: 'end_turn',
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_prime', name: 'web_search_prime', input: { search_query: 'synthetic search' } },
        { type: 'tool_result', tool_use_id: 'srvtoolu_prime', content: "[{'text': [{'title': 'Source', 'link': 'https://example.com/source', 'content': 'Search snippet'}, {'title': 'Excluded', 'link': 'https://excluded.test/source', 'content': 'Excluded snippet'}]}]" },
        { type: 'text', text: 'Untrusted assistant commentary with https://invented.test' },
      ],
      usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 0 } },
    })));
    await expect(provider.runSearch({
      profile: zhipuAnthropicProfile, apiKey: 'synthetic-key', authType: 'both', query: 'synthetic search',
      allowedDomains: ['example.com'], operationId: 'prime-search', signal: new AbortController().signal,
    })).resolves.toMatchObject({
      results: [{ title: 'Source', url: 'https://example.com/source', snippet: 'Search snippet' }],
      citations: [{ title: 'Source', url: 'https://example.com/source' }], searchCount: 1,
    });
  });

  it.each([
    { name: 'web_reader', callId: 'server-1', resultId: 'server-1', isError: false },
    { name: 'web_search_prime', callId: 'server-1', resultId: 'unrelated', isError: false },
    { name: 'web_search_prime', callId: 'server-1', resultId: 'server-1', isError: true },
  ])('accepts renamed server tools but never promotes unrelated results (%j)', async ({ name, callId, resultId, isError }) => {
    const provider = providerWith(vi.fn(async () => json({
      stop_reason: 'end_turn',
      content: [
        { type: 'server_tool_use', id: callId, name, input: {} },
        { type: 'tool_result', tool_use_id: resultId, is_error: isError, content: "[{'text': [{'title': 'Source', 'link': 'https://example.com', 'content': 'Synthetic'}]}]" },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    })));
    const request = provider.runSearch({
      profile: zhipuAnthropicProfile, apiKey: 'synthetic-key', authType: 'both', query: 'synthetic search',
      operationId: 'unrelated-search', signal: new AbortController().signal,
    });
    if (isError) await expect(request).rejects.toMatchObject({ code: 'provider_search_failed' });
    else if (callId !== resultId) await expect(request).resolves.toMatchObject({ results: [], citations: [], answer: '', warnings: ['unverified_search_results'] });
    else await expect(request).resolves.toMatchObject({ results: [{ url: 'https://example.com/' }], citations: [{ url: 'https://example.com/' }] });
  });

  it.each(['direct', 'proxy'] as const)('uses the native DeepSeek Search API on the Host %s route', async (route) => {
    const profile: DshModelExecutionProfile = Object.freeze({
      ...zhipuAnthropicProfile, provider: 'deepseek', providerRouteId: 'deepseek-official',
      modelId: 'deepseek-v4-pro', baseUrl: OFFICIAL_DEEPSEEK_ANTHROPIC_BASE_URL,
    });
    const inspect = vi.fn(async (url: URL, request: { headers?: Readonly<Record<string, string>>; body?: Uint8Array }) => {
      expect(url.toString()).toBe('https://api.deepseek.com/v1/tools/search');
      expect(request.headers).toMatchObject({ authorization: 'Bearer synthetic-key' });
      expect(request.headers).not.toHaveProperty('anthropic-version');
      expect(JSON.parse(Buffer.from(request.body ?? []).toString())).toEqual({
        query: 'synthetic search', count: 8, need_content: false,
      });
      return json({
        results: [{ title: 'Source', url: 'https://example.com', summary: 'Grounded summary', snippet: 'Short UI snippet' }],
      });
    });
    const direct = vi.fn<DshSafeHttpTransport['dispatch']>(async (url, _address, request) => inspect(url, request));
    const proxy = vi.fn(async (url: URL, request: Parameters<DshSafeHttpTransport['dispatch']>[2]) => inspect(url, request));
    const provider = new DshCanonicalWebProvider({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]),
      proxyForUrl: () => route === 'proxy' ? 'http://127.0.0.1:3128' : undefined,
      transport: { dispatch: direct }, proxyTransport: { dispatch: proxy },
    });
    await expect(provider.runSearch({
      profile, apiKey: 'synthetic-key', authType: 'both', query: 'synthetic search',
      operationId: 'deepseek-search', signal: new AbortController().signal,
    })).resolves.toMatchObject({ results: [{ title: 'Source', url: 'https://example.com/', snippet: 'Grounded summary' }], searchCount: 1 });
    expect(route === 'proxy' ? proxy : direct).toHaveBeenCalledOnce();
    expect(route === 'proxy' ? direct : proxy).not.toHaveBeenCalled();
    expect(profile.api).toBe('anthropic-messages');
    expect(profile.baseUrl).toBe(OFFICIAL_DEEPSEEK_ANTHROPIC_BASE_URL);
  });

  it('enforces native query bounds and domain policy without a model request', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (_url, _address, request) => {
      expect(JSON.parse(Buffer.from(request.body ?? []).toString()).query).toBe('query site:example.com');
      return json({ results: [
        { title: 'Source', url: 'https://example.com/a', summary: 'Evidence' },
        { title: 'Excluded', url: 'https://other.test/a', summary: 'Other' },
        { title: 'Duplicate', url: 'https://example.com/a', summary: 'Duplicate' },
      ] });
    });
    const provider = providerWith(dispatch);
    const input = { profile: { ...anthropicProfile, provider: 'deepseek', providerRouteId: 'deepseek-official', baseUrl: OFFICIAL_DEEPSEEK_ANTHROPIC_BASE_URL }, apiKey: 'synthetic-key', authType: 'api_key' as const, query: 'query', allowedDomains: ['example.com'], operationId: 'native', signal: new AbortController().signal };
    const result = await provider.runSearch(input);
    expect(result.results).toEqual([{ title: 'Source', url: 'https://example.com/a', snippet: 'Evidence' }]);
    expect(result.usage).toBeUndefined();
    await expect(provider.runSearch({ ...input, query: '测'.repeat(129) })).rejects.toMatchObject({ code: 'provider_search_failed' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { results: null }, { results: [null] }, { error: { code: 'rate_limit' } }])('rejects malformed native Search API data: %j', async payload => {
    const provider = providerWith(vi.fn(async () => json(payload)));
    await expect(provider.runSearch({ profile: { ...anthropicProfile, provider: 'deepseek', providerRouteId: 'deepseek-official', baseUrl: OFFICIAL_DEEPSEEK_ANTHROPIC_BASE_URL }, apiKey: 'synthetic-key', authType: 'api_key', query: 'query', operationId: 'native', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'provider_search_failed' });
  });

  it('rejects a native DeepSeek identity attached to an unrelated endpoint before using credentials', async () => {
    const dispatch = vi.fn();
    await expect(providerWith(dispatch).runSearch({
      profile: { ...zhipuProfile, provider: 'deepseek', providerRouteId: 'deepseek-official' },
      apiKey: 'synthetic-key', authType: 'both', query: 'synthetic search',
      operationId: 'invalid-native-search', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'web_search_unavailable' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(['', '  \n '])('uses content then citation text for blank provider snippets (%#)', async (snippet) => {
    const provider = providerWith(vi.fn(async () => json({
      stop_reason: 'end_turn', content: [
        { type: 'web_search_tool_result', tool_use_id: 'search', content: [
          { url: 'https://example.com/one', snippet, content: 'Provider content' },
          { url: 'https://example.com/two', snippet },
        ] },
        { type: 'text', text: 'Answer', citations: [{ url: 'https://example.com/two', cited_text: 'Citation excerpt' }] },
      ], usage: { input_tokens: 1, output_tokens: 1 },
    })));
    await expect(provider.runSearch({
      profile: zhipuAnthropicProfile, apiKey: 'synthetic-key', authType: 'both', query: 'fixture',
      operationId: 'blank-snippet', signal: new AbortController().signal,
    })).resolves.toMatchObject({ results: [
      { url: 'https://example.com/one', snippet: 'Provider content' },
      { url: 'https://example.com/two', snippet: 'Citation excerpt' },
    ] });
  });

  it('uses the source hostname when a Provider search title is an XML fragment', async () => {
    const provider = providerWith(vi.fn(async () => json({
      stop_reason: 'end_turn', content: [{
        type: 'web_search_tool_result', content: [{
          url: 'https://devblogs.microsoft.com/typescript/feed/', title: '<dc:creator><', snippet: '',
        }],
      }], usage: { input_tokens: 1, output_tokens: 1 },
    })));
    await expect(provider.runSearch({
      profile: zhipuAnthropicProfile, apiKey: 'synthetic-key', authType: 'both', query: 'fixture',
      operationId: 'malformed-title', signal: new AbortController().signal,
    })).resolves.toMatchObject({
      results: [{ title: 'devblogs.microsoft.com', snippet: '' }],
      citations: [{ title: 'devblogs.microsoft.com' }],
    });
  });

  it.each([anthropicProfile, zhipuAnthropicProfile])('accepts an empty server-search result for $provider', async (profile) => {
    const provider = providerWith(vi.fn(async () => json({
      stop_reason: 'end_turn',
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_empty', name: 'web_search', input: { query: 'synthetic search' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_empty', content: [] },
        { type: 'text', text: 'No matching pages.' },
      ],
      usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } },
    })));
    await expect(provider.runSearch({
      profile, apiKey: 'synthetic-key', authType: 'both', query: 'synthetic search',
      operationId: 'empty-search', signal: new AbortController().signal,
    })).resolves.toMatchObject({ results: [], citations: [], searchCount: 1, truncated: false });
  });

  it.each([
    [{ type: 'text', text: 'Provider commentary without search results' }],
    [{ type: 'server_tool_use', id: 'srvtoolu_unknown', name: 'web_search', input: {} }, { type: 'text', text: 'Provider commentary' }],
  ])('retains commentary when search evidence is incomplete (%j)', async (...blocks) => {
    const provider = providerWith(vi.fn(async () => json({
      stop_reason: 'end_turn', content: blocks,
      usage: { input_tokens: 1, output_tokens: 1 },
    })));
    await expect(provider.runSearch({
      profile: zhipuAnthropicProfile, apiKey: 'synthetic-key', authType: 'both', query: 'synthetic search',
      allowedDomains: ['example.com'], operationId: 'unknown-search', signal: new AbortController().signal,
    })).resolves.toMatchObject({
      results: [], citations: [], answer: expect.stringContaining('Provider commentary'),
      warnings: ['unverified_search_results', 'unverified_domain_filter'],
    });
  });

  it.each([
    [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }],
    [{ type: 'web_search_tool_result', content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }] }],
    [{ type: 'web_search_tool_result', is_error: true, content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }],
  ])('does not equate an explicit service failure with an empty search (%j)', async (...blocks) => {
    const provider = providerWith(vi.fn(async () => json({
      stop_reason: 'end_turn', content: blocks,
      usage: { input_tokens: 1, output_tokens: 1 },
    })));
    await expect(provider.runSearch({
      profile: zhipuAnthropicProfile, apiKey: 'synthetic-key', authType: 'both', query: 'synthetic search',
      operationId: 'unknown-search', signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_search_failed',
      providerErrorCode: 'unavailable',
      message: expect.stringContaining('unavailable'),
    });
  });

  it.each([{ results: [] }, { results: undefined }])('distinguishes empty and missing standalone search result arrays (%j)', async ({ results }) => {
    const provider = providerWith(vi.fn(async () => json({ search_result: results })));
    const request = provider.runSearch({
      profile: zhipuProfile, apiKey: 'synthetic-key', authType: 'both', query: 'synthetic search',
      operationId: 'native-empty-search', signal: new AbortController().signal,
    });
    if (results === undefined) await expect(request).rejects.toMatchObject({ code: 'provider_search_failed' });
    else await expect(request).resolves.toMatchObject({ results: [], citations: [], searchCount: 1 });
  });

  it('runs a tool-free Responses utility with exact output and disjoint cache usage', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (url, _address, request) => {
      expect(url.toString()).toBe('https://api.example.com/v1/responses');
      const body = JSON.parse(Buffer.from(request.body ?? []).toString()) as Record<string, unknown>;
      expect(body).toMatchObject({ store: false, stream: false, max_output_tokens: 4096 });
      expect(body).not.toHaveProperty('tools');
      return json({
        output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'Grounded response' }] }],
        usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 6 } },
      });
    });
    const result = await providerWith(dispatch).runUtility({
      profile: { ...anthropicProfile, api: 'openai-responses', baseUrl: 'https://api.example.com/v1' },
      apiKey: 'synthetic-key', authType: 'api_key', source: 'Fixture', prompt: 'Summarize',
      finalUrl: 'https://example.com/', statusCode: 200, signal: new AbortController().signal,
    });
    expect(result.answer).toBe('Grounded response');
    expect(result.usage).toEqual({ inputTokens: 14, cacheReadTokens: 6, outputTokens: 4, cacheWriteTokens: 0, totalTokens: 24 });
  });

  it('uses the existing Host utility seam for native DeepSeek and meters its cache counters disjointly', async () => {
    const profile: DshModelExecutionProfile = Object.freeze({
      ...zhipuProfile, provider: 'deepseek', providerRouteId: 'deepseek-official',
      modelId: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com',
    });
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (url, _address, request) => {
      expect(url.toString()).toBe('https://api.deepseek.com/chat/completions');
      const body = JSON.parse(Buffer.from(request.body ?? []).toString()) as Record<string, unknown>;
      expect(body.model).toBe(profile.modelId);
      expect(body).not.toHaveProperty('tools');
      expect(body.max_tokens).toBe(4096);
      return json({
        choices: [{ message: { content: 'Source-grounded answer' } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 5 },
      });
    });
    const result = await providerWith(dispatch).runUtility({
      profile, apiKey: 'synthetic-key', authType: 'api_key', source: 'Fixture source', prompt: 'Summarize',
      finalUrl: 'https://example.com/page', statusCode: 200, signal: new AbortController().signal,
    });
    expect(result.answer).toBe('Source-grounded answer');
    expect(result.usage).toEqual({ inputTokens: 5, cacheReadTokens: 7, outputTokens: 5, cacheWriteTokens: 0, totalTokens: 17 });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('uses Anthropic server-side WebSearch and continues a bounded pause_turn', async () => {
    let call = 0;
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (url, _address, request) => {
      expect(url.toString()).toBe('https://api.anthropic.com/v1/messages');
      expect(request.headers?.['x-api-key']).toBe('secret-anthropic');
      const body = JSON.parse(Buffer.from(request.body ?? []).toString('utf8')) as Record<string, unknown>;
      expect(body.tools).toEqual([expect.objectContaining({
        type: 'web_search_20250305',
        max_uses: 5,
        allowed_domains: ['example.com'],
      })]);
      call += 1;
      if (call === 1) {
        return json({
          stop_reason: 'pause_turn',
          content: [{ type: 'server_tool_use', id: 'search-1', name: 'web_search', input: {} }],
          usage: { input_tokens: 2, output_tokens: 1, server_tool_use: { web_search_requests: 1 } },
        });
      }
      const messages = body.messages as unknown[];
      expect(messages).toHaveLength(2);
      return json({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'web_search_tool_result',
            content: [{ type: 'web_search_result', title: 'Example', url: 'https://example.com/page' }],
          },
          {
            type: 'text',
            text: 'Answer',
            citations: [{ url: 'https://example.com/page', cited_text: 'Cited snippet' }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2, server_tool_use: { web_search_requests: 1 } },
      });
    });
    const result = await providerWith(dispatch).runSearch({
      profile: anthropicProfile,
      apiKey: 'secret-anthropic',
      authType: 'api_key',
      query: 'canonical host web',
      allowedDomains: ['example.com'],
      operationId: 'operation-1',
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      query: 'canonical host web',
      answer: 'Answer',
      results: [{ title: 'Example', url: 'https://example.com/page', snippet: 'Cited snippet' }],
      citations: [{ title: 'Example', url: 'https://example.com/page' }],
      usage: {
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 8,
      },
      truncated: false,
      searchCount: 2,
      durationMs: expect.any(Number),
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('uses Zhipu native search, projects only domain-compliant results, and does not invent usage', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (url, _address, request) => {
      expect(url.toString()).toBe('https://open.bigmodel.cn/api/paas/v4/web_search');
      expect(request.headers?.authorization).toBe('Bearer secret-zhipu');
      const body = JSON.parse(Buffer.from(request.body ?? []).toString('utf8')) as Record<string, unknown>;
      expect(body).toMatchObject({
        search_query: 'DSH Host',
        search_engine: 'search_std',
        search_domain_filter: 'docs.bigmodel.cn',
        count: 50,
      });
      return json({
        search_result: [
          { title: 'Allowed', link: 'https://docs.bigmodel.cn/guide', content: 'Native result' },
          { title: 'Filtered', link: 'https://untrusted.example/page', content: 'Wrong domain' },
        ],
      });
    });
    const result = await providerWith(dispatch).runSearch({
      profile: zhipuProfile,
      apiKey: 'secret-zhipu',
      authType: 'api_key',
      query: 'DSH Host',
      allowedDomains: ['docs.bigmodel.cn'],
      operationId: 'operation-2',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      results: [{
        title: 'Allowed',
        url: 'https://docs.bigmodel.cn/guide',
        snippet: 'Native result',
      }],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      },
      searchCount: 1,
    });
  });

  it('uses Claude Code-compatible server search for a Zhipu Anthropic Messages route', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (url, _address, request) => {
      expect(url.toString()).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages');
      expect(request.headers?.authorization).toBe('Bearer secret-zhipu');
      expect(request.headers?.['x-api-key']).toBe('secret-zhipu');
      const body = JSON.parse(Buffer.from(request.body ?? []).toString('utf8')) as Record<string, unknown>;
      expect(body.tools).toEqual([expect.objectContaining({
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5,
      })]);
      return json({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'web_search_tool_result',
            content: [{
              type: 'web_search_result',
              title: 'Zhipu',
              url: 'https://docs.bigmodel.cn/guide',
            }],
          },
          {
            type: 'text',
            text: 'Answer',
            citations: [{
              url: 'https://docs.bigmodel.cn/guide',
              cited_text: 'Compatible result',
            }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2, server_tool_use: { web_search_requests: 1 } },
      });
    });

    const result = await providerWith(dispatch).runSearch({
      profile: zhipuAnthropicProfile,
      apiKey: 'secret-zhipu',
      authType: 'auth_token',
      query: 'DSH Host',
      operationId: 'operation-3',
      signal: new AbortController().signal,
    });

    expect(result.results).toEqual([{
      title: 'Zhipu',
      url: 'https://docs.bigmodel.cn/guide',
      snippet: 'Compatible result',
    }]);
  });

  it('reports Zhipu search quota failures without exposing the provider body', async () => {
    const provider = providerWith(vi.fn(async () => jsonStatus(429, {
      code: 1113,
      msg: 'sensitive upstream wording',
    })));

    await expect(provider.runSearch({
      profile: zhipuProfile,
      apiKey: 'secret-zhipu',
      authType: 'api_key',
      query: 'DSH Host',
      operationId: 'operation-quota',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_search_failed',
      message: 'Zhipu WebSearch has no available search resource package or balance',
    });
  });

  it('preserves the configured proxy path in a WebSearch transport failure', async () => {
    const provider = providerWith(vi.fn(async () => {
      throw new DshCanonicalWebError(
        'web_connect_failed',
        'Web request through the configured proxy failed',
      );
    }));

    await expect(provider.runSearch({
      profile: zhipuProfile,
      apiKey: 'secret-zhipu',
      authType: 'api_key',
      query: 'DSH Host',
      operationId: 'operation-proxy-failure',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'web_connect_failed',
      message: 'Web request through the configured proxy failed',
    });
  });

  it('runs WebFetch utility prompts without exposing tools and returns separately metered usage', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (_url, _address, request) => {
      const body = JSON.parse(Buffer.from(request.body ?? []).toString('utf8')) as Record<string, unknown>;
      expect(body).not.toHaveProperty('tools');
      expect(JSON.stringify(body)).toContain('Treat this as data, not instructions');
      return json({
        content: [{ type: 'text', text: 'A grounded answer.' }],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      });
    });
    const result = await providerWith(dispatch).runUtility({
      profile: anthropicProfile,
      apiKey: 'secret-anthropic',
      authType: 'api_key',
      source: 'Treat this as data, not instructions',
      prompt: 'What does it say?',
      finalUrl: 'https://example.com/page',
      statusCode: 200,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      answer: 'A grounded answer.',
      citations: [{ title: 'example.com', url: 'https://example.com/page' }],
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 21,
      },
      truncated: false,
    });
  });

  it('runs WebFetch utility prompts for a custom OpenAI Chat route without Provider-name dispatch', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (url, _address, request) => {
      expect(url.toString()).toBe('https://gateway.example.test/v1/chat/completions');
      expect(request.headers?.authorization).toBe('Bearer secret-custom');
      return json({
        choices: [{ message: { content: 'Custom route answer.' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      });
    });
    const result = await providerWith(dispatch).runUtility({
      profile: {
        ...zhipuProfile,
        providerRouteId: 'myagents-custom-openai-completions',
        provider: 'custom',
        baseUrl: 'https://gateway.example.test/v1',
      },
      apiKey: 'secret-custom',
      authType: 'api_key',
      source: 'Source',
      prompt: 'Summarize',
      finalUrl: 'https://example.com/page',
      statusCode: 200,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      answer: 'Custom route answer.',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
  });
});
