import type { PromptCacheCompatibility } from '../prompt-cache';

// Bridge configuration types

export interface BridgeConfig {
  /** Callback to get upstream OpenAI endpoint config per request */
  getUpstreamConfig: (req: Request) => UpstreamConfig | Promise<UpstreamConfig>;

  /** Model name mapping: SDK sends claude-xxx, may need mapping to actual model */
  modelMapping?: Record<string, string> | ((model: string) => string | undefined);

  /**
   * Time limit for receiving upstream response headers. Does not bound a
   * streaming response body. Default 300000 (5 min).
   */
  upstreamHeadersTimeoutMs?: number;

  /** Logger function. null to disable. Default console.log */
  logger?: ((msg: string) => void) | null;

  /** Translate OpenAI reasoning_content to Anthropic thinking block. Default true */
  translateReasoning?: boolean;

  /** Global cap for max_tokens sent to upstream. CLI may send Claude-scale values (128k)
   *  that exceed OpenAI-compatible provider limits. Per-request UpstreamConfig.maxOutputTokens
   *  takes priority over this. Default: no cap. */
  maxOutputTokens?: number;

  /** Workspace path for saving tool result images that can't pass through OpenAI protocol.
   *  When set, tool result images are saved to {workspacePath}/myagents_files/temp/
   *  instead of being silently dropped. */
  workspacePath?: string;
}

export interface UpstreamConfig {
  /** Missing retains the existing OpenAI translator. */
  apiProtocol?: 'anthropic' | 'openai';
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
  headersTimeoutMs?: number;
  /** Only interactive Session bridges opt in, never utility/probe bridges. */
  modelFailover?: import('../model-failover').BridgeModelFailover;
  /** App-owned continuation guidance, only set on an elected backup. */
  continuationInstruction?: string;
  /** Effective backup identity for SDK usage projection; never changes desired model. */
  responseModel?: string;
  /** Provider owner for provider-scoped proxy policy. */
  providerId: string;
  /** OpenAI-compatible endpoint base URL, e.g. "https://api.openai.com/v1" */
  baseUrl: string;
  /** Override API Key (optional, defaults to x-api-key from request header) */
  apiKey?: string;
  /** Request-scoped managed bearer generation. Opaque and never logged. */
  credentialVersion?: number;
  /** Resolve one replacement bearer after an upstream 401. */
  recoverAuth?: (rejectedCredentialVersion: number) => Promise<{
    apiKey: string;
    credentialVersion: number;
  }>;
  /** Quarantine a bearer after the single recovery attempt also returns 401. */
  rejectCredential?: (credentialVersion: number) => Promise<void>;
  /** Project a non-secret upstream outcome back to the credential owner. */
  reportOutcome?: (credentialVersion: number, httpStatus: number) => Promise<void>;
  /** Override model name (optional, higher priority than modelMapping) */
  model?: string;
  /** Per-request max output tokens cap (takes priority over BridgeConfig.maxOutputTokens) */
  maxOutputTokens?: number;
  /** Parameter name for token limit. Default 'max_tokens' for Chat Completions, forced 'max_output_tokens' for Responses. */
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  /** Upstream API format: 'chat_completions' (default) or 'responses' (OpenAI Responses API) */
  upstreamFormat?: 'chat_completions' | 'responses';
  /**
   * PRD #124: per-request model alias map. When the bridge is keyed by
   * per-subprocess tokens, the alias map varies per-token — different
   * SDK subprocesses may have different sub-agent routing rules. Setting
   * this on UpstreamConfig overrides the BridgeConfig-level mapping for
   * this single request. Same shape as `BridgeConfig.modelMapping`.
   */
  modelMapping?: Record<string, string> | ((model: string) => string | undefined);
  /** #324 — user-selected reasoning effort (NORMALIZED level). When set, the
   *  translators inject `reasoning_effort` (chat_completions) /
   *  `reasoning.effort` (responses); absent = omitted entirely. */
  reasoningEffort?: string;
  /** Conversation identity does not declare upstream capabilities. */
  cacheAffinity?: {
    sessionId?: string;
    promptCacheKeyMode?: 'off' | 'session';
  };
  /** Compatibility state is captured from the exact registry generation. */
  cacheCompatibility?: PromptCacheCompatibility;
  /** OpenCode Go request identity; provided by the bridge token owner. */
  opencodeSessionId?: string;
}
