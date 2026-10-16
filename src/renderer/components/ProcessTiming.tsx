import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContentBlock } from '@/types/chat';
import { preciseDuration, summarizeProcessTiming } from '@/utils/processTiming';

export default function ProcessTiming({ blocks, running }: { blocks: ContentBlock[]; running: boolean }) {
  const { t, i18n } = useTranslation('chat');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const timing = summarizeProcessTiming(blocks, running, now);
  const formatTime = (value: number) => new Date(value).toLocaleTimeString(i18n.language, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const exactTime = (value: number) => new Date(value).toLocaleString(i18n.language, { hour12: false });
  return <span data-process-timing className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-[var(--ink-muted)]">
    {timing.startedAt !== undefined
      ? <time dateTime={new Date(timing.startedAt).toISOString()} title={`${t('process.timing.start')} ${exactTime(timing.startedAt)} · ${t(`process.timing.${timing.source}`)}`}>
        {formatTime(timing.startedAt)}{timing.finishedAt !== undefined && <>–{formatTime(timing.finishedAt)}</>}
      </time> : <span>{t('process.timing.unrecorded')}</span>}
    {timing.durationMs !== undefined && <span>{t(running ? 'process.timing.elapsed' : 'process.timing.duration', { time: preciseDuration(timing.durationMs) })}</span>}
    {running && timing.lastActivityAt !== undefined && <span data-last-activity>
      {t('process.timing.activity', { time: formatTime(timing.lastActivityAt) })}
      {now >= timing.lastActivityAt && <> · {t('process.timing.sinceActivity', { time: preciseDuration(now - timing.lastActivityAt) })}</>}
    </span>}
  </span>;
}
