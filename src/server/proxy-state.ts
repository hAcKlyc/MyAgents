import { APP_DATA_DIR_NAME } from '../shared/appProfile';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Agent, Dispatcher, ProxyAgent } from 'undici';

import type { ProxySettings } from '../shared/config-types';
import {
  effectiveProxyScopeKey,
  normalizeProxyScope,
  PROXY_ENV_KEYS,
  shouldUseMyAgentsProxyForGeneralRequests,
  shouldUseMyAgentsProxyForProvider,
} from '../shared/proxyScope';
import {
  isSocksBridgeRunning,
  startSocksBridge,
  stopSocksBridge,
} from './utils/socks-bridge';

export const PROXY_NO_PROXY_VAL = 'localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1';

const proxyWasInjectedByRust = process.env.MYAGENTS_PROXY_INJECTED === '1';
const proxyInheritedEnvJson = process.env.MYAGENTS_PROXY_INHERITED_ENV_JSON;
delete process.env.MYAGENTS_PROXY_INJECTED;
delete process.env.MYAGENTS_PROXY_INHERITED_ENV_JSON;

let inheritedProxySnapshot: Record<string, string | undefined> = readInheritedProxySnapshot();

let currentProxySettings: ProxySettings | null = readInitialProxySettings();
let appProxyEnvSnapshot: Record<string, string | undefined> | null = currentProxySettings?.enabled
  ? createAppProxyEnvSnapshot(rawProxyUrl(currentProxySettings))
  : null;
let providerOwnedConsumersEnabled = true;
let proxyConfigGeneration = 0;
let proxyConfigTransition: Promise<void> = Promise.resolve();
let generalRequestDispatcher: { key: string; dispatcher: Dispatcher } | null = null;

/**
 * Select a direct or protocol-specific proxy child with the canonical
 * NO_PROXY matcher. MyAgents' localhost invariant includes the whole 127/8
 * range, which Undici's conventional hostname matcher does not cover.
 */
class GeneralRequestDispatcher extends Dispatcher {
  private readonly direct = new Agent();
  private readonly httpProxy?: ProxyAgent;
  private readonly httpsProxy?: ProxyAgent;
  private readonly noProxy: string;

  constructor(options: { httpProxy?: string; httpsProxy?: string; noProxy: string }) {
    super();
    this.noProxy = options.noProxy;
    if (options.httpProxy) this.httpProxy = new ProxyAgent(options.httpProxy);
    if (options.httpsProxy) this.httpsProxy = new ProxyAgent(options.httpsProxy);
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const origin = typeof options.origin === 'string'
      ? new URL(options.origin)
      : options.origin;
    if (!origin || shouldBypassProxy(origin, this.noProxy)) {
      return this.direct.dispatch(options, handler);
    }
    const proxied = origin.protocol === 'https:' ? this.httpsProxy : this.httpProxy;
    return (proxied ?? this.direct).dispatch(options, handler);
  }

  override async close(): Promise<void> {
    await Promise.all([
      this.direct.close(),
      this.httpProxy?.close(),
      this.httpsProxy?.close(),
    ]);
  }

  override destroy(err: Error | null, callback: () => void): void;
  override destroy(callback: () => void): void;
  override destroy(err: Error | null): Promise<void>;
  override destroy(): Promise<void>;
  override destroy(
    errOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): void | Promise<void> {
    const err = typeof errOrCallback === 'function' ? null : (errOrCallback ?? null);
    const completion = Promise.all([
      this.direct.destroy(err),
      this.httpProxy?.destroy(err),
      this.httpsProxy?.destroy(err),
    ]).then(() => undefined);
    const done = typeof errOrCallback === 'function' ? errOrCallback : callback;
    if (done) {
      void completion.finally(done);
      return;
    }
    return completion;
  }
}

function readInheritedProxySnapshot(): Record<string, string | undefined> {
  if (proxyWasInjectedByRust && proxyInheritedEnvJson) {
    try {
      const parsed = JSON.parse(proxyInheritedEnvJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const snapshot: Record<string, string | undefined> = {};
        const source = parsed as Record<string, unknown>;
        for (const key of PROXY_ENV_KEYS) {
          const value = source[key];
          if (typeof value === 'string') snapshot[key] = value;
        }
        return snapshot;
      }
    } catch (err) {
      console.warn('[proxy-state] Failed to parse inherited proxy env snapshot:', err);
    }
  }

  const snapshot: Record<string, string | undefined> = {};
  if (!proxyWasInjectedByRust) {
    for (const key of PROXY_ENV_KEYS) {
      snapshot[key] = process.env[key];
    }
  }
  return snapshot;
}

function readInitialProxySettings(): ProxySettings | null {
  try {
    const raw = readFileSync(join(homedir(), APP_DATA_DIR_NAME, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as { proxySettings?: unknown };
    return coerceProxySettings(parsed.proxySettings);
  } catch {
    return null;
  }
}

function coerceProxySettings(raw: unknown): ProxySettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const protocol = obj.protocol === 'https' || obj.protocol === 'socks5' ? obj.protocol : 'http';
  return {
    enabled: obj.enabled === true,
    protocol,
    host: typeof obj.host === 'string' && obj.host.trim() ? obj.host : '127.0.0.1',
    port: typeof obj.port === 'number' && Number.isFinite(obj.port) ? obj.port : 7890,
    ...(obj.scope && typeof obj.scope === 'object' ? { scope: obj.scope as ProxySettings['scope'] } : {}),
  };
}

function rawProxyUrl(settings: ProxySettings): string {
  return `${settings.protocol || 'http'}://${settings.host || '127.0.0.1'}:${settings.port || 7890}`;
}

function createAppProxyEnvSnapshot(proxyUrl: string): Record<string, string | undefined> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: PROXY_NO_PROXY_VAL,
    no_proxy: PROXY_NO_PROXY_VAL,
  };
}

function restoreInheritedProxyEnvToProcess(): void {
  copyProxyEnvVars(process.env, inheritedProxySnapshot);
}

function copyProxyEnvVars(
  target: Record<string, string | undefined>,
  source: Record<string, string | undefined>,
): void {
  for (const key of PROXY_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
    else delete target[key];
  }
  delete target.MYAGENTS_PROXY_INJECTED;
  delete target.MYAGENTS_PROXY_INHERITED_ENV_JSON;
  const inheritedNoProxy = target.no_proxy || target.NO_PROXY;
  const noProxy = mergeNoProxyWithLocalhost(inheritedNoProxy);
  target.NO_PROXY = noProxy;
  target.no_proxy = noProxy;
}

function mergeNoProxyWithLocalhost(value: string | undefined): string {
  if (!value) return PROXY_NO_PROXY_VAL;
  if (value.trim() === '*') return '*';
  const entries = value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => Boolean(entry) && entry.toLowerCase() !== '[::1]');
  const seen = new Set(entries.map(entry => entry.toLowerCase()));
  for (const entry of PROXY_NO_PROXY_VAL.split(',')) {
    if (!seen.has(entry.toLowerCase())) entries.push(entry);
  }
  return entries.join(',');
}

function applyGeneralProxyEnv(): void {
  if (
    shouldUseMyAgentsProxyForGeneralRequests(currentProxySettings)
    && appProxyEnvSnapshot
  ) {
    copyProxyEnvVars(process.env, appProxyEnvSnapshot);
    return;
  }
  restoreInheritedProxyEnvToProcess();
}

function hasAnyAppProxyConsumer(settings: ProxySettings): boolean {
  if (!settings.enabled) return false;
  const scope = normalizeProxyScope(settings.scope);
  if (scope.mode === 'all') return true;
  return scope.generalRequests === true
    || (providerOwnedConsumersEnabled && (scope.providerIds?.length ?? 0) > 0);
}

function proxyForUrlFromEnv(url: string, env: Record<string, string | undefined>): string | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return undefined;
  }

  const allProxy = env.all_proxy || env.ALL_PROXY;
  const httpProxy = env.http_proxy || env.HTTP_PROXY || allProxy;
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY || httpProxy || allProxy;
  const proxy = parsedUrl.protocol === 'http:' ? httpProxy : httpsProxy;
  if (!proxy) return undefined;

  const noProxy = env.no_proxy || env.NO_PROXY || '';
  if (shouldBypassProxy(parsedUrl, noProxy)) return undefined;
  return proxy;
}

function shouldBypassProxy(url: URL, noProxy: string): boolean {
  if (noProxy.trim() === '*') return true;
  if (!noProxy) return false;

  const host = normalizeNoProxyHost(url.hostname);
  const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
  return noProxy.split(/[\s,]/).some(patternRaw => {
    let pattern = patternRaw.trim().toLowerCase();
    if (!pattern) return false;

    let patternPort = '';
    const bracketed = /^(\[[^\]]+\])(?::(\d+))?$/.exec(pattern);
    if (bracketed) {
      pattern = bracketed[1];
      patternPort = bracketed[2] ?? '';
    } else {
      const withPort = /^(.*):(\d+)$/.exec(pattern);
      if (withPort) {
        pattern = withPort[1];
        patternPort = withPort[2];
      }
    }
    if (patternPort && patternPort !== port) return false;

    const normalizedPattern = normalizeNoProxyHost(pattern.replace(/^\*?\./, ''));
    if (normalizedPattern === '127.0.0.0/8' || normalizedPattern === '127/8') {
      return host === '127.0.0.1' || host.startsWith('127.');
    }
    return host === normalizedPattern || host.endsWith(`.${normalizedPattern}`);
  });
}

function normalizeNoProxyHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  const bracketedIpv6 = /^\[(.*)\]$/.exec(trimmed);
  return bracketedIpv6?.[1] ?? trimmed;
}

export function getCurrentProxySettings(): ProxySettings | null {
  return currentProxySettings;
}

export function getProviderProxyScopeKey(providerId: string): string {
  return effectiveProxyScopeKey(currentProxySettings, providerId);
}

export function getProcessProxyEnvKey(): string {
  return PROXY_ENV_KEYS
    .map((key) => `${key}=${process.env[key] ?? ''}`)
    .join('\n');
}

export async function setProcessProxyConfig(rawSettings: unknown): Promise<void> {
  const proxySettings = coerceProxySettings(rawSettings);
  const generation = ++proxyConfigGeneration;

  const transition = proxyConfigTransition
    .catch(() => undefined)
    .then(() => applyProcessProxyConfig(proxySettings, generation));
  proxyConfigTransition = transition.catch(() => undefined);
  return transition;
}

async function applyProcessProxyConfig(
  proxySettings: ProxySettings | null,
  generation: number,
): Promise<void> {
  if (generation !== proxyConfigGeneration) return;

  if (!proxySettings?.enabled) {
    if (isSocksBridgeRunning()) {
      await stopSocksBridge().catch(() => { /* ignore */ });
    }
    commitProxyState(proxySettings, null);
    console.log('[proxy-state] owner=general path=inherited reason=proxy-disabled');
    return;
  }

  const proxyUrl = rawProxyUrl(proxySettings);
  if (proxySettings.protocol === 'socks5') {
    if (!hasAnyAppProxyConsumer(proxySettings)) {
      if (isSocksBridgeRunning()) {
        await stopSocksBridge().catch(() => { /* ignore */ });
      }
      commitProxyState(proxySettings, createAppProxyEnvSnapshot(proxyUrl));
      console.log('[proxy-state] owner=general path=inherited scope=empty');
      return;
    }
    try {
      const bridgePort = await startSocksBridge(proxySettings.host || '127.0.0.1', proxySettings.port || 7890);
      if (generation !== proxyConfigGeneration) {
        console.log('[proxy-state] SOCKS5 bridge callback discarded (superseded)');
        return;
      }
      const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
      commitProxyState(proxySettings, createAppProxyEnvSnapshot(bridgeUrl));
      console.log(`[proxy-state] owner=general path=${shouldUseMyAgentsProxyForGeneralRequests(proxySettings) ? 'myagents-proxy' : 'inherited'} protocol=socks5-bridge`);
      return;
    } catch (err) {
      if (generation !== proxyConfigGeneration) {
        return;
      }
      console.error(`[proxy-state] Failed to start SOCKS5 bridge: ${err instanceof Error ? err.message : String(err)}. Falling back to raw URL.`);
      commitProxyState(proxySettings, createAppProxyEnvSnapshot(proxyUrl));
      return;
    }
  }

  if (isSocksBridgeRunning()) {
    await stopSocksBridge().catch(() => { /* ignore */ });
  }
  commitProxyState(proxySettings, createAppProxyEnvSnapshot(proxyUrl));
  console.log(`[proxy-state] owner=general path=${shouldUseMyAgentsProxyForGeneralRequests(proxySettings) ? 'myagents-proxy' : 'inherited'} protocol=${proxySettings.protocol || 'http'}`);
}

function commitProxyState(
  settings: ProxySettings | null,
  appSnapshot: Record<string, string | undefined> | null,
): void {
  currentProxySettings = settings;
  appProxyEnvSnapshot = appSnapshot;
  applyGeneralProxyEnv();
  retireGeneralRequestDispatcher();
}

function retireGeneralRequestDispatcher(): void {
  const retired = generalRequestDispatcher;
  generalRequestDispatcher = null;
  if (retired) {
    void retired.dispatcher.close().catch((err: unknown) => {
      console.warn('[proxy-state] Failed to close retired general request dispatcher:', err);
    });
  }
}

function generalRequestEnvSnapshot(): Record<string, string | undefined> {
  return shouldUseMyAgentsProxyForGeneralRequests(currentProxySettings)
    ? (appProxyEnvSnapshot ?? {})
    : inheritedProxySnapshot;
}

/** Sealed subprocess projection of the general owner, including the localhost bypass. */
export function getGeneralProxyEnvironment(): Readonly<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  copyProxyEnvVars(env, generalRequestEnvSnapshot());
  return Object.freeze(env);
}

function envHttpProxyOptions(env: Record<string, string | undefined>): {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy: string;
} {
  const allProxy = env.all_proxy || env.ALL_PROXY;
  const httpProxy = env.http_proxy || env.HTTP_PROXY || allProxy;
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY || httpProxy || allProxy;
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    noProxy: mergeNoProxyWithLocalhost(env.no_proxy || env.NO_PROXY),
  };
}

/**
 * Dispatcher for generic MyAgents-owned network requests. The selected source
 * is either the live app-proxy overlay or the immutable startup environment;
 * it never reinterprets the process env after Rust/Node have overlaid it.
 */
export function getGeneralRequestDispatcher(): Dispatcher {
  const options = envHttpProxyOptions(generalRequestEnvSnapshot());
  const key = JSON.stringify(options);
  if (generalRequestDispatcher?.key === key) return generalRequestDispatcher.dispatcher;

  const retired = generalRequestDispatcher;
  const dispatcher = new GeneralRequestDispatcher(options);
  generalRequestDispatcher = { key, dispatcher };
  if (retired) {
    void retired.dispatcher.close().catch((err: unknown) => {
      console.warn('[proxy-state] Failed to close superseded general request dispatcher:', err);
    });
  }
  return dispatcher;
}

/** Initialize complete proxy state from disk-derived settings at Sidecar startup. */
export async function initializeProxyStateFromCurrentSettings(options?: {
  providerOwnedConsumers?: boolean;
}): Promise<void> {
  providerOwnedConsumersEnabled = options?.providerOwnedConsumers !== false;
  await setProcessProxyConfig(currentProxySettings);
}

export function applyProviderProxyPolicyToEnv(
  env: Record<string, string | undefined>,
  providerId: string,
): void {
  const useAppProxy = shouldUseMyAgentsProxyForProvider(currentProxySettings, providerId);
  if (useAppProxy) {
    copyProxyEnvVars(env, appProxyEnvSnapshot ?? {});
  } else {
    copyProxyEnvVars(env, inheritedProxySnapshot);
  }
  console.log(`[proxy-state] owner=provider provider=${providerId} path=${useAppProxy ? 'myagents-proxy' : 'inherited'}`);
}

/** Ephemeral Provider request policy for the DSH credential reverse response. */
export function getProviderRequestProxyPolicy(providerId: string): Readonly<{
  httpProxy?: string;
  httpsProxy?: string;
  noProxy: string;
}> {
  const source = shouldUseMyAgentsProxyForProvider(currentProxySettings, providerId)
    ? (appProxyEnvSnapshot ?? {})
    : inheritedProxySnapshot;
  return Object.freeze(envHttpProxyOptions(source));
}

export function getProxyForProviderUrl(providerId: string, url: string): string | undefined {
  const source = shouldUseMyAgentsProxyForProvider(currentProxySettings, providerId)
    ? (appProxyEnvSnapshot ?? {})
    : inheritedProxySnapshot;
  return proxyForUrlFromEnv(url, source);
}

/** General-owner proxy decision for DSH WebFetch, using the same sealed baseline as generic HTTP. */
export function getProxyForUrl(url: string): string | undefined {
  return proxyForUrlFromEnv(url, generalRequestEnvSnapshot());
}

/**
 * Resolve only the proxy explicitly configured by MyAgents for general
 * requests. Security-sensitive callers use this to distinguish the trusted
 * app overlay from the inherited baseline.
 */
export function getMyAgentsProxyForGeneralUrl(url: string): string | undefined {
  if (!shouldUseMyAgentsProxyForGeneralRequests(currentProxySettings)) return undefined;
  return proxyForUrlFromEnv(url, appProxyEnvSnapshot ?? {});
}

export function _getInheritedProxySnapshotForTests(): Record<string, string | undefined> {
  return { ...inheritedProxySnapshot };
}

export function _getGeneralRequestProxyOptionsForTests(): ReturnType<typeof envHttpProxyOptions> {
  return envHttpProxyOptions(generalRequestEnvSnapshot());
}

export function _shouldBypassProxyForTests(url: string, noProxy: string): boolean {
  return shouldBypassProxy(new URL(url), noProxy);
}

export function _resetProxyStateForTests(
  settings: ProxySettings | null,
  inheritedEnv?: Record<string, string | undefined>,
): void {
  if (inheritedEnv !== undefined) inheritedProxySnapshot = { ...inheritedEnv };
  currentProxySettings = settings;
  appProxyEnvSnapshot = settings?.enabled
    ? createAppProxyEnvSnapshot(rawProxyUrl(settings))
    : null;
  applyGeneralProxyEnv();
  retireGeneralRequestDispatcher();
}
