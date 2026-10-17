// Config load-boundary schema normalization (pure, side-effect free).
//
// Kept as a dependency-free leaf module so it can be unit-tested in the fast
// `unit` pool without pulling Tauri/runtime imports.
import { normalizeConfigMcpSelections } from '../../../shared/mcpSelection';
import type { AppConfig } from '../types';
export { promoteAgentMcpJsonToGlobal } from '../../../shared/mcpConfig';

/**
 * Restore persisted MCP selections and the "stringified JSON" invariant at the
 * config boundary. `providerEnvJson` / `mcpServersJson` are declared as `string` (they
 * carry a *serialized* JSON blob), but a legacy write path — or a hand-edit —
 * can persist them as a raw JSON object/array. That breaks every strict
 * consumer of the config:
 *
 *   - the renderer's `cmd_start_agent_channel` IPC rejects the whole
 *     `agentConfig` argument with `invalid type: map, expected a string`
 *     (issue #301) → the channel can never start, and retrying never helps
 *     because the bad value is persisted;
 *   - Rust boot-time `read_agent_configs_from_disk` fails the strict
 *     `AgentConfigRust` parse → no agent channels auto-start.
 *
 * Coercing an object back to its stringified form is semantically lossless: the
 * object is exactly what the string is meant to contain, so any downstream
 * `JSON.parse` round-trips to the same value. Idempotent — already-string
 * values are left untouched. Mutates `config` in place and returns whether
 * anything changed (used by tests; callers normalize in-memory on every load
 * and let the disk heal opportunistically on the next config write).
 *
 * MUST stay in sync with the Rust twin `normalize_stringified_json_value`
 * (`src-tauri/src/im/config_store.rs`) — the two independent config readers restore the
 * same invariant. Shared regression fixture:
 * `src/shared/__fixtures__/dirtyConfig301.json`.
 */
export function normalizeStringifiedJsonFields(config: AppConfig): boolean {
  let changed = normalizeConfigMcpSelections(config);
  const agents = (config as unknown as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return changed;

  for (const agent of agents) {
    if (!agent || typeof agent !== 'object') continue;
    const a = agent as Record<string, unknown>;

    if (coerceJsonStringField(a, 'providerEnvJson')) changed = true;
    if (coerceJsonStringField(a, 'mcpServersJson')) changed = true;

    const channels = a.channels;
    if (Array.isArray(channels)) {
      for (const ch of channels) {
        if (!ch || typeof ch !== 'object') continue;
        const overrides = (ch as Record<string, unknown>).overrides;
        if (overrides && typeof overrides === 'object') {
          if (coerceJsonStringField(overrides as Record<string, unknown>, 'providerEnvJson')) {
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

/**
 * If `obj[field]` is present but not a string, coerce it back to the field's
 * intended shape:
 *   - object / array → `JSON.stringify` (the serialized blob the field holds);
 *   - any other scalar (number / boolean) → delete it (it can't be a valid
 *     blob, and feeding a bogus string to a downstream `JSON.parse` would just
 *     move the failure elsewhere).
 *
 * Returns true iff it changed the field. `undefined` / `null` / `string` are
 * left untouched (so the pass is idempotent on healthy configs).
 */
function coerceJsonStringField(obj: Record<string, unknown>, field: string): boolean {
  const v = obj[field];
  if (v === undefined || v === null || typeof v === 'string') return false;
  if (typeof v === 'object') {
    obj[field] = JSON.stringify(v);
  } else {
    delete obj[field];
  }
  return true;
}
