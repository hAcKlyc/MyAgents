import { describe, expect, it } from 'vitest';
import { isBuiltinNativeUserRecord, resolveBuiltinUserAnchors } from './builtin-user-anchors';

const nativeUser = (uuid: string, extra = {}) => ({
  type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content: 'question' }, ...extra,
});

describe('builtin human-input anchor provenance', () => {
  it.each([
    { isReplay: true }, { isQueuedCommand: true }, { parent_tool_use_id: 'child' },
    { isSynthetic: true }, { isMeta: true }, { is_meta: true }, { isCompactSummary: true },
    { isVisibleInTranscriptOnly: true },
    { isCompletedLocalCommand: true },
    { message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'result' }] } },
    { message: { content: '<local-command-stdout>cost</local-command-stdout>' } },
    { message: { content: '<local-command-stderr>error</local-command-stderr>' } },
    { message: { content: [{ type: 'text', text: '<local-command-stdout>cost</local-command-stdout>' }] } },
    { message: { content: [{ type: 'text', text: '<local-command-stderr>error</local-command-stderr>' }] } },
  ])('excludes non-human native/receipt shape %j', extra => {
    expect(isBuiltinNativeUserRecord(nativeUser('candidate', extra))).toBe(false);
  });

  it('accepts ordinary root native inputs including image/text blocks', () => {
    expect(isBuiltinNativeUserRecord(nativeUser('human'))).toBe(true);
    expect(isBuiltinNativeUserRecord(nativeUser('human', { message: {
      content: [{ type: 'image', source: {} }, { type: 'text', text: 'question' }],
    } }))).toBe(true);
  });

  it('reconciles an exact submitted input, while preserving strict assistant boundaries', () => {
    const rows = [
      { id: 'u', role: 'user', sdkInputUuid: 'submitted', sdkUuid: 'wrong-tool' },
      { id: 'a', role: 'assistant', sdkUuid: 'assistant' },
    ];
    const resolved = resolveBuiltinUserAnchors(rows, [nativeUser('submitted')]);
    expect(resolved[0].sdkUuid).toBe('submitted');
    expect(resolved[1]).toBe(rows[1]);
    expect(rows[0].sdkUuid).toBe('wrong-tool');
  });

  it('does not guess positional replacements for legacy wrong or missing anchors', () => {
    const rows = [
      { role: 'user', sdkUuid: 'later-tool' }, { role: 'user', sdkUuid: 'absent' },
      { role: 'user', sdkUuid: 'queued-alias' }, { role: 'user', sdkUuid: 'valid' }, { role: 'user' },
    ];
    expect(resolveBuiltinUserAnchors(rows, [nativeUser('unrelated'), nativeUser('valid'),
      nativeUser('later-tool', { message: { content: [{ type: 'tool_result' }] } }),
      nativeUser('queued-alias', { isQueuedCommand: true }),
    ]).map(row => row.sdkUuid)).toEqual([undefined, undefined, undefined, 'valid', undefined]);
  });

  it('does not replace a known input correlation with another real human record', () => {
    expect(resolveBuiltinUserAnchors([{ role: 'user', sdkInputUuid: 'missing-input', sdkUuid: 'other-human' }],
      [nativeUser('other-human')])[0].sdkUuid).toBeUndefined();
  });
});
