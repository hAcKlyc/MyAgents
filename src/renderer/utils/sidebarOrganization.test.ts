import { describe, expect, it } from 'vitest';

import {
  createSidebarSection,
  DEFAULT_SIDEBAR_ORGANIZATION,
  moveSidebarItem,
  orderSidebarItems,
  parseSidebarOrganization,
  removeSidebarSection,
  renameSidebarSection,
  reorderSidebarSections,
  toggleSidebarSection,
  type SidebarOrganization,
} from './sidebarOrganization';

const base: SidebarOrganization = {
  sections: [
    { id: 'section:a', name: 'Team', collapsed: true },
    { id: 'section:b', name: 'Later', collapsed: false },
  ],
  placements: { 'session:s1': 'section:a', 'workspace:p1': 'section:b' },
  orders: {
    root: ['workspace:p1'],
    'workspace:p1': ['session:s1'],
    'section:a': ['session:s2'],
  },
};

describe('sidebarOrganization', () => {
  it('migrates missing organization as an empty value and tolerates malformed/unsupported fields', () => {
    expect(parseSidebarOrganization(undefined)).toEqual(
      DEFAULT_SIDEBAR_ORGANIZATION,
    );
    expect(
      parseSidebarOrganization({
        sections: 'bad',
        placements: [],
        orders: null,
      }),
    ).toEqual(DEFAULT_SIDEBAR_ORGANIZATION);
    const parsed = parseSidebarOrganization({
      sections: [
        null,
        { id: 'root', name: 'invalid' },
        { id: 'section:a', name: '  Team  ', collapsed: 1 },
        { id: 'section:a', name: 'duplicate' },
        { id: 'section:b', name: 'B'.repeat(100) },
      ],
      placements: { x: 'missing', 'session:y': 'section:a', ' ': 'section:a' },
      orders: {
        root: ['workspace:x', 'workspace:x', '', 4],
        'workspace:p': ['session:y'],
        missing: ['session:z'],
        'section:a': ['session:q', 'session:q'],
      },
    });
    expect(parsed).toEqual({
      sections: [
        { id: 'section:a', name: 'Team', collapsed: false },
        { id: 'section:b', name: 'B'.repeat(80), collapsed: false },
      ],
      placements: { 'session:y': 'section:a' },
      orders: {
        root: ['workspace:x'],
        'workspace:p': ['session:y'],
        'section:a': ['session:q'],
      },
    });
  });

  it('caps section count and rejects invalid creation/rename without mutating the input', () => {
    const many = parseSidebarOrganization({
      sections: Array.from({ length: 55 }, (_, i) => ({
        id: `section:s${i}`,
        name: `S${i}`,
      })),
    });
    expect(many.sections).toHaveLength(50);
    expect(createSidebarSection(base, '   ', 'new')).toBe(base);
    expect(createSidebarSection(base, 'New', 'root')).toBe(base);
    expect(renameSidebarSection(base, 'section:a', '  ')).toBe(base);
    const created = createSidebarSection(
      base,
      ` ${'N'.repeat(100)} `,
      'section:c',
    );
    expect(created.sections.at(-1)).toEqual({
      id: 'section:c',
      name: 'N'.repeat(80),
      collapsed: false,
    });
    expect(base.sections).toHaveLength(2);
  });

  it('moves across sections, clears membership when restored to its implicit workspace, and inserts at requested position', () => {
    const moved = moveSidebarItem(
      base,
      'session:s1',
      'section:b',
      ['session:s3', 'session:s1', 'session:s4'],
      'session:s4',
    );
    expect(moved.placements['session:s1']).toBe('section:b');
    expect(moved.sections[1].collapsed).toBe(false);
    expect(moved.orders['section:b']).toEqual([
      'session:s3',
      'session:s1',
      'session:s4',
    ]);
    expect(
      Object.values(moved.orders)
        .flat()
        .filter((id) => id === 'session:s1'),
    ).toHaveLength(1);

    const restored = moveSidebarItem(
      moved,
      'session:s1',
      'workspace:p1',
      ['session:s2'],
      'missing',
    );
    expect(restored.placements['session:s1']).toBeUndefined();
    expect(restored.orders['workspace:p1']).toEqual([
      'session:s2',
      'session:s1',
    ]);
    expect(
      moveSidebarItem(base, 'session:s1', 'deleted-section', [], undefined),
    ).toBe(base);
  });

  it('preserves hidden and partially loaded target ordering while moving visible items', () => {
    const organization: SidebarOrganization = {
      ...base,
      orders: {
        'section:b': [
          'session:a',
          'session:hidden',
          'session:b',
          'session:unloaded',
        ],
      },
    };
    const moved = moveSidebarItem(
      organization,
      'session:new',
      'section:b',
      ['session:a', 'session:b'],
      'session:b',
    );
    expect(moved.orders['section:b']).toEqual([
      'session:a',
      'session:hidden',
      'session:new',
      'session:b',
      'session:unloaded',
    ]);

    const favoritesFiltered = moveSidebarItem(moved, 'session:b', 'section:b', [
      'session:new',
    ]);
    expect(favoritesFiltered.orders['section:b']).toEqual([
      'session:a',
      'session:hidden',
      'session:new',
      'session:b',
      'session:unloaded',
    ]);
  });

  it('rejects non-namespaced item IDs and reserved/custom section container IDs', () => {
    expect(
      parseSidebarOrganization(
        JSON.parse(`{
      "sections": [
        { "id": "__proto__", "name": "bad" },
        { "id": "workspace:project", "name": "bad" },
        { "id": "section:ok", "name": "good" }
      ],
      "placements": { "__proto__": "section:ok", "session:good": "__proto__" },
      "orders": { "__proto__": ["session:good"], "section:ok": ["unknown", "session:good"] }
    }`),
      ),
    ).toEqual({
      sections: [{ id: 'section:ok', name: 'good', collapsed: false }],
      placements: {},
      orders: { 'section:ok': ['session:good'] },
    });
    expect(moveSidebarItem(base, '__proto__', 'section:a', [], undefined)).toBe(
      base,
    );
    expect(
      moveSidebarItem(base, 'session:s1', 'workspace:', [], undefined),
    ).toBe(base);
    expect(createSidebarSection(base, 'Bad ID', 'constructor')).toBe(base);
  });

  it('orders loaded IDs and leaves IDs absent from the saved order in their original order', () => {
    const input = ['new', 'two', 'one', 'unloaded'].map((id) => ({ id }));
    expect(
      orderSidebarItems(input, (item) => item.id, [
        'one',
        'two',
        'not-loaded',
      ]).map(({ id }) => id),
    ).toEqual(['one', 'two', 'new', 'unloaded']);
    expect(orderSidebarItems(input, (item) => item.id, undefined)).toEqual(
      input,
    );
  });

  it('deletes only section metadata and supports collapse, expand, rename and section reorder', () => {
    const removed = removeSidebarSection(base, 'section:a');
    expect(removed.sections.map(({ id }) => id)).toEqual(['section:b']);
    expect(removed.placements).toEqual({ 'workspace:p1': 'section:b' });
    expect(removed.orders.root).toEqual(['workspace:p1']);
    expect(removed.orders['workspace:p1']).toEqual(['session:s1']);
    expect(removed.orders['section:a']).toBeUndefined();

    const collapsed = toggleSidebarSection(base, 'section:b');
    expect(collapsed.sections[1].collapsed).toBe(true);
    const expanded = toggleSidebarSection(collapsed, 'section:b');
    expect(expanded.sections[1].collapsed).toBe(false);
    expect(
      renameSidebarSection(base, 'section:a', 'Renamed').sections[0].name,
    ).toBe('Renamed');
    expect(
      reorderSidebarSections(base, 'section:b', 'section:a').sections.map(
        ({ id }) => id,
      ),
    ).toEqual(['section:b', 'section:a']);
  });
});
