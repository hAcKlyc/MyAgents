import { ChevronDownIcon } from '@/components/icons';
import { memo, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContentBlock } from '@/types/chat';
import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import { buildProcessPhases, summarizeProcessPhase, type ProcessPhase } from '@/utils/processPresentation';
import { groupProcessResults, processPhaseResult } from '@/utils/processResults';
import { isSubagentContainerTool } from './tools/subagentActivity';
import ProcessRow from './ProcessRow';
import ProcessStatus from './ProcessStatus';
import ProcessTiming from './ProcessTiming';

interface BlockGroupProps {
  blocks: ContentBlock[];
  isLatestActiveSection?: boolean;
  isStreaming?: boolean;
}

function ProcessPhaseCard({ phase, live, totalBlocks }: { phase: ProcessPhase; live: boolean; totalBlocks: number }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  // File aggregation can reparent a completed row; keep user choices by event ID.
  const [rowExpansions, setRowExpansions] = useState<Record<string, boolean>>({});
  const detailsId = useId();
  const notify = useNotifyRowLayoutChanged();
  const handleChildExpand = useCallback(() => { notify('block-group-expand'); setExpanded(true); }, [notify]);
  const { counts, outcome } = summarizeProcessPhase(phase.entries);
  // Real active/failed calls and child navigation anchors remain reachable.
  const important = (entry: ProcessPhase['entries'][number]) =>
    ['running', 'failed', 'stopped'].includes(entry.outcome)
    || Boolean(entry.block.tool && isSubagentContainerTool(entry.block.tool.name));
  const visible = expanded ? phase.entries : phase.entries.filter(important);
  const hasImportant = phase.entries.some(important);
  const previousVisibleCount = useRef(visible.length);
  useLayoutEffect(() => {
    if (previousVisibleCount.current !== visible.length) notify('tool-complete');
    previousVisibleCount.current = visible.length;
  }, [visible.length, notify]);
  const result = processPhaseResult(phase, t);

  return <section data-process-phase={phase.kind} data-phase-outcome={outcome}
    className="min-w-0 overflow-hidden rounded-lg bg-[var(--paper-inset)]/30">
    <button type="button" aria-expanded={expanded} aria-controls={detailsId}
      aria-label={t(expanded ? 'process.hideResults' : 'process.showResults', { count: phase.entries.length })}
      onClick={() => { notify(expanded ? 'block-group-collapse' : 'block-group-expand'); setExpanded(!expanded); }}
      className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]">
      <ChevronDownIcon aria-hidden="true" className={`mt-0.5 size-3.5 shrink-0 text-[var(--ink-muted)] transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-[var(--ink)]">{t(`process.heading.${phase.kind}`)}</span>
          <span className="text-xs tabular-nums text-[var(--ink-muted)]">{t('process.result.progress', { completed: counts.succeeded, total: phase.entries.length })}</span>
          {counts.running > 0 && <span className="text-xs text-[var(--accent)]">{t('process.summary.running', { count: counts.running })}</span>}
          {counts.failed > 0 && <span className="text-xs text-[var(--error)]">{t('process.summary.failed', { count: counts.failed })}</span>}
          {counts.stopped > 0 && <span className="text-xs text-[var(--warning)]">{t('process.summary.stopped', { count: counts.stopped })}</span>}
          {counts.unknown > 0 && <span className="text-xs text-[var(--ink-secondary)]">{t('process.summary.unknown', { count: counts.unknown })}</span>}
          {!hasImportant && <span className="ml-auto"><ProcessTiming blocks={phase.entries.map(entry => entry.block)} running={false} /></span>}
        </span>
        {!hasImportant && <span data-phase-result className="mt-0.5 block break-words text-sm text-[var(--ink-secondary)]">{result}</span>}
      </span>
      {!hasImportant && <span className="mt-0.5"><ProcessStatus outcome={outcome} compact={outcome === 'succeeded'} /></span>}
    </button>
    <div id={detailsId}>
      {groupProcessResults(visible).map(group => <div key={group.key}>
        {group.path && group.entries.length > 1 && <p className="border-t border-[var(--line-subtle)] px-4 pt-2 text-xs text-[var(--ink-secondary)] break-all">
          {group.path.replaceAll('\\', '/').split('/').at(-1)} · {t('process.result.updates', { count: group.entries.length })}
        </p>}
        {group.entries.map((entry, index) => <ProcessRow
          key={entry.block.id ?? entry.block.tool?.id ?? entry.index}
          block={entry.block} index={entry.index} totalBlocks={totalBlocks} isStreaming={live} onUserExpand={handleChildExpand}
          resultFirst resultLabel={group.entries.length > 1 ? t('process.result.updateNumber', { count: index + 1 }) : undefined}
          expandedOverride={rowExpansions[entry.block.id ?? entry.block.tool?.id ?? entry.index]}
          onExpansionChange={open => setRowExpansions(previous => ({ ...previous, [entry.block.id ?? entry.block.tool?.id ?? entry.index]: open }))}
        />)}
      </div>)}
    </div>
  </section>;
}

const BlockGroup = memo(function BlockGroup({ blocks, isStreaming = false }: BlockGroupProps) {
  const phases = buildProcessPhases(blocks, isStreaming);
  if (!phases.length) return null;
  return <div className="my-2 min-w-0 space-y-1 select-none" data-process-group>
    {phases.map(phase => <ProcessPhaseCard key={phase.key} phase={phase} live={isStreaming} totalBlocks={blocks.length} />)}
  </div>;
});
export default BlockGroup;
