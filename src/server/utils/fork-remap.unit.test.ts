import { describe, it, expect } from 'vitest';
import { buildForkUuidRemap, remapStoredSdkUuids, remapForkMessageUuids, type ForkTranscriptEntry } from './fork-remap';

const e = (type: 'user' | 'assistant' | 'system', uuid: string): ForkTranscriptEntry => ({ type, uuid });

describe('buildForkUuidRemap (SDK↔SDK positional remap)', () => {
  it('happy path: same length + type sequence, all uuids renamed → clean bijection', () => {
    const src = [e('user', 's1'), e('assistant', 's2'), e('assistant', 's3')];
    const fork = [e('user', 'f1'), e('assistant', 'f2'), e('assistant', 'f3')];
    const r = buildForkUuidRemap(src, fork);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.map.get('s1')).toBe('f1');
      expect(r.map.get('s2')).toBe('f2');
      expect(r.map.get('s3')).toBe('f3');
      expect(r.map.size).toBe(3);
    }
  });

  it('length mismatch → ok:false (abort, fall back to lazy path)', () => {
    const r = buildForkUuidRemap([e('user', 's1')], [e('user', 'f1'), e('assistant', 'f2')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/length mismatch/);
  });

  it('type sequence mismatch → ok:false', () => {
    const r = buildForkUuidRemap([e('user', 's1'), e('assistant', 's2')], [e('user', 'f1'), e('user', 'f2')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/type mismatch at index 1/);
  });

  it('duplicate source uuid → ok:false (not a clean bijection)', () => {
    const r = buildForkUuidRemap([e('user', 'dup'), e('assistant', 'dup')], [e('user', 'f1'), e('assistant', 'f2')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/duplicate source uuid/);
  });

  it('duplicate fork uuid → ok:false', () => {
    const r = buildForkUuidRemap([e('user', 's1'), e('assistant', 's2')], [e('user', 'dup'), e('assistant', 'dup')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/duplicate fork uuid/);
  });

  it('empty transcripts → ok:true with empty map', () => {
    const r = buildForkUuidRemap([], []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.map.size).toBe(0);
  });
});

describe('remapStoredSdkUuids (apply to our stored row uuids)', () => {
  const map = new Map([['s1', 'f1'], ['s2', 'f2'], ['s3', 'f3']]);

  it('re-stamps every present uuid; passes undefined through', () => {
    const r = remapStoredSdkUuids(['s1', undefined, 's3'], map);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remapped).toEqual(['f1', undefined, 'f3']);
  });

  it('a stored uuid missing from the map → ok:false (abort the eager fork)', () => {
    const r = remapStoredSdkUuids(['s1', 'unknown'], map);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not in remap: unknown/);
  });

  it('only the last SDK assistant per turn is stored — still covered (it is a map key)', () => {
    // Our store keeps the LAST assistant uuid of a turn; the SDK-granularity map covers
    // every source uuid, so whichever one we stored resolves.
    const r = remapStoredSdkUuids(['s2'], map);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remapped).toEqual(['f2']);
  });
});

describe('exact legacy user stamp repair in a fork', () => {
  const user = { role: 'user', content: 'exact original request', sdkUuid: 'lost-user-stamp' };
  const native: ForkTranscriptEntry = { type: 'user', uuid: 'native-user', message: { content: [{ type: 'text', text: user.content }] } };
  const map = new Map([['native-user', 'fork-user'], ['native-assistant', 'fork-assistant']]);

  it('re-stamps only the fork snapshot from a unique complete plain-text native match', () => {
    expect(remapForkMessageUuids([user, { role: 'assistant', content: 'reply', sdkUuid: 'native-assistant' }], [native], map))
      .toEqual({ ok: true, remapped: ['fork-user', 'fork-assistant'] });
    expect(user.sdkUuid).toBe('lost-user-stamp');
  });

  it.each([
    { message: { ...user, role: 'assistant' }, source: [native], map },
    { message: { ...user, content: '' }, source: [native], map },
    { message: { ...user, attachments: [{}] }, source: [native], map },
    { message: { ...user, content: [{ type: 'text', text: user.content }] }, source: [native], map },
    { message: user, source: [], map },
    { message: user, source: [native, { ...native, uuid: 'duplicate-text' }], map },
    { message: user, source: [native], map: new Map<string, string>() },
    { message: user, source: [native, { type: 'user' as const, uuid: 'lost-user-stamp' }], map },
    { message: user, source: [{ ...native, message: { content: [{ type: 'text', text: user.content }, { type: 'image' }] } }], map },
  ])('refuses missing, ambiguous, beyond-boundary and non-text evidence', ({ message, source, map }) => {
    expect(remapForkMessageUuids([message], source, map).ok).toBe(false);
  });

  it('does not assign the same native user to another retained Product row', () => {
    expect(remapForkMessageUuids([user, { ...user, sdkUuid: 'native-user' }], [native], map).ok).toBe(false);
    expect(remapForkMessageUuids([user, { ...user, sdkUuid: undefined }], [native], map).ok).toBe(false);
  });
});
