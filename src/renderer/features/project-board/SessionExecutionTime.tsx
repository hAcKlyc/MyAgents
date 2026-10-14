import { useTranslation } from 'react-i18next';
import { sessionExecutionTime, type ActivitySnapshot } from './projection';

export default function SessionExecutionTime({ snapshot, now }: { snapshot?: ActivitySnapshot; now: number }) {
  const { t } = useTranslation('task');
  const timing = sessionExecutionTime(snapshot, now);
  if (!timing) return snapshot && !snapshot.error && (snapshot.state === 'running' || snapshot.state === 'waiting_user_action')
    ? <div className="pb-execution-time">{t('projectBoard.durationUnavailable')}</div> : null;
  const seconds = Math.floor(timing.elapsedMs / 1000);
  const values = { hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds / 60) % 60, seconds: seconds % 60 };
  const duration = t(values.hours ? 'projectBoard.durationHours' : 'projectBoard.durationMinutes', values);
  return <div className="pb-execution-time" title={t(timing.stale ? 'projectBoard.durationStaleHint' : 'projectBoard.durationHint', { start: new Date(timing.startedAt).toLocaleString() })}>
    {t(timing.stale ? 'projectBoard.snapshotDuration' : 'projectBoard.executionDuration', { duration })}
    {timing.stale && <span className="pb-duration-stale"> · {t('projectBoard.durationRefresh')}</span>}
  </div>;
}
