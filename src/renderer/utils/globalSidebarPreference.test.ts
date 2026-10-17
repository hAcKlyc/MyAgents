import { describe, expect, it, vi } from 'vitest';

import {
  clampGlobalSidebarWidth,
  DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
  GLOBAL_SIDEBAR_DEFAULT_WIDTH,
  GLOBAL_SIDEBAR_MAX_WIDTH,
  GLOBAL_SIDEBAR_MIN_WIDTH,
  GLOBAL_SIDEBAR_PREFERENCE_KEY,
  LEGACY_AUTOMATION_HISTORY_KEY,
  loadGlobalSidebarPreference,
  parseGlobalSidebarPreference,
  pruneRemovedWorkspaceKeys,
  resolveGlobalSidebarMode,
  seedDefaultWorkspaceExpansion,
} from './globalSidebarPreference';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    values,
  };
}

describe('globalSidebarPreference', () => {
  it('fails soft on malformed or unsupported persisted values', () => {
    expect(parseGlobalSidebarPreference({ version: 2 })).toBeNull();
    const storage = memoryStorage({
      [GLOBAL_SIDEBAR_PREFERENCE_KEY]: '{broken',
    });
    expect(loadGlobalSidebarPreference(storage)).toEqual(
      DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
    );
  });

  it('clamps persisted sidebar width and falls back for legacy or invalid values', () => {
    expect(clampGlobalSidebarWidth(undefined)).toBe(GLOBAL_SIDEBAR_DEFAULT_WIDTH);
    expect(clampGlobalSidebarWidth(Number.NaN)).toBe(GLOBAL_SIDEBAR_DEFAULT_WIDTH);
    expect(clampGlobalSidebarWidth(10)).toBe(GLOBAL_SIDEBAR_MIN_WIDTH);
    expect(clampGlobalSidebarWidth(9999)).toBe(GLOBAL_SIDEBAR_MAX_WIDTH);
    expect(clampGlobalSidebarWidth(300.4)).toBe(300);
    const { expandedWidth: _omit, ...legacy } = DEFAULT_GLOBAL_SIDEBAR_PREFERENCE;
    expect(parseGlobalSidebarPreference(legacy)?.expandedWidth).toBe(
      GLOBAL_SIDEBAR_DEFAULT_WIDTH,
    );
    expect(
      parseGlobalSidebarPreference({ ...legacy, expandedWidth: 333 })?.expandedWidth,
    ).toBe(333);
  });

  it('migrates the old automation history choice once', () => {
    const storage = memoryStorage({ [LEGACY_AUTOMATION_HISTORY_KEY]: 'true' });
    const preference = loadGlobalSidebarPreference(storage);
    expect(preference.showAutomationSessions).toBe(true);
    expect(storage.removeItem).toHaveBeenCalledWith(
      LEGACY_AUTOMATION_HISTORY_KEY,
    );
    expect(
      JSON.parse(storage.values.get(GLOBAL_SIDEBAR_PREFERENCE_KEY) ?? '{}'),
    ).toMatchObject({
      version: 1,
      showAutomationSessions: true,
    });
  });

  it('defaults organization for v1 preferences and preserves valid organization data', () => {
    expect(
      parseGlobalSidebarPreference({
        ...DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
        organization: undefined,
      })?.organization,
    ).toEqual({ sections: [], placements: {}, orders: {} });
    const preference = parseGlobalSidebarPreference({
      ...DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
      organization: {
        sections: [{ id: 'section:a', name: 'Team' }],
        placements: { 'session:s': 'section:a' },
        orders: {},
      },
    });
    expect(preference?.version).toBe(1);
    expect(preference?.organization.sections[0]).toMatchObject({
      id: 'section:a',
      name: 'Team',
      collapsed: false,
    });
    expect(preference?.organization.placements['session:s']).toBe('section:a');
  });

  it('restores the archived view while keeping old preferences compatible', () => {
    expect(
      parseGlobalSidebarPreference({
        ...DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
        sessionView: 'archived',
      })?.sessionView,
    ).toBe('archived');
    expect(
      parseGlobalSidebarPreference({
        ...DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
        sessionView: 'unknown',
      })?.sessionView,
    ).toBe('all');
  });

  it('seeds only a valid default workspace and never reseeds after user ownership', () => {
    const untouched = seedDefaultWorkspaceExpansion(
      DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
      '/work/mino',
      ['/work/other'],
    );
    expect(untouched).toBe(DEFAULT_GLOBAL_SIDEBAR_PREFERENCE);

    const seeded = seedDefaultWorkspaceExpansion(
      DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
      '/work/mino/',
      ['/work/mino'],
    );
    expect(seeded.hasSeededDefaultExpansion).toBe(true);
    expect(seeded.expandedWorkspaceKeys).toEqual(['/work/mino']);

    const userCollapsed = { ...seeded, expandedWorkspaceKeys: [] };
    expect(
      seedDefaultWorkspaceExpansion(userCollapsed, '/work/mino', [
        '/work/mino',
      ]),
    ).toBe(userCollapsed);
  });

  it('prunes removed workspaces and keeps automatic rail separate from preference', () => {
    const preference = {
      ...DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
      preferredMode: 'expanded' as const,
      expandedWorkspaceKeys: ['/work/a', '/work/b'],
    };
    expect(
      pruneRemovedWorkspaceKeys(preference, ['/work/b']).expandedWorkspaceKeys,
    ).toEqual(['/work/b']);
    expect(resolveGlobalSidebarMode(preference.preferredMode, true)).toBe(
      'rail',
    );
    expect(resolveGlobalSidebarMode(preference.preferredMode, false)).toBe(
      'expanded',
    );
  });
});
