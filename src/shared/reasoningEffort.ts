import { OFFICIAL_DEEPSEEK_ANTHROPIC_BASE_URL } from './integrated-runtimes/provider-constraints';

// Reasoning effort (推理强度) — shared vocabulary between renderer and sidecar.
//
// Issue #324: expose per-session control over the provider's reasoning-depth
// knob. One UI selector, three wire mappings:
//   - builtin + Anthropic-protocol → Claude Agent SDK effort / applyFlagSettings
//   - builtin + OpenAI-protocol   → OpenAI bridge injects `reasoning_effort`
//     (chat_completions) / `reasoning.effort` (responses)
//   - external runtimes           → Claude Code `--effort`, Codex `turn/start.effort`
//
// 'default' = follow provider/runtime default. Builtin Claude explicitly resets
// to the model default; the OpenAI bridge omits reasoning fields entirely.
//
// Storage convention: session snapshot / agent config persist the LITERAL
// string 'default'. That keeps the `sessionMeta.x ?? agent.x` fallback chain
// able to express "this session explicitly reverted to default" even when the
// agent-level value is non-default. Absent/undefined also means default.

import type { RuntimeModelInfo } from './types/runtime';

export const REASONING_EFFORT_DEFAULT = 'default';

export type ModelReasoningCapabilities = Pick<RuntimeModelInfo, 'supportedReasoningEfforts' | 'defaultReasoningEffort'>;

/** Catalog absence means unknown, never permission to erase a saved choice. */
export function reasoningEffortAfterModelChange(
  value: string | null | undefined,
  model: ModelReasoningCapabilities | undefined,
): string {
  const effort = normalizeReasoningEffort(value);
  if (!effort) return REASONING_EFFORT_DEFAULT;
  return model?.supportedReasoningEfforts !== undefined
    && !model.supportedReasoningEfforts.some(option => option.reasoningEffort === effort)
    ? REASONING_EFFORT_DEFAULT
    : effort;
}

/** Claude Agent SDK `EffortLevel` — also exactly the Claude Code CLI
 *  `--effort` vocabulary (verified against `claude --help`, CC 2.x). */
export const SDK_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type SdkEffortLevel = (typeof SDK_EFFORT_LEVELS)[number];

/** Union of effort values across OpenAI-compatible providers (researched
 *  2026-06: OpenAI none/minimal/low/medium/high/xhigh; Volcano Ark
 *  minimal..max; DeepSeek high/max with silent mapping). 'none' is excluded —
 *  it overlaps 'minimal' semantically and only OpenAI 5.1+ accepts it.
 *  Values are passed through verbatim; whether a given upstream accepts a
 *  given value is the provider's contract (hence the UI hint 需服务商支持). */
export const OPENAI_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Legacy system-CLI menu only. Managed Codex reads its model catalog;
 *  this list must never validate Codex persistence or execution. */
export const CODEX_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const GROK_46_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
const GROK_45_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
const GROK_43_EFFORT_LEVELS = ['none', 'low', 'medium', 'high'] as const;

export function providerReasoningEffortChoices(
  providerId: string | undefined,
  model: string | undefined,
): readonly string[] | null | undefined {
  if (providerId !== 'xai-sub') return undefined;
  if (model === 'grok-4.6') return GROK_46_EFFORT_LEVELS;
  if (model === 'grok-4.5') return GROK_45_EFFORT_LEVELS;
  if (model === 'grok-4.3') return GROK_43_EFFORT_LEVELS;
  return null;
}

export function isProviderReasoningEffortSupported(
  providerId: string | undefined,
  model: string | undefined,
  effort: string,
): boolean {
  const choices = providerReasoningEffortChoices(providerId, model);
  return choices === undefined || choices?.includes(effort) === true;
}

/**
 * Normalize a persisted/wire setting to the internal representation:
 * `undefined` = default (don't send anything; keep today's behavior).
 */
export function normalizeReasoningEffort(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === REASONING_EFFORT_DEFAULT) return undefined;
  return trimmed;
}

export function isSdkEffortLevel(value: string | undefined): value is SdkEffortLevel {
  return !!value && (SDK_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * The selectable effort levels for a given surface, or `null` when the
 * surface has no reasoning-effort knob (the UI hides the row entirely).
 *
 * @param runtime     'builtin' | 'dsh' | 'claude-code' | 'codex' | ...
 * @param apiProtocol builtin only — the active provider's protocol
 *                    (undefined = Anthropic official / subscription)
 */
export function reasoningEffortChoices(
  runtime: string,
  apiProtocol?: 'anthropic' | 'openai',
  providerId?: string,
  model?: string,
  providerBaseUrl?: string,
): readonly string[] | null {
  switch (runtime) {
    case 'builtin': {
      const providerChoices = providerReasoningEffortChoices(providerId, model);
      if (providerChoices !== undefined) return providerChoices;
      return apiProtocol === 'openai' ? OPENAI_EFFORT_LEVELS : SDK_EFFORT_LEVELS;
    }
    case 'claude-code':
      return SDK_EFFORT_LEVELS;
    case 'antigravity': return null; // The active ACP session owns the available choices.
    case 'codex':
      return CODEX_EFFORT_LEVELS;
    case 'dsh': {
      if (!providerId || !model) return null;
      return providerId === 'deepseek'
        && (apiProtocol ?? 'anthropic') === 'anthropic'
        && providerBaseUrl === OFFICIAL_DEEPSEEK_ANTHROPIC_BASE_URL
        ? ['high', 'max']
        : null;
    }
    default:
      // Unknown runtimes → hidden.
      return null;
  }
}

export function coerceReasoningEffortForRuntime(
  value: string | null | undefined,
  runtime: string,
  apiProtocol?: 'anthropic' | 'openai',
): string | undefined {
  const normalized = normalizeReasoningEffort(value);
  if (!normalized) return undefined;
  // Persist intent before a process/catalog exists. Codex owns model-specific
  // validation at execution; a closed vocabulary here destroys future values.
  if (runtime === 'codex' || runtime === 'antigravity') return normalized;
  const choices = reasoningEffortChoices(runtime, apiProtocol);
  if (!choices) return undefined;
  return choices.includes(normalized) ? normalized : undefined;
}

/**
 * Coerce a persisted/user-facing effort setting while preserving the literal
 * `default` sentinel. Storage needs the sentinel to override an inherited
 * non-default value; wire/runtime callers should use
 * `coerceReasoningEffortForRuntime()` instead.
 */
export function coerceReasoningEffortSettingForRuntime(
  value: string | null | undefined,
  runtime: string,
  apiProtocol?: 'anthropic' | 'openai',
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === REASONING_EFFORT_DEFAULT) return REASONING_EFFORT_DEFAULT;
  if (runtime === 'codex' || runtime === 'antigravity') return trimmed;
  const choices = reasoningEffortChoices(runtime, apiProtocol);
  if (!choices) return undefined;
  return choices.includes(trimmed) ? trimmed : undefined;
}

/** Short UI annotation per level (uniform menu typography; see DESIGN.md §5.5). */
export const REASONING_EFFORT_DESCRIPTIONS: Record<string, string> = {
  [REASONING_EFFORT_DEFAULT]: '跟随服务商',
  minimal: '最浅',
  low: '较浅',
  medium: '均衡',
  high: '较深',
  xhigh: '深度',
  max: '最深',
  none: '关闭',
};
