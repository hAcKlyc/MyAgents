import SessionWorkProgress from './SessionWorkProgress';
import SessionExecutionTime from './SessionExecutionTime';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { taskGet, taskRun, taskRerun, taskUpdateStatus } from '@/api/taskCenter';
import { TaskDocBlock } from '@/components/task-center/TaskDocBlock';
import { CloseIcon } from '@/components/icons';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { isImeComposingEvent } from '@/utils/imeKeyboard';
import { formatTime } from '@/utils/taskCenterUtils';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import type { Task } from '@/../shared/types/task';
import { useBoardOverlay } from './useBoardOverlay';
import { boardRowStateKey, type BoardRow } from './projection';

interface Props {
  row: BoardRow; workspacePath: string; isActive: boolean; now: number;
  draft: string; onDraftChange: (value: string) => void;
  onClose: () => void; onOpenSession: (id: string) => void; onChanged: () => void;
  onOrganize?: () => void; onConvert?: () => void; organizing?: boolean;
}

export default function ProjectBoardDetail({ row, workspacePath, isActive, now, draft, onDraftChange, onClose, onOpenSession, onChanged, onOrganize, onConvert, organizing = false }: Props) {
  const overlay = useBoardOverlay();
  const panel = useRef<HTMLElement>(null);
  const { t } = useTranslation('task');
  const [section, setSection] = useState<'overview' | 'history' | 'artifacts'>('overview');
  const [detail, setDetail] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!row.task);
  const mounted = useRef(false);
  const readGeneration = useRef(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const taskId = row.task?.id;
  const taskUpdatedAt = row.task?.updatedAt;
  const task = detail ?? row.task;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (isActive) closeButton.current?.focus({ preventScroll: true }); }, [isActive]);
  useEffect(() => {
    if (!taskId || !isActive) return;
    let cancelled = false;
    const generation = ++readGeneration.current;
    void taskGet(taskId).then(next => {
      if (cancelled || generation !== readGeneration.current) return;
      if (!next || next.deleted || next.status === 'deleted' || (next.workspacePath && !workspacePathsEqual(next.workspacePath, workspacePath))) throw new Error(t('projectBoard.unavailable'));
      setDetail(next); setLoaded(true); setError(null);
    }).catch(e => { if (!cancelled && generation === readGeneration.current) { setError(String(e)); setLoaded(false); } });
    return () => { cancelled = true; };
  }, [taskId, taskUpdatedAt, isActive, workspacePath, t]);
  useCloseLayer(() => { if (!isActive || busy) return false; onClose(); return true; }, 20);
  useEffect(() => {
    if (!isActive) return;
    const handleKey = (event: KeyboardEvent) => {
      if (overlay && event.key === 'Tab' && panel.current) {
        const controls = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')).filter(el => el.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if (event.key === 'Escape' && !isImeComposingEvent(event) && !busy && !event.defaultPrevented) { event.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isActive, busy, onClose, overlay]);
  const onDocError = useCallback((message: string) => setError(message), []);
  async function act(kind: 'run' | 'rerun' | 'done') {
    if (!task || busy || organizing || !loaded || task.executionState) return;
    readGeneration.current += 1;
    setBusy(true); setError(null);
    try {
      if (kind === 'done') await taskUpdateStatus({ id: task.id, status: 'done', message: draft.trim() || undefined });
      else if (kind === 'run') await taskRun(task.id);
      else await taskRerun(task.id);
      const next = await taskGet(task.id);
      if (!next) throw new Error(t('projectBoard.unavailable'));
      if (mounted.current) { setDetail(next); if (kind === 'done') onDraftChange(''); onChanged(); }
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const sessionIds = task ? task.sessionIds : row.sessions.map(s => s.id);
  const canRerun = row.group !== 'running' && (!row.confirmationReason || ['blocked', 'stopped'].includes(row.confirmationReason)) && task && task.executor === 'agent' && ['blocked', 'stopped', 'done'].includes(task.status);
  return <aside ref={panel} className="pb-detail" aria-label={t('projectBoard.details')}>
    <div className="pb-detail-head"><div><div className="pb-meta">{t(row.task ? 'projectBoard.task' : 'projectBoard.conversation')}</div><h2>{row.title}</h2></div>
      <button ref={closeButton} type="button" className="pb-button" aria-label={t('projectBoard.close')} onClick={onClose} disabled={busy}><CloseIcon className="h-4 w-4" /></button></div>
    <nav className="pb-detail-tabs" aria-label={t('projectBoard.details')}>{(['overview', 'history', 'artifacts'] as const).map(s => <button type="button" key={s} className="pb-detail-tab" aria-pressed={section === s} onClick={() => setSection(s)}>{t(`projectBoard.detailTabs.${s}`)}</button>)}</nav>
    {row.activity?.error && <div className="pb-error" role="alert">{t('projectBoard.observationError')} {row.activity.error}</div>}
    {error && <div className="pb-error" role="alert">{error}</div>}
    <div className="pb-detail-scroll">
      {taskId && !loaded && !error && <div role="status" className="pb-meta">{t('projectBoard.loading')}</div>}
      {section === 'overview' && <>
        <section className="pb-detail-section"><h3>{t('projectBoard.status')}</h3><p>{t(boardRowStateKey(row, now))}</p>
          {task?.executionState && <p>{t(`badges.execution.${task.executionState}`)}</p>}
          {task && task.executionMode !== 'once' && <div className="pb-detail-note">{t('projectBoard.scheduleHint')}</div>}
          {(task?.executionError || task?.lastExecution?.error) && <div className="pb-error">{task.executionError || task.lastExecution?.error}</div>}
        </section>
        <SessionExecutionTime snapshot={row.activity} now={now} />
        <SessionWorkProgress snapshot={row.activity} now={now} full sessionTitle={row.sessions.find(s => s.id === row.activitySessionId)?.title} />
        <section className="pb-detail-section"><h3>{t('projectBoard.summary')}</h3><p>{task?.description || row.summary || t('projectBoard.noSummary')}</p></section>
        <div className="pb-detail-note">{t('projectBoard.originalHint')}</div>
      </>}
      {section === 'history' && <>
        {task?.lastExecution && <section className="pb-detail-section"><h3>{t('projectBoard.lastExecution')}</h3><p>{t(task.lastExecution.success ? 'projectBoard.executionSucceeded' : 'projectBoard.executionFailed')}</p><time className="pb-meta">{formatTime(new Date(task.lastExecution.at).toISOString())}</time></section>}
        {task?.statusHistory.length ? [...task.statusHistory].reverse().map((entry, index) => <div key={`${entry.at}-${index}`} className="pb-history-entry"><time>{formatTime(new Date(entry.at).toISOString())}</time>{t(`badges.status.${entry.to}`)} · {entry.actor}{entry.message && <p>{entry.message}</p>}</div>) : <p className="pb-detail-note">{t('projectBoard.noHistory')}</p>}
      </>}
      {section === 'artifacts' && <>
        <div className="pb-detail-note">{t('projectBoard.acceptanceHint')}</div>
        {task && loaded ? <section className="pb-detail-section"><h3>{t('projectBoard.taskDocument')}</h3><TaskDocBlock task={task} doc="task" emptyHint={t('projectBoard.noDocument')} reloadKey={task.updatedAt} onError={onDocError} />
          {task.docs?.verifyMd && <TaskDocBlock task={task} doc="verify" emptyHint={t('projectBoard.noDocument')} onError={onDocError} />}
          {task.docs?.progressMd && <TaskDocBlock task={task} doc="progress" emptyHint={t('projectBoard.noDocument')} onError={onDocError} />}</section> : !task && <p className="pb-meta">{t('projectBoard.sessionArtifactsHint')}</p>}
        {task?.status === 'verifying' && <label className="pb-detail-section"><span className="pb-meta">{t('projectBoard.acceptanceNote')}</span><textarea aria-label={t('projectBoard.acceptanceNote')} value={draft} onChange={e => onDraftChange(e.target.value)} disabled={busy} /></label>}
      </>}
      <section className="pb-detail-section"><h3>{t('projectBoard.originalSession')}</h3>{sessionIds.length ? sessionIds.map(id => <button type="button" className="pb-session-link" key={id} onClick={() => onOpenSession(id)}>{row.sessions.find(s => s.id === id)?.title || t('projectBoard.originalSession')}<small>{t('projectBoard.openSession')}</small></button>) : <p className="pb-detail-note">{t('projectBoard.noSession')}</p>}</section>
    </div>
    {(task || onOrganize || onConvert) && <div className="pb-detail-actions">
      {onConvert && <button className="pb-button primary" type="button" disabled={busy || organizing} title={t('projectBoard.convertHint')} onClick={onConvert}>{t('projectBoard.convert')}</button>}
      {onOrganize && <button className="pb-button" type="button" disabled={busy || !loaded || organizing} title={row.group === 'archived' ? undefined : t('projectBoard.archiveHint')} onClick={onOrganize}>{t(row.group === 'archived' ? 'projectBoard.restore' : 'projectBoard.archive')}</button>}
      {task?.executor === 'agent' && task.status === 'todo' && row.group === 'todo' && <button className="pb-button primary" type="button" disabled={busy || organizing || !loaded || !!task.executionState} onClick={() => { void act('run'); }}>{t('projectBoard.run')}</button>}
      {canRerun && <button className="pb-button" type="button" disabled={busy || organizing || !loaded || !!task.executionState} onClick={() => { void act('rerun'); }}>{t('projectBoard.rerun')}</button>}
      {task?.status === 'verifying' && row.confirmationReason === 'verification' && <button className="pb-button primary" type="button" disabled={busy || organizing || !loaded || !!task.executionState} onClick={() => { if (section !== 'artifacts') setSection('artifacts'); else void act('done'); }}>{t(section === 'artifacts' ? 'projectBoard.accept' : 'projectBoard.inspect')}</button>}
      {busy && <span className="pb-meta" role="status">{t('projectBoard.processing')}</span>}
    </div>}
  </aside>;
}
