/**
 * Provider verification utilities
 * Verifies API key validity by sending a test request
 */

import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { basename, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeCodeCli, buildClaudeSessionEnv, startOneShotBridge, getSidecarPort } from './agent-session';
import type { ProviderEnv } from './provider-types';
import { applyContextWindowSuffixForContextLength } from './utils/model-capabilities';
import { ensureDirSync } from './utils/fs-utils';
import { createGuardedSdkQuery } from './utils/sdk-child-launch-guard';
import { sdkSubprocessUserMessage } from './utils/sdk-subprocess-diagnostics';
import { getLastBridgeError } from './openai-bridge';
import { getProxyForProviderUrl } from './proxy-state';
import { SUBSCRIPTION_PROVIDER_ID } from '../shared/config-types';
import type { Provider } from '../shared/config-types';
import { resolveProviderForModel, TOKENDANCE_PROVIDER_ID } from '../shared/tokendance';
import { findEffectiveProvider, loadConfig as loadProviderConfig } from './utils/admin-config';
import {
  classifySubscriptionVerifyFailureKind,
  type SubscriptionStatus,
  type SubscriptionVerifyFailureKind,
  type SubscriptionVerifyResult,
} from '../shared/subscription';
import {
  probeOpenAiProviderViaBridge,
  probeAnthropicProviderDirect,
  classifyOpenAiProbeStatus,
  composeVerifyFailureDetail,
  verifyTimeoutMessage,
  summarizeProbeOutcome,
  parseProviderError,
  type VerifyError,
  type ProbeOutcome,
} from './provider-probe';

const CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

function claudeCredentialsFilePath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

function keychainAccount(): string | null {
  return process.env.USER || process.env.LOGNAME || basename(homedir()) || null;
}

function hasClaudeCodeOAuthCredentialsStored(): boolean {
  if (existsSync(claudeCredentialsFilePath())) return true;
  if (process.platform !== 'darwin') return false;

  const account = keychainAccount();
  if (!account) return false;

  try {
    execFileSync('/usr/bin/security', [
      'find-generic-password',
      '-s',
      CLAUDE_CODE_KEYCHAIN_SERVICE,
      '-a',
      account,
    ], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 1500,
    });
    return true;
  } catch {
    return false;
  }
}

// Error message parser for subscription verification.
// `parseProviderError` + `VerifyError` now live in the pure `provider-probe`
// module so the 402/balance bucketing is unit-tested without importing the SDK.
function parseSubscriptionError(errorText: string, originalText?: string): VerifyError & { failureKind: SubscriptionVerifyFailureKind } {
  const raw = (originalText ?? errorText).slice(0, 300) || undefined;
  const failureKind = classifySubscriptionVerifyFailureKind(originalText ?? errorText);
  const lower = errorText.toLowerCase();
  if (failureKind === 'auth_required') {
    return { error: '登录已过期，请重新登录 (claude auth login)', detail: raw, failureKind };
  } else if (failureKind === 'entitlement_required') {
    return { error: '账号权限不足，请确认 Claude 订阅状态后重试', detail: raw, failureKind };
  } else if (lower.includes('rate limit') || lower.includes('429')) {
    return { error: '请求频率限制，请稍后再试', detail: raw, failureKind };
  } else if (lower.includes('network') || lower.includes('connect')) {
    return { error: '网络连接失败', detail: raw, failureKind };
  }
  return { error: errorText.slice(0, 100) || '验证失败', detail: raw, failureKind };
}

/**
 * Shared SDK verification core.
 * Spawns an SDK subprocess with a trivial test prompt and returns success/failure.
 */
async function verifyViaSdk(
  env: NodeJS.ProcessEnv,
  opts: {
    model?: string;
    providerId?: string;
    sessionId: string;
    logPrefix: string;
    parseError: (text: string, originalText?: string) => VerifyError & { failureKind?: SubscriptionVerifyFailureKind };
    settingSources: ('user' | 'project')[];
    /**
     * Real upstream baseUrl this verify targets (user-config baseUrl, NOT the
     * loopback ANTHROPIC_BASE_URL we set for OpenAI-bridge mode). Used to
     * scope bridge-error diagnostics so a concurrent verify of a DIFFERENT
     * provider can't leak its error into this one's timeout message.
     */
    upstreamBaseUrlForDiagnostics?: string;
    /**
     * Provider context for the always-present `detail` (PRD 0.2.30 P0). When
     * `baseUrl` is set the timeout/no-result copy switches to the honest
     * "supplier didn't respond" wording instead of the misleading
     * "check your network". Absent for subscription verify.
     */
    detailContext?: { baseUrl?: string; apiProtocol?: string };
    /**
     * Anthropic Layer-1 diagnostic (PRD 0.2.30 P1). Started CONCURRENTLY with
     * the SDK (so it never extends the 30s timeout) and consumed only by the
     * timeout / no-result branches to enrich `detail` with the provider's real
     * status+body. Diagnostic-only: it never flips the verdict. Absent for
     * OpenAI (covered by the authoritative pre-probe) and subscription. The
     * passed signal is aborted once verify settles so a still-in-flight probe
     * (fast-success case) doesn't outlive the call.
     */
    diagnostic?: (signal: AbortSignal) => Promise<ProbeOutcome | undefined>;
    /** Managed subscription activation requires the SDK's terminal success. */
    requireTerminalResult?: boolean;
  },
): Promise<{
  success: boolean;
  error?: string;
  detail?: string;
  failureKind?: SubscriptionVerifyFailureKind;
  retryable?: boolean;
}> {
  const TIMEOUT_MS = 30000;
  const startTime = Date.now();
  const stderrMessages: string[] = [];

  // Kick off the diagnostic in parallel with the SDK. It has its own ≤15s cap
  // (withAbortSignal) so it's resolved well before the 30s timeout — the
  // timeout branch reads it without blocking. `diagController` cancels it when
  // verify settles first (e.g. fast success) so it never leaks past the call.
  const diagController = new AbortController();
  const diagnosticPromise = opts.diagnostic
    ? opts.diagnostic(diagController.signal).catch(() => undefined)
    : undefined;

  // Compose the structured failure result shared by the timeout + no-result
  // branches: gather bridge signals (strong/weak), consume the already-running
  // diagnostic (started concurrently above), and build an always-present
  // `detail` via the pure composers.
  const buildTimeoutLikeFailure = async (
    reason: 'timeout' | 'no_result',
  ): Promise<{ success: false; error: string; detail: string }> => {
    // Bridge errors are ONLY meaningful for OpenAI providers (the only path that
    // routes through the bridge). Subscription / direct-Anthropic providers don't
    // touch the bridge, so any in-window bridge error there belongs to a DIFFERENT
    // concurrent session — never surface it (matches the original gating).
    let scopedBridgeError: string | undefined;
    let weakBridgeError: string | undefined;
    const expectedBase = opts.upstreamBaseUrlForDiagnostics;
    if (expectedBase) {
      const bridgeErr = getLastBridgeError();
      if (bridgeErr && bridgeErr.timestamp >= startTime) {
        const normalizedBase = expectedBase.replace(/\/+$/, '');
        const urlMatches = bridgeErr.upstreamUrl === normalizedBase
          || bridgeErr.upstreamUrl.startsWith(normalizedBase + '/');
        // Strong match (URL + window) → authoritative. In-window but URL-mismatch
        // → weak signal (could be a `.../v1` vs `.../v11` capture miss, G class).
        if (urlMatches) scopedBridgeError = bridgeErr.message;
        else weakBridgeError = bridgeErr.message;
      }
    }

    // Consume the already-running diagnostic (started at call entry). It's
    // resolved by now (≤15s cap, the timeout is 30s), so this never blocks.
    let diagnostic: string | undefined;
    if (diagnosticPromise) {
      const summary = summarizeProbeOutcome(await diagnosticPromise);
      if (summary) diagnostic = `${summary}（诊断探测，可能与 SDK 实际出网存在代理差异）`;
    }

    const detail = composeVerifyFailureDetail({
      baseUrl: opts.detailContext?.baseUrl,
      model: opts.model,
      apiProtocol: opts.detailContext?.apiProtocol,
      elapsedMs: Date.now() - startTime,
      stderr: stderrMessages,
      scopedBridgeError,
      weakBridgeError,
      diagnostic,
    });
    const error = verifyTimeoutMessage({
      reason,
      hasProviderContext: !!opts.detailContext?.baseUrl,
      scopedBridgeError,
      timeoutMs: TIMEOUT_MS,
    });
    return { success: false, error, detail };
  };
  // Collect the first real API error seen during the verify window.
  // If the SDK retries internally (e.g. 429) and our timeout fires first,
  // we use this instead of the generic "验证超时" message.
  let firstAuthError: (VerifyError & { failureKind?: SubscriptionVerifyFailureKind }) | undefined;
  const { logPrefix, parseError } = opts;

  try {
    const cliPath = resolveClaudeCodeCli();
    // Use ~/.myagents/projects/ as cwd — a dedicated app directory with guaranteed permissions.
    // Avoids potential permission or .claude/ config issues in home directory.
    const cwd = join(homedir(), '.myagents', 'projects');
    ensureDirSync(cwd);

    async function* simplePrompt() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: 'It\'s a test, directly reply "1"' },
        parent_tool_use_id: null,
        session_id: opts.sessionId,
      };
    }

    // Determine thinking config — mirrors startStreamingSession() logic.
    // Third-party anthropic-protocol providers (SiliconFlow etc.) reject `thinking: {type:"adaptive"}`
    // with 400 "thinking type should be enabled or disabled". Only enable for Claude models or official API.
    const modelLower = (opts.model ?? '').toLowerCase();
    const isClaudeModel = modelLower.includes('sonnet-4') || modelLower.includes('sonnet-5')
      || modelLower.includes('opus-4') || modelLower.includes('opus-5');
    const isOfficialAnthropicApi = !env.ANTHROPIC_BASE_URL || (() => {
      try { return new URL(env.ANTHROPIC_BASE_URL!).host === 'api.anthropic.com'; }
      catch { return false; }
    })();
    const thinkingConfig = (isOfficialAnthropicApi || isClaudeModel)
      ? { type: 'adaptive' as const }
      : { type: 'disabled' as const };

    const testQuery = await createGuardedSdkQuery(cliPath, () => query({
      prompt: simplePrompt(),
      options: {
        maxTurns: 1,
        sessionId: opts.sessionId,
        cwd,
        settingSources: opts.settingSources,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: cliPath,
        env,
        thinking: thinkingConfig,
        stderr: (message: string) => {
          console.error(`[${logPrefix}] stderr:`, message);
          stderrMessages.push(message);
        },
        systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
        includePartialMessages: true,
        persistSession: false,
        mcpServers: {},
        tools: [],
        // Wrap with [1m] when this provider's contextLength >200K (#335) so SDK
        // uses the 1M path.
        ...(opts.model ? {
          model: applyContextWindowSuffixForContextLength(
            opts.model,
            Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
          ),
        } : {}),
      },
    }));
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ success: false; error: string; detail?: string }>((resolve) => {
      timeoutId = setTimeout(() => {
        // Priority: real API error collected (already has detail) > composed
        // failure (honest copy + always-present detail: bridge signal, lazy
        // diagnostic, baseUrl/model/elapsed/stderr). See buildTimeoutLikeFailure.
        if (firstAuthError) {
          console.log(`[${logPrefix}] timeout but have auth error collected, using it`);
          resolve({ success: false, ...firstAuthError });
          return;
        }
        void (async () => {
          const failure = await buildTimeoutLikeFailure('timeout');
          console.log(`[${logPrefix}] timeout → ${failure.error}`);
          resolve(failure);
        })();
      }, TIMEOUT_MS);
    });
    // Cleanup helper: terminate SDK subprocess regardless of race outcome.
    // Without this, the losing promise's `for await` keeps the subprocess alive.
    const cleanupQuery = () => {
      try { testQuery.return(undefined as never); } catch { /* already terminated */ }
    };

    const verifyPromise = (async (): Promise<{
      success: boolean;
      error?: string;
      detail?: string;
      retryable?: boolean;
    }> => {
      for await (const message of testQuery) {
        if (message.type === 'system') continue;

        // With includePartialMessages, stream_event arrives before result.
        // A message_start event means the API accepted our request and is streaming
        // a response — the API key is valid. Return success immediately.
        if (message.type === 'stream_event') {
          const streamMsg = message as { event?: { type?: string } };
          if (streamMsg.event?.type === 'message_start' && !opts.requireTerminalResult) {
            const elapsed = Date.now() - startTime;
            console.log(`[${logPrefix}] verification successful (${elapsed}ms)`);
            return { success: true };
          }
          continue;
        }

        // assistant message: check for SDK-wrapped errors first.
        // When API returns 403/401, SDK wraps it as a synthetic assistant message
        // with an `error` field (e.g. "authentication_failed"). Without this check,
        // verification would falsely report success.
        if (message.type === 'assistant') {
          const assistantMsg = message as { error?: string; message?: { content?: Array<{ text?: string }> } };
          if (assistantMsg.error) {
            const errorDetail = assistantMsg.message?.content?.[0]?.text ?? assistantMsg.error;
            console.error(`[${logPrefix}] auth error: ${errorDetail}`);
            const parsed = parseError(errorDetail.toLowerCase(), errorDetail);
            // Store the first auth error so the timeout handler can use it
            // if the SDK keeps retrying and our timeout fires first.
            if (!firstAuthError) firstAuthError = parsed;
            return { success: false, ...parsed };
          }
          if (!opts.requireTerminalResult) {
            const elapsed = Date.now() - startTime;
            console.log(`[${logPrefix}] verification successful (${elapsed}ms)`);
            return { success: true };
          }
          continue;
        }

        if (message.type === 'result') {
          const resultMsg = message as {
            subtype?: string;
            errors?: string[];
          };

          if (resultMsg.subtype === 'success') {
            console.log(`[${logPrefix}] verification successful`);
            return { success: true };
          }

          // Error result (error_during_execution, error_max_turns, etc.)
          const errorsArray = resultMsg.errors;
          const errorText = (errorsArray && errorsArray.length > 0)
            ? errorsArray.join('; ')
            : resultMsg.subtype || '验证失败';
          console.error(`[${logPrefix}] error: ${errorText} (subtype: ${resultMsg.subtype})`);
          const parsed = parseError(errorText);
          const stderrHint = stderrMessages.length > 0
            ? ` (详情: ${stderrMessages.join('; ').slice(0, 100)})`
            : '';
          return {
            success: false,
            error: parsed.error + stderrHint,
            detail: parsed.detail,
            retryable: parsed.retryable,
          };
        }
      }

      // Stream ended without a terminal result — compose the same honest,
      // always-detailed failure as the timeout branch (no more bare string).
      return await buildTimeoutLikeFailure('no_result');
    })();

    try {
      return await Promise.race([verifyPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      cleanupQuery();
      // Cancel a still-in-flight diagnostic (e.g. fast-success path) so it
      // never outlives the verify call.
      diagController.abort();
    }
  } catch (error) {
    diagController.abort();
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[${logPrefix}] SDK exception: ${errorMsg}`);
    const sdkLaunchMessage = sdkSubprocessUserMessage(error, stderrMessages);
    if (sdkLaunchMessage) {
      return { success: false, error: sdkLaunchMessage, detail: errorMsg };
    }
    const parsed = parseError(errorMsg);
    const stderrHint = stderrMessages.length > 0
      ? ` (详情: ${stderrMessages.join('; ').slice(0, 200)})`
      : '';
    return {
      success: false,
      error: parsed.error + stderrHint,
      detail: parsed.detail,
      retryable: parsed.retryable,
    };
  }
}

/**
 * Verify a provider API key via SDK.
 * Uses the same SDK path as normal chat requests, ensuring verification = real usage.
 */
export async function verifyProviderViaSdk(
  providerId: string,
  baseUrl: string,
  apiKey: string,
  authType: string,
  model?: string,
  apiProtocol?: 'anthropic' | 'openai',
  maxOutputTokens?: number,
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens',
  upstreamFormat?: 'chat_completions' | 'responses',
  credentialSource?: import('../shared/config-types').ManagedProviderCredential,
  managedVerification?: { expectedLineage: string },
): Promise<{ success: boolean; error?: string; detail?: string; retryable?: boolean }> {
  if (providerId === TOKENDANCE_PROVIDER_ID) {
    try {
      const config = loadProviderConfig();
      const registered = findEffectiveProvider(providerId, config) as unknown as Provider | null;
      if (!registered) return { success: false, error: 'TokenDance provider is unavailable.' };
      model ??= (config.providerPrimaryModels as Record<string, string> | undefined)?.[providerId] ?? registered.primaryModel;
      const effective = resolveProviderForModel(registered, model);
      baseUrl = effective.config.baseUrl!;
      authType = effective.authType!;
      apiProtocol = effective.apiProtocol;
      upstreamFormat = effective.upstreamFormat;
      maxOutputTokens = effective.maxOutputTokens;
      maxOutputTokensParamName = effective.maxOutputTokensParamName;
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  console.log(`[provider/verify] Starting SDK verification for ${baseUrl}, model=${model ?? 'default'}, authType=${authType}, apiProtocol=${apiProtocol ?? 'anthropic'}, maxOutputTokens=${maxOutputTokens ?? 'none'}`);
  // PRD #124: register a per-call bridge token so the verify subprocess
  // routes to ITS upstream via /bridge/<token>/v1/messages, completely
  // isolated from the active Chat session's bridge (if any). The token
  // resolver returns a static snapshot — verify's config doesn't change
  // mid-call. Released in finally so the registry stays clean even on
  // throw / timeout.
  const providerEnv: ProviderEnv = {
    providerId,
    baseUrl,
    apiKey,
    authType: authType as 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key',
    apiProtocol,
    maxOutputTokens,
    maxOutputTokensParamName,
    upstreamFormat,
    credentialSource,
  };
  const startVerificationBridge: typeof startOneShotBridge = (env, bridgeModel, description) =>
    startOneShotBridge(
      env,
      bridgeModel,
      description,
      managedVerification
        ? { purpose: 'verification', expectedLineage: managedVerification.expectedLineage }
        : { purpose: 'execution' },
    );
  // Layer 1 (PRD 0.2.30) — OpenAI providers only: an AUTHORITATIVE probe through
  // the same one-shot bridge. It reads the bridge-translated upstream status and
  // short-circuits ONLY on a shape-independent definite failure (401/403/404/429
  // + 402 quota-remap) — surfacing the provider's real reason in ≤15s instead of
  // the 30s SDK timeout. 400 (request-shape / direct-402→400), 502 (ambiguous
  // connect-vs-transient), 2xx and hangs are inconclusive → fall through to the
  // unchanged SDK path, so this can only improve, never regress. See
  // classifyOpenAiProbeStatus for why 400/502 are intentionally excluded.
  if (apiProtocol === 'openai') {
    const probe = await probeOpenAiProviderViaBridge({
      providerEnv,
      model,
      sidecarPort: getSidecarPort(),
      startOneShotBridge: startVerificationBridge,
    });
    const shortCircuit = probe.status !== undefined
      && classifyOpenAiProbeStatus(probe.status) === 'definite-fail';
    if (shortCircuit) {
      const text = probe.body || `HTTP ${probe.status}`;
      const parsed = parseProviderError(text.toLowerCase(), text, probe.status);
      const detail = composeVerifyFailureDetail({
        baseUrl,
        model,
        apiProtocol,
        diagnostic: summarizeProbeOutcome(probe),
      });
      console.log(`[provider/verify] OpenAI Layer-1 short-circuit: HTTP ${probe.status} → ${parsed.error}`);
      return { success: false, error: parsed.error, detail, retryable: parsed.retryable };
    }
    console.log(`[provider/verify] OpenAI Layer-1 inconclusive (${summarizeProbeOutcome(probe) ?? 'no response'}) → SDK verify`);
  }

  // Only OpenAI-protocol providers route through the bridge. Anthropic-protocol
  // providers (and subscription) hit their baseUrl directly — no token needed.
  const bridge = apiProtocol === 'openai'
    ? startVerificationBridge(providerEnv, model, `provider-verify:${baseUrl}`)
    : null;
  try {
    // Pass `model` as the override so CLAUDE_CODE_AUTO_COMPACT_WINDOW is
    // computed for the model being verified, not the Tab's active session model.
    const env = buildClaudeSessionEnv(providerEnv, model, {
      bridgeToken: bridge?.token,
      providerId,
    });
    return await verifyViaSdk(env, {
      model,
      providerId,
      sessionId: randomUUID(),
      logPrefix: 'provider/verify',
      parseError: parseProviderError,
      // Match chat sessions: use 'project' to read .claude/ from cwd.
      // MUST NOT use 'user' — it reads ~/.claude/settings.json which may contain
      // enabledPlugins causing 30s+ initialization and triggering our timeout.
      settingSources: ['project'],
      // Scope bridge-error diagnostics to this provider's real upstream — but
      // ONLY when the OpenAI bridge is actually in play. Anthropic-protocol
      // providers call their baseUrl directly (no bridge), so any bridge error
      // in the window belongs to some OTHER concurrent session, not us. See
      // verifyViaSdk.opts.upstreamBaseUrlForDiagnostics docstring.
      upstreamBaseUrlForDiagnostics: apiProtocol === 'openai' ? baseUrl : undefined,
      detailContext: { baseUrl, apiProtocol: apiProtocol ?? 'anthropic' },
      // Anthropic-protocol only: a DIAGNOSTIC-ONLY direct probe. Started
      // CONCURRENTLY with the SDK at call entry (verifyViaSdk), but CONSUMED
      // only by the timeout/no-result branch to enrich `detail` with the
      // provider's real status+body. Never flips the verdict (Node undici ≠ SDK
      // native binary on proxy semantics). OpenAI is already covered by the
      // authoritative pre-probe.
      diagnostic: apiProtocol === 'openai'
        ? undefined
        : (signal) => probeAnthropicProviderDirect({ providerEnv, model, getProxyForProviderUrl, signal }),
      requireTerminalResult: credentialSource?.kind === 'managed-oauth',
    });
  } finally {
    bridge?.release();
  }
}

/**
 * Fetch supported models from SDK by spawning a lightweight query.
 * Works for both subscription (OAuth) and API key providers.
 * Uses the same SDK spawning pattern as verify, but only reads initialization data.
 */
export async function fetchSdkSupportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>> {
  // PRD #124: this path uses default Anthropic env (subscription / Anthropic-
  // protocol providers go straight to api.anthropic.com), so no bridge token
  // is needed. `buildClaudeSessionEnv()` is now a pure function — no global
  // state pollution to clean up.
  const cliPath = resolveClaudeCodeCli();
  const cwd = join(homedir(), '.myagents', 'projects');
  ensureDirSync(cwd);

  const officialSubscriptionProvider: ProviderEnv = { providerId: SUBSCRIPTION_PROVIDER_ID };
  const env = buildClaudeSessionEnv(officialSubscriptionProvider, undefined, {
    providerId: SUBSCRIPTION_PROVIDER_ID,
  });

  const testQuery = await createGuardedSdkQuery(cliPath, () => query({
    prompt: '1+1=',
    options: {
      maxTurns: 0,
      sessionId: randomUUID(),
      cwd,
      // Issue #199/#429: settingSources governs settings.json /
      // managed-settings only. Claude Code's native OAuth store is independent
      // of settingSources, so loading 'user' adds no auth value and instead
      // exposes us to stale apiKeyHelper from prior third-party CLI tooling.
      settingSources: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: cliPath,
      env,
      persistSession: false,
      mcpServers: {},
      tools: [],
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
    },
  }));

  const INIT_TIMEOUT_MS = 30000;
  try {
    const initResult = await Promise.race([
      testQuery.initializationResult(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SDK initialization timeout')), INIT_TIMEOUT_MS),
      ),
    ]);
    return initResult.models ?? [];
  } catch (error) {
    const sdkLaunchMessage = sdkSubprocessUserMessage(error);
    if (sdkLaunchMessage) throw new Error(sdkLaunchMessage);
    throw error;
  } finally {
    try { testQuery.return(undefined as never); } catch { /* cleanup */ }
  }
}

/**
 * Check if Anthropic subscription credentials exist locally.
 * Two-tier detection (see Issue #203):
 *   1. `~/.claude.json::oauthAccount` — fast path with rich account info
 *   2. fallback probe of the OAuth token store (Keychain on macOS,
 *      `~/.claude/.credentials.json` elsewhere) — covers the "just ran
 *      `claude auth login`" case where the JSON cache hasn't been seeded yet
 */
export function checkAnthropicSubscription(): SubscriptionStatus {
  const claudeJsonPath = join(homedir(), '.claude.json');

  if (existsSync(claudeJsonPath)) {
    try {
      const content = readFileSync(claudeJsonPath, 'utf-8');
      const config = JSON.parse(content);

      if (config.oauthAccount && config.oauthAccount.accountUuid) {
        return {
          available: true,
          path: claudeJsonPath,
          info: {
            accountUuid: config.oauthAccount.accountUuid,
            email: config.oauthAccount.emailAddress,
            displayName: config.oauthAccount.displayName,
            organizationName: config.oauthAccount.organizationName,
          }
        };
      }
    } catch {
      // File exists but can't read/parse — fall through to token probe
    }
  }

  if (hasClaudeCodeOAuthCredentialsStored()) {
    return {
      available: true,
      info: {},
    };
  }

  return { available: false };
}

/**
 * Verify Anthropic subscription by sending a test request via SDK.
 * Uses the same SDK path as normal chat requests.
 */
export async function verifySubscription(model?: string): Promise<SubscriptionVerifyResult> {
  console.log('[subscription/verify] Starting SDK verification...');
  // PRD #124: subscription path doesn't need a bridge — SDK talks to
  // api.anthropic.com directly. `buildClaudeSessionEnv()` is now pure
  // and won't pollute any state.
  //
  // Issue #199: explicitly skip user settingSources. The native CLI's auth
  // gate (`oD()`) treats `apiKeyHelper` in loaded settings as a hard signal
  // "user has set up an API-key auth source, do NOT use OAuth." Users who
  // arrived from third-party CLI tooling (cc-switch, Claude Code Router)
  // often have a stale `apiKeyHelper` in `~/.claude/settings.json` pointing
  // at their old third-party key — loading it makes the verify subprocess
  // send `x-api-key: <third-party-key>` to api.anthropic.com → 403.
  //
  // OAuth credentials live in macOS Keychain (or `.credentials.json`), neither
  // of which is gated by settingSources. MyAgents deliberately does not host
  // the OAuth lifecycle here: buildClaudeSessionEnv() skips
  // CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST for anthropic-sub, so the native
  // Claude Code runtime consumes the same local login state as `claude` CLI.
  const officialSubscriptionProvider: ProviderEnv = { providerId: SUBSCRIPTION_PROVIDER_ID };
  const env = buildClaudeSessionEnv(officialSubscriptionProvider, model, {
    providerId: SUBSCRIPTION_PROVIDER_ID,
  });
  return verifyViaSdk(env, {
    model,
    sessionId: randomUUID(),
    providerId: SUBSCRIPTION_PROVIDER_ID,
    logPrefix: 'subscription/verify',
    parseError: parseSubscriptionError,
    settingSources: [],
  });
}

/**
 * Get the current git branch for a directory
 * Returns undefined if not a git repository
 */
export function getGitBranch(cwd: string): string | undefined {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], // Suppress stderr
    });
    return branch.trim() || undefined;
  } catch {
    // Not a git repository or git not available
    return undefined;
  }
}
