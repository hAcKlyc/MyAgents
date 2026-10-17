import { useTranslation } from 'react-i18next';
import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import type { Message } from '@/types/chat';
import { executionEvidence } from '@/utils/processResults';

/** Observed evidence, not a subjective model score or business acceptance. */
export default function ExecutionQuality({ message, live = false }: { message: Message; live?: boolean }) {
  const { t } = useTranslation('chat');
  const notify = useNotifyRowLayoutChanged();
  const blocks = typeof message.content === 'string' ? [] : message.content;
  if (!blocks.some(block => block.tool) && !message.usage) return null;
  const evidence = executionEvidence(blocks, live);
  const usage = message.usage;
  return <details data-execution-quality className="mx-3 my-1 text-xs text-[var(--ink-muted)]"
    onToggle={() => notify('process-row-expand')}>
    <summary className="w-fit cursor-pointer rounded py-1 focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
      {t('process.quality.label')}
      {(evidence.failed > 0 || evidence.stopped > 0 || evidence.unknown > 0) && <> · {t('process.quality.attention')}</>}
    </summary>
    <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words pb-2 text-[var(--ink-secondary)]">
      <dt>{t('process.quality.checks')}</dt><dd>{t('process.quality.checkCounts', { returned: evidence.checksReturned, failed: evidence.checksFailed })}</dd>
      <dt>{t('process.quality.execution')}</dt><dd>{t('process.quality.executionCounts', evidence)}</dd>
      {usage && <><dt>Token</dt><dd>{t('process.quality.tokens', { input: usage.inputTokens, output: usage.outputTokens })}</dd></>}
      {usage?.model && <><dt>{t('process.quality.model')}</dt><dd>{usage.model}</dd></>}
      <dt>{t('process.quality.content')}</dt><dd>{t('process.quality.notAssessed')}</dd>
    </dl>
    <p className="max-w-prose pb-2">{t('process.quality.scope')}</p>
  </details>;
}
