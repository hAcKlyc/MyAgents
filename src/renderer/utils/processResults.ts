import type { ContentBlock } from '@/types/chat';
import { getProcessOutcome, getProcessPhaseKind, processInput, type ProcessEntry, type ProcessPhase } from './processPresentation';
import { resolveFilePatchRenderModel } from '../../shared/toolDisplay/filePatch';
import { dshToolDisplayName } from '../../shared/toolDisplay/dshToolNames';
import { resolveBashTranscriptModel } from '@/components/tools/bashTranscript';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Results are projections of existing events, never a second execution ledger. */
export function processFilePaths(entry: ProcessEntry): string[] {
  if (entry.outcome !== 'succeeded' || !entry.block.tool) return [];
  let model;
  try { model = resolveFilePatchRenderModel(entry.block.tool); } catch { return []; }
  if (!model || model.summary.files > model.changes.length) return [];
  return [...new Set(model.changes.map(change => change.movePath ?? change.path).filter((path): path is string => Boolean(path)))];
}

export function shortResult(text: string | undefined): string | null {
  if (!text) return null;
  // Bound work and remove terminal formatting. Render as text, never markup.
  const clean = text.slice(0, 16_000).split('\u001b').map((part, index) => index ? part.replace(/^\[[0-?]*[ -/]*[@-~]/, '') : part).join('');
  const lines = clean.split('\n').map(line => line.trim()).filter(Boolean);
  const summary = lines.findLast(line => /^(?:Tests?|Test Files|\d+ (?:passed|failed)|PASS\b|FAIL\b|Error\b|AssertionError\b|error:|失败|通过)/i.test(line)) ?? lines[0];
  if (!summary || summary.startsWith('{') || summary.startsWith('[')) return null;
  return summary.length > 180 ? `${summary.slice(0, 180)}…` : summary;
}

function baseName(path: string) { return path.replace(/\\/g, '/').split('/').at(-1) || path; }

export function processResultLabel(entry: ProcessEntry, t: Translate): string {
  const kind = getProcessPhaseKind(entry.block);
  const tool = entry.block.tool;
  if (entry.outcome === 'running') {
    const description = tool ? processInput(tool).description : undefined;
    return typeof description === 'string' && description.trim()
      ? description.trim().slice(0, 180) : t(`process.work.${kind}`);
  }
  if (entry.outcome === 'unknown') return t('process.result.unknown');
  if (entry.outcome === 'stopped') return t('process.result.stopped');
  if (entry.outcome === 'failed') return shortResult(tool?.result) ?? t('process.result.failed');
  const paths = processFilePaths(entry);
  if (paths.length === 1) return t('process.result.file', { target: baseName(paths[0]) });
  if (paths.length > 1) return t('process.result.files', { count: paths.length });
  if (kind === 'think') return t('process.result.think');
  if (tool && dshToolDisplayName(tool.name) === 'Read') {
    const path = processInput(tool).file_path;
    if (typeof path === 'string' && path.trim()) return t('process.result.readFile', { target: baseName(path) });
  }
  if (tool && ['Grep', 'Glob'].includes(dshToolDisplayName(tool.name))) {
    // Only structured counts are evidence; grep text itself is not a total.
    try {
      const result: unknown = JSON.parse(tool.result?.slice(0, 64_000) ?? '');
      if (result && typeof result === 'object') {
        const data = result as Record<string, unknown>;
        const count = dshToolDisplayName(tool.name) === 'Glob' ? data.numFiles : data.numLines;
        if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) {
          return t(dshToolDisplayName(tool.name) === 'Glob' ? 'process.result.foundFiles' : 'process.result.matches', { count });
        }
      }
    } catch { /* Non-JSON results retain their neutral result label. */ }
  }
  if (kind === 'verify' || kind === 'execute') {
    const shell = tool && ['Bash', 'bash', 'pwsh', 'PowerShell'].includes(dshToolDisplayName(tool.name));
    const output = shell ? resolveBashTranscriptModel(tool).streams.slice(0, 3).map(stream => stream.text.slice(0, 16_000)).join('\n') : tool?.result;
    return shortResult(output) ?? t(`process.result.${kind}`);
  }
  return t(`process.result.${kind}`);
}

export interface ProcessResultGroup { key: string; path?: string; entries: ProcessEntry[] }
/** Combine only adjacent successful updates to the exact same path. Never hide
 * an intervening failure, parallel activity or reorder a chronological result. */
export function groupProcessResults(entries: ProcessEntry[]): ProcessResultGroup[] {
  const groups: ProcessResultGroup[] = [];
  for (const entry of entries) {
    const paths = processFilePaths(entry);
    const path = paths.length === 1 ? paths[0] : undefined;
    const previous = groups.at(-1);
    if (path && previous?.path === path) previous.entries.push(entry);
    else groups.push({ key: entry.block.id ?? entry.block.tool?.id ?? String(entry.index), path, entries: [entry] });
  }
  return groups;
}

export function processPhaseResult(phase: ProcessPhase, t: Translate): string {
  const completed = phase.entries.filter(entry => entry.outcome === 'succeeded');
  if (phase.entries.some(entry => entry.outcome === 'running')) {
    const active = phase.entries.findLast(entry => entry.outcome === 'running')!;
    return processResultLabel(active, t);
  }
  const paths = new Set(completed.flatMap(processFilePaths));
  if (phase.kind === 'change' && paths.size && completed.length === phase.entries.length) return t('process.result.files', { count: paths.size });
  if (phase.entries.some(entry => entry.outcome === 'failed')) return t('process.result.needsAttention');
  if (phase.entries.some(entry => entry.outcome === 'stopped')) return t('process.result.stopped');
  if (phase.entries.some(entry => entry.outcome === 'unknown')) return t('process.result.unknown');
  // Multiple outputs have no implied combined count or last-call diff total.
  if (phase.entries.length > 1) return t('process.result.returned', { count: completed.length });
  return processResultLabel(phase.entries[0], t);
}

export function executionEvidence(blocks: ContentBlock[], live = false) {
  // Imported classification only identifies checks; exit 0 proves that command,
  // not the answer, business outcome or a production acceptance.
  const evidence = { checksReturned: 0, checksFailed: 0, failed: 0, stopped: 0, unknown: 0 };
  for (const block of blocks) {
    if (!block.tool) continue;
    const entryOutcome = getProcessOutcome(block, live);
    if (entryOutcome === 'failed') evidence.failed++;
    if (entryOutcome === 'stopped') evidence.stopped++;
    if (entryOutcome === 'unknown') evidence.unknown++;
    if (getProcessPhaseKind(block) === 'verify') {
      if (entryOutcome === 'succeeded') evidence.checksReturned++;
      if (entryOutcome === 'failed') evidence.checksFailed++;
    }
    // Do not infer retries from repeated tool names or calls to the same file.
  }
  return evidence;
}
