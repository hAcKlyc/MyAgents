import { SUBSCRIPTION_PROVIDER_ID, CODEX_SUBSCRIPTION_PROVIDER_ID, XAI_SUBSCRIPTION_PROVIDER_ID, ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID } from './config-types';
/** Closed, non-secret portable Host API profile. Shared by UI and Host owner. */
export type HostProviderProfile = {
  id: string; sourceProviderId?: string; name: string; apiProtocol: 'anthropic' | 'openai'; baseUrl: string;
  authType: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; upstreamFormat?: 'chat_completions' | 'responses';
  maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  modelAliases?: { fable?: string; sonnet?: string; opus?: string; haiku?: string };
};
export type HostWorkspaceSelection = {rootId: string; relativePath: string};
export const HOST_PROVIDER_LIMIT = 32;
const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([SUBSCRIPTION_PROVIDER_ID,CODEX_SUBSCRIPTION_PROVIDER_ID,XAI_SUBSCRIPTION_PROVIDER_ID,ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID]);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasControls = (v: string) => [...v].some(c => {const n=c.charCodeAt(0);return n < 32 || (n >= 127 && n <= 159);});
export const isHostProviderId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(v);
export const isHostModelId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 160 && !hasControls(v) && v.trim().length > 0;
export function isHostRelativePath(v: unknown, allowRoot = true): v is string {
  return typeof v === 'string' && new TextEncoder().encode(v).length <= 4096 && !hasControls(v) && !v.includes('\\')
    && (v === '' ? allowRoot : v.split('/').every(p => p !== '' && p !== '.' && p !== '..' && new TextEncoder().encode(p).length <= 255))
    && !/[\ud800-\udfff]/u.test(v.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''));
}
export function isHostWorkspaceSelection(v: unknown): v is HostWorkspaceSelection {
  return plain(v) && Object.keys(v).length === 2 && typeof v.rootId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.rootId) && isHostRelativePath(v.relativePath);
}
export function isHostProviderProfile(v: unknown): v is HostProviderProfile {
  if (!plain(v) || Object.keys(v).some(k => !['id','sourceProviderId','name','apiProtocol','baseUrl','authType','upstreamFormat','maxOutputTokens','maxOutputTokensParamName','modelAliases'].includes(k))
    || !isHostProviderId(v.id) || (v.sourceProviderId !== undefined && !isHostProviderId(v.sourceProviderId)) || RESERVED_PROVIDER_IDS.has(v.id) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 256 || hasControls(v.name)
    || !['anthropic','openai'].includes(v.apiProtocol as string) || !['auth_token','api_key','both','auth_token_clear_api_key'].includes(v.authType as string) || typeof v.baseUrl !== 'string' || v.baseUrl.length > 4096) return false;
  try {
    const url = new URL(v.baseUrl); const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!/^https:\/\//i.test(v.baseUrl) || v.baseUrl.includes('\\') || v.baseUrl.includes('?') || v.baseUrl.includes('#') || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (/\s/.test(v.baseUrl) || hasControls(v.baseUrl))
      || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host) || (host.startsWith('::ffff:127.') || /^::ffff:7f[0-9a-f]{2}:/.test(host))) return false;
  } catch { return false; }
  if (v.upstreamFormat !== undefined && !['chat_completions','responses'].includes(v.upstreamFormat as string)) return false;
  if (v.maxOutputTokens !== undefined && (!Number.isSafeInteger(v.maxOutputTokens) || Number(v.maxOutputTokens) <= 0 || Number(v.maxOutputTokens) > 1_000_000_000)) return false;
  if (v.maxOutputTokensParamName !== undefined && !['max_tokens','max_completion_tokens','max_output_tokens'].includes(v.maxOutputTokensParamName as string)) return false;
  if (v.modelAliases !== undefined && (!plain(v.modelAliases) || Object.keys(v.modelAliases).some(k => !['fable','sonnet','opus','haiku'].includes(k) || !isHostModelId((v.modelAliases as Record<string, unknown>)[k])))) return false;
  return true;
}
/** A normal API catalog entry; no environment, commands, headers or subscriptions. */
export function portableHostProviderToRegistry(profile: HostProviderProfile, models: string[]) {
  if (!isHostProviderProfile(profile) || !models.length || !models.every(isHostModelId)) throw new Error('HOST_PROVIDER_PROFILE_INVALID');
  const {baseUrl, sourceProviderId: _sourceProviderId, ...metadata} = profile;
  return {...metadata, type: 'api' as const, enabled: true, config: {baseUrl}, models: [...new Set(models)].map(model => ({model, modelName: model})), primaryModel: models[0]};
}

export const portableProfileToProvider = portableHostProviderToRegistry;
export type PortableApiProvider = HostProviderProfile;
