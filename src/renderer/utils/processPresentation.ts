import type { ContentBlock, ToolUseSimple } from '@/types/chat';
import { dshToolDisplayName } from '../../shared/toolDisplay/dshToolNames';
import { resolveBashTranscriptStatus } from '@/components/tools/bashTranscript';
import { isSubagentContainerRunning, isSubagentContainerTool } from '@/components/tools/subagentActivity';

export type ProcessOutcome = 'running' | 'succeeded' | 'failed' | 'stopped' | 'unknown';
export type ProcessPhaseKind = 'plan' | 'explore' | 'change' | 'verify' | 'execute' | 'delegate' | 'think';
export interface ProcessEntry { block: ContentBlock; index: number; outcome: ProcessOutcome }
export interface ProcessPhase { key: string; kind: ProcessPhaseKind; entries: ProcessEntry[] }

export function processInput(tool: ToolUseSimple): Record<string, unknown> {
  if (tool.parsedInput) return tool.parsedInput as Record<string, unknown>;
  if (tool.inputJson && tool.inputJson.length <= 64_000) {
    try {
      const parsed: unknown = JSON.parse(tool.inputJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* Streaming input can be incomplete. */ }
  }
  return tool.input && typeof tool.input === 'object' ? tool.input as Record<string, unknown> : {};
}

export function getProcessOutcome(block: ContentBlock, live: boolean): ProcessOutcome {
  const tool = block.tool;
  // A continuable child owns later activations even when its original parent
  // tool retained stopped/failed flags during history finalization.
  if (tool && isSubagentContainerTool(tool.name) && tool.subagentLifecycle) {
    const status = tool.subagentLifecycle.status;
    return status === 'completed' ? 'succeeded' : status === 'interrupted' ? 'stopped' : status;
  }
  if (block.isStopped || tool?.isStopped) return 'stopped';
  if (block.isFailed || tool?.isFailed || tool?.isError) return 'failed';
  if (block.type === 'thinking') return block.isComplete ? 'succeeded' : live ? 'running' : 'unknown';
  if (!tool) return 'unknown';
  if (isSubagentContainerTool(tool.name)) {
    if (isSubagentContainerRunning(tool)) return live ? 'running' : 'unknown';
  }
  if (['Bash', 'bash', 'pwsh', 'PowerShell'].includes(tool.name)) {
    const status = resolveBashTranscriptStatus(tool);
    if (status === 'failed' || status === 'timeout') return 'failed';
    if (status === 'stopped' || status === 'interrupted') return 'stopped';
    if (status === 'background') return live ? 'running' : 'unknown';
    if (!tool.isLoading && tool.resultMeta?.exitCode === 0) return 'succeeded';
    if (status === 'running' || status === 'initializing') return live ? 'running' : 'unknown';
  }
  const metaStatus = tool.resultMeta?.status?.toLowerCase();
  if (typeof tool.resultMeta?.exitCode === 'number' && tool.resultMeta.exitCode !== 0
    || ['failed', 'error', 'denied', 'timeout'].includes(metaStatus ?? '')) return 'failed';
  if (['stopped', 'interrupted', 'cancelled', 'canceled'].includes(metaStatus ?? '')) return 'stopped';
  if (live && tool.isLoading) return 'running';
  // Empty output is a result; missing output alone is never success.
  // A loading bit on reopened history is not proof of current execution.
  if (tool.isLoading) return 'unknown';
  if (tool.result !== undefined || tool.resultMeta?.exitCode === 0
    || ['completed', 'succeeded'].includes(metaStatus ?? '')) return 'succeeded';
  return 'unknown';
}

export function getProcessPhaseKind(block: ContentBlock): ProcessPhaseKind {
  if (block.type === 'thinking') return 'think';
  const tool = block.tool;
  if (!tool) return 'execute';
  const name = dshToolDisplayName(tool.name);
  if (isSubagentContainerTool(name)) return 'delegate';
  if (['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'EnterPlanMode', 'ExitPlanMode'].includes(name)) return 'plan';
  if (['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill'].includes(name)) return 'explore';
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'change';
  if (['Bash', 'bash', 'pwsh', 'PowerShell'].includes(name)) {
    const input = processInput(tool);
    const command = typeof input.command === 'string' ? input.command.slice(0, 4096).trim() : '';
    // Only classify known command entry points; descriptions/output are data,
    // not proof of verification. Classification never implies a passed test.
    if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|verify)(?=[:\s]|$)|(?:npx\s+)?(?:vitest|tsc|pytest)\b|(?:cargo|go)\s+(?:test|check|build|clippy)\b|node\s+--test\b)/.test(command)) return 'verify';
    if (/^(?:rg|grep|cat|sed|head|tail|ls|pwd)\b/.test(command)) return 'explore';
  }
  return 'execute';
}

/** Display-only chronological grouping; no transcript mutation or reordering.
 * IDs come from the first original block, so appending events preserves folds. */
export function buildProcessPhases(blocks: ContentBlock[], live: boolean): ProcessPhase[] {
  const phases: ProcessPhase[] = [];
  blocks.forEach((block, index) => {
    const kind = getProcessPhaseKind(block);
    const previous = phases.at(-1);
    const entry = { block, index, outcome: getProcessOutcome(block, live) };
    if (previous?.kind === kind) previous.entries.push(entry);
    else phases.push({ key: block.id ?? block.tool?.id ?? `block-${index}`, kind, entries: [entry] });
  });
  return phases;
}

export function summarizeProcessPhase(entries: ProcessEntry[]) {
  const counts: Record<ProcessOutcome, number> = { running: 0, succeeded: 0, failed: 0, stopped: 0, unknown: 0 };
  for (const entry of entries) counts[entry.outcome]++;
  const outcome: ProcessOutcome = counts.running ? 'running' : counts.failed ? 'failed' : counts.stopped ? 'stopped' : counts.unknown ? 'unknown' : 'succeeded';
  return { counts, outcome };
}
