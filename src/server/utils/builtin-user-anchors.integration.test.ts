import { getSessionMessages, type SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { isBuiltinNativeUserRecord, resolveBuiltinUserAnchors } from './builtin-user-anchors';

describe('installed SDK historical user provenance', () => {
  it.each(['stdout-string', 'stdout-array', 'stderr-string', 'stderr-array'])(
    'excludes a completed local command reconstructed from %s', async shape => {
      const sessionId = '00000000-0000-4000-8000-000000000001';
      const output = `<local-command-${shape.startsWith('stdout') ? 'stdout' : 'stderr'}>synthetic output`;
      const rows = [
        { uuid: 'caveat', type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>local execution' } },
        { uuid: 'command', type: 'user', message: { role: 'user', content: '<command-name>/cost</command-name>' } },
        { uuid: 'output', type: 'user', message: { role: 'user', content: shape.endsWith('array') ? [{ type: 'text', text: output }] : output } },
        { uuid: 'human', type: 'user', message: { role: 'user', content: 'real question' } },
        { uuid: 'assistant', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
      ].map((row, index, all) => ({ ...row, sessionId, parentUuid: index ? all[index - 1].uuid : null,
        timestamp: `2026-10-31T00:00:0${index}.000Z` }));
      const sessionStore: SessionStore = { append: async () => {}, load: async () => structuredClone(rows) };
      const native = await getSessionMessages(sessionId, { dir: '/synthetic-workspace', sessionStore });
      for (const uuid of ['command', 'output']) {
        const local = native.find(row => row.uuid === uuid);
        expect(local).toMatchObject({ isCompletedLocalCommand: true });
        expect(isBuiltinNativeUserRecord(local)).toBe(false);
        expect(resolveBuiltinUserAnchors([{ role: 'user', sdkUuid: uuid }], native)[0].sdkUuid).toBeUndefined();
      }
      expect(resolveBuiltinUserAnchors([{ role: 'user', sdkInputUuid: 'human' }], native)[0].sdkUuid).toBe('human');
    },
  );
});
