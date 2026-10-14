import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@/hooks/useConfig';
import { GridIcon, ListIcon, PlusIcon, SearchIcon } from '@/components/icons';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import { formatTime, getFolderName } from '@/utils/taskCenterUtils';
import { useProjectBoardData } from '@/features/project-board/useProjectBoardData';
import { projectBoardRows, filterBoardRows, freshActivity, type BoardGroup, type BoardRow } from '@/features/project-board/projection';
import { useBoardOverlay } from '@/features/project-board/useBoardOverlay';
import SessionExecutionTime from '@/features/project-board/SessionExecutionTime';
import ProjectBoardDetail from '@/features/project-board/ProjectBoardDetail';
import './ProjectBoard.css';

const GROUPS: BoardGroup[] = ['running', 'needs', 'verifying', 'done'];

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
  const [filter, setFilter] = useState<'all' | 'needs' | 'todo'>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<BoardGroup>>(() => new Set(['needs']));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState(false);
  const [todoOpen, setTodoOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = contentRef.current; if (!el) return;
    const observer = new ResizeObserver(entries => setCompact(entries[0].contentRect.width <= 860));
    observer.observe(el); return () => observer.disconnect();
  }, []);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const rows = useMemo(() => projectBoardRows({ id: project?.id, path: workspacePath }, data.tasks, data.sessions, data.activity, data.now), [project?.id, workspacePath, data.tasks, data.sessions, data.activity, data.now]);
  const visible = useMemo(() => filterBoardRows(rows, filter, query), [rows, filter, query]);
  const selected = rows.find(r => r.id === selectedId);
  const groups = filter === 'todo' ? ['todo'] as BoardGroup[] : filter === 'needs' ? ['needs', 'verifying'] as BoardGroup[] : GROUPS;
  const counts = Object.fromEntries([...GROUPS, 'todo', 'other'].map(g => [g, rows.filter(r => r.group === g).length]));
  const needCount = counts.needs + counts.verifying;
  const observationFailures = [...data.activity.values()].filter(a => a.error).length;
  const unknownCount = rows.filter(r => !r.task && !freshActivity(r.activity, data.now)).length;

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

  function rowState(row: BoardRow): string {
    if (freshActivity(row.activity, data.now) === 'waiting_user_action') return t('projectBoard.waiting');
    if (row.task?.executionState) return t(`badges.execution.${row.task.executionState}`);
    if (row.task?.status === 'running' && row.task.executionMode !== 'once') return t('projectBoard.awaitingTrigger');
    if (row.task) return t(`badges.status.${row.task.status}`);
    return t(freshActivity(row.activity, data.now) === 'idle' ? 'projectBoard.idle' : row.group === 'running' ? 'projectBoard.running' : 'projectBoard.unknown');
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
      </button>
      <SessionExecutionTime snapshot={row.activity} now={data.now} />
      <time className="pb-card-updated" dateTime={new Date(row.updatedAt).toISOString()} title={new Date(row.updatedAt).toLocaleString()}>
        {t('projectBoard.updated')} {formatTime(new Date(row.updatedAt).toISOString())}
      </time>
      <div className="pb-card-bottom">
        <button type="button" className="pb-card-action" onClick={() => select(row)}>{t(row.group === 'verifying' ? 'projectBoard.inspect' : row.group === 'needs' ? 'projectBoard.handle' : 'projectBoard.details')} ↗</button>
        {row.sessions.length === 1 && <button type="button" className="pb-card-action pb-enter-session" onClick={() => openSession(row.sessions[0].id)} aria-label={t('projectBoard.enterSessionFor', { title: row.sessions[0].title })}>{t('projectBoard.enterSession')} ↗</button>}
      </div>
    </article>;
  }

  const other = visible.filter(r => r.group === 'other');
  return <section className="project-board" aria-label={t('projectBoard.title')} data-project-board={workspacePath}>
    <header className="pb-header"><div><h1>{name}</h1><div className="pb-meta">{t('projectBoard.overview', { total: rows.length, needs: needCount })}</div></div>
      <div className="pb-actions"><button type="button" className="pb-button" onClick={data.refresh} disabled={data.checking}>{t(data.checking ? 'projectBoard.checking' : 'projectBoard.refresh')}</button>
        <button type="button" className="pb-button primary" onClick={() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CREATE, { detail: { initialMode: 'manual', source: 'task-center', defaultWorkspacePath: workspacePath } }))}><PlusIcon className="h-4 w-4" />{t('projectBoard.create')}</button></div>
    </header>
    <div className="pb-controls"><div className="pb-control-left"><button type="button" className="pb-button" aria-pressed={view === 'board'} onClick={() => setView('board')}><GridIcon className="h-4 w-4" />{t('projectBoard.board')}</button>
      <button type="button" className="pb-button" aria-pressed={view === 'list'} onClick={() => setView('list')}><ListIcon className="h-4 w-4" />{t('projectBoard.list')}</button>
      {(['all', 'needs', 'todo'] as const).map(f => <button type="button" key={f} className="pb-button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{t(`projectBoard.filter.${f}`)}{f === 'needs' ? ` ${needCount}` : f === 'todo' ? ` ${counts.todo}` : ''}</button>)}</div>
      <label className="pb-search"><SearchIcon className="h-4 w-4 text-[var(--ink-muted)]" /><input ref={searchRef} type="search" aria-label={t('projectBoard.search')} placeholder={t('projectBoard.search')} value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    {!!observationFailures && <div className="pb-error" role="alert">{t('projectBoard.observationFailed', {count: observationFailures})}</div>}
    {data.taskError && <div className="pb-error" role="alert">{t('projectBoard.taskError')} {data.taskError}</div>}
    {data.sessionError && <div className="pb-error" role="alert">{t('projectBoard.sessionError')} {data.sessionError}</div>}
    <div className="pb-work"><div className="pb-content" ref={contentRef} inert={overlay && !!selected}><div className="pb-status-strip">{GROUPS.map(g => <span key={g}>{t(`projectBoard.groups.${g}`)} {counts[g]}</span>)}</div>
      <div className="pb-scroll">
        {data.tasksLoading || data.sessionsLoading ? <div className="pb-meta" role="status">{t('projectBoard.loading')}</div> : null}
        {!visible.length && !data.tasksLoading && !data.sessionsLoading ? <div className="pb-empty">{t(rows.length ? 'projectBoard.noMatch' : 'projectBoard.empty')}<br />{t('projectBoard.emptyHint')}</div>
        : view === 'board' ? <>
          <div className="pb-columns" style={groups.length < 4 ? { gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` } : undefined}>
            {groups.map(g => <section key={g} className={`pb-column ${expanded.has(g) ? 'expanded' : ''}`} data-group={g} aria-label={t(`projectBoard.groups.${g}`)}>
              <button type="button" className="pb-column-head" aria-expanded={compact ? expanded.has(g) : true} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(g)) next.delete(g); else next.add(g); return next; })}>
                <span>{t(`projectBoard.groups.${g}`)}</span><span className="count">{visible.filter(r => r.group === g).length}</span><span className="chevron" aria-hidden="true">›</span></button>
              <div className="pb-cards">{visible.filter(r => r.group === g).map(card)}{!visible.some(r => r.group === g) && <div className="pb-column-empty">{t('projectBoard.groupEmpty')}</div>}</div>
            </section>)}
          </div>
          {filter === 'all' && visible.some(r => r.group === 'todo') && <details className="pb-other" open={todoOpen} onToggle={e => setTodoOpen(e.currentTarget.open)}><summary>{t('projectBoard.groups.todo')} · {visible.filter(r => r.group === 'todo').length}</summary><div className="pb-other-grid">{visible.filter(r => r.group === 'todo').map(card)}</div></details>}
          {!!other.length && <details className="pb-other" open={otherOpen} onToggle={e => setOtherOpen(e.currentTarget.open)}><summary>{t('projectBoard.groups.other')} · {other.length}</summary>
            <p className="pb-meta">{t('projectBoard.otherHint')}</p><div className="pb-other-grid">{other.map(card)}</div></details>}
        </> : <div className="pb-table-wrap"><table className="pb-table"><thead><tr><th>{t('projectBoard.task')}</th><th>{t('projectBoard.status')}</th><th className="summary-col">{t('projectBoard.summary')}</th><th className="time-col">{t('projectBoard.updated')}</th><th>{t('projectBoard.action')}</th></tr></thead>
          <tbody>{visible.map(row => <tr key={row.id}><td><button type="button" ref={node => { if (node) rowRefs.current.set(row.id, node); else rowRefs.current.delete(row.id); }} className="title-button" onClick={() => select(row)}>{row.title}</button><div className="pb-meta">{t(row.task ? 'projectBoard.task' : 'projectBoard.conversation')}</div></td><td><span className={`pb-badge ${row.group}`}>{rowState(row)}</span><SessionExecutionTime snapshot={row.activity} now={data.now} /></td><td className="summary-col summary">{row.summary}</td><td className="time-col pb-meta">{formatTime(new Date(row.updatedAt).toISOString())}</td><td><button type="button" className="pb-button" onClick={() => select(row)}>{t('projectBoard.details')}</button>{row.sessions.length === 1 && <button type="button" className="pb-card-action pb-enter-session" onClick={() => openSession(row.sessions[0].id)} aria-label={t('projectBoard.enterSessionFor', { title: row.sessions[0].title })}>{t('projectBoard.enterSession')} ↗</button>}</td></tr>)}</tbody></table></div>}
      </div>
      <footer className="pb-footer"><span>{data.checkedAt ? t('projectBoard.snapshotAt', { time: formatTime(new Date(data.checkedAt).toISOString()) }) : t('projectBoard.snapshotPending')}{unknownCount ? ` · ${t('projectBoard.unknownCount', { count: unknownCount })}` : ''}</span>
        <span>{data.unobservedCount ? t('projectBoard.boundedSnapshot', { count: data.unobservedCount }) : t('projectBoard.snapshotHint')}</span></footer>
    </div>
      {selected && <ProjectBoardDetail key={selected.id} row={selected} workspacePath={workspacePath} isActive={isActive} now={data.now}
        draft={drafts[selected.id] ?? ''} onDraftChange={value => setDrafts(current => ({ ...current, [selected.id]: value }))}
        onClose={closeDetail} onOpenSession={openSession} onChanged={data.refresh} />}
    </div>
  </section>;
}
