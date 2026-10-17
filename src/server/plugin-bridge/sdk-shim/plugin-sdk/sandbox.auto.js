// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/sandbox.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/sandbox.' + fn + '() not implemented in Bridge mode'); }
}

export function buildExecRemoteCommand() { _w('buildExecRemoteCommand'); return undefined; }
export function buildRemoteCommand() { _w('buildRemoteCommand'); return undefined; }
export function buildSshSandboxArgv() { _w('buildSshSandboxArgv'); return undefined; }
export function createRemoteShellSandboxFsBridge() { _w('createRemoteShellSandboxFsBridge'); return undefined; }
export function createWritableRenameTargetResolver() { _w('createWritableRenameTargetResolver'); return undefined; }
export function createSshSandboxSessionFromConfigText() { _w('createSshSandboxSessionFromConfigText'); return undefined; }
export function createSshSandboxSessionFromSettings() { _w('createSshSandboxSessionFromSettings'); return undefined; }
export function disposeSshSandboxSession() { _w('disposeSshSandboxSession'); return undefined; }
export function getSandboxBackendFactory() { _w('getSandboxBackendFactory'); return undefined; }
export function getSandboxBackendManager() { _w('getSandboxBackendManager'); return undefined; }
export function registerSandboxBackend() { _w('registerSandboxBackend'); return undefined; }
export function requireSandboxBackendFactory() { _w('requireSandboxBackendFactory'); return undefined; }
export function resolveWritableRenameTargets() { _w('resolveWritableRenameTargets'); return undefined; }
export function resolveWritableRenameTargetsForBridge() { _w('resolveWritableRenameTargetsForBridge'); return undefined; }
export function runSshSandboxCommand() { _w('runSshSandboxCommand'); return undefined; }
export function sanitizeEnvVars() { _w('sanitizeEnvVars'); return ""; }
export function shellEscape() { _w('shellEscape'); return undefined; }
export function uploadDirectoryToSshTarget() { _w('uploadDirectoryToSshTarget'); return undefined; }
export function runPluginCommandWithTimeout() { _w('runPluginCommandWithTimeout'); return undefined; }
