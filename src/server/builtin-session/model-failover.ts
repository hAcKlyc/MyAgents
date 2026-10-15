import type { ModelFailoverSettings } from '../../shared/modelFailover';
import { isModelFailoverProvider } from '../../shared/modelFailover';
import { canResumeAcrossProviderBoundary } from '../../shared/providerHistory';
import type { ProviderEnv } from '../provider-types';
import { findEffectiveProvider, loadConfig, materializeProviderRouteEnv } from '../utils/admin-config';
import { ModelFailoverController } from '../openai-bridge/model-failover';
import type { UpstreamConfig } from '../openai-bridge/types/bridge';

export function sessionApiFailoverEligible(env?: ProviderEnv): boolean {
  if (!env?.providerId || !env.apiKey || !env.baseUrl || env.credentialSource || env.endpointSource) return false;
  const provider = findEffectiveProvider(env.providerId, loadConfig());
  return !!provider && isModelFailoverProvider(provider);
}

/** Uses config.json/catalog authority, but never writes selected Session config. */
export function createSessionModelFailover(options: {
  current: () => { env?: ProviderEnv; model: string; turnId?: string };
  isLive: () => boolean;
  canSwitch?: () => boolean;
  onSwitch: (target: UpstreamConfig, status: number) => void;
}): ModelFailoverController {
  type Ref = NonNullable<ModelFailoverSettings['backup']>;
  let root: { scope: string; primaryIdentity: string; backup: Ref } | undefined;
  const identity = () => {
    const { env, model } = options.current();
    return JSON.stringify([env?.providerId, env?.baseUrl, model]);
  };
  const resolveBackup = (ref: Ref): UpstreamConfig | undefined => {
    const current = options.current();
    const env = current.env;
    if (!options.isLive() || !sessionApiFailoverEligible(env)) return undefined;
    const config = loadConfig();
    const settings = config.modelFailover as ModelFailoverSettings | undefined;
    if (settings?.enabled !== true || settings.backup?.providerId !== ref.providerId
      || settings.backup.modelId !== ref.modelId) return undefined;
    if (ref.providerId === env!.providerId && ref.modelId === current.model) return undefined;
    const provider = findEffectiveProvider(ref.providerId, config);
    if (!provider || !isModelFailoverProvider(provider) || !Array.isArray(provider.models)
      || !provider.models.some(row => row && typeof row === 'object' && row.model === ref.modelId)) return undefined;
    const backup = materializeProviderRouteEnv({ kind: 'provider', providerId: ref.providerId, model: ref.modelId }, config);
    if (!backup?.apiKey || !backup.baseUrl || backup.credentialSource || backup.endpointSource
      || !canResumeAcrossProviderBoundary({ ...env, model: current.model }, { ...backup, model: ref.modelId })) return undefined;
    return {
      providerId: ref.providerId, model: ref.modelId, apiKey: backup.apiKey, baseUrl: backup.baseUrl,
      apiProtocol: backup.apiProtocol ?? 'anthropic', authType: backup.authType,
      upstreamFormat: backup.upstreamFormat, maxOutputTokens: backup.maxOutputTokens,
      maxOutputTokensParamName: backup.maxOutputTokensParamName, headersTimeoutMs: 30_000,
      continuationInstruction: 'Continue the existing task using the conversation and completed tool results. Do not restart the user task or repeat confirmed successful writes, sends, submissions or deployments. If an earlier action has an uncertain outcome, verify it with a read-only check first; if verification is unavailable, stop and explain instead of repeating it.',
      responseModel: ref.modelId,
    };
  };
  return new ModelFailoverController({
    scope: () => {
      if (!options.isLive()) return undefined;
      // Recovery eligibility can disappear; an established root's replay guard
      // must survive that change. Never re-pin a different backup mid-turn.
      if (root) return root.primaryIdentity === identity() ? root.scope : undefined;
      if (options.canSwitch?.() === false) return undefined;
      const current = options.current();
      const ref = (loadConfig().modelFailover as ModelFailoverSettings | undefined)?.backup;
      if (!current.turnId || typeof ref?.providerId !== 'string' || typeof ref.modelId !== 'string' || !resolveBackup(ref)) return undefined;
      root = { scope: JSON.stringify([current.turnId, identity()]), primaryIdentity: identity(), backup: { ...ref } };
      return root.scope;
    },
    resolveBackup: () => root ? resolveBackup(root.backup) : undefined,
    canSwitch: options.canSwitch,
    isActive: options.isLive,
    onSwitch: options.onSwitch,
    onTurnEnd: () => { root = undefined; },
  });
}
