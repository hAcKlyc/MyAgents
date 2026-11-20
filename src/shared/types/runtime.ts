export type { PermissionReview, PermissionOperation } from '../../../contracts/myagents-dsh/public-contract.generated';
// Multi-Agent Runtime types (v0.1.59)
// Defines runtime types and metadata for external CLI agent integration

import {
  agentRuntimePreferenceForRuntime,
  resolveAgentRuntimePreference,
  runtimeTypeForAgentRuntimePreference,
  type AgentRuntimePreference,
} from '../integrated-runtimes/identity';
import {
  AGENT_RUNTIME_DISTRIBUTION_POLICY,
  defaultIntegratedRuntimeType,
  isRuntimeAllowedByDistribution,
  isRuntimeSelectorAvailable,
  resolveDefaultIntegratedRuntime,
  type AgentRuntimeDistributionPolicy,
} from '../integrated-runtimes/distribution-policy';

/**
 * Available Agent Runtime types
 * - builtin: Built-in Claude Agent SDK (current default)
 * - claude-code: Claude Code CLI (user-installed `claude`)
 * - codex: OpenAI Codex CLI (user-installed `codex`)
 */
export type RuntimeType = 'builtin' | 'dsh' | 'claude-code' | 'codex' | 'antigravity';

/**
 * Distinguishes user-managed CLI runtimes from product-managed runtime-backed
 * providers. Missing source is treated as `system-cli` for existing sessions.
 */
export type RuntimeSource = 'integrated' | 'system-cli' | 'managed-provider';

/** Optional review details, separate from the Runtime's authorization input. */
export interface PermissionOperationDisplay {
  command: string;
  cwd: string;
  description?: string;
  alwaysAllowScope?: 'session_workspace';
}

/** Canonical source projection for legacy RuntimeType consumers and analytics. */
export function runtimeSourceForRuntimeType(
  runtime: RuntimeType,
  runtimeSource?: RuntimeSource | null,
): RuntimeSource | undefined {
  if (runtime === 'builtin') return undefined;
  if (runtime === 'dsh') return 'integrated';
  if (runtime === 'codex' && runtimeSource === 'managed-provider') {
    return 'managed-provider';
  }
  return 'system-cli';
}

/**
 * Canonical runtime type list — single source of truth.
 *
 * Used by:
 *   - Server-side validation (admin-api.ts task creation guards).
 *   - CLI help-text generation (admin-api.ts HELP_TEXTS).
 *   - Factory / runtime switch statements.
 *
 * Adding a runtime? Update the `RuntimeType` union above, then extend
 * this tuple. The `_exhaustiveRuntimeCheck` helper below makes typecheck
 * fail if the two drift — so you don't get a stale list that compiles
 * silently and produces an incomplete `--help` / validator allowlist.
 */
export const VALID_RUNTIMES = [
  'builtin',
  'dsh',
  'claude-code',
  'codex',
  'antigravity',
] as const satisfies readonly RuntimeType[];

/**
 * Compile-time exhaustiveness gate: fails `npm run typecheck` if a new
 * `RuntimeType` variant is added to the union without adding the same string
 * to `VALID_RUNTIMES`. The type-level assertion at the bottom never runs at
 * runtime — it just blocks the build on drift.
 */
type _VALID_RUNTIMES_UNION = (typeof VALID_RUNTIMES)[number];
type _AssertRuntimeExhaustive = RuntimeType extends _VALID_RUNTIMES_UNION
  ? _VALID_RUNTIMES_UNION extends RuntimeType
    ? true
    : ['VALID_RUNTIMES has strings not in RuntimeType']
  : ['RuntimeType has variants missing from VALID_RUNTIMES'];
// Exported purely to satisfy the "unused" lint rule — the type-level assertion
// on this declaration is what fails the build on drift; the runtime value
// itself is inert.
export const _exhaustiveRuntimeCheck: _AssertRuntimeExhaustive = true;

/** Human-readable display names keyed by runtime type. */
export const RUNTIME_DISPLAY_NAMES: Record<RuntimeType, string> = {
  builtin: 'Built-in (Claude Agent SDK)',
  dsh: 'MyAgents (DeepSeek Harness)',
  'claude-code': 'Claude Code CLI',
  antigravity: 'Antigravity CLI',
  codex: 'OpenAI Codex CLI',
};

/** Runtime processes that can be started before the first user turn. */
export function runtimeSupportsPrewarm(runtime: RuntimeType): boolean {
  return runtime === 'dsh' || runtime === 'codex';
}

/**
 * Coerce an arbitrary string (agent config value, persisted state, env) into a
 * valid `RuntimeType`, defaulting to `'builtin'` for missing/unknown values.
 *
 * Single source of truth — re-exported from `@/utils/sessionOpenPlan` for
 * renderer callers. Lives in `shared/` so renderer + sidecar consume one impl.
 */
export function normalizeRuntime(value: string | null | undefined): RuntimeType {
  return VALID_RUNTIMES.includes(value as RuntimeType) ? (value as RuntimeType) : 'builtin';
}

/**
 * Conservative "does this model id belong to this runtime?" family matcher.
 *
 * Returns `true` for ambiguous / unknown values. Callers use this only to drop
 * values that are obviously from another runtime family, e.g. `claude-*` on
 * Codex or `gemini-*` on Claude Code. Unknown future model ids are allowed
 * through so a new runtime release does not require a MyAgents release first.
 */
function modelHasFamily(model: string, families: readonly string[]): boolean {
  return families.some((family) => {
    const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[./:_-])${escaped}([./:_-]|$)`).test(model);
  });
}

export function modelLooksLikeRuntime(model: string, runtime: RuntimeType): boolean {
  const m = model.trim().toLowerCase();
  if (m.length === 0) return true;
  if (runtime === 'codex') {
    if (modelHasFamily(m, ['gpt', 'o1', 'o3', 'o4', 'codex', 'chatgpt'])) return true;
    if (modelHasFamily(m, ['gemini', 'claude', 'sonnet', 'opus', 'haiku'])) return false;
    return true;
  }
  if (runtime === 'claude-code') {
    if (modelHasFamily(m, ['sonnet', 'opus', 'haiku', 'claude'])) return true;
    if (modelHasFamily(m, ['gpt', 'o1', 'o3', 'o4', 'codex', 'chatgpt', 'gemini'])) return false;
    return true;
  }
  return true;
}

export function coerceModelForRuntime(
  model: string | null | undefined,
  runtime: RuntimeType,
): string | undefined {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (!trimmed) return undefined;
  return modelLooksLikeRuntime(trimmed, runtime) ? trimmed : undefined;
}

/**
 * Resolve the **agent-config** effective runtime through the build distribution
 * and its selector policy. Agents without an explicit choice use the configured
 * Default Integrated Runtime; displaying that default does not persist a preference.
 *
 * SCOPE — this is the spawn runtime for a NEW session (and the pre-session
 * fallback), NOT the authoritative runtime of an EXISTING session. It mirrors
 * only the **config fallback** leg of the Rust spawn decision in
 * `src-tauri/src/sidecar/runtime_identity.rs` (distribution/selector policy,
 * Provider constraint, and default projection). The Rust spawn path for an existing Tab/Cron sidecar
 * resolves `resolve_session_runtime(session_id)` FIRST (the frozen runtime the
 * session was created with), and only falls back to agent config when there is
 * no session yet. That frozen value — surfaced to the frontend as
 * `chat:system-init.payload.runtime` / session metadata — is what the
 * server-side `ai_turn_complete.runtime` reports.
 *
 * Therefore **session-scoped analytics** (`session_new` / `message_send` /
 * `message_complete` / `history_open`) MUST prefer the frozen session runtime
 * (`sessionRuntime ?? resolveEffectiveRuntime(agentConfig)`, the canonical
 * precedence in `Chat.tsx` `currentRuntime`); using this helper alone would
 * diverge from `ai_turn_complete` once a user changes an agent's runtime after
 * session creation. Only genuinely config-level callers (`workspace_open` for a
 * brand-new session, `app_launch` adoption snapshot) may use this directly.
 *
 * Keep these projection semantics in sync with the Rust Session-birth owner.
 */
export function resolveEffectiveRuntime(
  agentRuntime: string | null | undefined,
  runtimePreference?: unknown,
  runtimeSource?: RuntimeSource | null,
  providerId?: unknown,
  policy: AgentRuntimeDistributionPolicy = AGENT_RUNTIME_DISTRIBUTION_POLICY,
  configuredDefaultIntegratedRuntime?: unknown,
): RuntimeType {
  const defaultIntegratedRuntime = resolveDefaultIntegratedRuntime(
    policy,
    configuredDefaultIntegratedRuntime,
  );
  const distributionDefault = defaultIntegratedRuntimeType(
    policy,
    configuredDefaultIntegratedRuntime,
  );
  const selectorAvailable = isRuntimeSelectorAvailable(
    policy,
  );
  const preference = selectorAvailable
    ? resolveAgentRuntimePreference({
        runtimePreference,
        runtime: agentRuntime,
        runtimeSource,
        providerId,
        defaultIntegratedRuntime,
      })
    : { family: 'integrated' as const, id: defaultIntegratedRuntime };
  if (!preference) return distributionDefault;
  const preferredRuntime = runtimeTypeForAgentRuntimePreference(preference);
  // Explicit External CLI intent wins over dormant Product Provider fields.
  if (preference.family === 'external') {
    return isRuntimeAllowedByDistribution(policy, preferredRuntime, 'system-cli')
      ? preferredRuntime
      : distributionDefault;
  }
  // Product subscription Providers have fixed execution owners and constrain
  // either Integrated preference before Session birth. Managed Codex keeps its
  // historical builtin carrier in renderer-facing configuration.
  if (providerId === 'codex-sub') {
    return isRuntimeAllowedByDistribution(policy, 'codex', 'managed-provider')
      ? 'builtin'
      : distributionDefault;
  }
  if (providerId === 'anthropic-sub' || providerId === 'xai-sub') {
    return isRuntimeAllowedByDistribution(policy, 'builtin')
      ? 'builtin'
      : distributionDefault;
  }
  return isRuntimeAllowedByDistribution(policy, preferredRuntime, runtimeSource)
    ? preferredRuntime
    : distributionDefault;
}

export function isAgentRuntimeSelectorAvailable(
  policy: AgentRuntimeDistributionPolicy = AGENT_RUNTIME_DISTRIBUTION_POLICY,
): boolean {
  return isRuntimeSelectorAvailable(policy);
}

/**
 * Structured hint for recoverable CLI errors.
 *
 * Emitted by Admin-API handlers when they reject a request for a reason that
 * the caller (AI agent or human) can fix by running one more command. The CLI
 * surfaces `recoveryCommand` as `→ Run: <cmd>` under the error line so the
 * reader can copy-paste to correct course without digging through --help.
 *
 * Design note: kept separate from the existing `AdminResponse.hint: string`
 * field — that one is a free-form success tip ("Server added."), this one is
 * specifically about recovering from failure.
 */
export interface RecoveryHint {
  /** Exact CLI command that will help the caller retry correctly. */
  recoveryCommand?: string;
  /** Short explanatory text shown alongside the command. */
  message?: string;
}

/**
 * Runtime detection result
 */
export interface RuntimeDetection {
  installed: boolean;
  version?: string;
  path?: string;
  /** Resolver-facing readiness; DSH remains experimental until native release evidence is accepted. */
  readiness?: 'ready' | 'unverified-dev-runtime' | 'unavailable';
  reason?: 'not-distributed' | 'artifact-missing' | 'artifact-invalid' | 'platform-unverified' | 'protocol-mismatch';
}

/**
 * All runtime detections keyed by type
 */
export type RuntimeDetections = Record<RuntimeType, RuntimeDetection>;

/**
 * Model info from an external runtime CLI
 */
export interface RuntimeModelInfo {
  value: string;        // Value passed to CLI (e.g., "sonnet", "o3")
  displayName: string;  // UI display name (e.g., "Sonnet 4.6")
  description?: string; // Optional description
  isDefault?: boolean;  // Mark as default selection
  /** Runtime-owned model capabilities. Values are intentionally open-ended. */
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
  defaultReasoningEffort?: string;
}

/**
 * Permission mode for an external runtime
 */
export interface RuntimePermissionMode {
  value: string;        // Value passed to CLI
  label: string;        // UI display label
  icon: string;         // Emoji icon
  description: string;  // Description text
  /** Supported by the runtime, but omitted from selection menus and cycling. */
  hidden?: boolean;
}

/**
 * Proxy policy for external-runtime subprocess env (issue #194).
 *
 * - `myagents` (default, legacy) — MyAgents unconditionally injects its own
 *    `proxySettings` into the runtime's env, overriding whatever the parent
 *    shell or system has configured. Best for "MyAgents proxy is THE proxy"
 *    setups.
 * - `terminal` — Drop MyAgents-injected proxy vars; restore whatever proxy
 *    the user's interactive shell would export (HTTP_PROXY / HTTPS_PROXY /
 *    ALL_PROXY / NO_PROXY, lowercase + UPPERCASE). Best for "I run codex /
 *    claude from terminal and want MyAgents to behave the same."
 * - `direct` — Strip all proxy vars. Best when system-level proxy (Clash
 *    TUN, transparent proxy) handles routing.
 */
export type RuntimeProxyPolicy = 'myagents' | 'terminal';

/**
 * Per-agent env policy for external-runtime subprocesses (issue #194).
 *
 * Today only `proxy` matters; the structure is extensible because the same
 * dimension (override vs inherit) is likely to apply to other env surfaces
 * (locale, XDG, custom Codex-specific env) as needs surface.
 *
 * Historical note: 0.2.16 dev shipped a third `'direct'` literal that stripped
 * every proxy var (for users on Clash TUN / VPN). It was removed before
 * 0.2.16 release — the UI was confusing and `'terminal'` already covers the
 * case (a user on TUN typically has no proxy var set in their shell, so
 * `terminal` mode = no proxy injected = same result). Disk values of
 * `'direct'` on existing installs fall through `resolveAgentEnvPolicy`'s
 * validator and default to `'myagents'`; users who relied on stripping
 * MyAgents proxy can pick `terminal` from the UI.
 */
export interface RuntimeEnvPolicy {
  proxy?: RuntimeProxyPolicy;
}

/**
 * Runtime-specific configuration stored in AgentConfig
 */
export interface RuntimeConfig {
  source?: RuntimeSource;    // Runtime binary/state owner; missing == system-cli
  model?: string;            // Runtime-specific model selection
  permissionMode?: string;   // Runtime-specific permission mode
  /** #324 — reasoning effort setting ('default' | level). Vocabulary is
   *  per-runtime (CC: low..max, Codex: model-catalog-defined — see
   *  shared/reasoningEffort.ts), hence NOT portable across runtimes. */
  reasoningEffort?: string;
  additionalArgs?: string[]; // Extra CLI arguments
  /**
   * Issue #194 — per-agent env policy. When omitted, runtime treats it as
   * `{ proxy: 'myagents' }` (the legacy behaviour) for backwards compat.
   */
  envPolicy?: RuntimeEnvPolicy;
}

/**
 * Field families on RuntimeConfig grouped by "are they portable across
 * runtimes". Used by `buildRuntimeChangePatch` and the startup migration to
 * decide what to scrub when `agent.runtime` changes.
 *
 *  - **NOT portable**: source / model / permissionMode / reasoningEffort /
 *    additionalArgs — runtime ownership, model lists, permission vocabularies,
 *    and effort vocabularies are wholly disjoint between managed Codex, user
 *    Codex CLI and Claude Code. Carrying a value from one runtime to
 *    another guarantees the new runtime either rejects it or silently falls
 *    back to defaults — both worse than starting clean.
 *  - **Portable**: envPolicy — per-agent network routing choice that has
 *    nothing to do with which CLI is in use.
 *
 * The split lives here (single source of truth) so the migration and the
 * write-time helper can't drift.
 */
export const RUNTIME_CONFIG_PER_RUNTIME_FIELDS = [
  'source',
  'model',
  'permissionMode',
  'reasoningEffort',
  'additionalArgs',
] as const satisfies readonly (keyof RuntimeConfig)[];

/**
 * Build the `{ runtime, runtimeConfig }` patch to apply when an agent's
 * runtime is being changed. Centralizes the "drop non-portable fields"
 * policy so every callsite (in-chat switch, Settings panel, Launcher
 * selector, `myagents agent set runtime <v>` CLI) behaves identically.
 *
 * Returns `runtimeConfig: undefined` instead of `{}` when scrubbing empties
 * the object so the caller's atomic-merge logic doesn't persist a noise
 * `runtimeConfig: {}` entry.
 *
 * Runtime-specific model and permission settings must not leak into another
 * runtime after a switch.
 */
export function buildRuntimeChangePatch(
  currentRuntimeConfig: RuntimeConfig | undefined,
  newRuntime: RuntimeType,
): {
  runtime: RuntimeType;
  runtimeConfig: RuntimeConfig | undefined;
  runtimePreference: AgentRuntimePreference;
} {
  const runtimePreference = agentRuntimePreferenceForRuntime(newRuntime);
  if (!currentRuntimeConfig) {
    return { runtime: newRuntime, runtimeConfig: undefined, runtimePreference };
  }
  const next: RuntimeConfig = { ...currentRuntimeConfig };
  for (const k of RUNTIME_CONFIG_PER_RUNTIME_FIELDS) {
    delete next[k];
  }
  const hasFields = Object.keys(next).length > 0;
  return {
    runtime: newRuntime,
    runtimeConfig: hasFields ? next : undefined,
    runtimePreference,
  };
}

/**
 * Runtime metadata for UI display
 */
export interface RuntimeInfo {
  type: RuntimeType;
  name: string;
  icon: string;           // Path to icon or built-in identifier
  detection: RuntimeDetection;
}

// ─── Claude Code permission modes ───

export const CC_PERMISSION_MODES: RuntimePermissionMode[] = [
  {
    value: 'manual',
    hidden: true,
    label: 'Manual',
    icon: '\u{1F6E1}',  // 🛡
    description: '每次工具调用都需要确认',
  },
  {
    value: 'auto',
    label: 'Auto',
    icon: '\u2728',      // ✨
    description: '由 Claude Code 自动判断工具权限',
    hidden: true,
  },
  {
    value: 'plan',
    label: 'Plan',
    icon: '\u{1F4CB}',  // 📋
    description: '规划模式，只读不执行',
    hidden: true,
  },
  {
    value: 'acceptEdits',
    label: 'Accept Edits',
    icon: '\u{1F4DD}',  // 📝
    description: '自动接受文件编辑，其他需确认',
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass Permissions',
    icon: '\u26A1',      // ⚡
    description: '跳过所有权限确认',
  },
  {
    value: 'dontAsk',
    label: "Don't Ask",
    icon: '\u{1F6AB}',  // 🚫
    description: '不弹出权限确认，未授权操作直接拒绝',
  },
];

// ─── Built-in Claude Agent SDK permission modes ───
//
// These mirror the `PermissionMode` string union in `src/server/agent-session.ts`
// (`'auto' | 'plan' | 'fullAgency' | 'custom'`). Exposing them here lets
// `myagents runtime describe builtin` show the same allowlist other runtimes
// expose — otherwise the discovery flow returns an empty permissionModes list
// for builtin and the AI caller has no way to know what values `--permissionMode`
// accepts without reading source code.
export const BUILTIN_PERMISSION_MODES: RuntimePermissionMode[] = [
  {
    value: 'auto',
    label: 'Auto',
    icon: '\u{1F916}',  // 🤖
    description: '默认模式，工具按需申请权限',
  },
  {
    value: 'plan',
    label: 'Plan',
    icon: '\u{1F4CB}',  // 📋
    description: '规划模式，只读不执行',
  },
  {
    value: 'fullAgency',
    label: 'Full Agency',
    icon: '\u26A1',      // ⚡
    description: '跳过所有权限确认（Cron 任务默认）',
  },
  {
    value: 'custom',
    label: 'Custom',
    icon: '\u{1F527}',  // 🔧
    description: '用户自定义的权限规则',
  },
];

export const ANTIGRAVITY_PERMISSION_MODES: RuntimePermissionMode[] = [
  { value: 'default', label: 'Default', icon: '🛡', description: '使用 Antigravity 的常规审批' },
  { value: 'accept-edits', label: 'Accept Edits', icon: '📝', description: '自动接受文件编辑' },
  { value: 'auto', label: 'Auto', icon: '⚡', description: '由 Antigravity 自动判定工具权限' },
  { value: 'plan', label: 'Plan', icon: '📋', description: '规划模式' },
];

export const DSH_PERMISSION_MODES: RuntimePermissionMode[] = [
  { value: 'approval-required', label: '请求批准', icon: '\u{1F6E1}', description: '工作区内行动，使用工具需审批' },
  { value: 'workspace-autonomous', label: '工作区自主', icon: '\u{1F4C1}', description: '工作区内无限制，无需审批' },
  { value: 'full-autonomous', label: '完全自主', icon: '\u26A1', description: '无限制使用电脑与互联网，无需审批' },
];

// ─── Codex permission modes (pre-defined for v2) ───

export const CODEX_PERMISSION_MODES: RuntimePermissionMode[] = [
  {
    value: 'auto-edit',
    label: 'Ask for approval',
    icon: '\u{1F4DD}',  // 📝
    description: '工作区内自动执行；联网或修改外部文件时请求批准',
  },
  {
    value: 'full-auto',
    label: 'Approve for me',
    icon: '\u26A1',      // ⚡
    description: '由 Codex 自动审查审批请求，仅潜在不安全操作需确认',
  },
  {
    value: 'no-restrictions',
    label: 'Full Access',
    icon: '\u{1F513}',  // 🔓
    description: '跳过所有审批和沙箱限制',
  },
];

/**
 * Get permission modes for a given runtime type
 *
 * Returns supported modes for every runtime, including builtin. Selection
 * menus and cycling omit hidden entries; validators retain supported values
 * so existing sessions can keep their execution permissions.
 */
export function getRuntimePermissionModes(runtime: RuntimeType): RuntimePermissionMode[] {
  switch (runtime) {
    case 'dsh': return DSH_PERMISSION_MODES;
    case 'claude-code': return CC_PERMISSION_MODES;
    case 'antigravity': return ANTIGRAVITY_PERMISSION_MODES;
    case 'codex': return CODEX_PERMISSION_MODES;
    case 'builtin': return BUILTIN_PERMISSION_MODES;
    default: return [];
  }
}

/** Exact write-boundary validator. */
export function isRuntimePermissionMode(
  mode: string | null | undefined,
  runtime: RuntimeType,
): boolean {
  const trimmed = typeof mode === 'string' ? mode.trim() : '';
  return Boolean(trimmed)
    // Historical read-only sessions and managed planning still use suggest.
    && ((runtime === 'codex' && trimmed === 'suggest')
      || getRuntimePermissionModes(runtime).some(candidate => candidate.value === trimmed));
}

/** Read-only historical projection. Unknown or foreign values are invalid and
 * let the caller fall back to the runtime's interactive default. */
export function projectPermissionModeForRuntime(
  mode: string | null | undefined,
  runtime: RuntimeType,
): string | undefined {
  const trimmed = typeof mode === 'string' ? mode.trim() : '';
  return isRuntimePermissionMode(trimmed, runtime) ? trimmed : undefined;
}

/**
 * Conservative runtime-family matcher for permission modes.
 *
 * Permission vocabularies are runtime-specific. We keep unknown future values
 * (same rationale as `modelLooksLikeRuntime`) but drop values that are known to
 * belong to another runtime. This prevents stale `fullAgency`/`auto` values
 * from downgrading Codex/Claude Code into their adapter fallback modes.
 */
export function permissionModeLooksLikeRuntime(mode: string, runtime: RuntimeType): boolean {
  const trimmed = mode.trim();
  if (!trimmed) return true;
  // Hidden historical modes still belong to their runtime; removing a menu
  // option must not make that value an unknown, portable future extension.
  if (trimmed === 'suggest') return runtime === 'codex';

  const ownModes = new Set(getRuntimePermissionModes(runtime).map((m) => m.value));
  if (ownModes.has(trimmed)) return true;

  for (const rt of VALID_RUNTIMES) {
    if (rt === runtime) continue;
    const otherModes = getRuntimePermissionModes(rt);
    if (otherModes.some((m) => m.value === trimmed)) {
      return false;
    }
  }
  return true;
}

export function coercePermissionModeForRuntime(
  mode: string | null | undefined,
  runtime: RuntimeType,
): string | undefined {
  const trimmed = typeof mode === 'string' ? mode.trim() : '';
  if (!trimmed) return undefined;
  return permissionModeLooksLikeRuntime(trimmed, runtime) ? trimmed : undefined;
}

// ─── Claude Code model list (canonical, shared) ───

export const CC_MODELS: RuntimeModelInfo[] = [
  { value: '', displayName: '默认', isDefault: true },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'haiku', displayName: 'Haiku' },
];

/**
 * Get default permission mode for a given runtime type
 */
export function getDefaultRuntimePermissionMode(runtime: RuntimeType): string {
  switch (runtime) {
    case 'dsh': return 'approval-required';
    case 'claude-code': return 'manual';
    case 'antigravity': return 'default';
    case 'codex': return 'full-auto';
    case 'builtin': return 'auto';
    default: return '';
  }
}

/**
 * Get the highest-permission mode for the given runtime.
 *
 * Used in unattended contexts (cron task dispatch, agent task execution) where
 * "user didn't pick anything" should mean "give me whatever lets the AI
 * actually run without blocking on a human approval that never comes".
 *
 * Distinct from getDefaultRuntimePermissionMode() which returns each runtime's
 * INTERACTIVE default (auto/default/full-auto). Those defaults are
 * correct for chat tabs but pathological for cron — they leave WebSearch /
 * Bash / mcp__* in a pending-approval state that times out on a 10-minute
 * deadline.
 *
 * Per-runtime mapping:
 *   - builtin     → 'fullAgency'        (mapToSdkPermissionMode → bypassPermissions)
 *   - claude-code → 'bypassPermissions' (CC CLI native value, no translation)
 *   - codex       → 'no-restrictions'   (Codex sandbox: skip approvals + sandbox)
 */
export function getMaxPermissionForRuntime(runtime: RuntimeType): string {
  switch (runtime) {
    case 'dsh':         return 'full-autonomous';
    case 'builtin':     return 'fullAgency';
    case 'claude-code': return 'bypassPermissions';
    case 'antigravity': return 'auto';
    case 'codex':       return 'no-restrictions';
    default:            return 'fullAgency';
  }
}

// ─── Runtime diagnostics (issue #194) ───
//
// Diagnostic snapshot collected at session start for external runtimes (Codex /
// Claude Code). Renderer surfaces this to make 「为什么我看不到 X 工具？」
// debuggable without grepping unified log. Codex fills all four sections via
// RPC after thread/start; other runtimes contribute the subset they expose.
//
// IMPORTANT — privacy: never put secrets (API keys, OAuth tokens, full proxy URL
// with embedded credentials) into this payload. It's sent over SSE to the
// renderer and persisted in chat history. Use boolean presence for sensitive
// env vars (e.g. `hasOpenaiApiKey: true`) not the value.

/**
 * Auth state as reported by the runtime CLI itself.
 *
 * `authMethod` mirrors Codex's `AuthMode` (`apiKey` / `chatGptToken` / ...) or
 * CC's keychain/OAuth labels. `null` means runtime hasn't told us (e.g. Codex
 * `getAuthStatus` returned null) — distinct from "not authenticated".
 */
export interface RuntimeAuthStatus {
  authMethod: string | null;
  /** True when this account needs to complete sign-in before tools work. */
  requiresLogin?: boolean;
  /** Free-form display text, runtime-specific. */
  details?: string;
}

/**
 * Single feature flag as reported by the runtime. For Codex: `[features]` table
 * in config.toml + experimentalFeature/list RPC. `defaultEnabled` differs from
 * `enabled` when the user explicitly toggled it (e.g. `artifact = true` in a
 * stage-`underDevelopment` flag).
 */
export interface RuntimeFeatureFlag {
  name: string;
  enabled: boolean;
  defaultEnabled: boolean;
  /** Codex: 'beta' | 'underDevelopment' | 'stable' | 'deprecated' | 'removed'. */
  stage?: string;
}

/**
 * One MCP server as the runtime sees it. `state` follows Codex's
 * `McpServerStartupState`; CC uses its own labels. `authStatus` is a runtime-
 * defined string (e.g. 'oauth-required', 'authenticated').
 */
export interface RuntimeMcpServerInfo {
  name: string;
  toolCount: number;
  resourceCount?: number;
  state?: string;
  authStatus?: string;
}

/**
 * One "App" / connector / plugin the runtime sees. Codex's `app/list` populates
 * this (artifact-tool, github, computer-use, etc.). `isAccessible: false` is
 * the most actionable signal for issue #194 — it tells the user the runtime
 * tried to discover the app and couldn't (auth / network / discovery error).
 */
export interface RuntimeAppInfo {
  id: string;
  name?: string;
  description?: string;
  isAccessible?: boolean;
  isEnabled?: boolean;
  needsAuth?: boolean;
  installUrl?: string | null;
}

/**
 * Per-call status. `'ok'` = runtime returned a payload. `'unsupported'` = the
 * runtime doesn't have the corresponding RPC (e.g. CC has no app/list).
 * `{ error }` = the RPC was tried and failed; carries a short reason.
 */
export type RuntimeDiagnosticsCallStatus =
  | 'ok'
  | 'unsupported'
  | { error: string };

export interface RuntimeDiagnosticsStatus {
  auth?: RuntimeDiagnosticsCallStatus;
  features?: RuntimeDiagnosticsCallStatus;
  mcpServers?: RuntimeDiagnosticsCallStatus;
  apps?: RuntimeDiagnosticsCallStatus;
}

export interface RuntimeDiagnosticIssue {
  code: string;
  severity: 'info' | 'warn' | 'error';
  title: string;
  message: string;
  hint?: string;
}

export type RuntimeExtensionApplyState =
  | 'unchanged'
  | 'applied'
  | 'pending_next_start'
  | 'deferred_until_idle'
  | 'not_applicable'
  | 'unsupported'
  | 'failed';

export interface RuntimeExtensionComponentStatus {
  /** Admission and invocation are runtime facts, separate from installed/enabled settings and permission. */
  admission?: 'ready' | 'rejected' | 'disabled' | 'pending';
  enabled?: boolean;
  modelInvocable?: boolean;
  effectiveGeneration?: string;
  component: string;
  id?: string;
  state: RuntimeExtensionApplyState;
  code: string;
  message?: string;
  /**
   * True when a direct configuration action should explain how to apply this
   * degradation. This is not a passive Chat-banner severity signal.
   */
  requiresUserAction?: boolean;
}

export interface RuntimeExtensionDiagnostics {
  desiredRevision: string;
  effectiveRevision: string | null;
  state: RuntimeExtensionApplyState;
  components: RuntimeExtensionComponentStatus[];
}

/** One exact, root-origin permission grant owned and persisted by the Runtime. */
export interface RuntimePermissionRule {
  ruleId: string;
  revision: string;
  tool: string;
  permissionClass: string;
  target: string;
  origin: 'root';
  createdAt: number;
  /** null means the Runtime grant lasts for this Session, until revoked. */
  expiresAt: number | null;
}

/** Authoritative Runtime permission policy snapshot. */
export interface RuntimePermissionRulesSnapshot {
  readonly permissionMode: string;
  readonly autoAllowTools: readonly string[];
  readonly revision: string;
  readonly rules: readonly RuntimePermissionRule[];
}

export type RuntimePermissionRuleMutationResult =
  | { state: 'applied'; revision: string; rule?: RuntimePermissionRule }
  | { state: 'already_effective'; revision: string; rule: RuntimePermissionRule }
  | { state: 'already_absent'; revision: string };

/**
 * Non-sensitive permission reconciliation summary. Exact targets stay behind
 * the explicit rule-list API and never enter generic diagnostics or logs.
 */
export interface RuntimePermissionDiagnostics {
  desiredProductMode: string;
  desiredRuntimeMode: string;
  effectiveRuntimeMode: string;
  policyRevision: string;
  ruleCount: number;
  state: 'applied' | 'drift';
}

/**
 * Effective env snapshot for the runtime subprocess. Sanitised for display:
 *  - `proxy.http/https/all` are URLs without embedded credentials.
 *  - `pathHead` is the first 5 entries of PATH (full PATH is logged, not shown).
 *  - sensitive vars surface only as `has<NAME>: boolean` presence checks.
 *
 * `proxyPolicy` is filled in Phase 2 when RuntimeEnvPolicy lands; today it's
 * always `'myagents'` (the legacy behaviour).
 */
export interface RuntimeEffectiveEnv {
  cwd: string;
  proxy?: {
    http?: string;
    https?: string;
    all?: string;
    no?: string;
  } | null;
  proxyPolicy?: RuntimeProxyPolicy;
  /** First few PATH entries for visibility (full PATH would be too noisy). */
  pathHead?: string[];
  /** True when MYAGENTS_PROXY_INJECTED=1 reached the runtime. */
  myagentsProxyInjected?: boolean;
  /** Codex-only sandbox probe used to diagnose loopback proxy/network blocks. */
  codexSandbox?: {
    detected?: boolean;
    networkDisabled?: boolean;
    proxyProbe?: {
      url: string;
      reachable: boolean;
      error?: string;
    };
  };
  /** Presence-only flags for sensitive env vars. */
  hasOpenaiApiKey?: boolean;
  hasAnthropicApiKey?: boolean;
  hasCodexHome?: boolean;
  hasXdgConfigHome?: boolean;
}

/**
 * Combined runtime diagnostics payload. Delivered as a UnifiedEvent
 * (`runtime_diagnostics`) shortly after session_init; consumed by the renderer
 * to show "what the runtime sees" in a Chat header strip / details panel.
 */
export interface RuntimeDiagnostics {
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  effectiveEnv: RuntimeEffectiveEnv;
  auth?: RuntimeAuthStatus;
  features?: RuntimeFeatureFlag[];
  mcpServers?: RuntimeMcpServerInfo[];
  apps?: RuntimeAppInfo[];
  status: RuntimeDiagnosticsStatus;
  issues?: RuntimeDiagnosticIssue[];
  /** MyAgents product-extension projection consumed by this Runtime process. */
  extensions?: RuntimeExtensionDiagnostics;
  /** Runtime-owned permission state, excluding rule targets and identities. */
  permissions?: RuntimePermissionDiagnostics;
  /** ISO-8601 UTC string. */
  timestamp: string;
}

/** Read-only diagnostic projection; adapters must exclude credentials and rule targets. */
export interface IntegratedRuntimeArtifactIdentity {
  runtimeVersion: string;
  dshVersion: string;
  requiredNodeVersion: string;
  sourceCommit: string;
  handoffSha256: string;
  runtimeManifestSha256: string;
}

export interface RuntimeInspection {
  runtime: RuntimeType;
  installed: boolean;
  version?: string;
  resources: { state: 'available' | 'unavailable'; code?: string; expectedIdentity: IntegratedRuntimeArtifactIdentity; installedIdentity: IntegratedRuntimeArtifactIdentity | null };
  process: { state: string; pid?: number; identity?: object | null; artifact?: object | null };
  model: { id: string; provider: string; revision: string } | null;
  permissions: RuntimePermissionDiagnostics | null;
  extensions: RuntimeExtensionDiagnostics | null;
  environment: { policy: string; allowedKeys: readonly string[] } | null;
  proxy: { scope: string; capturedAt: string; endpoints: Record<string, string>; keys: readonly string[] } | null;
  observedAt: string;
}

/**
 * Resolve the effective permissionMode for a cron / unattended task tick.
 *
 * Semantics:
 *   - undefined / '' (sentinel "user didn't pick") → runtime max permission
 *   - runtime-appropriate literal value → respected as user's explicit choice
 *   - obvious foreign-runtime stale value → ignored; try the next source, then
 *     runtime max permission
 *
 * Crucially, 'auto' / 'default' / 'full-auto' are NOT treated as
 * "user didn't pick" when they belong to the selected runtime — they're the
 * runtime's interactive defaults but if a user has them in their cron config,
 * that's a literal value we honor. Empty/undefined and obvious cross-runtime
 * leftovers use max.
 *
 * (Historical note: pre-v0.2.5, cron config persisted 'auto' as a silent
 * default even when the user never picked anything. The v0.2.5 migration in
 * src-tauri/src/cron_task.rs::load_from_disk clears those values to empty
 * string before they reach this resolver.)
 */
export function resolveCronPermissionMode(
  payloadMode: string | null | undefined,
  snapshotMode: string | null | undefined,
  runtime: RuntimeType,
): string {
  const candidates = [payloadMode, snapshotMode];
  for (const candidate of candidates) {
    const coerced = coercePermissionModeForRuntime(candidate, runtime);
    if (coerced) return coerced;
  }
  return getMaxPermissionForRuntime(runtime);
}

export function resolveScheduledTurnPermissionMode(
  taskKind: 'cron' | 'goal',
  payloadMode: string | null | undefined,
  sessionSnapshotMode: string | null | undefined,
  runtime: RuntimeType,
): string {
  return resolveCronPermissionMode(
    payloadMode,
    taskKind === 'goal' ? undefined : sessionSnapshotMode,
    runtime,
  );
}
