import type { PromptCacheCompatibility } from './prompt-cache';

/**
 * Per-subprocess bridge configuration registry (PRD #124, 2026-05).
 *
 * Pre-#124 the OpenAI bridge had a single shared global
 * `currentOpenAiBridgeConfig` mutated as a side effect of
 * `buildClaudeSessionEnv`. Multiple SDK subprocesses (active session,
 * verify, title-gen, model-fetch, sub-agents) all routed through one
 * loopback bridge that read that single global, so a one-shot caller
 * verifying provider X would silently hijack the active session's
 * routing → Chat's `/v1/messages` requests went to provider X with
 * Chat's model name and came back as 404 + `<synthetic>` agent-error.
 *
 * Architecture now: every SDK subprocess gets a unique token. The
 * subprocess's `ANTHROPIC_BASE_URL` carries that token in the URL path
 * (`/bridge/<token>`), and the bridge handler resolves the token to
 * the right upstream by looking it up here. There is no more shared
 * mutable state; concurrent bridges with different upstreams coexist
 * cleanly.
 *
 * Lifecycle:
 *
 *   - `registerBridge(token, resolve)` registers a config resolver
 *     function. The resolver is called per-request so bridges whose
 *     state can change over their lifetime (e.g., an active session
 *     where `currentModel` updates mid-flight) return the latest
 *     values without re-registering.
 *
 *   - `unregisterBridge(token)` removes the entry. Callers MUST do
 *     this in a `finally` block — orphans waste memory and (if a
 *     stale subprocess somehow survives its parent) could route
 *     traffic to the wrong upstream.
 *
 *   - `lookupBridge(token)` returns the resolver or `undefined`. The
 *     bridge handler invokes the resolver to get the per-request
 *     `UpstreamBridgeConfig`.
 *
 * No bridge config in registry == request rejected with 400. There is
 * no "default" or "fallback" behavior — the route is structurally
 * either tokened or invalid.
 */

/**
 * Model aliases for sub-agent routing. Structurally identical to
 * `ModelAliases` in `utils/model-aliases.ts` and `config/types.ts`; inlined
 * here to keep this module dependency-free (it's loaded eagerly from
 * the route handler, while agent-session is heavyweight).
 */
type ModelAliases = {
  fable?: string;
  sonnet?: string;
  opus?: string;
  haiku?: string;
};

export type PromptCacheKeyMode = 'off' | 'session';

export interface BridgeCacheAffinity {
  sessionId?: string;
  promptCacheKeyMode?: PromptCacheKeyMode;
}

export interface UpstreamBridgeConfig {
  apiProtocol?: 'anthropic' | 'openai';
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
  headersTimeoutMs?: number;
  modelFailover?: import('./model-failover').BridgeModelFailover;
  contextRecovery?: import('./context-recovery').BridgeContextRecovery;
  /** Provider owner for provider-scoped proxy policy. */
  providerId: string;
  baseUrl: string;
  apiKey: string;
  /** Opaque generation for a request-scoped managed bearer. Never logged. */
  credentialVersion?: number;
  /** Resolve one replacement bearer after a 401. */
  recoverAuth?: (rejectedCredentialVersion: number) => Promise<{
    apiKey: string;
    credentialVersion: number;
  }>;
  /** Quarantine the credential after the recovery retry also returns 401. */
  rejectCredential?: (credentialVersion: number) => Promise<void>;
  /** Project a non-secret upstream outcome back to the credential owner. */
  reportOutcome?: (credentialVersion: number, httpStatus: number) => Promise<void>;
  /** Active model for this bridge. May change over time for session bridges. */
  model: string | undefined;
  /** Model aliases (sub-agent routing). May change for session bridges. */
  modelAliases: ModelAliases | undefined;
  maxOutputTokens?: number;
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  upstreamFormat?: 'chat_completions' | 'responses';
  /** #324 — user-selected reasoning effort (NORMALIZED level; undefined =
   *  default → the translators omit reasoning fields entirely, preserving
   *  the historical wire shape). May change over time for session bridges. */
  reasoningEffort?: string;
  /** OpenAI prompt-cache affinity identity. Active sessions set this; one-shot
   *  bridges intentionally leave it off so verify/title/vision do not pollute
   *  conversation cache routing. */
  cacheAffinity?: BridgeCacheAffinity;
  cacheCompatibility?: PromptCacheCompatibility;
  /** Request identity for OpenCode Go; scoped to this bridge, never persisted. */
  opencodeSessionId?: string;
}

interface Entry {
  /** Called per-request to resolve current config. */
  resolve: (request?: Request) => UpstreamBridgeConfig | Promise<UpstreamBridgeConfig>;
  /** Wall-clock time at registration; used by orphan watchdog. */
  registeredAt: number;
  /** Free-form description for diagnostics (e.g., 'verify:moonshot', 'session:abc-123'). */
  description: string;
  /** Rejections are scoped to concrete provider/endpoint/model/format targets. */
  keyRejections: Set<string>;
  breakpointRejections: Set<string>;
}

const registry = new Map<string, Entry>();

/**
 * Register a bridge resolver under `token`.
 *
 * The `resolve` callback is invoked on every `/bridge/<token>/v1/messages`
 * request. Keep it cheap — it runs in the request hot path.
 *
 * If `token` is already registered, the new resolver replaces the old.
 * Replacement is intentional: callers that re-register represent a
 * deliberate config update for that subprocess (e.g., a session whose
 * provider env switched mid-flight). Tests asserting "no double-register"
 * should use distinct tokens per subprocess instead.
 */
export function registerBridge(
  token: string,
  resolve: (request?: Request) => UpstreamBridgeConfig | Promise<UpstreamBridgeConfig>,
  description: string,
): void {
  const existing = registry.get(token);
  registry.set(token, {
    resolve,
    registeredAt: Date.now(),
    description,
    keyRejections: existing?.keyRejections ?? new Set(),
    breakpointRejections: existing?.breakpointRejections ?? new Set(),
  });
}

/**
 * Remove a bridge from the registry. Callers MUST invoke this in a
 * `finally` block paired with `registerBridge`. Idempotent: removing
 * a non-existent token is a no-op.
 */
export function unregisterBridge(token: string): void {
  registry.delete(token);
}

/**
 * Resolve a token to its current upstream config.
 *
 * Returns `undefined` if the token is unknown — in which case the
 * caller should respond with HTTP 400 (or equivalent for the protocol).
 *
 * If the resolver throws, this function lets the throw propagate so the
 * caller can surface it (a misbehaving resolver is a bug to log loudly,
 * not silently swallow).
 */
export async function lookupBridge(
  token: string,
  request?: Request,
): Promise<UpstreamBridgeConfig | undefined> {
  const entry = registry.get(token);
  if (!entry) return undefined;
  const cfg = await entry.resolve(request);
  return {
    ...cfg,
    // Capture the entry before await: a retired request cannot modify a new
    // registration that happens to reuse this token.
    cacheCompatibility: {
      isKeyDisabled: target => entry.keyRejections.has(target),
      isBreakpointsDisabled: target => entry.breakpointRejections.has(target),
      disableKey: target => { entry.keyRejections.add(target); },
      disableBreakpoints: target => { entry.breakpointRejections.add(target); },
    },
  };
}

/** Existence-only check. Must never trigger managed credential resolution. */
export function hasBridge(token: string): boolean {
  return registry.has(token);
}

/**
 * Diagnostic snapshot — for `/health/ready` payloads or debug endpoints.
 * Returns metadata only; never exposes API keys.
 */
export function listBridges(): Array<{ token: string; description: string; ageMs: number }> {
  const now = Date.now();
  const result: Array<{ token: string; description: string; ageMs: number }> = [];
  for (const [token, entry] of registry) {
    result.push({
      token,
      description: entry.description,
      ageMs: now - entry.registeredAt,
    });
  }
  return result;
}

/**
 * Drop all registrations. Tests only — production code should always
 * pair register/unregister.
 */
export function _clearRegistryForTests(): void {
  registry.clear();
}

/**
 * Optional orphan watchdog. Removes entries older than `ttlMs`. Defends
 * against subprocess-crash-with-no-cleanup scenarios (e.g., the SDK
 * binary segfaults before our `finally` block runs).
 *
 * The watchdog is the last line of defense; correct callers always
 * unregister on exit. Disabled by default — caller decides if/when.
 */
export function startOrphanWatchdog(intervalMs: number, ttlMs: number): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    let dropped = 0;
    for (const [token, entry] of registry) {
      if (now - entry.registeredAt > ttlMs) {
        registry.delete(token);
        dropped++;
      }
    }
    if (dropped > 0) {
      try {
        process.stderr.write(`[bridge-registry] orphan watchdog dropped ${dropped} stale entries (>${Math.round(ttlMs / 1000)}s)\n`);
      } catch { /* ignore */ }
    }
  }, intervalMs);
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
  return () => clearInterval(timer);
}
