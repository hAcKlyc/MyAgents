import type { ProxySettings, ProxyScopeSettings } from './config-types';

import { EXTERNAL_RUNTIME_IDS, type ExternalRuntimeId } from './integrated-runtimes/identity';

/** The standard subprocess proxy surface; Provider keys and app-injection markers stay outside it. */
export const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

export const DEFAULT_PROXY_SCOPE: ProxyScopeSettings = Object.freeze({ mode: 'all' });

function cleanIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Normalize persisted intent, never membership in a runtime/display catalog. */
export function normalizeProxyScope(raw: unknown): ProxyScopeSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_PROXY_SCOPE;
  }
  const scope = raw as Partial<ProxyScopeSettings>;
  if (scope.mode !== 'custom') {
    return DEFAULT_PROXY_SCOPE;
  }
  const hasGeneralRequests = Object.prototype.hasOwnProperty.call(scope, 'generalRequests');
  const generalRequests = hasGeneralRequests ? scope.generalRequests === true : true;
  const providerIds = cleanIds(scope.providerIds);
  // Historical empty custom scopes were treated as invalid and fell back to
  // all. Once the new field is present, an empty provider list is an explicit
  // and valid selection (general-only or no app-proxy owners).
  if (!hasGeneralRequests && scope.runtimeIds === undefined && providerIds.length === 0) {
    return DEFAULT_PROXY_SCOPE;
  }
  return {
    mode: 'custom', generalRequests, providerIds,
    ...(scope.runtimeIds !== undefined && { runtimeIds: cleanIds(scope.runtimeIds) }),
  };
}

/** Old custom scopes used the general network selection for all system CLIs. */
export function selectedProxyRuntimeIds(scope: ProxyScopeSettings): readonly string[] {
  if (scope.mode === 'all') return EXTERNAL_RUNTIME_IDS;
  return scope.runtimeIds ?? (scope.generalRequests === false ? [] : EXTERNAL_RUNTIME_IDS);
}

export function shouldUseMyAgentsProxyForRuntime(
  settings: ProxySettings | null | undefined,
  runtime: ExternalRuntimeId,
): boolean {
  return !!settings?.enabled && selectedProxyRuntimeIds(normalizeProxyScope(settings.scope)).includes(runtime);
}

export function shouldUseMyAgentsProxyForGeneralRequests(
  proxySettings: ProxySettings | null | undefined,
): boolean {
  if (!proxySettings?.enabled) return false;
  const scope = normalizeProxyScope(proxySettings.scope);
  return scope.mode === 'all' || scope.generalRequests === true;
}

export function shouldUseMyAgentsProxyForProvider(
  proxySettings: ProxySettings | null | undefined,
  providerId: string | null | undefined,
): boolean {
  if (!proxySettings?.enabled) return false;
  const id = providerId?.trim();
  if (!id) return false;
  const scope = normalizeProxyScope(proxySettings.scope);
  if (scope.mode === 'all') return true;
  return (scope.providerIds ?? []).includes(id);
}

export function effectiveProxyScopeKey(
  proxySettings: ProxySettings | null | undefined,
  providerId: string | null | undefined,
): string {
  const id = providerId?.trim();
  if (!proxySettings?.enabled || !id) return 'myagents-proxy:none';
  if (!shouldUseMyAgentsProxyForProvider(proxySettings, id)) {
    return `myagents-proxy:disabled-for-provider:${id}`;
  }
  const protocol = proxySettings.protocol || 'http';
  const host = proxySettings.host || '127.0.0.1';
  const port = proxySettings.port || 7890;
  return `myagents-proxy:${id}:${protocol}://${host}:${port}`;
}

export function effectiveGeneralProxyScopeKey(
  proxySettings: ProxySettings | null | undefined,
): string {
  if (!shouldUseMyAgentsProxyForGeneralRequests(proxySettings)) {
    return 'myagents-proxy:general:inherited';
  }
  const protocol = proxySettings?.protocol || 'http';
  const host = proxySettings?.host || '127.0.0.1';
  const port = proxySettings?.port || 7890;
  return `myagents-proxy:general:${protocol}://${host}:${port}`;
}

export function normalizeProxySettingsScope(proxySettings: ProxySettings): ProxySettings {
  const scope = normalizeProxyScope(proxySettings.scope);
  return {
    ...proxySettings,
    scope,
  };
}

export function removeProviderFromProxySettingsScope(
  proxySettings: ProxySettings | null | undefined,
  providerId: string,
): ProxySettings | undefined {
  if (!proxySettings) return undefined;
  const id = providerId.trim();
  if (!id || proxySettings.scope?.mode !== 'custom') return proxySettings;

  const providerIds = cleanIds(proxySettings.scope.providerIds)
    .filter(existingId => existingId !== id);
  const normalizedScope = normalizeProxyScope(proxySettings.scope);
  const generalRequests = normalizedScope.mode === 'all'
    ? true
    : normalizedScope.generalRequests === true;
  return {
    ...proxySettings,
    scope: { ...normalizedScope, mode: 'custom', generalRequests, providerIds },
  };
}
