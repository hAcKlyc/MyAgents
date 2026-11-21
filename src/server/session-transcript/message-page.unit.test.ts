import { describe, expect, it } from 'vitest';
import { applyTranscriptOperation, createTranscriptProjection } from '../../shared/sessionTranscript';
import { projectMessagePage } from './message-page';
import type { SessionMessage } from '../types/session';

describe('V2 page authority', () => {
  it('keeps a pending send on the page boundary when history accepts it', () => {
    const projection = createTranscriptProjection();
    const row = (id: string): SessionMessage => ({ id, role: 'user', content: id, timestamp: new Date(0).toISOString() });
    for (const id of ['first', 'second', 'live']) {
      applyTranscriptOperation(projection, { kind: 'message-create', message: row(id) });
    }
    const pending = row('pending');
    const pages = () => [
      { from: null, before: null, limit: 1 }, { from: 'second', before: null, limit: 1 },
      { from: null, before: 'pending', limit: 1 }, { from: 'gone', before: null, limit: 1 },
      { from: null, before: 'gone', limit: 1 },
    ].map(request => projectMessagePage(projection, request, 'live', [pending, pending]));
    const before = pages();
    expect(before.map(page => page.messages.map(message => message.id))).toEqual([
      ['pending'], ['second', 'pending'], ['second'], ['pending'], [],
    ]);
    applyTranscriptOperation(projection, { kind: 'message-create', message: pending });
    expect(pages()).toEqual(before);
    expect(before.every(page => page.totalCount === 3)).toBe(true);
  });
});
