// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/browser-support.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/browser-support.' + fn + '() not implemented in Bridge mode'); }
}

export function createConfigIO() { _w('createConfigIO'); return undefined; }
export function getRuntimeConfigSnapshot() { _w('getRuntimeConfigSnapshot'); return undefined; }
export const loadConfig = undefined;
export function writeConfigFile() { _w('writeConfigFile'); return undefined; }
export function resolveConfigPath() { _w('resolveConfigPath'); return undefined; }
export function resolveGatewayPort() { _w('resolveGatewayPort'); return undefined; }
export const DEFAULT_BROWSER_CONTROL_PORT = undefined;
export function deriveDefaultBrowserCdpPortRange() { _w('deriveDefaultBrowserCdpPortRange'); return undefined; }
export function deriveDefaultBrowserControlPort() { _w('deriveDefaultBrowserControlPort'); return undefined; }
export const normalizePluginsConfig = undefined;
export function resolveEffectiveEnableState() { _w('resolveEffectiveEnableState'); return undefined; }
export function parseBooleanValue() { _w('parseBooleanValue'); return undefined; }
export const CONFIG_DIR = undefined;
export function escapeRegExp() { _w('escapeRegExp'); return undefined; }
export function resolveUserPath() { _w('resolveUserPath'); return undefined; }
export function shortenHomePath() { _w('shortenHomePath'); return undefined; }
export function addGatewayClientOptions() { _w('addGatewayClientOptions'); return undefined; }
export function callGatewayFromCli() { _w('callGatewayFromCli'); return undefined; }
export function runCommandWithRuntime() { _w('runCommandWithRuntime'); return undefined; }
export function resolveGatewayAuth() { _w('resolveGatewayAuth'); return undefined; }
export function isLoopbackHost() { _w('isLoopbackHost'); return false; }
export function isNodeCommandAllowed() { _w('isNodeCommandAllowed'); return false; }
export function resolveNodeCommandAllowlist() { _w('resolveNodeCommandAllowlist'); return undefined; }
export function ErrorCodes() { _w('ErrorCodes'); return undefined; }
export function errorShape() { _w('errorShape'); return undefined; }
export function respondUnavailableOnNodeInvokeError() { _w('respondUnavailableOnNodeInvokeError'); return undefined; }
export function safeParseJson() { _w('safeParseJson'); return undefined; }
export function ensureGatewayStartupAuth() { _w('ensureGatewayStartupAuth'); return undefined; }
export function rawDataToString() { _w('rawDataToString'); return undefined; }
export function startLazyPluginServiceModule() { _w('startLazyPluginServiceModule'); return undefined; }
export function runExec() { _w('runExec'); return undefined; }
export function defaultRuntime() { _w('defaultRuntime'); return undefined; }
export function withTimeout() { _w('withTimeout'); return undefined; }
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
export function imageResultFromFile() { _w('imageResultFromFile'); return undefined; }
export function jsonResult() { _w('jsonResult'); return undefined; }
export function readStringParam() { _w('readStringParam'); return undefined; }
export function listNodes() { _w('listNodes'); return []; }
export function resolveNodeIdFromList() { _w('resolveNodeIdFromList'); return undefined; }
export function selectDefaultNodeFromList() { _w('selectDefaultNodeFromList'); return undefined; }
export function callGatewayTool() { _w('callGatewayTool'); return undefined; }
export function optionalStringEnum() { _w('optionalStringEnum'); return undefined; }
export function stringEnum() { _w('stringEnum'); return undefined; }
export function formatCliCommand() { _w('formatCliCommand'); return ""; }
export function inheritOptionFromParent() { _w('inheritOptionFromParent'); return undefined; }
export function formatHelpExamples() { _w('formatHelpExamples'); return ""; }
export function danger() { _w('danger'); return undefined; }
export function info() { _w('info'); return undefined; }
export const IMAGE_REDUCE_QUALITY_STEPS = undefined;
export function buildImageResizeSideGrid() { _w('buildImageResizeSideGrid'); return undefined; }
export function getImageMetadata() { _w('getImageMetadata'); return undefined; }
export function resizeToJpeg() { _w('resizeToJpeg'); return undefined; }
export function detectMime() { _w('detectMime'); return undefined; }
export function ensureMediaDir() { _w('ensureMediaDir'); return undefined; }
export function saveMediaBuffer() { _w('saveMediaBuffer'); return undefined; }
export function formatDocsLink() { _w('formatDocsLink'); return ""; }
export function note() { _w('note'); return undefined; }
export function theme() { _w('theme'); return undefined; }
export function captureEnv() { _w('captureEnv'); return undefined; }
export function withEnv() { _w('withEnv'); return undefined; }
export function withEnvAsync() { _w('withEnvAsync'); return undefined; }
export function withFetchPreconnect() { _w('withFetchPreconnect'); return undefined; }
export function createTempHomeEnv() { _w('createTempHomeEnv'); return undefined; }
