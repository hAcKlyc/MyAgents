import JSON5 from 'json5';

import { DshCanonicalWebError, zhipuProviderSearchError } from './canonical-web-errors';

/** Split concatenated data containers without interpreting their contents. */
function dataFragments(value: string): Readonly<{ fragments: readonly string[]; truncated: boolean }> {
  const fragments: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (depth === 0) {
      if (/\s/u.test(char)) { start = index + 1; continue; }
      if (char !== '[' && char !== '{') break;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        fragments.push(value.slice(start, index + 1));
        start = index + 1;
        if (fragments.length === 100) break;
      }
    }
  }
  const remainder = value.slice(start);
  const truncated = fragments.length === 100 && remainder.trim().length > 0;
  if (!truncated && remainder.trim()) fragments.push(remainder);
  return { fragments, truncated };
}

/** Only inspect content belonging to a server search result. Assistant prose
 * and unrelated client tool results must never be passed to this normalizer.
 */
export function parseCompatibleServerSearchContent(value: unknown, provider?: string): Readonly<{
  results: readonly Record<string, unknown>[];
  unverified: boolean;
  text: readonly string[];
  failures?: readonly DshCanonicalWebError[];
}> {
  const results: Record<string, unknown>[] = [];
  const text: string[] = [];
  let unverified = false;
  let visited = 0;
  const failures: DshCanonicalWebError[] = [];
  let omitted = false;
  const omit = (): void => {
    unverified = true;
    if (!omitted) text.push('Unrecognized or over-limit search response data was omitted.');
    omitted = true;
  };
  const retain = (value: unknown): void => {
    unverified = true;
    // Unknown containers can hide error bodies. Keep source text, not an
    // arbitrary serialization of fields the normalizer has not understood.
    if (typeof value === 'string') text.push(value);
    else if (value !== undefined) omit();
  };
  const visit = (value: unknown, depth: number): void => {
    if (++visited > 2_000 || depth > 8) { omit(); return; }
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > 262_144) { omit(); return; }
      const { fragments, truncated } = dataFragments(value);
      if (truncated) omit();
      for (const fragment of fragments) {
        let decoded: unknown;
        try {
          // Compatible servers can serialize data with single quotes or join
          // containers. Never evaluate expressions or extract prose links.
          decoded = JSON5.parse(fragment) as unknown;
        } catch {
          const prefix = fragment.trimStart()[0];
          if (prefix === '[' || prefix === '{') omit();
          else retain(fragment);
          continue;
        }
        if (!decoded || typeof decoded !== 'object') { retain(fragment); continue; }
        visit(decoded, depth + 1);
      }
      if (!value.trim()) retain(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') { retain(value); return; }
    const item = value as Record<string, unknown>;
    if (item.is_error === true || item.error_code !== undefined
      || (typeof item.type === 'string' && (item.type === 'error' || item.type.endsWith('_error')))
      || (item.error !== undefined && item.error !== null && item.error !== false)) {
      const errorCode = typeof item.error_code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(item.error_code)
        ? item.error_code : undefined;
      const guidance = errorCode === 'max_uses_exceeded'
        ? 'Try a narrower query.'
        : 'Retry later, or use WebFetch when you already have a source URL.';
      failures.push(zhipuProviderSearchError(item, provider) ?? new DshCanonicalWebError(
        'provider_search_failed',
        `Provider WebSearch failed${errorCode ? ` (${errorCode})` : ''}. ${guidance}`,
        { phase: 'provider_response', providerErrorCode: errorCode },
      ));
      return;
    }
    const url = item.url ?? item.link;
    if (typeof url === 'string' && url) {
      results.push({
        url,
        ...(typeof item.title === 'string' ? { title: item.title } : {}),
        snippet: typeof item.snippet === 'string' && item.snippet.trim() ? item.snippet
          : typeof item.content === 'string' ? item.content : '',
      });
      return;
    }
    // Recognize result envelopes, not arbitrary nested provider metadata.
    const field = ['results', 'search_results', 'search_result', 'text', 'content']
      .find(key => Object.hasOwn(item, key));
    if (field) visit(item[field], depth + 1);
    else retain(item);
  };
  visit(value, 0);
  return { results, unverified, text, ...(failures.length ? { failures } : {}) };
}
