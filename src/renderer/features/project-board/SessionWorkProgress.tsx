import { useTranslation } from 'react-i18next';
import { freshActivity, type ActivitySnapshot } from './projection';
import { TodoCompletedIcon, TodoInProgressIcon, TodoPendingIcon } from '@/components/agent-status/icons';

export default function SessionWorkProgress({ snapshot, now, full = false, sessionTitle }: {
  snapshot?: ActivitySnapshot; now: number; full?: boolean; sessionTitle?: string;
}) {
  const { t } = useTranslation('task');
  const progress = snapshot?.progress;
  if (!progress) return full ? <p className="pb-detail-note">{t('projectBoard.progressUnavailable')}</p> : null;
  const stale = !freshActivity(snapshot, now);
  const active = !stale && progress.source === 'live' && snapshot?.state !== 'idle';
  const current = progress.todos.find(todo => todo.status === 'in_progress');
  if (!full && progress.todoTotal === 0 && progress.agentTotal === 0) return null;
  return <section className={`pb-work-progress ${full ? 'full' : 'compact'}`} aria-label={t('projectBoard.workProgress')}>
    {full && <h3>{t('projectBoard.workProgress')}</h3>}
    {full && sessionTitle && <p className="pb-meta">{t('projectBoard.progressSession', { title: sessionTitle })}</p>}
    {progress.todoSource !== 'none' && <>
      <div className="pb-progress-heading"><span>{t('projectBoard.todoProgress', { completed: progress.todoCompleted, total: progress.todoTotal })}</span>
        {stale && <span className="pb-duration-stale">{t('projectBoard.progressSnapshot')}</span>}
      </div>
      {progress.todoTotal > 0 && <progress aria-label={t('projectBoard.todoProgress', { completed: progress.todoCompleted, total: progress.todoTotal })} max={progress.todoTotal} value={progress.todoCompleted} />}
      {!full && current && <p className="pb-current-step" title={current.content}>{t(active ? 'projectBoard.currentStep' : 'projectBoard.unfinishedStep', { step: active ? current.activeForm || current.content : current.content })}</p>}
      {full && <ul className="pb-progress-todos">{progress.todos.map(todo => <li key={todo.key} data-todo-status={todo.status}>
        <span aria-hidden="true">{todo.status === 'completed' ? <TodoCompletedIcon /> : todo.status === 'in_progress' ? <TodoInProgressIcon /> : <TodoPendingIcon />}</span>
        <span className="pb-todo-content">{todo.content}</span><span className="pb-meta">{t(`projectBoard.todoStates.${todo.status}`)}</span>
      </li>)}</ul>}
      {full && progress.todoTotal > progress.todos.length && <p className="pb-meta">{t('projectBoard.progressLimited', { shown: progress.todos.length, total: progress.todoTotal })}</p>}
    </>}
    {full && progress.todoSource === 'none' && <p className="pb-meta">{t('projectBoard.noTodoProgress')}</p>}
    {progress.agentTotal > 0 && <>
      <div className="pb-progress-heading"><span>{t(stale ? 'projectBoard.agentsSnapshot' : 'projectBoard.agentsProgress', { running: progress.agentRunning, total: progress.agentTotal })}</span></div>
      {full && <ul className="pb-progress-agents">{progress.agents.map(agent => {
        const status = agent.status === 'running' && stale ? 'lastRunning' : agent.status;
        const end = agent.status === 'running' && !stale ? now : agent.finishedAt ?? snapshot?.checkedAt ?? now;
        const seconds = agent.startedAt === undefined ? undefined : Math.max(0, Math.floor((end - agent.startedAt) / 1000));
        return <li key={agent.id} data-agent-status={status}><div className="pb-progress-agent-head"><strong>{agent.agentType}</strong>
          {agent.background && <span className="pb-agent-mode">{t('projectBoard.backgroundAgent')}</span>}<span>{t(`projectBoard.agentStates.${status}`)}</span></div>
          {agent.description && <p>{agent.description}</p>}
          {seconds !== undefined && <span className="pb-meta">{t(stale && agent.status === 'running' ? 'projectBoard.agentSnapshotDuration' : 'projectBoard.agentDuration', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })}</span>}
        </li>;
      })}</ul>}
      {full && progress.agentTotal > progress.agents.length && <p className="pb-meta">{t('projectBoard.progressLimited', { shown: progress.agents.length, total: progress.agentTotal })}</p>}
    </>}
    {full && <p className="pb-meta">{t(progress.source === 'history' ? 'projectBoard.progressHistoryHint' : 'projectBoard.progressHint')}</p>}
  </section>;
}
