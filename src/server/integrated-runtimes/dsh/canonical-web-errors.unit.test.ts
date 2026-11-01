import { describe, expect, it } from 'vitest';
import { dshCanonicalWebTransportError, zhipuProviderSearchError } from './canonical-web-errors';

describe('Zhipu search business causes', () => {
  it.each([
    [{ error: { code: 1301, message: 'private upstream detail' } }, '1301'],
    [{ error_code: 'invalid_tool_input', error_message: 'private upstream detail (1301)' }, '1301'],
    [{ error: { code: '1302', message: 'private upstream detail' } }, '1302'],
    [{ error_code: 'invalid_tool_input', error_message: 'private upstream detail (1399)' }, '1399'],
  ])('keeps a bounded business code without copying Provider prose (%#)', (value, code) => {
    const error = zhipuProviderSearchError(value, 'zhipu');
    expect(error).toMatchObject({ code: 'provider_search_failed', providerErrorCode: code, phase: 'provider_response' });
    expect(error?.message).toContain(code);
    expect(error?.message).not.toContain('private upstream detail');
  });

  it.each([
    { error_code: 'invalid_tool_input', error_message: 'private upstream detail 1301 in arbitrary prose' },
    { error_code: 'invalid_tool_input', error_message: `${'private upstream detail '.repeat(300)}(1301)` },
    { code: '1301-secret-token', message: 'private upstream detail' },
  ])('does not infer a cause from unbounded or unrecognized error prose (%#)', value => {
    expect(zhipuProviderSearchError(value, 'zhipu')).toBeUndefined();
  });

  it('keeps the business-code namespace with its Provider', () => {
    expect(zhipuProviderSearchError({ error: { code: 1301 } }, 'another-provider')).toBeUndefined();
  });
});

describe('known Web transport failures', () => {
  it.each(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED'])('explains %s without inventing a DNS failure', code => {
    const cause = Object.assign(new Error('private upstream detail'), { code });
    for (const route of ['direct', 'proxy'] as const) {
      const error = dshCanonicalWebTransportError(new TypeError('fetch failed', { cause }), route, 'response_headers');
      expect(error).toMatchObject({ code: 'web_connect_failed', systemErrorClass: code, phase: 'response_headers' });
      expect(error.message).toContain(code === 'ECONNREFUSED' ? 'was refused' : 'closed before the response completed');
      expect(error.message.includes('proxy')).toBe(route === 'proxy');
      expect(error.message).not.toMatch(/DNS|private upstream detail/);
    }
  });

  it('preserves the response body phase and known DNS classification', () => {
    expect(dshCanonicalWebTransportError(Object.assign(new Error(), { code: 'UND_ERR_SOCKET' }), 'proxy', 'response_body'))
      .toMatchObject({ code: 'web_request_failed', phase: 'response_body', systemErrorClass: 'UND_ERR_SOCKET' });
    expect(dshCanonicalWebTransportError(Object.assign(new Error(), { code: 'ENOTFOUND' }), 'proxy'))
      .toMatchObject({ code: 'web_dns_failed', phase: 'dns', systemErrorClass: 'ENOTFOUND' });
  });
});
