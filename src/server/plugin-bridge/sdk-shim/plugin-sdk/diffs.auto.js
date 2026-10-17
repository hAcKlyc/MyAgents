// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/diffs.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/diffs.' + fn + '() not implemented in Bridge mode'); }
}

export function definePluginEntry() { _w('definePluginEntry'); return undefined; }
