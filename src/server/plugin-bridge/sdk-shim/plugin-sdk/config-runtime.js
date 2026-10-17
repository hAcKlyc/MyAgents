// HAND-WRITTEN BRIDGE SHIM — listed in _handwritten.json.
//
// MyAgents Plugin Bridge does not own an openclaw.json file. The authoritative
// OpenClaw config for a loaded channel is the in-process normalized snapshot
// built by src/server/plugin-bridge/openclaw-config.ts. This shim exposes the
// subset of config-runtime that channel plugins use for runtime reload paths
// (notably openclaw-weixin QR login).

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/config-runtime.' + fn + '() not implemented in Bridge mode'); }
}

const CONFIG_GLOBAL_KEY = '__MYAGENTS_OPENCLAW_CONFIG__';

function _clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function _asConfig(value) {
  const root = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawChannels = root.channels && typeof root.channels === 'object' && !Array.isArray(root.channels)
    ? root.channels
    : {};
  const channels = {};
  for (const [key, channel] of Object.entries(rawChannels)) {
    channels[key] = channel && typeof channel === 'object' && !Array.isArray(channel) ? channel : {};
  }
  return { ...root, channels };
}

function _getConfig() {
  return _clone(globalThis[CONFIG_GLOBAL_KEY] ?? { channels: {} });
}

function _setConfig(cfg) {
  const next = _clone(_asConfig(cfg));
  globalThis[CONFIG_GLOBAL_KEY] = next;
  return _clone(next);
}

export function resolveDefaultAgentId() { _w('resolveDefaultAgentId'); return undefined; }
export function requireRuntimeConfig() { return _getConfig(); }
export function resolveLivePluginConfigObject() { return _getConfig(); }
export function resolvePluginConfigObject() { return _getConfig(); }
export function clearConfigCache() { return undefined; }
export function clearRuntimeConfigSnapshot() { globalThis[CONFIG_GLOBAL_KEY] = { channels: {} }; return undefined; }
export function getRuntimeConfigSourceSnapshot() { return { source: 'myagents-plugin-bridge' }; }
export function getRuntimeConfigSnapshot() { return _getConfig(); }
export function getRuntimeConfig() { return _getConfig(); }
export function loadConfig() { return _getConfig(); }
export function readConfigFileSnapshotForWrite() { return _getConfig(); }
export function setRuntimeConfigSnapshot(cfg) { return _setConfig(cfg); }
export function writeConfigFile(cfg) { return _setConfig(cfg); }
// New entry points share this queue and the existing snapshot. A concurrent
// legacy/host write invalidates an awaited mutation instead of losing data.
let mutationTail = Promise.resolve();
export function mutateConfigFile(params) {
  if (typeof params === 'function') {
    const current = _getConfig();
    return _setConfig(params(current) ?? current);
  }
  const run = async () => {
    if (typeof params?.mutate !== 'function') throw new TypeError('mutateConfigFile requires mutate(draft)');
    if (params.io || params.base || params.baseHash || params.writeOptions) {
      throw new Error('Bridge config mutation supports the runtime snapshot, not OpenClaw file writes');
    }
    const before = globalThis[CONFIG_GLOBAL_KEY];
    const draft = _getConfig();
    const result = await params.mutate(draft, {
      snapshot: { config: _clone(draft) }, previousHash: null, attempt: 1,
    });
    if (globalThis[CONFIG_GLOBAL_KEY] !== before) {
      throw new Error('Bridge config changed while mutation was running');
    }
    const nextConfig = _setConfig(draft);
    // Rust owns durable channel config; no disk write/restart is claimed.
    return { nextConfig, result, attempts: 1 };
  };
  const pending = mutationTail.then(run);
  mutationTail = pending.then(() => undefined, () => undefined);
  return pending;
}
export function replaceConfigFile(cfg) { return _setConfig(cfg); }
export function logConfigUpdated() { return undefined; }
export function updateConfig(patch) {
  const current = _getConfig();
  return _setConfig({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
}
export function resolveChannelModelOverride() { _w('resolveChannelModelOverride'); return undefined; }
export function evaluateSupplementalContextVisibility() { _w('evaluateSupplementalContextVisibility'); return undefined; }
export function filterSupplementalContextItems() { _w('filterSupplementalContextItems'); return undefined; }
export function resolveChannelContextVisibilityMode() { _w('resolveChannelContextVisibilityMode'); return undefined; }
export function resolveDefaultContextVisibility() { _w('resolveDefaultContextVisibility'); return undefined; }
export function resolveMarkdownTableMode() { _w('resolveMarkdownTableMode'); return undefined; }
export function resolveChannelGroupPolicy() { _w('resolveChannelGroupPolicy'); return undefined; }
export function resolveChannelGroupRequireMention() { _w('resolveChannelGroupRequireMention'); return undefined; }
export function resolveToolsBySender() { _w('resolveToolsBySender'); return undefined; }
export const GROUP_POLICY_BLOCKED_LABEL = undefined;
export function resolveAllowlistProviderRuntimeGroupPolicy() { _w('resolveAllowlistProviderRuntimeGroupPolicy'); return undefined; }
export function resolveDefaultGroupPolicy() { _w('resolveDefaultGroupPolicy'); return undefined; }
export function resolveOpenProviderRuntimeGroupPolicy() { _w('resolveOpenProviderRuntimeGroupPolicy'); return undefined; }
export function warnMissingProviderGroupPolicyFallbackOnce() { _w('warnMissingProviderGroupPolicyFallbackOnce'); return undefined; }
export function isNativeCommandsExplicitlyDisabled() { _w('isNativeCommandsExplicitlyDisabled'); return false; }
export function resolveNativeCommandsEnabled() { _w('resolveNativeCommandsEnabled'); return undefined; }
export function resolveNativeSkillsEnabled() { _w('resolveNativeSkillsEnabled'); return undefined; }
export const TELEGRAM_COMMAND_NAME_PATTERN = undefined;
export function normalizeTelegramCommandName() { _w('normalizeTelegramCommandName'); return ""; }
export function resolveTelegramCustomCommands() { _w('resolveTelegramCustomCommands'); return undefined; }
export function resolveActiveTalkProviderConfig() { _w('resolveActiveTalkProviderConfig'); return undefined; }
export function resolveAgentMaxConcurrent() { _w('resolveAgentMaxConcurrent'); return undefined; }
export function loadCronStore() { _w('loadCronStore'); return undefined; }
export function resolveCronStorePath() { _w('resolveCronStorePath'); return undefined; }
export function saveCronStore() { _w('saveCronStore'); return undefined; }
export function applyModelOverrideToSessionEntry() { _w('applyModelOverrideToSessionEntry'); return undefined; }
export function coerceSecretRef() { _w('coerceSecretRef'); return undefined; }
export function resolveConfiguredSecretInputString() { _w('resolveConfiguredSecretInputString'); return undefined; }
export function resolveConfiguredSecretInputWithFallback() { _w('resolveConfiguredSecretInputWithFallback'); return undefined; }
export function resolveRequiredConfiguredSecretRefInputString() { _w('resolveRequiredConfiguredSecretRefInputString'); return undefined; }
export function clearSessionStoreCacheForTest() { _w('clearSessionStoreCacheForTest'); return undefined; }
export function loadSessionStore() { _w('loadSessionStore'); return undefined; }
export function readSessionUpdatedAt() { _w('readSessionUpdatedAt'); return undefined; }
export function recordSessionMetaFromInbound() { _w('recordSessionMetaFromInbound'); return undefined; }
export function saveSessionStore() { _w('saveSessionStore'); return undefined; }
export function updateLastRoute() { _w('updateLastRoute'); return undefined; }
export function updateSessionStore() { _w('updateSessionStore'); return undefined; }
export function resolveSessionStoreEntry() { _w('resolveSessionStoreEntry'); return undefined; }
export function resolveSessionKey() { _w('resolveSessionKey'); return undefined; }
export function resolveStorePath() { _w('resolveStorePath'); return undefined; }
export function resolveGroupSessionKey() { _w('resolveGroupSessionKey'); return undefined; }
export function canonicalizeMainSessionAlias() { _w('canonicalizeMainSessionAlias'); return undefined; }
export function evaluateSessionFreshness() { _w('evaluateSessionFreshness'); return undefined; }
export function resolveChannelResetConfig() { _w('resolveChannelResetConfig'); return undefined; }
export function resolveSessionResetPolicy() { _w('resolveSessionResetPolicy'); return undefined; }
export function resolveSessionResetType() { _w('resolveSessionResetType'); return undefined; }
export function resolveThreadFlag() { _w('resolveThreadFlag'); return undefined; }
export function isDangerousNameMatchingEnabled() { _w('isDangerousNameMatchingEnabled'); return false; }
export function resolveDangerousNameMatchingEnabled() { _w('resolveDangerousNameMatchingEnabled'); return undefined; }
