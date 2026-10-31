/**
 * Compatibility policy for persisted MCP selections. Each store applies this
 * only to its own values, never to another owner's effective state. IDs in real
 * arrays are opaque (including single-character IDs); never guess lost IDs from
 * a character array. Unrecoverable present values fail closed to explicit [].
 * Missing/null retain the existing unspecified-selection semantics.
 * Rust parity: mcp_selection.rs; fixtures: __fixtures__/mcpSelection.json.
 */
/** Agent owns future defaults; Project is a compatibility source only when
 * no Agent exists. Global availability and an owned Session are separate.
 */
export function resolveDefaultMcpSelection(
  agent: { mcpEnabledServers?: string[] } | undefined,
  project: { mcpEnabledServers?: string[] } | undefined,
): string[] {
  return (agent ? agent.mcpEnabledServers : project?.mcpEnabledServers) ?? [];
}

export function normalizeMcpSelection(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const text = value.trim();
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // Only the historical unquoted bracketed ID list is recoverable. Do not
      // reinterpret broken JSON, nested values, or arbitrary scalar strings.
      if (!/^\[\s*[A-Za-z0-9_./:@+-]+(?:\s*,\s*[A-Za-z0-9_./:@+-]+)*\s*\]$/.test(text)) return [];
      parsed = text.slice(1, -1).split(',').map(id => id.trim());
    }
  }
  return Array.isArray(parsed) && parsed.every(id => typeof id === 'string')
    ? parsed as string[]
    : [];
}

/** Normalize one persisted holder, without touching serialized mcpServersJson. */
export function normalizeMcpSelectionField(holder: unknown): boolean {
  if (!holder || typeof holder !== 'object' || Array.isArray(holder)) return false;
  const record = holder as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'mcpEnabledServers')) return false;
  const current = record.mcpEnabledServers;
  const normalized = normalizeMcpSelection(current);
  if (current === normalized) return false;
  if (normalized === undefined) delete record.mcpEnabledServers;
  else record.mcpEnabledServers = normalized;
  return true;
}

/** Only config-owned holders; deliberately never traverses Session/Task state. */
export function normalizeConfigMcpSelections(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const root = config as Record<string, unknown>;
  let changed = normalizeMcpSelectionField(root);
  for (const key of ['agents', 'projects', 'imBotConfigs']) {
    const holders = root[key];
    if (Array.isArray(holders)) {
      for (const holder of holders) changed = normalizeMcpSelectionField(holder) || changed;
    }
  }
  for (const key of ['launcherLastUsed', 'imBotConfig']) {
    changed = normalizeMcpSelectionField(root[key]) || changed;
  }
  return changed;
}

export function normalizeProjectMcpSelections(projects: unknown): void {
  if (Array.isArray(projects)) projects.forEach(normalizeMcpSelectionField);
}
