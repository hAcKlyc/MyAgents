import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@/hooks/useConfig';
import { GridIcon, ListIcon, PlusIcon, SearchIcon } from '@/components/icons';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import { taskAppendSession, taskArchive, taskCreateDirect, taskUpdateStatus } from '@/api/taskCenter';
import { updateSession } from '@/api/sessionClient';
import { actions as sessionActions } from '@/hooks/taskCenterStore';
import { readBoardSessionActivity } from '@/features/project-board/activity';
import { formatTime, getFolderName } from '@/utils/taskCenterUtils';
import { useProjectBoardData } from '@/features/project-board/useProjectBoardData';
import { projectBoardRows, filterBoardRows, boardGoalState, boardRowStateKey, type BoardGroup, type BoardRow } from '@/features/project-board/projection';
import { useBoardOverlay } from '@/features/project-board/useBoardOverlay';
import SessionWorkProgress from '@/features/project-board/SessionWorkProgress';
import SessionExecutionTime from '@/features/project-board/SessionExecutionTime';
import ProjectBoardDetail from '@/features/project-board/ProjectBoardDetail';
import './ProjectBoard.css';

const GROUPS: BoardGroup[] = ['todo', 'running', 'needs', 'done'];

export default function ProjectBoard({ workspacePath, isActive = true }: { workspacePath: string; isActive?: boolean }) {
  const { t } = useTranslation('task');
  const { projects } = useConfig();
  const project = projects.find(p => workspacePathsEqual(p.path, workspacePath));
  const name = project?.displayName || project?.name || getFolderName(workspacePath);
  const overlay = useBoardOverlay();
  const searchRef = useRef<HTMLInputElement>(null);
  const focusFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);
  const data = useProjectBoardData(workspacePath, isActive);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [scope, setScope] = useState<'work' | 'history'>('work');
  const [organizingId, setOrganizingId] = useState<string | null>(null);
  const [organizingError, setOrganizingError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'needs' | 'todo'>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<BoardGroup>>(() => new Set(['todo', 'running', 'needs', 'done', 'archived']));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<ReadonlySet<BoardGroup>>(() => new Set(['idle']));
  const contentRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = contentRef.current; if (!el) return;
    const observer = new ResizeObserver(entries => setCompact(entries[0].contentRect.width <= 860));
    observer.observe(el); return () => observer.disconnect();
  }, []);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const rows = useMemo(() => projectBoardRows({ id: project?.id, path: workspacePath }, data.tasks, data.sessions, data.activity, data.now), [project?.id, workspacePath, data.tasks, data.sessions, data.activity, data.now]);
  const scopedRows = useMemo(() => rows.filter(r => scope === 'history' ? r.group === 'archived' : r.group !== 'archived'), [rows, scope]);
  const visible = useMemo(() => filterBoardRows(scopedRows, filter, query), [scopedRows, filter, query]);
  const selected = rows.find(r => r.id === selectedId);
  const groups = scope === 'history' ? ['archived'] as BoardGroup[] : filter === 'todo' ? ['todo'] as BoardGroup[] : filter === 'needs' ? ['needs'] as BoardGroup[] : GROUPS;
  const counts = Object.fromEntries([...GROUPS, 'idle', 'inactive', 'scheduled', 'archived'].map(g => [g, scopedRows.filter(r => r.group === g).length]));
  const needCount = rows.filter(r => r.group === 'needs').length;
  const observationFailures = [...data.activity.values()].filter(a => a.error).length;
  const unknownCount = scopedRows.filter(r => r.confirmationReason === 'unknown').length;

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => (selectedId ? rowRefs.current.get(selectedId) ?? searchRef.current : searchRef.current)?.focus({ preventScroll: true }));
  }, [selectedId]);
  const select = (row: BoardRow) => {
    setSelectedId(row.id);
    setExpanded(current => new Set([...current, row.group]));
  };
  const openSession = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
      detail: { sessionId, workspacePath, historyEntrySource: 'task_run_history' },
    }));
  }, [workspacePath]);

  function rowState(row: BoardRow): string { return t(boardRowStateKey(row, data.now)); }
  function canOrganize(row: BoardRow): boolean {
    return row.group === 'archived' || row.group === 'done' || !row.task && (row.group === 'idle' || row.group === 'inactive');
  }
  /** Recheck the actual owner before a user-requested archive or conversion. This read
   * neither starts nor stops an execution; concurrent activity stays visible. */
  async function assertSessionsIdle(sessionIds: readonly string[], busyKey: string) {
    for (let start = 0; start < sessionIds.length; start += 4) {
      const observations = await Promise.all(sessionIds.slice(start, start + 4).map(id => readBoardSessionActivity(id, workspacePath)));
      if (observations.some(a => a.state !== 'idle' || a.error || (boardGoalState(a, Date.now()) !== undefined && boardGoalState(a, Date.now()) !== 'complete'))) throw new Error(t(busyKey));
    }
  }
  function canConvert(row: BoardRow): boolean { return !row.task && row.group === 'idle' && row.sessions.length === 1; }
  /** An idle conversation with a deliverable becomes a real Task bound to the same Session,
   * so it can be run, verified and completed instead of staying a pool entry. */
  async function convertToTask(row: BoardRow) {
    const session = row.sessions[0];
    if (organizingId || !canConvert(row) || !session) return;
    setOrganizingId(row.id); setOrganizingError(null);
    let createdId: string | undefined;
    try {
      if (!project?.id) throw new Error(t('projectBoard.unavailable'));
      await assertSessionsIdle([session.id], 'projectBoard.convertBusy');
      const title = (session.title || t('projectBoard.conversation')).trim();
      const task = await taskCreateDirect({
        name: title.slice(0, 120), executor: 'agent', workspaceId: project.id, workspacePath,
        executionMode: 'once', runMode: 'single-session', preselectedSessionId: session.id,
        taskMdContent: t('projectBoard.convertTaskDoc', { title, summary: row.summary || t('projectBoard.noSummary') }),
      });
      createdId = task.id;
      await taskAppendSession(task.id, session.id);
      setSelectedId(`task:${task.id}`);
    } catch (error) {
      setOrganizingError(createdId ? `${t('projectBoard.convertLinkFailed')} ${String(error)}` : String(error));
    } finally { setOrganizingId(null); data.refresh(); }
  }
  async function organize(row: BoardRow) {
    if (organizingId || !canOrganize(row)) return;
    const restore = row.group === 'archived';
    setOrganizingId(row.id); setOrganizingError(null);
    try {
      if (!restore) await assertSessionsIdle([...new Set(row.task?.sessionIds ?? row.sessions.map(s => s.id))], 'projectBoard.archiveBusy');
      if (row.task) {
        if (restore) await taskUpdateStatus({ id: row.task.id, status: 'done' });
        else await taskArchive(row.task.id);
      } else {
        const session = row.sessions[0];
        if (!session) throw new Error(t('projectBoard.unavailable'));
        const sequence = sessionActions.beginSessionMetadataMutation(session.id);
        const next = await updateSession(session.id, { archived: !restore });
        if (!next) throw new Error(t('projectBoard.unavailable'));
        sessionActions.applySessionMetadata(next, sequence);
      }
      setSelectedId(null); data.refresh();
    } catch (error) { setOrganizingError(String(error)); }
    finally { setOrganizingId(null); }
  }

  function card(row: BoardRow) {
    return <article key={row.id} className={`pb-card ${row.id === selectedId ? 'selected' : ''}`}>
      <button type="button" ref={node => { if (node) rowRefs.current.set(row.id, node); else rowRefs.current.delete(row.id); }}
        className="pb-card-main" onClick={() => select(row)}
        aria-label={`${row.title} · ${rowState(row)}`} aria-pressed={row.id === selectedId} data-board-row={row.id}>
        <div className="pb-card-kind">{t(row.task ? 'projectBoard.task' : 'projectBoard.conversation')}</div>
        <h3>{row.title}</h3>
        <p className="pb-card-summary" title={row.summary}>{row.summary || t('projectBoard.noSummary')}</p>
        <div className={`pb-badge ${row.group}`}>{rowState(row)}</div>
        {row.confirmationReason === 'unknown' && row.activity?.state && <p className="pb-meta">{t('projectBoard.lastKnown', { state: t(row.activity.state === 'running' ? 'projectBoard.running' : row.activity.state === 'waiting_user_action' ? 'projectBoard.waiting' : 'projectBoard.idle') })}</p>}
      </button>
      <SessionWorkProgress snapshot={row.activity} now={data.now} />
      <SessionExecutionTime snapshot={row.activity} now={data.now} />
      <time className="pb-card-updated" dateTime={new Date(row.updatedAt).toISOString()} title={new Date(row.updatedAt).toLocaleString()}>
        {t('projectBoard.updated')} {formatTime(new Date(row.updatedAt).toISOString())}
      </time>
      <div className="pb-card-bottom">
        <button type="button" className="pb-card-action" onClick={() => select(row)}>{t(row.confirmationReason === 'verification' ? 'projectBoard.inspect' : row.group === 'needs' ? 'projectBoard.handle' : 'projectBoard.details')} ↗</button>
        {canConvert(row) && <button type="button" className="pb-card-action" disabled={!!organizingId} title={t('projectBoard.convertHint')} onClick={() => { void convertToTask(row); }}>{t('projectBoard.convert')}</button>}
        {canOrganize(row) && <button type="button" className="pb-card-action" disabled={!!organizingId} title={row.group === 'archived' ? undefined : t('projectBoard.archiveHint')} onClick={() => { void organize(row); }}>{t(row.group === 'archived' ? 'projectBoard.restore' : 'projectBoard.archive')}</button>}
        {row.sessions.length === 1 && <button type="button" className="pb-card-action pb-enter-session" onClick={() => openSession(row.sessions[0].id)} aria-label={t('projectBoard.enterSessionFor', { title: row.sessions[0].title })}>{t('projectBoard.enterSession')} ↗</button>}
      </div>
    </article>;
  }

  const auxiliaryGroups = (['scheduled', 'idle', 'inactive'] as const).map(group => ({ group, rows: visible.filter(r => r.group === group) }));
  return <section className="project-board" aria-label={t('projectBoard.title')} data-project-board={workspacePath}>
    <header className="pb-header"><div><h1>{name}</h1><div className="pb-meta">{scope === 'history' ? t('projectBoard.historyOverview', { total: scopedRows.length }) : t('projectBoard.overview', { total: scopedRows.length, needs: needCount })}</div></div>
      <div className="pb-actions"><button type="button" className="pb-button" onClick={data.refresh} disabled={data.checking}>{t(data.checking ? 'projectBoard.checking' : 'projectBoard.refresh')}</button>
        <button type="button" className="pb-button primary" onClick={() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CREATE, { detail: { initialMode: 'manual', source: 'task-center', defaultWorkspacePath: workspacePath } }))}><PlusIcon className="h-4 w-4" />{t('projectBoard.create')}</button></div>
    </header>
    <nav className="pb-scope-tabs" aria-label={t('projectBoard.scopeLabel')}>
      {(['work', 'history'] as const).map(value => <button type="button" key={value} className="pb-scope-tab" aria-pressed={scope === value}
        onClick={() => { setScope(value); setFilter('all'); setSelectedId(null); }}>
        {t(`projectBoard.scopes.${value}`)} <span className="count">{rows.filter(r => value === 'history' ? r.group === 'archived' : r.group !== 'archived').length}</span>
      </button>)}
    </nav>
    <div className="pb-controls"><div className="pb-control-left"><button type="button" className="pb-button" aria-pressed={view === 'board'} onClick={() => setView('board')}><GridIcon className="h-4 w-4" />{t('projectBoard.board')}</button>
      <button type="button" className="pb-button" aria-pressed={view === 'list'} onClick={() => setView('list')}><ListIcon className="h-4 w-4" />{t('projectBoard.list')}</button>
      {(scope === 'work' ? ['all', 'needs'] as const : ['all'] as const).map(f => <button type="button" key={f} className="pb-button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{t(`projectBoard.filter.${f}`)}{f === 'needs' ? ` ${needCount}` : ''}</button>)}</div>
      <label className="pb-search"><SearchIcon className="h-4 w-4 text-[var(--ink-muted)]" /><input ref={searchRef} type="search" aria-label={t('projectBoard.search')} placeholder={t('projectBoard.search')} value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    {organizingError && <div className="pb-error" role="alert">{organizingError}</div>}
    {!!observationFailures && <div className="pb-error" role="alert">{t('projectBoard.observationFailed', {count: observationFailures})}</div>}
    {data.taskError && <div className="pb-error" role="alert">{t('projectBoard.taskError')} {data.taskError}</div>}
    {data.sessionError && <div className="pb-error" role="alert">{t('projectBoard.sessionError')} {data.sessionError}</div>}
    <div className="pb-work"><div className="pb-content" ref={contentRef} inert={overlay && !!selected}><div className="pb-status-strip">{groups.map(g => <span key={g}>{t(`projectBoard.groups.${g}`)} {counts[g]}</span>)}</div>
      <div className="pb-scroll">
        {scope === 'history' && <p className="pb-history-hint">{t('projectBoard.historyHint')}</p>}
        {data.tasksLoading || data.sessionsLoading ? <div className="pb-meta" role="status">{t('projectBoard.loading')}</div> : null}
        {!visible.length && !data.tasksLoading && !data.sessionsLoading ? <div className="pb-empty">{t(scope === 'history' ? 'projectBoard.historyEmpty' : scopedRows.length ? 'projectBoard.noMatch' : 'projectBoard.empty')}<br />{t('projectBoard.emptyHint')}</div>
        : view === 'board' ? <>
          <div className="pb-columns" style={groups.length < 4 ? { gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` } : undefined}>
            {groups.map(g => <section key={g} className={`pb-column ${expanded.has(g) ? 'expanded' : ''}`} data-group={g} aria-label={t(`projectBoard.groups.${g}`)}>
              <button type="button" className="pb-column-head" aria-expanded={compact ? expanded.has(g) : true} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(g)) next.delete(g); else next.add(g); return next; })}>
                <span>{t(`projectBoard.groups.${g}`)}</span><span className="count">{visible.filter(r => r.group === g).length}</span><span className="chevron" aria-hidden="true">›</span></button>
              <div className="pb-cards">{visible.filter(r => r.group === g).map(card)}{!visible.some(r => r.group === g) && <div className="pb-column-empty">{t('projectBoard.groupEmpty')}</div>}</div>
            </section>)}
          </div>
          {scope === 'work' && filter === 'all' && auxiliaryGroups.map(({group, rows: extraRows}) => !!extraRows.length && <details key={group} className="pb-other" open={otherOpen.has(group)} onToggle={e => { const open = e.currentTarget.open; setOtherOpen(current => { const next = new Set(current); if (open) next.add(group); else next.delete(group); return next; }); }}><summary>{t(`projectBoard.groups.${group}`)} · {extraRows.length}</summary>
            <p className="pb-meta">{t(`projectBoard.${group}Hint`)}</p><div className="pb-other-grid">{extraRows.map(card)}</div></details>)}
        </> : <div className="pb-table-wrap"><table className="pb-table"><thead><tr><th>{t('projectBoard.task')}</th><th>{t('projectBoard.status')}</th><th className="summary-col">{t('projectBoard.summary')}</th><th className="time-col">{t('projectBoard.updated')}</th><th>{t('projectBoard.action')}</th></tr></thead>
          <tbody>{visible.map(row => <tr key={row.id}><td><button type="button" ref={node => { if (node) rowRefs.current.set(row.id, node); else rowRefs.current.delete(row.id); }} className="title-button" onClick={() => select(row)}>{row.title}</button><div className="pb-meta">{t(row.task ? 'projectBoard.task' : 'projectBoard.conversation')}</div><SessionWorkProgress snapshot={row.activity} now={data.now} /></td><td><span className={`pb-badge ${row.group}`}>{rowState(row)}</span><SessionExecutionTime snapshot={row.activity} now={data.now} /></td><td className="summary-col summary">{row.summary}</td><td className="time-col pb-meta">{formatTime(new Date(row.updatedAt).toISOString())}</td><td><button type="button" className="pb-button" onClick={() => select(row)}>{t('projectBoard.details')}</button>{canConvert(row) && <button type="button" className="pb-card-action" disabled={!!organizingId} title={t('projectBoard.convertHint')} onClick={() => { void convertToTask(row); }}>{t('projectBoard.convert')}</button>}{canOrganize(row) && <button type="button" className="pb-card-action" disabled={!!organizingId} title={row.group === 'archived' ? undefined : t('projectBoard.archiveHint')} onClick={() => { void organize(row); }}>{t(row.group === 'archived' ? 'projectBoard.restore' : 'projectBoard.archive')}</button>}{row.sessions.length === 1 && <button type="button" className="pb-card-action pb-enter-session" onClick={() => openSession(row.sessions[0].id)} aria-label={t('projectBoard.enterSessionFor', { title: row.sessions[0].title })}>{t('projectBoard.enterSession')} ↗</button>}</td></tr>)}</tbody></table></div>}
      </div>
      <footer className="pb-footer"><span>{data.checkedAt ? t('projectBoard.snapshotAt', { time: formatTime(new Date(data.checkedAt).toISOString()) }) : t('projectBoard.snapshotPending')}{unknownCount ? ` · ${t('projectBoard.unknownCount', { count: unknownCount })}` : ''}</span>
        <span>{data.unobservedCount ? t('projectBoard.boundedSnapshot', { count: data.unobservedCount }) : t('projectBoard.snapshotHint')}</span></footer>
    </div>
      {selected && <ProjectBoardDetail key={selected.id} row={selected} workspacePath={workspacePath} isActive={isActive} now={data.now}
        draft={drafts[selected.id] ?? ''} onDraftChange={value => setDrafts(current => ({ ...current, [selected.id]: value }))}
        onOrganize={canOrganize(selected) ? () => { void organize(selected); } : undefined} onConvert={canConvert(selected) ? () => { void convertToTask(selected); } : undefined} organizing={!!organizingId}
        onClose={closeDetail} onOpenSession={openSession} onChanged={data.refresh} />}
    </div>
  </section>;
}
