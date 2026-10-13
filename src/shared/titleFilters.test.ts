import { describe, expect, it } from 'vitest';
import { isLikelyErrorTitle } from './titleFilters';

describe('isLikelyErrorTitle — #245 backstop', () => {
  it('rejects the exact reported pattern from #245 (SDK 4xx surface)', () => {
    expect(isLikelyErrorTitle('API Error: 400 专用渠道限制: 接口仅可用于C')).toBe(true);
    expect(isLikelyErrorTitle('API Error: 401 Unauthorized')).toBe(true);
    expect(isLikelyErrorTitle('API Error: 500 Internal Server Error')).toBe(true);
  });

  it('rejects [Error]: prefix (openai-bridge stream-responses.ts:195)', () => {
    expect(isLikelyErrorTitle('[Error]: upstream timeout')).toBe(true);
    expect(isLikelyErrorTitle('[error]: lowercase variant')).toBe(true);
  });

  it('rejects Claude Code error / SDK rewind error surfaces', () => {
    expect(isLikelyErrorTitle('Claude Code returned an error result: foo')).toBe(true);
    expect(isLikelyErrorTitle('No message found with message.uuid of: abc')).toBe(true);
  });

  it('rejects the observed login surface but keeps tasks about login failures', () => {
    expect(isLikelyErrorTitle('Not logged in · Please run /login')).toBe(true);
    expect(isLikelyErrorTitle('修复 Not logged in 登录错误')).toBe(false);
  });

  it('tolerates leading/trailing whitespace', () => {
    expect(isLikelyErrorTitle('  API Error: 400 timeout  ')).toBe(true);
    expect(isLikelyErrorTitle('\n\tAPI Error: 401\n')).toBe(true);
  });

  it('does NOT reject legitimate titles even when they mention "error"', () => {
    // Topic-relevant phrasing that should be allowed as a title
    expect(isLikelyErrorTitle('调试 API Error 处理流程')).toBe(false);
    expect(isLikelyErrorTitle('Error handling refactor notes')).toBe(false);
    expect(isLikelyErrorTitle('Redis 缓存优化')).toBe(false);
    expect(isLikelyErrorTitle('SSE 流式调试')).toBe(false);
  });

  it('returns false for empty / non-string input (defense)', () => {
    expect(isLikelyErrorTitle('')).toBe(false);
    expect(isLikelyErrorTitle('   ')).toBe(false);
    expect(isLikelyErrorTitle(undefined as unknown as string)).toBe(false);
    expect(isLikelyErrorTitle(null as unknown as string)).toBe(false);
    expect(isLikelyErrorTitle(42 as unknown as string)).toBe(false);
  });
});
