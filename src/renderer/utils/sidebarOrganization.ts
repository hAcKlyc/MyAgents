export type SidebarItemId = string;

export interface SidebarSection {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface SidebarOrganization {
  sections: SidebarSection[];
  /** Only custom-section membership is stored; workspace/root membership is implicit. */
  placements: Record<SidebarItemId, string>;
  /** Ordered item IDs keyed by root, workspace ID, or custom section ID. */
  orders: Record<string, SidebarItemId[]>;
}

export const DEFAULT_SIDEBAR_ORGANIZATION: SidebarOrganization = {
  sections: [],
  placements: {},
  orders: {},
};

const MAX_SECTIONS = 50;
const MAX_SECTION_NAME_LENGTH = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasNonEmptySuffix(value: string, prefix: string): boolean {
  return (
    value.startsWith(prefix) && value.slice(prefix.length).trim().length > 0
  );
}

function isWorkspaceContainer(value: string): boolean {
  return hasNonEmptySuffix(value, 'workspace:');
}

function isSectionId(value: string): boolean {
  return hasNonEmptySuffix(value, 'section:');
}

function isSidebarItemId(value: unknown): value is SidebarItemId {
  return (
    typeof value === 'string' &&
    (hasNonEmptySuffix(value, 'workspace:') ||
      hasNonEmptySuffix(value, 'session:'))
  );
}

function validContainerId(
  value: string,
  sectionIds: ReadonlySet<string>,
): boolean {
  return (
    value === 'root' || isWorkspaceContainer(value) || sectionIds.has(value)
  );
}

function cloneOrganization(value: SidebarOrganization): SidebarOrganization {
  return {
    sections: value.sections.map((section) => ({ ...section })),
    placements: { ...value.placements },
    orders: Object.fromEntries(
      Object.entries(value.orders).map(([container, ids]) => [
        container,
        [...ids],
      ]),
    ),
  };
}

export function parseSidebarOrganization(value: unknown): SidebarOrganization {
  if (!isRecord(value)) return cloneOrganization(DEFAULT_SIDEBAR_ORGANIZATION);

  const sections: SidebarSection[] = [];
  const sectionIds = new Set<string>();
  if (Array.isArray(value.sections)) {
    for (const candidate of value.sections) {
      if (sections.length >= MAX_SECTIONS) break;
      if (
        !isRecord(candidate) ||
        !isNonEmptyString(candidate.id) ||
        !isNonEmptyString(candidate.name)
      )
        continue;
      const id = candidate.id.trim();
      const name = candidate.name.trim().slice(0, MAX_SECTION_NAME_LENGTH);
      if (!name || !isSectionId(id) || sectionIds.has(id)) continue;
      sectionIds.add(id);
      sections.push({ id, name, collapsed: candidate.collapsed === true });
    }
  }

  const placements: Record<string, string> = {};
  if (isRecord(value.placements)) {
    for (const [itemId, sectionId] of Object.entries(value.placements)) {
      if (
        isSidebarItemId(itemId) &&
        typeof sectionId === 'string' &&
        sectionIds.has(sectionId)
      ) {
        placements[itemId] = sectionId;
      }
    }
  }

  const orders: Record<string, string[]> = {};
  if (isRecord(value.orders)) {
    for (const [container, rawIds] of Object.entries(value.orders)) {
      if (!validContainerId(container, sectionIds) || !Array.isArray(rawIds))
        continue;
      const seen = new Set<string>();
      const ids = rawIds.filter((id): id is string => {
        if (!isSidebarItemId(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (ids.length) orders[container] = ids;
    }
  }

  return { sections, placements, orders };
}

/** Apply a saved prefix order while preserving the source order of IDs not yet loaded. */
export function orderSidebarItems<T>(
  items: readonly T[],
  ids: (item: T) => string,
  order: readonly string[] | undefined,
): T[] {
  if (!order?.length || items.length < 2) return [...items];
  const rank = new Map<string, number>();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  return items
    .map((item, index) => ({ item, index, rank: rank.get(ids(item)) }))
    .sort((a, b) => {
      if (a.rank === undefined && b.rank === undefined)
        return a.index - b.index;
      if (a.rank === undefined) return 1;
      if (b.rank === undefined) return -1;
      return a.rank - b.rank || a.index - b.index;
    })
    .map(({ item }) => item);
}

function mergeVisibleOrderWithSavedHiddenIds(
  savedOrder: readonly string[],
  reorderedVisibleIds: readonly string[],
  originallyVisibleIds: readonly string[],
  movedItemId: string,
): string[] {
  const visibleSet = new Set(originallyVisibleIds.filter(isSidebarItemId));
  const orderedVisibleIds = [
    ...new Set(reorderedVisibleIds.filter(isSidebarItemId)),
  ];
  const savedVisibleSlotCount = savedOrder.filter(
    (id) => isSidebarItemId(id) && id !== movedItemId && visibleSet.has(id),
  ).length;
  const result: string[] = [];
  const seenSavedIds = new Set<string>();
  let visibleIndex = 0;
  let visibleSlotsSeen = 0;

  for (const id of savedOrder) {
    if (!isSidebarItemId(id) || id === movedItemId || seenSavedIds.has(id))
      continue;
    seenSavedIds.add(id);
    if (visibleSet.has(id)) {
      if (visibleIndex < orderedVisibleIds.length) {
        result.push(orderedVisibleIds[visibleIndex++]);
      }
      visibleSlotsSeen += 1;
      if (visibleSlotsSeen === savedVisibleSlotCount) {
        result.push(...orderedVisibleIds.slice(visibleIndex));
        visibleIndex = orderedVisibleIds.length;
      }
    } else {
      result.push(id);
    }
  }

  // If no prior visible slot existed, preserve hidden IDs first and add the
  // current visible order after them. Otherwise leftovers were placed at the
  // final visible slot, before any later hidden IDs.
  if (savedVisibleSlotCount === 0) result.push(...orderedVisibleIds);
  return result;
}

export function moveSidebarItem(
  current: SidebarOrganization,
  itemId: string,
  targetContainer: string,
  visibleTargetIds: readonly string[],
  beforeId?: string,
): SidebarOrganization {
  const sectionIds = new Set(current.sections.map(({ id }) => id));
  if (
    !isSidebarItemId(itemId) ||
    !validContainerId(targetContainer, sectionIds)
  )
    return current;

  const originalTargetOrder = current.orders[targetContainer] ?? [];
  const next = cloneOrganization(current);
  for (const [container, ids] of Object.entries(next.orders)) {
    next.orders[container] = ids.filter((id) => id !== itemId);
    if (!next.orders[container].length) delete next.orders[container];
  }

  if (targetContainer === 'root' || isWorkspaceContainer(targetContainer)) {
    delete next.placements[itemId];
  } else {
    next.placements[itemId] = targetContainer;
    const section = next.sections.find(({ id }) => id === targetContainer);
    if (section) section.collapsed = false;
  }

  const visibleIds = [
    ...new Set(visibleTargetIds.filter(isSidebarItemId)),
  ].filter((id) => id !== itemId);
  const requestedIndex = beforeId ? visibleIds.indexOf(beforeId) : -1;
  const insertionIndex =
    requestedIndex >= 0 ? requestedIndex : visibleIds.length;
  visibleIds.splice(insertionIndex, 0, itemId);

  // Keep saved IDs hidden by filters or partial loading in their existing slots.
  // Visible IDs are reordered into their old slots; newly visible IDs append after
  // those slots, which preserves hidden IDs' relative order without discarding them.
  next.orders[targetContainer] = mergeVisibleOrderWithSavedHiddenIds(
    originalTargetOrder,
    visibleIds,
    visibleTargetIds,
    itemId,
  );
  return next;
}

export function removeSidebarSection(
  current: SidebarOrganization,
  id: string,
): SidebarOrganization {
  if (!current.sections.some((section) => section.id === id)) return current;
  const next = cloneOrganization(current);
  next.sections = next.sections.filter((section) => section.id !== id);
  for (const [itemId, sectionId] of Object.entries(next.placements)) {
    if (sectionId === id) delete next.placements[itemId];
  }
  delete next.orders[id];
  return next;
}

export function createSidebarSection(
  current: SidebarOrganization,
  name: string,
  id: string,
): SidebarOrganization {
  const normalizedName = name.trim().slice(0, MAX_SECTION_NAME_LENGTH);
  if (
    !normalizedName ||
    !isSectionId(id) ||
    current.sections.some((section) => section.id === id) ||
    current.sections.length >= MAX_SECTIONS
  )
    return current;
  const next = cloneOrganization(current);
  next.sections.push({ id, name: normalizedName, collapsed: false });
  return next;
}

export function renameSidebarSection(
  current: SidebarOrganization,
  id: string,
  name: string,
): SidebarOrganization {
  const normalizedName = name.trim().slice(0, MAX_SECTION_NAME_LENGTH);
  if (!normalizedName) return current;
  const index = current.sections.findIndex((section) => section.id === id);
  if (index < 0 || current.sections[index].name === normalizedName)
    return current;
  const next = cloneOrganization(current);
  next.sections[index].name = normalizedName;
  return next;
}

export function toggleSidebarSection(
  current: SidebarOrganization,
  id: string,
): SidebarOrganization {
  const index = current.sections.findIndex((section) => section.id === id);
  if (index < 0) return current;
  const next = cloneOrganization(current);
  next.sections[index].collapsed = !next.sections[index].collapsed;
  return next;
}

export function reorderSidebarSections(
  current: SidebarOrganization,
  activeId: string,
  overId: string,
): SidebarOrganization {
  const from = current.sections.findIndex(({ id }) => id === activeId);
  const to = current.sections.findIndex(({ id }) => id === overId);
  if (from < 0 || to < 0 || from === to) return current;
  const next = cloneOrganization(current);
  const [active] = next.sections.splice(from, 1);
  next.sections.splice(to, 0, active);
  return next;
}
