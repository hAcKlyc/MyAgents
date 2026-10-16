import type { ContentBlock } from '@/types/chat';
import type { ExecutionTiming } from '../../shared/executionTiming';
import { isSubagentContainerRunning, isSubagentContainerTool } from '@/components/tools/subagentActivity';

const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8.64e15;
const validDuration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function getProcessTiming(block: ContentBlock): ExecutionTiming | undefined {
  const tool = block.tool;
  const lifecycle = tool && isSubagentContainerTool(tool.name) ? tool.subagentLifecycle : undefined;
  // The child may be reactivated after its launch tool returned. Its current
  // lifecycle owns that span; the launch's old finishedAt must not freeze it.
  if (lifecycle?.timingVerified === false) return undefined;
  const timing = lifecycle ? { startedAt: lifecycle.startedAt, finishedAt: lifecycle.status === 'running' ? undefined : lifecycle.finishedAt,
    lastActivityAt: lifecycle.lastActivityAt, source: 'runtime' as const } : tool?.executionTiming ?? block.executionTiming;
  if (!lifecycle && tool && isSubagentContainerRunning(tool) && timing?.finishedAt !== undefined) return undefined;
  if (!timing || !validTime(timing.startedAt)) return undefined;
  return {
    startedAt: timing.startedAt,
    source: timing.source === 'runtime' ? 'runtime' : 'observed',
    ...(validTime(timing.finishedAt) && timing.finishedAt >= timing.startedAt ? { finishedAt: timing.finishedAt } : {}),
    ...(validTime(timing.lastActivityAt) && timing.lastActivityAt >= timing.startedAt ? { lastActivityAt: timing.lastActivityAt } : {}),
  };
}

/** Wall-clock span, never summed parallel runtimes. Partial timestamps cannot
 * establish a whole phase's start/end; callers can still show each known row. */
export function summarizeProcessTiming(blocks: ContentBlock[], running: boolean, now: number) {
  const timings = blocks.map(getProcessTiming);
  const known = timings.filter((timing): timing is ExecutionTiming => Boolean(timing));
  const complete = known.length === blocks.length && known.length > 0;
  const startedAt = complete ? Math.min(...known.map(timing => timing.startedAt)) : undefined;
  const finishedAt = complete && known.every(timing => timing.finishedAt !== undefined)
    ? Math.max(...known.map(timing => timing.finishedAt!)) : undefined;
  const lastActivityAt = known.length ? Math.max(...known.map(timing => timing.lastActivityAt ?? timing.finishedAt ?? timing.startedAt)) : undefined;
  let durationMs = startedAt !== undefined && finishedAt !== undefined ? finishedAt - startedAt
    : startedAt !== undefined && running && now >= startedAt ? now - startedAt : undefined;
  if (durationMs === undefined && blocks.length === 1 && !running && !(blocks[0].tool && isSubagentContainerTool(blocks[0].tool.name))) {
    const reported = blocks[0].tool?.resultMeta?.durationMs ?? blocks[0].thinkingDurationMs;
    if (validDuration(reported)) durationMs = reported;
  }
  return { startedAt, finishedAt, lastActivityAt, durationMs, source: known.some(timing => timing.source === 'observed') ? 'observed' : 'runtime' };
}

export function preciseDuration(ms: number): string {
  if (ms < 1000) return `${Math.floor(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}
