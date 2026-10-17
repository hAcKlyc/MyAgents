import { CheckIcon, CircleDotIcon, LoaderIcon, StopCircleIcon, XCircleIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import type { ProcessOutcome } from '@/utils/processPresentation';

export const processStatusClass: Record<ProcessOutcome, string> = {
  running: 'text-[var(--accent)]',
  succeeded: 'text-[var(--success)]',
  failed: 'text-[var(--error)]',
  stopped: 'text-[var(--warning)]',
  unknown: 'text-[var(--ink-secondary)]',
};

export default function ProcessStatus({ outcome, compact = false }: { outcome: ProcessOutcome; compact?: boolean }) {
  const { t } = useTranslation('chat');
  const Icon = outcome === 'running' ? LoaderIcon : outcome === 'succeeded' ? CheckIcon
    : outcome === 'failed' ? XCircleIcon : outcome === 'stopped' ? StopCircleIcon : CircleDotIcon;
  return <span data-process-status={outcome} title={compact ? t(`process.status.${outcome}`) : undefined} className={`inline-flex shrink-0 items-center gap-1 text-xs ${compact && outcome === 'succeeded' ? 'text-[var(--ink-muted)]' : processStatusClass[outcome]}`}>
    <Icon aria-hidden="true" className={`size-3.5 ${outcome === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`} />
    <span className={compact ? 'sr-only' : undefined}>{t(`process.status.${outcome}`)}</span>
  </span>;
}
