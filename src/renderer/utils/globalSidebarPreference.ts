import { normalizeWorkspacePathIdentity } from '../../shared/workspacePath';

export const GLOBAL_SIDEBAR_PREFERENCE_KEY = 'myagents.globalSidebar.v1';
export const LEGACY_AUTOMATION_HISTORY_KEY = 'myagents.launcher.showAutomationHistorySessions';

export type GlobalSidebarPreferredMode = 'expanded' | 'rail';

export interface GlobalSidebarPreferenceV1 {
  version: 1;
  preferredMode: GlobalSidebarPreferredMode;
  expandedWorkspaceKeys: string[];
  hasSeededDefaultExpansion: boolean;
  showAutomationSessions: boolean;
  sessionView: 'all' | 'favorites' | 'archived';
}

export const DEFAULT_GLOBAL_SIDEBAR_PREFERENCE: GlobalSidebarPreferenceV1 = {
  version: 1,
  preferredMode: 'expanded',
  expandedWorkspaceKeys: [],
  hasSeededDefaultExpansion: false,
  showAutomationSessions: false,
  sessionView: 'all',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeWorkspaceKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    keys.add(normalizeWorkspacePathIdentity(candidate));
  }
  return [...keys];
}

export function parseGlobalSidebarPreference(value: unknown): GlobalSidebarPreferenceV1 | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (value.preferredMode !== 'expanded' && value.preferredMode !== 'rail') return null;
  if (typeof value.hasSeededDefaultExpansion !== 'boolean') return null;

  return {
    version: 1,
    preferredMode: value.preferredMode,
    expandedWorkspaceKeys: normalizeWorkspaceKeys(value.expandedWorkspaceKeys),
    hasSeededDefaultExpansion: value.hasSeededDefaultExpansion,
    showAutomationSessions: typeof value.showAutomationSessions === 'boolean'
      ? value.showAutomationSessions
      : false,
    sessionView: value.sessionView === 'favorites' || value.sessionView === 'archived'
      ? value.sessionView : 'all',
  };
}

export function loadGlobalSidebarPreference(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): GlobalSidebarPreferenceV1 {
  const raw = storage.getItem(GLOBAL_SIDEBAR_PREFERENCE_KEY);
  if (raw) {
    try {
      const parsed = parseGlobalSidebarPreference(JSON.parse(raw));
      if (parsed) return parsed;
      console.warn('[GlobalSidebar] Ignoring unsupported sidebar preference');
    } catch (error) {
      console.warn('[GlobalSidebar] Ignoring malformed sidebar preference:', error);
    }
  }

  const legacyAutomation = storage.getItem(LEGACY_AUTOMATION_HISTORY_KEY);
  const migrated: GlobalSidebarPreferenceV1 = {
    ...DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
    showAutomationSessions: legacyAutomation === 'true',
  };
  try {
    storage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify(migrated));
    if (legacyAutomation !== null) storage.removeItem(LEGACY_AUTOMATION_HISTORY_KEY);
  } catch (error) {
    console.warn('[GlobalSidebar] Failed to persist migrated sidebar preference:', error);
  }
  return migrated;
}

export function saveGlobalSidebarPreference(
  storage: Pick<Storage, 'setItem'>,
  preference: GlobalSidebarPreferenceV1,
): boolean {
  try {
    storage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify(preference));
    return true;
  } catch (error) {
    console.warn('[GlobalSidebar] Failed to persist sidebar preference:', error);
    return false;
  }
}

export function seedDefaultWorkspaceExpansion(
  preference: GlobalSidebarPreferenceV1,
  defaultWorkspacePath: string | null | undefined,
  validWorkspacePaths: readonly string[],
): GlobalSidebarPreferenceV1 {
  if (preference.hasSeededDefaultExpansion || !defaultWorkspacePath) return preference;
  const defaultKey = normalizeWorkspacePathIdentity(defaultWorkspacePath);
  const validKeys = new Set(validWorkspacePaths.map(normalizeWorkspacePathIdentity));
  if (!validKeys.has(defaultKey)) return preference;
  return {
    ...preference,
    expandedWorkspaceKeys: [...new Set([...preference.expandedWorkspaceKeys, defaultKey])],
    hasSeededDefaultExpansion: true,
  };
}

export function pruneRemovedWorkspaceKeys(
  preference: GlobalSidebarPreferenceV1,
  validWorkspacePaths: readonly string[],
): GlobalSidebarPreferenceV1 {
  const validKeys = new Set(validWorkspacePaths.map(normalizeWorkspacePathIdentity));
  const expandedWorkspaceKeys = preference.expandedWorkspaceKeys.filter((key) => validKeys.has(key));
  if (expandedWorkspaceKeys.length === preference.expandedWorkspaceKeys.length) return preference;
  return { ...preference, expandedWorkspaceKeys };
}

export function resolveGlobalSidebarMode(
  preferredMode: GlobalSidebarPreferredMode,
  forceRail: boolean,
): GlobalSidebarPreferredMode {
  return forceRail ? 'rail' : preferredMode;
}
