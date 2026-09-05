import type { ModelEntity, Provider } from './config-types';

export const TOKENDANCE_PROVIDER_ID = 'tokendance';
export const TOKENDANCE_APP_URL = 'https://myagents.io';
export const TOKENDANCE_MODEL_LIST_URL =
  'https://tokendance.space/gateway/v1/models';

/** Supplier capability names; order is the product's transport preference. */
export const MODEL_PROTOCOL_PRIORITY = [
  'anthropic:messages',
  'openai:responses',
  'openai:chat-completions',
] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOL_PRIORITY)[number];

export interface TokenDanceError {
  code: string;
  message: string;
  recoveryAction?:
    | 'top_up_balance'
    | 'reauthorize_api_key'
    | 'api_key_quota'
    | null;
  accountVersion?: string | null;
}
export interface TokenDanceAuthView {
  id: string;
  phase:
    | 'waiting'
    | 'exchanging'
    | 'saving'
    | 'save-failed'
    | 'failed'
    | 'expired'
    | 'connected';
  authUrl: string;
  error?: TokenDanceError | null;
}
export interface TokenDanceBalance {
  accountVersion: string;
  balance: number;
  credits: number;
  creditsUsed: number;
}
export interface TokenDancePaymentSession {
  id: string;
  amount: number;
  status: 'pending' | 'paid' | 'failed' | 'closed' | 'refunded';
  payment_url: string | null;
  status_url: string;
  expired_at: number;
  created_at: number;
  paid_at: number | null;
}

export function parseSupportedProtocols(
  value: unknown,
): ModelProtocol[] | undefined {
  if (!Array.isArray(value) || value.some((p) => typeof p !== 'string'))
    return undefined;
  return MODEL_PROTOCOL_PRIORITY.filter((p) => value.includes(p));
}

const all = [...MODEL_PROTOCOL_PRIORITY];
const chat = ['openai:chat-completions'] as const;
const responses = ['openai:responses', ...chat] as const;
const anthropic = ['anthropic:messages', ...chat] as const;

/** Public catalog snapshot, 2026-09-05. Refresh never replaces user selections. */
const presetRows: Array<
  [string, string, string, number, readonly ModelProtocol[]]
> = [
  ['deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', 'deepseek', 1000000, all],
  ['qwen3.8-max-0902', 'Qwen3.8-Max-0902', 'qwen', 1000000, responses],
  ['kimi-k3', 'Kimi K3', 'kimi', 1048576, chat],
  ['glm-5.3', 'GLM 5.3', 'zhipu', 1000000, all],
  ['minimax-m3', 'MiniMax M3', 'minimax', 1000000, all],
  ['seed-2.1-pro', 'Seed-2.1-Pro', 'doubao', 256000, responses],
  ['step-3.7-flash', 'Step 3.7 Flash', 'stepfun', 256000, all],
  ['mimo-v2.5-pro', 'MiMo-V2.5-Pro', 'xiaomi', 1048576, all],
  ['hy4-preview', 'Hy4 Preview', 'hunyuan', 1024000, responses],
  ['longcat-2.0', 'LongCat-2.0', 'longcat', 1000000, chat],
  ['dots-3-note-preview', 'Dots3-Note Preview', 'dots', 512000, anthropic],
  ['ling-3.0-flash', 'Ling-3.0-Flash', 'ling', 256000, anthropic],
  ['spark-x2.5-4b', 'Spark-X2.5-4B', 'spark', 1000000, anthropic],
];
export const TOKENDANCE_MODELS: ModelEntity[] = presetRows.map(
  ([model, modelName, modelSeries, contextLength, supportedProtocols]) => ({
    model,
    modelName,
    modelSeries,
    contextLength,
    supportedProtocols: [...supportedProtocols],
    source: 'preset',
  }),
);

/** Resolve an immutable execution projection. Never mutate a shared Provider. */
export function resolveProviderForModel(
  provider: Provider,
  model: string,
): Provider {
  if (provider.id !== TOKENDANCE_PROVIDER_ID) return provider;
  const protocols = parseSupportedProtocols(
    provider.models.find((m) => m.model === model)?.supportedProtocols,
  );
  const protocol = protocols?.[0];
  if (!protocol)
    throw new Error(
      `TokenDance model '${model}' has no known supported conversation protocol. Refresh the model catalog.`,
    );
  const isAnthropic = protocol === 'anthropic:messages';
  return {
    ...provider,
    config: {
      ...provider.config,
      baseUrl: isAnthropic
        ? 'https://tokendance.space/gateway'
        : 'https://tokendance.space/gateway/v1',
    },
    authType: 'api_key',
    apiProtocol: isAnthropic ? 'anthropic' : 'openai',
    upstreamFormat: isAnthropic
      ? undefined
      : protocol === 'openai:responses'
        ? 'responses'
        : 'chat_completions',
    maxOutputTokens: isAnthropic ? undefined : provider.maxOutputTokens,
    maxOutputTokensParamName: isAnthropic
      ? undefined
      : protocol === 'openai:responses'
        ? 'max_output_tokens'
        : 'max_tokens',
  };
}

/** Preserve raw microyuan for availability; this function is display only. */
export function formatTokenDanceBalance(microyuan: number): string {
  const yuan = microyuan / 1_000_000;
  return (yuan > 0 && yuan < 0.01 ? 0 : yuan).toFixed(2);
}
