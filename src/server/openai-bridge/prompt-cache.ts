import { createHash } from 'node:crypto';

export interface PromptCacheKeyInput {
  appNamespace: 'myagents' | 'moxbot';
  providerId: string;
  model: string | undefined;
  sessionId: string | undefined;
  upstreamFormat: 'chat_completions' | 'responses';
}

const HASH_LENGTH = 32;
const LOG_HASH_LENGTH = 12;

/**
 * Build an upstream-safe prompt cache affinity key.
 *
 * The key must be stable for a MyAgents session but must not reveal raw
 * session ids, workspace paths, prompts, or provider secrets to the upstream.
 */
export function buildPromptCacheKey(input: PromptCacheKeyInput): string | undefined {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) return undefined;
  const providerId = input.providerId.trim() || 'unknown-provider';
  const model = input.model?.trim() || 'unknown-model';
  const material = [
    input.appNamespace,
    input.upstreamFormat,
    providerId,
    model,
    sessionId,
  ].join('\0');
  const digest = createHash('sha256').update(material).digest('hex').slice(0, HASH_LENGTH);
  return `myagents:${input.upstreamFormat}:${digest}`;
}

export function hashForLog(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, LOG_HASH_LENGTH);
}

/** Generation-owned compatibility observations for one concrete target. */
export interface PromptCacheCompatibility {
  isKeyDisabled: (target: string) => boolean;
  isBreakpointsDisabled: (target: string) => boolean;
  disableKey: (target: string) => void;
  disableBreakpoints: (target: string) => void;
}

export function promptCacheTarget(providerId: string, baseUrl: string, model: string, format: string): string {
  return JSON.stringify([providerId, baseUrl.replace(/\/+$/, ''), model, format]);
}
