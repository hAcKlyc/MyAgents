import { describe, expect, it } from 'vitest';

import { shouldBumpSessionRecency } from './session-metadata-patch-policy';

describe('Session metadata PATCH recency policy', () => {
  it('does not treat title, favorite, Tag-adjacent, or sidebar pin organization as activity', () => {
    expect(shouldBumpSessionRecency({ title: 'Renamed', titleSource: 'user' })).toBe(false);
    expect(shouldBumpSessionRecency({ favorite: true })).toBe(false);
    expect(shouldBumpSessionRecency({ archived: true })).toBe(false);
    expect(shouldBumpSessionRecency({ pinned: true })).toBe(false);
    expect(shouldBumpSessionRecency({ pinned: false })).toBe(false);
  });

  it('still advances recency for execution-setting edits', () => {
    expect(shouldBumpSessionRecency({ model: 'model-a' })).toBe(true);
    expect(shouldBumpSessionRecency({ permissionMode: 'default' })).toBe(true);
    expect(shouldBumpSessionRecency({ providerRoute: { kind: 'api' } })).toBe(true);
    expect(shouldBumpSessionRecency({ model: undefined, title: 'Only rename' })).toBe(false);
  });
});
