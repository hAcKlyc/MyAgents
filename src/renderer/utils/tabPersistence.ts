// Tab restore persistence (Issue #232 / PRD 0.2.25).
//
// Persists the list of open chat / Record tabs to localStorage so they can be
// restored after an app restart / update. This module is the PURE core:
// serialize / deserialize / save / load with no React or sidecar coupling,
// so the filtering + dedup + validation invariants are unit-testable in the
// fast pool (see tabPersistence.test.ts).
//
// Design (PRD 0.2.25, codex-reviewed):
//  - Chat tabs need a REAL sessionId; Record tabs need a stable recordId.
//    Launcher tabs, pending sessions, and other views are dropped.
//  - De-duped by owned identity: a Session / Record can only live in one tab.
//  - persist-on-mutation: callers write synchronously on every structural
//    change. We do NOT rely on `beforeunload` (unreliable in Tauri WKWebView;
//    update install exits from the Rust side — see App.handleRestartAndUpdate).
//  - Hydration creates normal live Tab shapes. App owns validation, merge,
//    Session materialization, and rollback.

import { MAX_TABS, type Tab } from '@/types/tab';
import { builtinTabModules } from '@/tab-workspace/builtinComposition';
import {
  hydrateRegisteredTab,
  parseRegisteredTab,
  serializeRegisteredTab,
  type RegisteredPersistenceWire,
  type TabPersistenceProjection,
} from '@/tab-workspace/registry';

export type { PersistedChatTab } from '@/features/chat/tabPersistence';
export type { PersistedRecordTab } from '@/features/record/tabPersistence';

const PERSIST_KEY = 'myagents.openTabs.v1';
const PERSIST_VERSION = 1 as const;

/** Whitelisted persisted shapes. Runtime-only fields (recording snapshots,
 *  seek intents, generation state, sidecar disposition, drafts) never cross
 *  this boundary. */
export type PersistedTab = RegisteredPersistenceWire<typeof builtinTabModules>;

export interface PersistedTabState {
  version: typeof PERSIST_VERSION;
  tabs: PersistedTab[];
  activeTabId: string | null;
}

/**
 * Reduce the live tab list to the persisted shape. Returns null when there is
 * nothing worth persisting (so callers can clear the key instead of writing an
 * empty record).
 *
 * Invariants:
 *  - only restorable chat / Record tabs
 *  - field whitelist (no runtime-only fields leak to disk)
 *  - de-duped by Session / Record identity, first occurrence wins
 *  - capped at MAX_TABS
 *  - activeTabId is preserved only if it survives filtering; otherwise falls
 *    back to the first surviving tab
 */
export function serializeTabs(tabs: readonly Tab[], activeTabId: string | null): PersistedTabState | null {
  const seenResources = new Set<string>();
  const seenIds = new Set<string>();
  const persisted: PersistedTab[] = [];
  for (const tab of tabs) {
    const projection = serializeRegisteredTab(builtinTabModules, tab);
    if (!projection) continue;
    const entry = projection.value;
    const identity = projection.resourceIdentity;
    // Duplicate ids collide as React keys and owner ids; duplicate resource
    // identities violate the existing single-instance navigation contract.
    if (seenResources.has(identity) || seenIds.has(tab.id)) continue;
    seenResources.add(identity);
    seenIds.add(tab.id);
    persisted.push(entry);
    if (persisted.length >= MAX_TABS) break;
  }
  if (persisted.length === 0) return null;

  const activeSurvives = activeTabId != null && persisted.some((t) => t.id === activeTabId);
  return {
    version: PERSIST_VERSION,
    tabs: persisted,
    activeTabId: activeSurvives ? activeTabId : persisted[0].id,
  };
}

function normalizePersistedTab(value: unknown): TabPersistenceProjection<PersistedTab> | null {
  return parseRegisteredTab(builtinTabModules, value);
}

/**
 * Parse a raw localStorage string back into a validated PersistedTabState.
 * Returns null on ANY problem (bad JSON, version mismatch, no valid tabs) so
 * the caller cleanly falls back to a fresh launcher tab — never throws.
 *
 * Re-applies dedup + cap defensively in case the stored payload was written by
 * an older/buggy build or hand-edited.
 */
export function deserializeTabs(raw: string | null): PersistedTabState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== PERSIST_VERSION) return null;
  if (!Array.isArray(obj.tabs)) return null;

  const seenResources = new Set<string>();
  const seenIds = new Set<string>();
  const tabs: PersistedTab[] = [];
  for (const candidate of obj.tabs) {
    const projection = normalizePersistedTab(candidate);
    if (!projection) continue;
    const tab = projection.value;
    if (seenResources.has(projection.resourceIdentity) || seenIds.has(tab.id)) continue;
    seenResources.add(projection.resourceIdentity);
    seenIds.add(tab.id);
    tabs.push(tab);
    if (tabs.length >= MAX_TABS) break;
  }
  if (tabs.length === 0) return null;

  const activeTabId =
    typeof obj.activeTabId === 'string' && tabs.some((t) => t.id === obj.activeTabId) ? obj.activeTabId : tabs[0].id;

  return { version: PERSIST_VERSION, tabs, activeTabId };
}

/** Synchronous persist-on-mutation. Clears the key when there's nothing to
 *  store. Swallows storage errors (quota / private mode) — persistence is
 *  best-effort and must never break the app. */
export function saveOpenTabs(tabs: readonly Tab[], activeTabId: string | null): void {
  try {
    const state = serializeTabs(tabs, activeTabId);
    if (state === null) {
      window.localStorage.removeItem(PERSIST_KEY);
    } else {
      window.localStorage.setItem(PERSIST_KEY, JSON.stringify(state));
    }
  } catch {
    // ignore — localStorage unavailable / quota exceeded
  }
}

/** Read + validate the persisted state. Returns null when nothing restorable
 *  is stored (caller falls back to a fresh launcher tab). */
export function loadPersistedTabs(): PersistedTabState | null {
  try {
    return deserializeTabs(window.localStorage.getItem(PERSIST_KEY));
  } catch {
    return null;
  }
}

/** Hydrate a validated PersistedTabState into normal live Tab shapes. They
 *  remain only in the restore candidate until the user accepts the pill; App
 *  validates and atomically mounts survivors. */
export function hydratePersistedState(state: PersistedTabState): {
  tabs: Tab[];
  activeTabId: string | null;
} {
  const tabs = state.tabs.flatMap((tab) => {
    const hydrated = hydrateRegisteredTab<Tab, typeof builtinTabModules>(builtinTabModules, tab);
    return hydrated ? [hydrated] : [];
  });
  return { tabs, activeTabId: state.activeTabId };
}

/** Read + hydrate the localStorage-persisted tabs. Returns null when there's
 *  nothing to restore (caller falls back to a fresh launcher tab). */
export function buildRestoredTabs(): {
  tabs: Tab[];
  activeTabId: string | null;
} | null {
  const state = loadPersistedTabs();
  if (!state) return null;
  return hydratePersistedState(state);
}

/** Decide whether the durable-handoff snapshot (fsync'd to disk right before an
 *  abrupt update-restart — see tabPersistenceDurable) should override the
 *  synchronous localStorage boot read.
 *
 *  localStorage is written on every structural change AND flushed on a clean
 *  quit, so whenever it yields a restore it is at least as fresh as the durable
 *  handoff — trust it. The durable snapshot only wins when localStorage came up
 *  EMPTY, i.e. its asynchronous WebView disk-flush was lost to the abrupt exit
 *  (the exact failure this backstop exists to fix). Returns the state to adopt,
 *  or null to keep the localStorage result. */
export function pickDurableOverride(
  hadLocalRestore: boolean,
  durable: PersistedTabState | null,
): PersistedTabState | null {
  if (hadLocalRestore) return null;
  if (!durable || durable.tabs.length === 0) return null;
  return durable;
}

/** Parse the Rust-written clean-exit marker (`~/.myagents/last-exit.json`).
 *  Returns true ONLY for a well-formed `{ "clean": true }`; anything else
 *  (absent → null, malformed, `clean:false`) is treated as NOT a clean quit so
 *  the boot offers to restore. See `lastExitMarker.ts`. */
export function parseCleanMarker(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null && (v as { clean?: unknown }).clean === true;
  } catch {
    return false;
  }
}

/** Decide whether to surface the "restore previous tabs" pill on boot (Issue
 *  #309). We offer restore ONLY when the last exit was NOT a deliberate user
 *  quit (i.e. a crash or an update-restart) AND there is a non-empty restorable
 *  snapshot. A clean quit means the user chose to end the window state → boot
 *  fresh, no nag. Pure + unit-tested; the title-bar pill and the App boot
 *  effect share this single predicate. */
export function shouldOfferRestore(lastExitWasClean: boolean, restorableTabCount: number): boolean {
  return !lastExitWasClean && restorableTabCount > 0;
}

function restoreResourceIdentity(tab: Tab): string | null {
  if (tab.view === 'remote-session') return builtinTabModules['remote-session'].identity(tab);
  if (tab.view === 'chat' && tab.sessionId) return `chat:${tab.sessionId}`;
  if (tab.view === 'record' && tab.recordId) return `record:${tab.recordId}`;
  // App may replace a missing persisted Record with the existing Record-list
  // surface at the same tab id. It is a one-restore fallback, not persisted.
  if (tab.view === 'taskcenter') return 'taskcenter';
  return null;
}

/** Plan how clicking the restore pill (Issue #309) merges the previous tabs
 *  into the currently-open tabs. Replaces a still-pristine lone launcher (the
 *  boot default); otherwise APPENDS candidate tabs — de-duped by Session or
 *  Record identity and capped at MAX_TABS — so it never
 *  disturbs work the user already started.
 *
 *  Crucially the merged list AND the surviving `activeTabId` are computed from
 *  the SAME merge: the active id is the candidate's active tab if it survived
 *  the dedup + cap, else the first restored tab still in the list, else the last
 *  tab. This avoids the "two same-render setState from divergent bases" bug
 *  (App computing setActiveTabId independently of the setTabs reducer would let
 *  the active id point at a tab that got sliced/deduped out → blank content).
 *  Returns null when there is nothing to restore. Pure + unit-tested. */
export function planRestoreTabs(
  prev: readonly Tab[],
  candidate: { tabs: readonly Tab[]; activeTabId: string | null },
  maxTabs: number = MAX_TABS,
): { tabs: Tab[]; activeTabId: string } | null {
  if (candidate.tabs.length === 0) return null;
  const onlyPristineLauncher = prev.length === 1 && prev[0]?.view === 'launcher' && !prev[0].launcherWorkspacePath;
  const base = onlyPristineLauncher ? [] : prev;
  const openResources = new Set(base.map(restoreResourceIdentity).filter(Boolean));
  const openTabIds = new Set(base.map((tab) => tab.id));
  const toAdd = candidate.tabs.filter((tab) => {
    const identity = restoreResourceIdentity(tab);
    if (identity == null || openResources.has(identity) || openTabIds.has(tab.id)) {
      return false;
    }
    openResources.add(identity);
    openTabIds.add(tab.id);
    return true;
  });
  if (toAdd.length === 0) return null; // everything is already open — nothing to bring back

  const tabs = [...base, ...toAdd].slice(0, maxTabs);
  const addedIds = new Set(toAdd.map((t) => t.id));
  // If the cap left no room for ANY restored tab (base already at maxTabs),
  // the restore would be a visual no-op → signal "nothing happened".
  if (!tabs.some((t) => addedIds.has(t.id))) return null;

  const inList = (id: string | null | undefined): id is string => id != null && tabs.some((t) => t.id === id);
  // Active id from the SAME merge: candidate's active if it survived dedup+cap,
  // else the first restored tab still in the list (guaranteed to exist), else
  // the last tab. Never points outside `tabs`.
  const firstRestoredInList = tabs.find((t) => addedIds.has(t.id))!.id;
  const activeTabId = inList(candidate.activeTabId) ? candidate.activeTabId : firstRestoredInList;
  return { tabs, activeTabId };
}
