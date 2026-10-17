// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/security-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/security-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function SafeOpenError() { _w('SafeOpenError'); return undefined; }
export function openFileWithinRoot() { _w('openFileWithinRoot'); return undefined; }
export function writeFileFromPathWithinRoot() { _w('writeFileFromPathWithinRoot'); return undefined; }
export function extractErrorCode() { _w('extractErrorCode'); return undefined; }
export function formatErrorMessage() { _w('formatErrorMessage'); return ""; }
export function hasProxyEnvConfigured() { _w('hasProxyEnvConfigured'); return false; }
export function normalizeHostname() { _w('normalizeHostname'); return ""; }
export function SsrFBlockedError() { _w('SsrFBlockedError'); return undefined; }
export function isBlockedHostnameOrIp() { _w('isBlockedHostnameOrIp'); return false; }
export function isPrivateNetworkAllowedByPolicy() { _w('isPrivateNetworkAllowedByPolicy'); return false; }
export function matchesHostnameAllowlist() { _w('matchesHostnameAllowlist'); return undefined; }
export function resolvePinnedHostnameWithPolicy() { _w('resolvePinnedHostnameWithPolicy'); return undefined; }
export function isNotFoundPathError() { _w('isNotFoundPathError'); return false; }
export function isPathInside() { _w('isPathInside'); return false; }
export function ensurePortAvailable() { _w('ensurePortAvailable'); return undefined; }
export function generateSecureToken() { _w('generateSecureToken'); return undefined; }
export function redactSensitiveText() { _w('redactSensitiveText'); return undefined; }
export function safeEqualSecret() { _w('safeEqualSecret'); return undefined; }
export function collectConditionalChannelFieldAssignments() { _w('collectConditionalChannelFieldAssignments'); return []; }
export function collectNestedChannelFieldAssignments() { _w('collectNestedChannelFieldAssignments'); return []; }
export function collectSimpleChannelFieldAssignments() { _w('collectSimpleChannelFieldAssignments'); return []; }
export function getChannelRecord() { _w('getChannelRecord'); return undefined; }
export function getChannelSurface() { _w('getChannelSurface'); return undefined; }
export function hasConfiguredSecretInputValue() { _w('hasConfiguredSecretInputValue'); return false; }
export function isBaseFieldActiveForChannelSurface() { _w('isBaseFieldActiveForChannelSurface'); return false; }
export function normalizeSecretStringValue() { _w('normalizeSecretStringValue'); return ""; }
export function resolveChannelAccountSurface() { _w('resolveChannelAccountSurface'); return undefined; }
export function collectNestedChannelTtsAssignments() { _w('collectNestedChannelTtsAssignments'); return []; }
export function createResolverContext() { _w('createResolverContext'); return undefined; }
export function pushAssignment() { _w('pushAssignment'); return undefined; }
export function pushWarning() { _w('pushWarning'); return undefined; }
export function pushInactiveSurfaceWarning() { _w('pushInactiveSurfaceWarning'); return undefined; }
export function collectSecretInputAssignment() { _w('collectSecretInputAssignment'); return []; }
export function applyResolvedAssignments() { _w('applyResolvedAssignments'); return undefined; }
export function hasOwnProperty() { _w('hasOwnProperty'); return false; }
export function isEnabledFlag() { _w('isEnabledFlag'); return false; }
export function isChannelAccountEffectivelyEnabled() { _w('isChannelAccountEffectivelyEnabled'); return false; }
export function isNonEmptyString() { _w('isNonEmptyString'); return false; }
export function parseEnvValue() { _w('parseEnvValue'); return undefined; }
export function normalizePositiveInt() { _w('normalizePositiveInt'); return ""; }
export function parseDotPath() { _w('parseDotPath'); return undefined; }
export function toDotPath() { _w('toDotPath'); return undefined; }
export function ensureDirForFile() { _w('ensureDirForFile'); return undefined; }
export function writeJsonFileSecure() { _w('writeJsonFileSecure'); return undefined; }
export function readTextFileIfExists() { _w('readTextFileIfExists'); return undefined; }
export function writeTextFileAtomic() { _w('writeTextFileAtomic'); return undefined; }
export function isRecord() { _w('isRecord'); return false; }
export function buildUntrustedChannelMetadata() { _w('buildUntrustedChannelMetadata'); return undefined; }
export function evaluateSupplementalContextVisibility() { _w('evaluateSupplementalContextVisibility'); return undefined; }
export function shouldIncludeSupplementalContext() { _w('shouldIncludeSupplementalContext'); return false; }
export function filterSupplementalContextItems() { _w('filterSupplementalContextItems'); return undefined; }
export async function readStoreAllowFromForDmPolicy() { _w('readStoreAllowFromForDmPolicy'); return undefined; }
export async function resolveDmAllowState() { _w('resolveDmAllowState'); return undefined; }
export function resolvePinnedMainDmOwnerFromAllowlist() { _w('resolvePinnedMainDmOwnerFromAllowlist'); return undefined; }
export function resolveEffectiveAllowFromLists() { _w('resolveEffectiveAllowFromLists'); return undefined; }
export function resolveDmGroupAccessDecision() { _w('resolveDmGroupAccessDecision'); return undefined; }
export function resolveDmGroupAccessWithLists() { _w('resolveDmGroupAccessWithLists'); return undefined; }
export function resolveDmGroupAccessWithCommandGate() { _w('resolveDmGroupAccessWithCommandGate'); return undefined; }
export const DM_GROUP_ACCESS_REASON = undefined;
export function detectSuspiciousPatterns() { _w('detectSuspiciousPatterns'); return undefined; }
export function wrapExternalContent() { _w('wrapExternalContent'); return undefined; }
export function buildSafeExternalPrompt() { _w('buildSafeExternalPrompt'); return undefined; }
export function getHookType() { _w('getHookType'); return undefined; }
export function wrapWebContent() { _w('wrapWebContent'); return undefined; }
export function isExternalHookSession() { _w('isExternalHookSession'); return false; }
export function mapHookExternalContentSource() { _w('mapHookExternalContentSource'); return undefined; }
export function resolveHookExternalContentSource() { _w('resolveHookExternalContentSource'); return undefined; }
export function testRegexWithBoundedInput() { _w('testRegexWithBoundedInput'); return undefined; }
export function hasNestedRepetition() { _w('hasNestedRepetition'); return false; }
export function compileSafeRegexDetailed() { _w('compileSafeRegexDetailed'); return undefined; }
export function compileSafeRegex() { _w('compileSafeRegex'); return undefined; }
