import { ChevronDownIcon } from '@/components/icons';
import { memo, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContentBlock } from '@/types/chat';
import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import { buildProcessPhases, summarizeProcessPhase, type ProcessPhase } from '@/utils/processPresentation';
import { getToolActionLabel, getToolSummaryNode, formatDuration } from './tools/toolBadgeConfig';
import { isSubagentContainerTool } from './tools/subagentActivity';
import ProcessRow from './ProcessRow';
import ProcessStatus from './ProcessStatus';

interface BlockGroupProps {
  blocks: ContentBlock[];
  isLatestActiveSection?: boolean;
  isStreaming?: boolean;
}

function ProcessPhaseCard({ phase, live, totalBlocks }: { phase: ProcessPhase; live: boolean; totalBlocks: number }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const notify = useNotifyRowLayoutChanged();
  const { counts, outcome } = summarizeProcessPhase(phase.entries);
  const latest = phase.entries.at(-1)?.block;
  const latestAction = latest?.tool ? getToolActionLabel(latest.tool, t) : undefined;
  // Keep active/failure rows and child-agent anchors visible even when details
  // are folded. A hidden error or a broken status-panel jump defeats the summary.
  const important = (entry: ProcessPhase['entries'][number]) =>
    ['running', 'failed', 'stopped'].includes(entry.outcome)
    || Boolean(entry.block.tool && isSubagentContainerTool(entry.block.tool.name));
  const hasImportant = phase.entries.some(important);
  const toolCount = phase.entries.filter(entry => entry.block.tool).length;
  const visibleCount = expanded ? phase.entries.length : phase.entries.filter(important).length;
  const previousVisibleCount = useRef(visibleCount);
  useLayoutEffect(() => {
    if (previousVisibleCount.current !== visibleCount) notify('tool-complete');
    previousVisibleCount.current = visibleCount;
  }, [visibleCount, notify]);
  const latestOutcome = phase.entries.at(-1)?.outcome;
  const resultSummary = latest?.tool && latestOutcome === 'succeeded' ? getToolSummaryNode(latest.tool, t) : null;
  const resultMeta = latest?.tool?.resultMeta;

  return <section data-process-phase={phase.kind} data-phase-outcome={outcome}
    className="overflow-hidden rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)]/30">
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium text-[var(--ink)]">{t(`process.phase.${phase.kind}`)}</h3>
        <ProcessStatus outcome={outcome} />
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--ink-secondary)]" aria-live={live ? 'polite' : 'off'} aria-atomic="true">
        <span>{t(toolCount ? 'process.summary.tools' : 'process.summary.records', { count: phase.entries.length })}</span>
        {counts.succeeded > 0 && <span>{t('process.summary.succeeded', { count: counts.succeeded })}</span>}
        {counts.running > 0 && <span>{t('process.summary.running', { count: counts.running })}</span>}
        {counts.failed > 0 && <span className="text-[var(--error)]">{t('process.summary.failed', { count: counts.failed })}</span>}
        {counts.stopped > 0 && <span className="text-[var(--warning)]">{t('process.summary.stopped', { count: counts.stopped })}</span>}
        {counts.unknown > 0 && <span>{t('process.summary.unknown', { count: counts.unknown })}</span>}
      </p>
      {!hasImportant && latestAction && <p className="break-words text-sm text-[var(--ink-secondary)]">{t('process.latest', { action: latestAction })}</p>}
      {(latestOutcome === 'succeeded' || latestOutcome === 'failed' || latestOutcome === 'stopped')
        && (resultSummary || resultMeta?.exitCode !== undefined && resultMeta.exitCode !== null || typeof resultMeta?.durationMs === 'number') &&
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-secondary)]" data-phase-result>
          {hasImportant && latestAction && <span className="w-full break-words">{t('process.resultFor', { action: latestAction })}</span>}
          {resultSummary}
          {typeof resultMeta?.exitCode === 'number' && <span>{t('process.exitCode', { code: resultMeta.exitCode })}</span>}
          {typeof resultMeta?.durationMs === 'number' && <span>{formatDuration(resultMeta.durationMs)}</span>}
        </div>}

    </div>
    <button type="button" aria-expanded={expanded} aria-controls={detailsId}
      onClick={() => { notify(expanded ? 'block-group-collapse' : 'block-group-expand'); setExpanded(!expanded); }}
      className="flex min-h-8 w-full items-center gap-1.5 border-t border-[var(--line-subtle)] px-4 py-1.5 text-left text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]">
      <ChevronDownIcon aria-hidden="true" className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} />
      {t(expanded ? 'process.hideDetails' : 'process.showDetails', { count: phase.entries.length })}
    </button>
    <div id={detailsId}>
      {phase.entries.map(entry => expanded || important(entry) ? <ProcessRow
        key={entry.block.id ?? entry.block.tool?.id ?? entry.index}
        block={entry.block} index={entry.index} totalBlocks={totalBlocks} isStreaming={live}
      /> : null)}
    </div>
  </section>;
}

const BlockGroup = memo(function BlockGroup({ blocks, isStreaming = false }: BlockGroupProps) {
  // Background subagent lifecycle remains authoritative even for older groups;
  // ordinary tool loading requires this message's live streaming context.
  const live = isStreaming;
  const phases = buildProcessPhases(blocks, live);
  if (!phases.length) return null;
  return <div className="my-3 space-y-2 select-none" data-process-group>
    {phases.map(phase => <ProcessPhaseCard key={phase.key} phase={phase} live={live} totalBlocks={blocks.length} />)}
  </div>;
});

export default BlockGroup;
