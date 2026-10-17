// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/browser-security-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/browser-security-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function hasConfiguredSecretInput() { _w('hasConfiguredSecretInput'); return false; }
export function extractErrorCode() { _w('extractErrorCode'); return undefined; }
export function formatErrorMessage() { _w('formatErrorMessage'); return ""; }
export function SafeOpenError() { _w('SafeOpenError'); return undefined; }
export function openFileWithinRoot() { _w('openFileWithinRoot'); return undefined; }
export function writeFileFromPathWithinRoot() { _w('writeFileFromPathWithinRoot'); return undefined; }
export function hasProxyEnvConfigured() { _w('hasProxyEnvConfigured'); return false; }
export function SsrFBlockedError() { _w('SsrFBlockedError'); return undefined; }
export function isBlockedHostnameOrIp() { _w('isBlockedHostnameOrIp'); return false; }
export function matchesHostnameAllowlist() { _w('matchesHostnameAllowlist'); return undefined; }
export function isPrivateNetworkAllowedByPolicy() { _w('isPrivateNetworkAllowedByPolicy'); return false; }
export function resolvePinnedHostnameWithPolicy() { _w('resolvePinnedHostnameWithPolicy'); return undefined; }
export function normalizeHostname() { _w('normalizeHostname'); return ""; }
export function isNotFoundPathError() { _w('isNotFoundPathError'); return false; }
export function isPathInside() { _w('isPathInside'); return false; }
export function ensurePortAvailable() { _w('ensurePortAvailable'); return undefined; }
export function generateSecureToken() { _w('generateSecureToken'); return undefined; }
export function createSubsystemLogger() { _w('createSubsystemLogger'); return undefined; }
export function redactSensitiveText() { _w('redactSensitiveText'); return undefined; }
export function wrapExternalContent() { _w('wrapExternalContent'); return undefined; }
export function safeEqualSecret() { _w('safeEqualSecret'); return undefined; }
