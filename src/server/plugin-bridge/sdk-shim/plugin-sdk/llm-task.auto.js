// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/llm-task.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/llm-task.' + fn + '() not implemented in Bridge mode'); }
}

export function definePluginEntry() { _w('definePluginEntry'); return undefined; }
export function formatThinkingLevels() { _w('formatThinkingLevels'); return ""; }
export function formatXHighModelHint() { _w('formatXHighModelHint'); return ""; }
export function normalizeThinkLevel() { _w('normalizeThinkLevel'); return ""; }
export function supportsXHighThinking() { _w('supportsXHighThinking'); return false; }
