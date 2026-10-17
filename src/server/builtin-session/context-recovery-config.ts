import { stripModelSuffix } from '../../shared/contextUsage';
import type { ProviderEnv } from '../provider-types';
import { findEffectiveProvider, loadConfig } from '../utils/admin-config';
import { resolveBuiltinContextBudget } from '../utils/context-budget';

/** Existing API credentials only. Managed endpoints/auth keep their native owner. */
export function contextRecoveryApiRoute(env?: ProviderEnv): boolean {
  if (!env?.providerId || !env.apiKey || !env.baseUrl || env.credentialSource || env.endpointSource
    || env.providerId.startsWith('cloud-session:')) return false;
  try { return new URL(env.baseUrl).hostname !== 'api.anthropic.com'; }
  catch { return false; }
}

export function sessionContextBudget(env: ProviderEnv | undefined, model: string | undefined,
  declaredWindow?: number | null): ReturnType<typeof resolveBuiltinContextBudget> {
  const apiRoute = contextRecoveryApiRoute(env);
  // An explicit route budget is independent of the model's declared capacity.
  // Missing budget means conservative compression, not a claim that capacity is 200K.
  const provider = apiRoute ? findEffectiveProvider(env!.providerId!, loadConfig()) : undefined;
  const row = Array.isArray(provider?.models)
    ? provider.models.find(row => row && typeof row === 'object' && typeof row.model === 'string'
      && stripModelSuffix(row.model) === stripModelSuffix(model))
    : undefined;
  return resolveBuiltinContextBudget({ apiRoute, declaredWindow,
    operationalWindow: row?.contextCompactionWindow });
}
