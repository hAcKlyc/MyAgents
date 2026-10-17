import { describe, expect, it } from 'vitest';

import {
  buildImCancelledPayload,
  buildImCompletePayload,
  buildImErrorPayload,
  formatImResumeFailure,
} from './im-terminal-payload';

describe('IM terminal producer payloads', () => {
  it('puts explicit recovery guidance in the final payload forwarded by OpenClaw', () => {
    const payload = buildImErrorPayload(formatImResumeFailure('resume failed'));
    expect(payload.finalPayloads[0]).toMatchObject({ isError: true, text: expect.stringContaining('/new') });
    expect(payload.finalPayloads[0].text).toContain('旧会话历史会保留');
    expect(buildImErrorPayload('provider error').finalPayloads[0].text).not.toContain('/new');
  });
  it('preserves canonical complete text and permits zero finals', () => {
    expect(buildImCompletePayload('answer\n')).toEqual({ finalPayloads: [{ text: 'answer\n' }] });
    expect(buildImCompletePayload('  ')).toEqual({ finalPayloads: [] });
  });

  it('marks errors independently and keeps cancellation user-safe', () => {
    expect(buildImErrorPayload('failed')).toEqual({
      finalPayloads: [{ text: 'failed', isError: true }],
    });
    expect(buildImCancelledPayload()).toEqual({ finalPayloads: [{ text: '🛑 已取消' }] });
  });
});
