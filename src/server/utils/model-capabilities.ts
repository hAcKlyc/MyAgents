import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
/**
 * Model capability lookup — read-side for CLAUDE_CODE_AUTO_COMPACT_WINDOW injection.
 *
 * Problem: Claude Agent SDK's autoCompact threshold derives from
 * `getContextWindowForModel(model)` which only recognizes Claude-family models
 * natively; everything else falls back to MODEL_CONTEXT_WINDOW_DEFAULT = 200_000.
 * For third-party providers with smaller windows (e.g. DeepSeek V3 = 128K),
 * the threshold sits above the upstream limit → upstream returns a raw 400
 * "context_length_exceeded" before SDK fires compaction.
 *
 * Fix: inject env `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<N>` so SDK caps its
 * effective window estimate via `Math.min(contextWindow, N)` (autoCompact.ts:40-46).
 *
 * Data sources (in **disk-first override order** — first wins):
 *   1. `~/.myagents/providers/*.json` — user-defined custom providers.
 *   2. `~/.myagents/config.json::presetCustomModels[providerId][]` — models
 *      discovered/added by the user via the UI on preset providers.
 *   3. `PRESET_PROVIDERS` (bundled in `renderer/config/types.ts`) — fallback.
 *   4. `~/.myagents/cache/litellm_model_prices.json` — LiteLLM community data,
 *      fetched by the Rust side on a 24h cadence. LOWEST priority in the flat,
 *      provider-unknown registry. A provider-scoped lookup only reaches this
 *      fallback when the active provider has no corresponding model row; a
 *      provider-owned row with a missing field stays unknown until discovery
 *      or explicit configuration fills it (#516).
 *
 * Rationale for the order: it mirrors the `findProvider`-style disk-first
 * precedence elsewhere in admin-config. If a user pins a corrected
 * `contextLength` for `deepseek-chat` in their own providers file (e.g.
 * because a proxy in front enforces a tighter cap), their value must win
 * over the preset default — otherwise their override is silently ignored.
 *
 * Design:
 *   - Flat Map<modelId, capability>, keyed by the BARE model id. The `[1m]`
 *     capability suffix (and the malformed ` 1m` space form users type by hand,
 *     #338) is stripped at BOTH ingest and lookup — it is purely an SDK-ingress
 *     decoration (re-applied by `applyContextWindowSuffix`), never a key.
 *   - First-wins **PER FIELD** across sources (see `mergeCapabilityInto`), NOT
 *     per-entry: a higher-priority entry that defines only some fields (e.g. a
 *     discovered model carrying `inputModalities` but no `contextLength`) keeps
 *     those fields but does NOT shadow a lower source's value for the fields it
 *     left undefined. (Per-entry first-wins let an incomplete override collapse
 *     the window to the SDK 200K default — #338.)
 *   - Rebuilt every call. Called at session-env build boundaries (Tab /
 *     CronTask / Agent / BackgroundCompletion session spawn, pre-warm,
 *     provider-verify, title-gen). Each call: ≤1 `readdirSync` + bounded
 *     `readFileSync` (capped at 256 files / 1 MB each) + one `config.json`
 *     read. Cache is deliberately skipped so mid-session provider edits take
 *     effect without an invalidate-hook.
 *   - Returns undefined if the model isn't in any registry — callers MUST
 *     treat undefined as "leave SDK's built-in default alone".
 *
 * Scope:
 *   - Covers the builtin Claude Agent SDK path in `agent-session.ts`. External
 *     runtimes (Claude Code CLI / Codex — `src/server/runtimes/`)
 *     spawn via their own env-build (`runtimes/env-utils.ts`) and currently
 *     do NOT receive `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. That's acceptable
 *     for V1 because Codex manages compaction differently and the CC
 *     CLI's `-p` mode respawns per turn. See runtimes/claude-code.ts if the
 *     coverage gap needs closing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { getHomeDirOrNull } from './platform';
import { stripBom } from '../../shared/utils';
import { stripModelSuffix } from '../../shared/contextUsage';
// PRESET_PROVIDERS now lives in src/shared/config-types (moved from
// renderer/config/types in v0.2.9 to satisfy the dependency-cruiser
// `sidecar-no-import-renderer` boundary rule). The historical concern
// — that the source file might pull React / renderer-only deps into
// the Sidecar bundle — is moot now that the file lives in shared/
// where it has zero transitive deps by construction.
import { PRESET_PROVIDERS } from '../../shared/config-types';

export type ModelCapabilitySource = 'preset' | 'custom' | 'discovered' | 'litellm';

/** Modality kinds we recognize. Mirrors OpenAI / OpenRouter convention. */
export type ModalityKind = 'text' | 'image' | 'video' | 'audio';
type NonTextModalityKind = Exclude<ModalityKind, 'text'>;

export interface ModelModalitySupportEvidence {
  supported: boolean;
  source: ModelCapabilitySource;
}

export interface ModelCapability {
  contextLength?: number;
  maxOutputTokens?: number;
  /**
   * Input modalities the model accepts. Currently consumed by the
   * attachment-filter path in agent-session.ts (only the 'image' value is
   * acted on this release). Stored as the full list (`text`, `image`,
   * `video`, `audio`) so the same data drives the future video/audio
   * filters and the modality badges in the model picker without re-research.
   */
  inputModalities?: string[];
  /**
   * Per-modality evidence. Unlike `inputModalities`, this can safely represent
   * LiteLLM's partial boolean flags (for example vision known, audio unknown)
   * without turning every omitted flag into an unsupported capability.
   */
  inputModalitySupport?: Partial<Record<NonTextModalityKind, ModelModalitySupportEvidence>>;
  source: ModelCapabilitySource;
}

// Safety caps for malicious / runaway inputs. A rogue ~/.myagents/providers/
// directory with thousands of files would otherwise freeze the event loop
// on every session-env build.
const MAX_PROVIDER_FILES = 256;
const MAX_PROVIDER_FILE_BYTES = 1 * 1024 * 1024;      // 1 MB
const MAX_CONFIG_FILE_BYTES = 10 * 1024 * 1024;       // 10 MB
// Values above this are almost certainly bogus. Largest known public model is
// ~10M context (Gemini 2M, Llama 3.1 10M); 20M is generous headroom.
const MAX_PLAUSIBLE_TOKENS = 20_000_000;

// LiteLLM fallback (issue: per-model context for third-party models the
// provider's /v1/models doesn't report). The Rust side fetches
// `model_prices_and_context_window.json` (~1.5MB, ~2700 entries) to this path
// on a 24h cadence; we read it here as the LOWEST-priority registry source.
const LITELLM_CACHE_REL = [APP_DATA_DIR_NAME, 'cache', 'litellm_model_prices.json'] as const;
// The file is ~1.5MB today; 24MB headroom guards against runaway growth while
// still rejecting an absurd/poisoned file before we JSON.parse it.
const MAX_LITELLM_FILE_BYTES = 24 * 1024 * 1024;
// LiteLLM `mode` values that denote a text LLM whose context window is
// meaningful to us. The file also carries image_generation / embedding /
// audio_* / rerank / moderation entries (and path-like keys such as
// `1024-x-1024/.../bedrock/...`) whose token fields are NOT chat context — those
// MUST be filtered out or they poison the registry.
const LITELLM_LLM_MODES = new Set(['chat', 'completion', 'responses']);

/** Coerce a JSON-ish numeric field to a finite positive integer, or null. */
function coercePositiveFinite(v: unknown): number | undefined {
  // LiteLLM and some discovery APIs return numbers as strings; accept both.
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_PLAUSIBLE_TOKENS) return undefined;
  return Math.floor(n);
}

/** Coerce a JSON-ish input_modalities array to a string[] of known kinds.
 *  - Non-array → undefined (treated as "no info" → optimistic default-allow)
 *  - Empty array → undefined (same: no info; users meaning "nothing accepted"
 *    should write `['text']` explicitly, since text-only IS the meaningful
 *    minimum and matches how every other source represents it)
 *  - Lowercased + dedup'd; non-string / oversize items dropped silently
 *    (defends against accidental Infinity / very long fragments in custom JSON) */
function coerceModalities(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0 && item.length <= 16) {
      seen.add(item.toLowerCase());
    }
  }
  return seen.size > 0 ? [...seen] : undefined;
}

const NON_TEXT_MODALITY_KINDS: readonly NonTextModalityKind[] = ['image', 'video', 'audio'];

function completeModalityEvidence(
  modalities: readonly string[],
  source: ModelCapabilitySource,
): NonNullable<ModelCapability['inputModalitySupport']> {
  return Object.fromEntries(
    NON_TEXT_MODALITY_KINDS.map(kind => [kind, { supported: modalities.includes(kind), source }]),
  ) as NonNullable<ModelCapability['inputModalitySupport']>;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * LiteLLM exposes modality support in two shapes:
 *   - `supported_modalities`: a complete input list on newer entries;
 *   - per-modality booleans (`supports_vision`, `supports_audio_input`, ...).
 *
 * Prefer a boolean when present because it is the field LiteLLM consumers use
 * for feature gating; otherwise fall back to membership in the complete list.
 * Missing booleans without a list stay unknown rather than being interpreted
 * as `false`.
 */
function readLiteLLMModalityEvidence(
  entry: Record<string, unknown>,
): {
  inputModalities?: string[];
  inputModalitySupport?: ModelCapability['inputModalitySupport'];
} {
  const supportedModalities = coerceModalities(entry.supported_modalities);
  const supportByKind: Partial<Record<NonTextModalityKind, boolean | undefined>> = {
    image: readBoolean(entry.supports_vision) ?? readBoolean(entry.supports_image_input),
    video: readBoolean(entry.supports_video_input),
    audio: readBoolean(entry.supports_audio_input),
  };
  const inputModalitySupport = Object.fromEntries(
    NON_TEXT_MODALITY_KINDS.flatMap(kind => {
      const supported = supportByKind[kind] ?? (
        supportedModalities ? supportedModalities.includes(kind) : undefined
      );
      return typeof supported === 'boolean'
        ? [[kind, { supported, source: 'litellm' as const }]]
        : [];
    }),
  ) as ModelCapability['inputModalitySupport'];
  return {
    inputModalities: supportedModalities,
    inputModalitySupport: Object.keys(inputModalitySupport ?? {}).length > 0
      ? inputModalitySupport
      : undefined,
  };
}

/** Best-effort extract {contextLength, maxOutputTokens, inputModalities} from a JSON-ish model entry. */
function readCapability(entry: unknown, source: ModelCapabilitySource): ModelCapability | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const ctx = coercePositiveFinite(e.contextLength);
  const out = coercePositiveFinite(e.maxOutputTokens);
  const mods = coerceModalities(e.inputModalities);
  if (!ctx && !out && !mods) return null;
  return {
    contextLength: ctx,
    maxOutputTokens: out,
    inputModalities: mods,
    inputModalitySupport: mods ? completeModalityEvidence(mods, source) : undefined,
    source,
  };
}

/**
 * Merge a capability into the registry with **first-wins PER FIELD** (not
 * per-entry). The earlier (higher-priority) source keeps every field it already
 * defined; the new source only fills fields the existing entry left undefined.
 *
 * Why per-field and not all-or-nothing (#338): an incomplete higher-priority
 * entry — e.g. a `presetCustomModels` model added via the UI that carries
 * `inputModalities` but no `contextLength` — used to claim the whole key and
 * SHADOW the bundled preset's real `contextLength`, so `lookupModelContextLength`
 * returned `undefined` and the window silently collapsed to the SDK 200K
 * default (clean model id, `windowSource:"default"`). Per-field merge lets the
 * user's explicit override (e.g. modalities) win while the preset / LiteLLM
 * fallback still fills the `contextLength` gap the override left.
 */
function mergeCapabilityInto(
  map: Map<string, ModelCapability>,
  modelId: string,
  cap: ModelCapability,
): void {
  const existing = map.get(modelId);
  if (!existing) {
    map.set(modelId, cap);
    return;
  }
  const inputModalitySupport = Object.fromEntries(
    NON_TEXT_MODALITY_KINDS.flatMap(kind => {
      const evidence = existing.inputModalitySupport?.[kind] ?? cap.inputModalitySupport?.[kind];
      return evidence ? [[kind, evidence]] : [];
    }),
  ) as ModelCapability['inputModalitySupport'];
  map.set(modelId, {
    contextLength: existing.contextLength ?? cap.contextLength,
    maxOutputTokens: existing.maxOutputTokens ?? cap.maxOutputTokens,
    inputModalities: existing.inputModalities ?? cap.inputModalities,
    inputModalitySupport: Object.keys(inputModalitySupport ?? {}).length > 0
      ? inputModalitySupport
      : undefined,
    source: existing.source, // keep the highest-priority source's label
  });
}

function ingestProviderList(
  providers: unknown,
  map: Map<string, ModelCapability>,
  source: ModelCapabilitySource,
): void {
  if (!Array.isArray(providers)) return;
  for (const p of providers) {
    if (!p || typeof p !== 'object') continue;
    const models = (p as Record<string, unknown>).models;
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      if (!m || typeof m !== 'object') continue;
      const rawMid = (m as Record<string, unknown>).model;
      if (typeof rawMid !== 'string' || !rawMid) continue;
      // Registry is BARE-keyed (#338): strip the capability suffix so a model
      // stored/typed as `claude-X[1m]` / `claude-X 1m` lands on the same key as
      // the bundled bare `claude-X`. Load order (disk-first) + per-field merge
      // (mergeCapabilityInto) determine priority; see module header.
      const mid = stripModelSuffix(rawMid);
      if (!mid) continue;
      const cap = readCapability(m, source);
      if (cap) mergeCapabilityInto(map, mid, cap);
    }
  }
}

function providerListContainsModel(providers: unknown, bareModelId: string): boolean {
  if (!Array.isArray(providers)) return false;
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue;
    const models = (provider as Record<string, unknown>).models;
    if (!Array.isArray(models)) continue;
    if (models.some(model => {
      if (!model || typeof model !== 'object') return false;
      const rawModelId = (model as Record<string, unknown>).model;
      return typeof rawModelId === 'string' && stripModelSuffix(rawModelId) === bareModelId;
    })) {
      return true;
    }
  }
  return false;
}

function loadCustomProvidersFromDisk(home: string): Array<Record<string, unknown>> {
  const dir = resolve(home, APP_DATA_DIR_NAME, 'providers');
  if (!existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (err) {
    console.warn(`[model-caps] readdir failed for ~/${APP_DATA_DIR_NAME}/providers/:`, (err as Error)?.message ?? err);
    return [];
  }
  if (files.length > MAX_PROVIDER_FILES) {
    console.warn(`[model-caps] ~/${APP_DATA_DIR_NAME}/providers/ has ${files.length} files; processing first ${MAX_PROVIDER_FILES}`);
    files = files.slice(0, MAX_PROVIDER_FILES);
  }
  for (const f of files) {
    const filePath = resolve(dir, f);
    try {
      const stat = statSync(filePath);
      if (stat.size > MAX_PROVIDER_FILE_BYTES) {
        console.warn(`[model-caps] skip oversize provider file ${f} (${stat.size} bytes > ${MAX_PROVIDER_FILE_BYTES})`);
        continue;
      }
      const raw = readFileSync(filePath, 'utf-8');
      const p = JSON.parse(stripBom(raw)) as Record<string, unknown>;
      if (p && typeof p === 'object' && typeof p.id === 'string') out.push(p);
    } catch (err) {
      console.warn(`[model-caps] skip malformed provider file ${f}:`, (err as Error)?.message ?? err);
    }
  }
  return out;
}

function loadPresetCustomModels(home: string): Record<string, unknown> | null {
  const configPath = resolve(home, APP_DATA_DIR_NAME, 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    const stat = statSync(configPath);
    if (stat.size > MAX_CONFIG_FILE_BYTES) {
      console.warn(`[model-caps] skip oversize config.json (${stat.size} bytes > ${MAX_CONFIG_FILE_BYTES})`);
      return null;
    }
    const raw = readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(stripBom(raw)) as { presetCustomModels?: Record<string, unknown> };
    return cfg.presetCustomModels ?? null;
  } catch (err) {
    console.warn(`[model-caps] failed to read ~/${APP_DATA_DIR_NAME}/config.json:`, (err as Error)?.message ?? err);
    return null;
  }
}

/**
 * Parse a LiteLLM `model_prices_and_context_window.json` object into a
 * capability map. PURE (no I/O) — unit-tested separately.
 *
 *  - Skips the `sample_spec` doc entry.
 *  - Filters to text-LLM `mode`s (chat/completion/responses); drops
 *    image_generation / embedding / audio_* / rerank / moderation and the
 *    path-like keys (`1024-x-1024/.../bedrock/...`) whose token fields are not
 *    a chat context window. Entries with NO `mode` are kept (some valid text
 *    models omit it; they're lowest-priority and only fill genuine gaps).
 *  - Maps `max_input_tokens` → contextLength (fallback `max_tokens`),
 *    `max_output_tokens` → maxOutputTokens (reusing coercePositiveFinite so
 *    string numbers / bogus values are handled identically to other sources),
 *    and retains LiteLLM's modality flags even on entries with no token data.
 *  - Indexes each model under its literal key AND, for `provider/model` keys,
 *    a safe provider-stripped tail — so our bare `deepseek-chat` can match
 *    LiteLLM's `deepseek/deepseek-chat` without making one provider's limit
 *    globally authoritative. An unqualified literal is canonical across casing;
 *    without one, a field is exposed through the tail only when every candidate
 *    that defines that field agrees. Never select an arbitrary entry or max:
 *    provider-enforced limits legitimately differ for the same tail (#516).
 */
export function parseLiteLLMCatalog(raw: unknown): Map<string, ModelCapability> {
  const out = new Map<string, ModelCapability>();
  if (!raw || typeof raw !== 'object') return out;
  type ParsedCatalogEntry = {
    tail: string;
    isUnqualified: boolean;
    cap: ModelCapability;
  };
  const entriesByFoldedTail = new Map<string, ParsedCatalogEntry[]>();
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'sample_spec') continue;
    if (!val || typeof val !== 'object') continue;
    const e = val as Record<string, unknown>;
    const mode = typeof e.mode === 'string' ? e.mode : undefined;
    if (mode && !LITELLM_LLM_MODES.has(mode)) continue;
    const contextLength = coercePositiveFinite(e.max_input_tokens) ?? coercePositiveFinite(e.max_tokens);
    const maxOutputTokens = coercePositiveFinite(e.max_output_tokens);
    const modality = readLiteLLMModalityEvidence(e);
    if (!contextLength && !maxOutputTokens && !modality.inputModalitySupport) continue;
    const cap: ModelCapability = {
      ...(contextLength ? { contextLength } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(modality.inputModalities ? { inputModalities: modality.inputModalities } : {}),
      ...(modality.inputModalitySupport
        ? { inputModalitySupport: modality.inputModalitySupport }
        : {}),
      source: 'litellm',
    };
    if (!out.has(key)) out.set(key, cap);
    const slash = key.lastIndexOf('/');
    const tail = slash >= 0 && slash < key.length - 1 ? key.slice(slash + 1) : key;
    const foldedTail = tail.toLocaleLowerCase('en-US');
    const grouped = entriesByFoldedTail.get(foldedTail) ?? [];
    grouped.push({ tail, isUnqualified: slash < 0, cap });
    entriesByFoldedTail.set(foldedTail, grouped);
  }

  const consensusField = (
    candidates: ParsedCatalogEntry[],
    field: 'contextLength' | 'maxOutputTokens',
  ): number | undefined => {
    const values = new Set(
      candidates
        .map(candidate => candidate.cap[field])
        .filter((value): value is number => typeof value === 'number'),
    );
    return values.size === 1 ? values.values().next().value : undefined;
  };

  const consensusModality = (
    candidates: ParsedCatalogEntry[],
    kind: NonTextModalityKind,
  ): ModelModalitySupportEvidence | undefined => {
    const evidence = candidates
      .map(candidate => candidate.cap.inputModalitySupport?.[kind])
      .filter((value): value is ModelModalitySupportEvidence => Boolean(value));
    if (evidence.length === 0) return undefined;
    const values = new Set(evidence.map(value => value.supported));
    return values.size === 1 ? { supported: evidence[0].supported, source: 'litellm' } : undefined;
  };

  for (const candidates of entriesByFoldedTail.values()) {
    const canonical = candidates.filter(candidate => candidate.isUnqualified);
    const authority = canonical.length > 0 ? canonical : candidates;
    const contextLength = consensusField(authority, 'contextLength');
    const maxOutputTokens = consensusField(authority, 'maxOutputTokens');
    const inputModalitySupport = Object.fromEntries(
      NON_TEXT_MODALITY_KINDS.flatMap(kind => {
        const evidence = consensusModality(authority, kind);
        return evidence ? [[kind, evidence]] : [];
      }),
    ) as ModelCapability['inputModalitySupport'];
    if (
      !contextLength
      && !maxOutputTokens
      && Object.keys(inputModalitySupport ?? {}).length === 0
    ) continue;
    const alias: ModelCapability = {
      ...(contextLength ? { contextLength } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(Object.keys(inputModalitySupport ?? {}).length > 0
        ? { inputModalitySupport }
        : {}),
      source: 'litellm',
    };
    for (const tail of new Set(candidates.map(candidate => candidate.tail))) {
      if (!out.has(tail)) out.set(tail, alias);
    }
  }
  return out;
}

/** Load + parse the Rust-maintained LiteLLM cache file (lowest-priority source). */
function loadLiteLLMCatalogFromDisk(home: string): Map<string, ModelCapability> {
  const filePath = resolve(home, ...LITELLM_CACHE_REL);
  if (!existsSync(filePath)) return new Map();
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_LITELLM_FILE_BYTES) {
      console.warn(`[model-caps] skip oversize LiteLLM cache ${filePath} (${stat.size} bytes > ${MAX_LITELLM_FILE_BYTES})`);
      return new Map();
    }
    const raw = JSON.parse(stripBom(readFileSync(filePath, 'utf-8'))) as unknown;
    return parseLiteLLMCatalog(raw);
  } catch (err) {
    console.warn('[model-caps] failed to read LiteLLM cache:', (err as Error)?.message ?? err);
    return new Map();
  }
}

/**
 * Mtime-keyed cache for `buildRegistry()`.
 *
 * Hot-path callers — every `enqueueUserMessage`, every pre-warm, every model
 * switch, every provider-verify — used to pay an unbounded sync `readdirSync`
 * + N×`readFileSync` (capped at 256 files / 1 MB each) + a `config.json`
 * read. On a busy IM bot this stalls the event loop 50–500ms per turn and
 * undoes the v0.2.0 cold-start work.
 *
 * The cache is invalidated by stat-checking just two paths:
 *   - `~/.myagents/providers/`  (mtime changes when a file is created /
 *     deleted / replaced via tmp+rename — the canonical edit pattern)
 *   - `~/.myagents/config.json` (mtime changes on `presetCustomModels` edits)
 *
 * A miss costs 2 `statSync`s + 1 Map alloc; a hit costs 2 `statSync`s. Mid-
 * session edits propagate by the next call after the file system records the
 * change, preserving the "no invalidate hook required" guarantee from the
 * original design comment.
 */
interface RegistryCacheEntry {
  map: Map<string, ModelCapability>;
  providersDirMtimeMs: number;     // -1 when dir absent
  configMtimeMs: number;           // -1 when file absent
  litellmFileMtimeMs: number;      // -1 when file absent; bumps when Rust writes new data (not on 304)
  homeAtBuild: string | null;      // re-keyed on home change (test isolation)
}
let registryCache: RegistryCacheEntry | null = null;

function statMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1; // missing dir/file is a valid state — cache it as such.
  }
}

function buildRegistry(): Map<string, ModelCapability> {
  const home = getHomeDirOrNull();

  const providersDir = home ? resolve(home, APP_DATA_DIR_NAME, 'providers') : '';
  const configPath = home ? resolve(home, APP_DATA_DIR_NAME, 'config.json') : '';
  const litellmPath = home ? resolve(home, ...LITELLM_CACHE_REL) : '';
  const providersDirMtimeMs = providersDir ? statMtimeMs(providersDir) : -1;
  const configMtimeMs = configPath ? statMtimeMs(configPath) : -1;
  const litellmFileMtimeMs = litellmPath ? statMtimeMs(litellmPath) : -1;

  if (
    registryCache &&
    registryCache.homeAtBuild === home &&
    registryCache.providersDirMtimeMs === providersDirMtimeMs &&
    registryCache.configMtimeMs === configMtimeMs &&
    registryCache.litellmFileMtimeMs === litellmFileMtimeMs
  ) {
    return registryCache.map;
  }

  const map = new Map<string, ModelCapability>();

  // 1) Custom providers from ~/.myagents/providers/*.json — disk-first override.
  if (home) {
    ingestProviderList(loadCustomProvidersFromDisk(home), map, 'custom');
  }

  // 2) Discovered models stored on preset providers (config.presetCustomModels).
  //    Shape: { [providerId]: ModelEntity[] }. Populated by the "Discover
  //    models" flow in ModelManagementPanel.tsx.
  if (home) {
    const pcm = loadPresetCustomModels(home);
    if (pcm && typeof pcm === 'object') {
      for (const models of Object.values(pcm)) {
        if (!Array.isArray(models)) continue;
        for (const m of models) {
          if (!m || typeof m !== 'object') continue;
          const rawMid = (m as Record<string, unknown>).model;
          if (typeof rawMid !== 'string' || !rawMid) continue;
          const mid = stripModelSuffix(rawMid); // bare-keyed (#338)
          if (!mid) continue;
          const cap = readCapability(m, 'discovered');
          if (cap) mergeCapabilityInto(map, mid, cap);
        }
      }
    }
  }

  // 3) Bundled PRESET_PROVIDERS — fallback when neither user override nor
  //    discovery has filled the same modelId.
  ingestProviderList(PRESET_PROVIDERS, map, 'preset');

  // 4) LiteLLM cached catalog (Rust-maintained ~/.myagents/cache/) — LOWEST
  //    priority. first-wins means it only fills models that custom/discovered/
  //    preset never defined; our hand-curated presets (e.g. MiniMax 200K, which
  //    corrects LiteLLM's wrong 1M) always win. Absent until the first fetch.
  if (home) {
    for (const [mid, cap] of loadLiteLLMCatalogFromDisk(home)) {
      // Lowest priority: per-field merge only fills gaps the higher sources
      // left (so a preset's hand-curated window still wins), and no longer
      // skips a model entirely just because a higher source registered an
      // incomplete (contextLength-less) entry for it (#338).
      mergeCapabilityInto(map, stripModelSuffix(mid) ?? mid, cap);
    }
  }

  registryCache = { map, providersDirMtimeMs, configMtimeMs, litellmFileMtimeMs, homeAtBuild: home };
  return map;
}

/**
 * Test-only: drop the cached registry. Real callers don't need to invoke this
 * — the mtime check inside `buildRegistry` picks up provider edits naturally.
 */
export function __resetModelCapabilityCacheForTests(): void {
  registryCache = null;
}

/**
 * Look up the context window for a model.
 * Returns undefined if the model isn't registered OR has no contextLength —
 * callers MUST treat undefined as "don't touch the env var" so SDK's
 * MODEL_CONTEXT_WINDOW_DEFAULT (200_000) remains in effect.
 */
export function lookupModelContextLength(modelId: string | undefined | null): number | undefined {
  const bare = stripModelSuffix(modelId); // registry is bare-keyed (#338)
  if (!bare) return undefined;
  return buildRegistry().get(bare)?.contextLength;
}

/**
 * Provider-scoped context lookup for duplicate model ids.
 *
 * The flat registry is intentionally model-keyed for SDK env injection, but
 * custom providers can reuse the same model id with a tighter account/proxy
 * limit. In UI context usage, the active provider is known, so its own model
 * row claims authority even when the optional contextLength field is absent.
 * Only a model that is absent from that provider may reach the flat fallback;
 * collapsing "row absent" and "field absent" leaks another provider's limit
 * into the active session (#516).
 */
export function lookupProviderModelContextLength(
  modelId: string | undefined | null,
  providerId: string | undefined | null,
): number | undefined {
  const bare = stripModelSuffix(modelId);
  if (!bare) return undefined;
  return snapshotProviderModelContextLengths([bare], providerId).get(bare);
}

export type ModelContextLengthSnapshot = ReadonlyMap<string, number | undefined>;

/**
 * Resolve every model needed by one SDK launch from one Provider-file view.
 * The returned map is immutable by convention and can safely cross async
 * startup work without re-reading a newer capability generation.
 */
export function snapshotProviderModelContextLengths(
  modelIds: Iterable<string | undefined | null>,
  providerId: string | undefined | null,
): ModelContextLengthSnapshot {
  const bareModelIds = new Set<string>();
  for (const modelId of modelIds) {
    const bare = stripModelSuffix(modelId);
    if (bare) bareModelIds.add(bare);
  }
  const snapshot = new Map<string, number | undefined>();
  if (bareModelIds.size === 0) return snapshot;

  const home = getHomeDirOrNull();
  if (!providerId || !home) {
    const flatRegistry = buildRegistry();
    for (const bare of bareModelIds) {
      snapshot.set(bare, flatRegistry.get(bare)?.contextLength);
    }
    return snapshot;
  }

  const providerCandidates: unknown[] = [];
  const custom = loadCustomProvidersFromDisk(home).find(p => p.id === providerId);
  if (custom) providerCandidates.push(custom);

  const presetCustomModels = loadPresetCustomModels(home);
  const discovered = presetCustomModels && typeof presetCustomModels === 'object'
    ? (presetCustomModels as Record<string, unknown>)[providerId]
    : undefined;
  if (Array.isArray(discovered)) {
    providerCandidates.push({ id: providerId, models: discovered });
  }

  const preset = (PRESET_PROVIDERS as unknown as Array<Record<string, unknown>>)
    .find(p => p.id === providerId);
  if (preset) providerCandidates.push(preset);

  const providerMap = new Map<string, ModelCapability>();
  ingestProviderList(providerCandidates, providerMap, custom ? 'custom' : 'discovered');
  const flatRegistry = buildRegistry();
  for (const bare of bareModelIds) {
    const providerOwnsModel = providerListContainsModel(providerCandidates, bare);
    snapshot.set(
      bare,
      providerOwnsModel
        ? providerMap.get(bare)?.contextLength
        : flatRegistry.get(bare)?.contextLength,
    );
  }
  return snapshot;
}

export function lookupSnapshotModelContextLength(
  snapshot: ModelContextLengthSnapshot,
  modelId: string | undefined | null,
): number | undefined {
  const bare = stripModelSuffix(modelId);
  return bare ? snapshot.get(bare) : undefined;
}

/** Full capability record (contextLength + maxOutputTokens + inputModalities). */
export function lookupModelCapability(modelId: string | undefined | null): ModelCapability | undefined {
  const bare = stripModelSuffix(modelId); // registry is bare-keyed (#338)
  if (!bare) return undefined;
  return buildRegistry().get(bare);
}

export interface ModelModalitySupport {
  status: 'supported' | 'unsupported' | 'unknown';
  source?: ModelCapabilitySource;
}

/**
 * Return modality evidence without collapsing unknown into either verdict.
 * This is used by feature pickers that need to distinguish an explicit
 * provider declaration from a low-priority LiteLLM inference.
 */
export function lookupModelModalitySupport(
  modelId: string | undefined | null,
  kind: ModalityKind,
): ModelModalitySupport {
  if (kind === 'text') return { status: 'supported' };
  const cap = lookupModelCapability(modelId);
  const evidence = cap?.inputModalitySupport?.[kind];
  if (evidence) {
    return {
      status: evidence.supported ? 'supported' : 'unsupported',
      source: evidence.source,
    };
  }
  if (cap?.inputModalities) {
    return {
      status: cap.inputModalities.includes(kind) ? 'supported' : 'unsupported',
      source: cap.source,
    };
  }
  return { status: 'unknown' };
}

/**
 * Threshold above which we tag a model with `[1m]` — the SDK's
 * MODEL_CONTEXT_WINDOW_DEFAULT (200K). Anything the registry declares LARGER
 * than the SDK default needs the unlock, because the suffix is the ONLY lever
 * that raises the SDK window for a non-Anthropic model, and
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` only `Math.min`'s downward (#335):
 *
 *   effective auto-compact window = min(suffix ? 1M : 200K, env cap) − ~33K
 *
 * For a mid-band model (e.g. volcengine minimax-m3 @ 512K) the old ≥1M policy
 * left the SDK on the 200K path → usable window ≈ 167K, silently wasting 2/3
 * of the model's real capacity; the user's configured contextLength only ever
 * moved the env cap, which min(200K, 512K) ignored. With the unlock + env cap
 * the effective window is min(1M, 512K) − 33K ≈ 491K — always ≤ the model's
 * real limit, so compaction still fires before upstream overflows.
 *
 * Known cosmetic trade-off (documented in #335): the SDK's own `/context`
 * HEADLINE window is the raw suffix value (1M) — the env cap only shapes the
 * auto-compact threshold / free-space rows, which stay correct. MyAgents' own
 * context ring (`chat:context-usage`) uses the registry window and shows the
 * true value. Models at exactly 200K (claude-sonnet-4-6 wire-default,
 * claude-haiku-4-5) stay unwrapped — for first-party Anthropic models the
 * suffix also requests the `context-1m` beta header (Tier-4 / extra-usage
 * billing), so our presets deliberately encode the SAFE window and the
 * registry value itself is the wrap policy.
 */
const CONTEXT_WINDOW_UNLOCK_THRESHOLD = 200_000;

/**
 * Wrap a model id with `[1m]` suffix iff its registry contextLength exceeds
 * the SDK's 200K default window. This is the trigger Claude Agent SDK uses to
 * take the 1M-context code path: `getContextWindowForModel` checks
 * `has1mContext` which is `/\[1m\]/i.test(model)`. Without the suffix, SDK
 * falls back to MODEL_CONTEXT_WINDOW_DEFAULT (200K) for every non-Anthropic
 * model regardless of any env var — `CLAUDE_CODE_AUTO_COMPACT_WINDOW` only
 * `Math.min`'s the window down, never up. For models between 200K and 1M the
 * suffix raises the SDK window to 1M and the env cap (injected from the same
 * registry value in buildClaudeSessionEnv) pulls the effective auto-compact
 * window back down to the model's real limit.
 *
 * The wrapped value MUST only flow into SDK ingress points:
 *   - `query({ model })` SDK option
 *   - `query({ agents: { ...{ model } } })` sub-agent definitions
 *   - `querySession.setModel()` runtime model switch
 *   - `ANTHROPIC_DEFAULT_{FABLE,SONNET,OPUS,HAIKU}_MODEL` env (alias resolution)
 *
 * It MUST NOT flow into:
 *   - bridge `modelOverride` (forwarded verbatim to upstream OpenAI-compat API)
 *   - `ANTHROPIC_DEFAULT_*_MODEL_NAME` env (SDK uses this as a display label
 *     fallback — wrapping would surface the suffix in the SDK `/model` picker)
 *   - persisted config / cron-context / IM-business state (user-visible)
 *
 * Wire-format safety: SDK strips `[1m]` via `normalizeModelStringForAPI()`
 * before every `messages.create` call, so the suffix never leaks to the
 * upstream HTTP body.
 *
 * Behavior:
 *   - input empty / undefined / null — or whitespace-/suffix-only (`" 1m"`,
 *     `"   "`) that strips to nothing — → returns `undefined` (avoids
 *     overwriting an existing SDK option with an empty / garbage model id)
 *   - already contains `[1m]` anywhere (case-insensitive) → returned VERBATIM —
 *     matches SDK's own `has1mContext` semantics, so user-typed pre-wrapped
 *     values are respected even if the registry has a lower ctx; also defends
 *     against pathological double-wrap on partially-tagged ids
 *   - otherwise the id is normalized to its BARE form first (dropping a
 *     malformed ` 1m` / trailing whitespace, #338) so BOTH the registry lookup
 *     and the emitted id are clean; then:
 *       · registry contextLength > CONTEXT_WINDOW_UNLOCK_THRESHOLD → append a
 *         canonical `[1m]` (so a hand-typed `claude-X 1m` becomes the correct
 *         `claude-X[1m]` instead of leaking ` 1m` to the wire)
 *       · otherwise (no entry, or ctx ≤ threshold; the strict `>` also rejects
 *         `undefined` / `NaN` / negative) → return the bare id
 */
export function applyContextWindowSuffix(model: string | undefined | null): string | undefined {
  const bare = stripModelSuffix(model);
  if (!bare) return undefined;
  if (model && /\[1m\]/i.test(model)) return model;
  return applyContextWindowSuffixForContextLength(bare, lookupModelContextLength(bare));
}

/**
 * Pure SDK-ingress decorator for a context value already snapshotted by the
 * caller. Use this after `buildClaudeSessionEnv()` so the query model and its
 * subprocess env cannot observe different Provider-file generations.
 */
export function applyContextWindowSuffixForContextLength(
  model: string | undefined | null,
  contextLength: number | undefined,
): string | undefined {
  if (!model) return undefined;
  // Empty / whitespace-only / suffix-only (e.g. " 1m", "   ") strips to nothing
  // usable — return undefined rather than feed the SDK a garbage model option.
  const bare = stripModelSuffix(model);
  if (!bare) return undefined;
  if (/\[1m\]/i.test(model)) return model;
  if (typeof contextLength === 'number' && contextLength > CONTEXT_WINDOW_UNLOCK_THRESHOLD) {
    return `${bare}[1m]`;
  }
  return bare;
}

/**
 * Provider-scoped variant for SDK ingress points whose active provider is
 * known. This keeps official provider presets authoritative for their own
 * sessions while still allowing custom providers to reuse a bundled model id
 * with a different context window.
 */
export function applyProviderContextWindowSuffix(
  model: string | undefined | null,
  providerId: string | undefined | null,
): string | undefined {
  const bare = stripModelSuffix(model);
  if (!bare) return undefined;
  if (model && /\[1m\]/i.test(model)) return model;
  return applyContextWindowSuffixForContextLength(
    bare,
    lookupProviderModelContextLength(bare, providerId),
  );
}

/**
 * Whether the model accepts a given input modality.
 *
 * Returns `true` for unknown / unregistered models — the optimistic default
 * preserves behavior for user-defined custom providers and brand-new models
 * that haven't propagated to any data source yet, per product requirement
 * "未知和自定义的就是默认支持" (default-allow). Only an explicit registry
 * entry whose `inputModalities` lacks the kind returns `false`.
 *
 * `text` is always permitted regardless of registry contents (a model with
 * no listed modalities at all wouldn't be usable).
 */
export function modelSupportsModality(
  modelId: string | undefined | null,
  kind: ModalityKind,
): boolean {
  const evidence = lookupModelModalitySupport(modelId, kind);
  // LiteLLM is a provider-unknown fallback. A negative row must not veto the
  // active provider's same-named offering; only provider-owned declarations
  // are authoritative enough to reject an attachment.
  return evidence.status !== 'unsupported' || evidence.source === 'litellm';
}
