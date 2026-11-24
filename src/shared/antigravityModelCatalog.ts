import type { RuntimeModelInfo } from './types/runtime';

// Shared pure policy for Antigravity CLI (`agy`) model catalog normalization and
// legacy flat-ID compatibility across sidecar and renderer.
//
// `agy models` CLI outputs flat (model × thought_level) rows such as
// `gemini-4-neon-high\tGemini 4 Neon (High)`, whereas an active `agy acp`
// session exposes `configOptions` split into model families (`gemini-4-neon`)
// and independent `thought_level` choices (`low`, `medium`, `high`, `xhigh`).
// Normalizing the flat CLI catalog with the exact same family-collapse rule
// keeps Launcher, idle Chat, and active ACP Chat visually and semantically
// identical without spawning an ACP worker just to populate menus.

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORT_RANK = new Map<string, number>(EFFORT_ORDER.map((level, index) => [level, index]));

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra',
  max: 'Max',
};

const FLAT_VALUE_EFFORT_RE = /^(.+)-(minimal|low|medium|high|xhigh|max)$/i;
const FLAT_NAME_EFFORT_RE = /^(.+?)\s*\((Minimal|Low|Medium|High|XHigh|Extra|Max)\)\s*$/i;

function canonicalEffortToken(token: string): string | null {
  const lower = token.trim().toLowerCase();
  if (lower === 'extra') return 'xhigh';
  return EFFORT_RANK.has(lower) ? lower : null;
}

export interface RawAntigravityModelEntry {
  value: string;
  displayName: string;
}

export interface ParsedAntigravityFlatModelId {
  familyId: string;
  effort: string;
}

/**
 * Parse a legacy flat Antigravity model ID (e.g. `gemini-4-neon-high`) into its
 * family ID (`gemini-4-neon`) and canonical effort (`high`). Returns `null`
 * when the ID does not end with a known effort suffix.
 */
export function splitAntigravityFlatModelId(
  modelId: string | null | undefined,
): ParsedAntigravityFlatModelId | null {
  const trimmed = modelId?.trim();
  if (!trimmed) return null;
  const match = FLAT_VALUE_EFFORT_RE.exec(trimmed);
  if (!match) return null;
  const familyId = match[1]?.trim();
  const effort = canonicalEffortToken(match[2] ?? '');
  if (!familyId || !effort) return null;
  return { familyId, effort };
}

function parseFlatCatalogRow(entry: RawAntigravityModelEntry): {
  familyId: string;
  familyName: string;
  effort: string;
} | null {
  const valueMatch = FLAT_VALUE_EFFORT_RE.exec(entry.value.trim());
  const nameMatch = FLAT_NAME_EFFORT_RE.exec(entry.displayName.trim());
  if (!valueMatch || !nameMatch) return null;
  const familyId = valueMatch[1]?.trim();
  const valueEffort = canonicalEffortToken(valueMatch[2] ?? '');
  const familyName = nameMatch[1]?.trim();
  const nameEffort = canonicalEffortToken(nameMatch[2] ?? '');
  if (!familyId || !familyName || !valueEffort || valueEffort !== nameEffort) {
    return null;
  }
  return { familyId, familyName, effort: valueEffort };
}

/**
 * Collapse flat Antigravity `(model × effort)` rows into model families with
 * `supportedReasoningEfforts` + `defaultReasoningEffort`, matching `agy acp`'s
 * `configOptions` schema:
 * - Families with ≥2 distinct effort variants collapse into one family row.
 * - Single-variant entries (e.g. `gpt-oss-120b-medium`) and non-effort variants
 *   (e.g. `Orchestrator (Neon)`) remain untouched verbatim.
 */
export function normalizeAntigravityFlatModels(
  entries: readonly RawAntigravityModelEntry[],
): RuntimeModelInfo[] {
  type FamilyGroup = {
    familyId: string;
    familyName: string;
    firstEntry: RawAntigravityModelEntry;
    defaultEffort: string;
    efforts: Set<string>;
  };

  const groups = new Map<string, FamilyGroup>();
  const orderedItems: Array<
    | { kind: 'family'; group: FamilyGroup }
    | { kind: 'standalone'; entry: RawAntigravityModelEntry }
  > = [];

  for (const entry of entries) {
    const value = entry.value.trim();
    const displayName = entry.displayName.trim();
    if (!value || !displayName) continue;
    const parsed = parseFlatCatalogRow({ value, displayName });
    if (!parsed) {
      orderedItems.push({ kind: 'standalone', entry: { value, displayName } });
      continue;
    }
    const existing = groups.get(parsed.familyId);
    if (existing) {
      existing.efforts.add(parsed.effort);
    } else {
      const group: FamilyGroup = {
        familyId: parsed.familyId,
        familyName: parsed.familyName,
        firstEntry: { value, displayName },
        defaultEffort: parsed.effort,
        efforts: new Set([parsed.effort]),
      };
      groups.set(parsed.familyId, group);
      orderedItems.push({ kind: 'family', group });
    }
  }

  return orderedItems.map((item): RuntimeModelInfo => {
    if (item.kind === 'standalone') {
      return { value: item.entry.value, displayName: item.entry.displayName };
    }
    const { group } = item;
    // Match `agy acp`: only collapse into a family + thought_level knob when
    // multiple effort variants exist (singletons like `gpt-oss-120b-medium`
    // stay verbatim).
    if (group.efforts.size < 2) {
      return {
        value: group.firstEntry.value,
        displayName: group.firstEntry.displayName,
      };
    }
    const supportedReasoningEfforts: NonNullable<RuntimeModelInfo['supportedReasoningEfforts']> = [...group.efforts]
      .sort((a, b) => (EFFORT_RANK.get(a) ?? 99) - (EFFORT_RANK.get(b) ?? 99))
      .map((effort) => ({
        reasoningEffort: effort,
        description: EFFORT_LABELS[effort] ?? effort,
      }));
    return {
      value: group.familyId,
      displayName: group.familyName,
      supportedReasoningEfforts,
      defaultReasoningEffort: group.defaultEffort,
    };
  });
}

export interface ResolvedAntigravityModelSelection {
  model: RuntimeModelInfo | undefined;
  /** Effort encoded in a legacy flat ID (e.g. `gemini-4-neon-high` → `high`) when mapped onto a family row. */
  legacyEffort?: string;
}

/**
 * Resolve a selected Antigravity model ID against a family-normalized catalog,
 * gracefully mapping legacy persisted flat IDs (e.g. `gemini-4-neon-high`) onto
 * their corresponding family row (`gemini-4-neon`) without losing the effort hint.
 */
export function resolveAntigravityModelSelection(
  models: readonly RuntimeModelInfo[] | undefined,
  selectedModel: string | null | undefined,
): ResolvedAntigravityModelSelection {
  if (!models?.length || !selectedModel) return { model: undefined };
  const exact = models.find((candidate) => candidate.value === selectedModel);
  if (exact) return { model: exact };

  const legacyCurrent = models.find((model) => model.isCurrent
    && splitAntigravityFlatModelId(model.value)?.familyId === selectedModel);
  if (legacyCurrent) return { model: legacyCurrent };
  const split = splitAntigravityFlatModelId(selectedModel);
  if (!split) return { model: undefined };
  const family = models.find((candidate) => candidate.value === split.familyId);
  if (!family) return { model: undefined };
  const supported = family.supportedReasoningEfforts;
  const legacyEffort =
    !supported || supported.some((option) => option.reasoningEffort === split.effort)
      ? split.effort
      : undefined;
  return { model: family, ...(legacyEffort ? { legacyEffort } : {}) };
}
