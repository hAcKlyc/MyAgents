import { GroupedModelList, groupModelRows } from '@/components/GroupedModelList';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionMetadata } from '@/api/sessionClient';
import { ChannelPlatformIcon } from '@/components/AgentSettings/channelPlatform';
import ContextMenu, { type ContextMenuItem } from '@/components/ContextMenu';
import RuntimeIcon from '@/components/RuntimeIcon';
import { sessionRuntimePresentation } from '@/components/runtimePresentation';
import { Toggle } from '@/components/task-center/editors/PanelChrome';
import { DropdownMenu } from '@/components/ui/DropdownMenu';
import { Popover } from '@/components/ui/Popover';
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalIcon,
  InfoIcon,
  PlusIcon,
  PowerIcon,
} from '@/components/icons';
import { formatPastRelativeTime } from '@/i18n/format';
import { getSessionDisplayText } from '@/utils/sessionDisplay';
import { copyPlainText } from '@/utils/clipboard';
import type { TeamAction, TeamActionResult, TeamPeerConfig, TeamPeerProfile, TeamSessionState } from '@/../shared/teamAi';
import type { RuntimeType } from '@/../shared/types/runtime';
import { teamPeerConfig } from './client';
import { channelOffline, isBusyActivity, peerHistory, peerLabel, peerStats, sessionActivity, type PeerRow } from './model';
import { PeerAvatar } from './PeerList';
import TabActivityIndicator from '@/components/TabActivityIndicator';

export const ghostButton =
  'compact-action gap-1.5 px-2.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40';
export const secondaryButton =
  'compact-action gap-1.5 border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm text-[var(--ink)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-40';
export const primaryButton =
  'compact-action gap-1.5 bg-[var(--button-primary-bg)] px-3.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40';
const menuOption =
  'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-sm text-[var(--ink)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-40';
const tag = 'inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-xs';

/** Feedback for the last action; `scope` puts it next to the control that caused it. */
export type TeamNote = { tone: 'ok' | 'err' | 'info'; text: string; scope: 'config' | 'sessions' | 'access' };
export type TeamPending = { key: string; kind: TeamAction['kind'] | 'approveGroup' | 'rejectGroup'; sessionId?: string };
/** Execute a Team AI action; the page owns feedback. `done` is the success text. */
export type RunTeamAction = (action: TeamAction, done: string) => Promise<TeamActionResult | null>;
export type ConfirmRequest = { title: string; message: string; confirmText: string; onConfirm: () => void };

const RUNTIMES: RuntimeType[] = ['builtin', 'dsh', 'codex', 'claude-code', 'antigravity'];
const toolTotal = (config: TeamPeerProfile) =>
  (config.mcpEnabledServers?.length ?? 0) + (config.enabledPluginIds?.length ?? 0) + (config.enabledOfficialToolIds?.length ?? 0);

export function PeerDetail({ agentId, row, sessions, states, pending, note, run, review, confirm, onOpen, onEnable, onBack }: {
  agentId: string;
  row: PeerRow;
  sessions: SessionMetadata[];
  states: TeamSessionState[];
  pending: TeamPending | null;
  note: TeamNote | null;
  run: RunTeamAction;
  review: (decision: 'approve' | 'reject') => void;
  confirm: (request: ConfirmRequest) => void;
  onOpen: (session: SessionMetadata) => void;
  onEnable: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('app');
  const { channel, peer } = row;
  const off = channelOffline(channel);
  const stats = peerStats(peer, sessions);
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pt-5 pb-10">
      {/* Wrapper owns visibility: `compact-action` sets display outside Tailwind layers. */}
      <div className="mb-2 @[720px]/team-ai:hidden">
        <button className={`${ghostButton} -ml-2`} onClick={onBack}>
          <ArrowLeftIcon className="h-4 w-4" />
          {t('teamAi.back')}
        </button>
      </div>
      <header className="flex flex-wrap items-center gap-3">
        <PeerAvatar peer={peer} size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold" title={peer.sourceId}>{peerLabel(peer)}</h2>
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-[var(--ink-muted)]">
            <ChannelPlatformIcon type={channel.platform} className="h-3.5 w-3.5" />
            <span className="truncate">{channel.name || channel.platform}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{t(`teamAi.${peer.sourceType}`)}</span>
            {peer.access && peer.access !== 'open' && <span className={`${tag} ${peer.access === 'pending' ? 'bg-[var(--warning-bg)] text-[var(--warning)]' : 'bg-[var(--paper-inset)] text-[var(--ink-muted)]'}`}>{t(`teamAi.access.${peer.access}`)}</span>}
          </p>
        </div>
        {peer.sourceType === 'group' && peer.access === 'pending' && (
          <div className="ml-auto flex w-full shrink-0 justify-end gap-2 @[480px]/team-ai:w-auto" aria-busy={pending?.kind === 'approveGroup' || pending?.kind === 'rejectGroup'}>
            <button className={secondaryButton} disabled={!!pending} onClick={() => review('reject')}>{t(pending?.kind === 'rejectGroup' ? 'teamAi.access.processing' : 'teamAi.access.reject')}</button>
            <button className={primaryButton} disabled={!!pending} onClick={() => review('approve')}>{t(pending?.kind === 'approveGroup' ? 'teamAi.access.processing' : 'teamAi.access.allow')}</button>
          </div>
        )}
      </header>
      {note?.scope === 'access' && <p role={note.tone === 'err' ? 'alert' : 'status'} className={`mt-3 text-sm ${note.tone === 'err' ? 'text-[var(--error)]' : 'text-[var(--ink-muted)]'}`}>{note.text}</p>}
      {peer.access === 'pending' && <p className="mt-3 text-xs text-[var(--ink-muted)]">{t('teamAi.access.pendingHint')}</p>}
      {off && (
        <div className="mt-4 flex items-center gap-2.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] px-3.5 py-2.5 text-sm text-[var(--ink-muted)]">
          <InfoIcon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{t('teamAi.channelOff', { name: channel.name || channel.platform, status: t(`teamAi.${off}`) })}</span>
          {off === 'disabled' && (
            <button className={secondaryButton} onClick={onEnable}>
              <PowerIcon className="h-4 w-4" />
              {t('teamAi.enable')}
            </button>
          )}
        </div>
      )}

      <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3">
        {[
          [String(stats.recentSessions), t('teamAi.stats.recentSessions')],
          [String(stats.turns), t('teamAi.stats.turns')],
          [stats.lastActiveMs ? formatPastRelativeTime(stats.lastActiveMs) : '—', t('teamAi.stats.lastActive')],
        ].map(([value, label]) => (
          <div key={label} className="flex flex-col-reverse gap-0.5">
            <dt className="text-xs text-[var(--ink-muted)]">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {peer.sessionKey ? <>
        <ConfigSection agentId={agentId} row={row} editable={!off && !pending} note={note?.scope === 'config' ? note : null} run={run} confirm={confirm} />
        <SessionList row={row} sessions={sessions} states={states} disabled={!!off || !!pending} pending={pending} note={note?.scope === 'sessions' ? note : null} run={run} onOpen={onOpen} />
      </> : <div className="mt-8 text-sm text-[var(--ink-muted)]">
        <p>{t('teamAi.access.noConversation')}</p>
        <p className="mt-2 text-xs">{t(peer.access === 'pending' ? 'teamAi.access.waitingApproval' : 'teamAi.access.waitingMessage')}</p>
      </div>}
    </div>
  );
}

/** "配置": what new Sessions of this peer use. Collapsed by default; editing writes the
 *  peer profile and, when compatible, the current Session too. */
function ConfigSection({ agentId, row, editable, note, run, confirm }: {
  agentId: string;
  row: PeerRow;
  editable: boolean;
  note: TeamNote | null;
  run: RunTeamAction;
  confirm: (request: ConfirmRequest) => void;
}) {
  const { t } = useTranslation('app');
  const { channel, peer, current } = row;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TeamPeerConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let stale = false;
    void teamPeerConfig(agentId, channel.channelId, peer.sessionKey)
      .then(next => { if (!stale) { setView(next); setLoadError(null); } })
      .catch(error => { if (!stale) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { stale = true; };
  }, [agentId, channel.channelId, peer.sessionKey, peer.hasProfile, current?.configSnapshotAt, version]);
  const kind = { context: peer.sourceType };
  const edit = async (action: TeamAction, done: string) => {
    const result = await run(action, done);
    setVersion(v => v + 1);
    // A change the current Session cannot take (another Runtime, an incompatible model) only reaches new Sessions.
    if (action.kind === 'updateConfig' && result?.sessionApply === 'skipped' && peer.sessionId) {
      confirm({
        title: t('teamAi.config.needsNewTitle'),
        message: t('teamAi.config.needsNewMessage'),
        confirmText: t('teamAi.config.needsNewConfirm'),
        onConfirm: () => { void run({ kind: 'new' }, t('teamAi.done.created')); },
      });
    }
    return result;
  };

  const config = view?.config;
  const runtimeName = config ? sessionRuntimePresentation(config.runtime, config.runtimeSource).name : '';
  const model = view?.models.find(option => option.isCurrent);
  const effort = config?.reasoningEffort ?? 'default';
  const effortLabel = t(`teamAi.efforts.${effort}`, { defaultValue: effort });
  const canManage = view?.tools.canManageExtensions ?? false;
  const summary = config ? [runtimeName, model?.name ?? config.model ?? t('teamAi.defaultModel'), effortLabel,
    canManage ? t('teamAi.toolsCount', { count: toolTotal(config) }) : t('teamAi.toolsExternal', { runtime: runtimeName })].join(' · ') : '';

  return (
    <section className="mt-5 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)]">
      <button
        className="flex min-h-12 w-full items-center gap-2.5 rounded-[var(--radius-lg)] px-4 text-left hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="shrink-0 text-sm font-semibold">{t('teamAi.config.title')}</span>
        {view?.custom
          ? <span className={`${tag} bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]`}>{t('teamAi.profile.custom')}</span>
          : <span className={`${tag} bg-[var(--paper-inset)] text-[var(--ink-muted)]`}>{t('teamAi.profile.default')}</span>}
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink-muted)]">{summary}</span>
        <ChevronDownIcon className={`h-4 w-4 shrink-0 text-[var(--ink-subtle)] transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-[var(--line-subtle)] px-2 pt-1 pb-2">
          {loadError && !view ? (
            <div role="alert" className="m-2 flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--error-bg)] px-3 py-2.5 text-sm text-[var(--error)]">
              <span className="min-w-0 flex-1" title={loadError}>{t('teamAi.config.loadFailed')}</span>
              <button className="shrink-0 font-medium underline-offset-2 hover:underline" onClick={() => setVersion(v => v + 1)}>{t('teamAi.retry')}</button>
            </div>
          ) : !view || !config ? (
            <div className="m-2 h-28 animate-pulse rounded-[var(--radius-md)] bg-[var(--paper-inset)]" />
          ) : (
            <>
              <PropRow label={t('teamAi.runtime')} disabled={!editable} value={<><RuntimeIcon type={config.runtime} size={16} />{runtimeName}</>}>
                {close => (
                  <>
                    {RUNTIMES.map(option => (
                      <button key={option} className={menuOption} onClick={() => {
                        close();
                        if (option !== config.runtime || config.runtimeSource === 'managed-provider') {
                          void edit({ kind: 'updateConfig', change: { runtime: option } }, t('teamAi.done.updated', { what: t('teamAi.runtime') }));
                        }
                      }}>
                        <RuntimeIcon type={option} size={16} />
                        <span className="min-w-0 flex-1 truncate">{sessionRuntimePresentation(option).name}</span>
                        {option === config.runtime && config.runtimeSource !== 'managed-provider' && <CheckIcon className="h-4 w-4 text-[var(--accent)]" />}
                      </button>
                    ))}
                    <p className="mt-1 border-t border-[var(--line-subtle)] px-2.5 pt-2 pb-1 text-xs text-[var(--ink-muted)]">{t('teamAi.config.runtimeHint')}</p>
                  </>
                )}
              </PropRow>
              <PropRow
                menuClassName="flex flex-col"
                label={t('teamAi.model')}
                disabled={!editable || view.models.length === 0}
                value={<>{model?.name ?? config.model ?? t('teamAi.defaultModel')}{model && <span className="truncate text-xs text-[var(--ink-subtle)]">{model.group}</span>}</>}
              >
                {close => (
                  <GroupedModelList onDismiss={close}
                    flat={view.models[0]?.selection.kind === 'external-cli'}
                    selectedGroupId={model && modelGroupId(model.selection)} selectedModelId={model?.selection.model}
                    groups={groupModelRows(view.models, option => ({
                      groupId: modelGroupId(option.selection),
                      groupName: option.group,
                      row: {
                        id: option.selection.model, name: option.name,
                        suffix: !option.isCurrent && current && !option.appliesNow && (
                          <span className={`${tag} ml-auto bg-[var(--paper-inset)] text-[var(--ink-muted)]`}>{t('teamAi.config.laterTag')}</span>
                        ),
                        select: () => {
                          close();
                          if (!option.isCurrent) void edit({ kind: 'updateConfig', change: { selection: option.selection } }, t('teamAi.done.updated', { what: t('teamAi.model') }));
                        },
                      },
                    }))} />
                )}
              </PropRow>
              {!!view.effortChoices?.length && (
                <PropRow label={t('teamAi.effort')} disabled={!editable} value={effortLabel}>
                  {close => ['default', ...(view.effortChoices ?? [])].map(value => (
                    <button key={value} className={menuOption} onClick={() => {
                      close();
                      if (value !== effort) void edit({ kind: 'updateConfig', change: { effort: value } }, t('teamAi.done.updated', { what: t('teamAi.effort') }));
                    }}>
                      <span className="min-w-0 flex-1">{t(`teamAi.efforts.${value}`, { defaultValue: value })}</span>
                      {value === effort && <CheckIcon className="h-4 w-4 text-[var(--accent)]" />}
                    </button>
                  ))}
                </PropRow>
              )}
              <PropRow
                label={t('teamAi.tools')}
                disabled={!editable}
                value={canManage
                  ? <>{t('teamAi.toolsCount', { count: toolTotal(config) })}<span className="truncate text-xs text-[var(--ink-subtle)]">{t('teamAi.toolsBreakdown', { mcp: config.mcpEnabledServers?.length ?? 0, plugins: config.enabledPluginIds?.length ?? 0, official: config.enabledOfficialToolIds?.length ?? 0 })}</span></>
                  : <span className="text-[var(--ink-muted)]">{t('teamAi.toolsExternal', { runtime: runtimeName })}</span>}
              >
                {() => <ToolsPanel view={view} runtimeName={runtimeName} edit={edit} />}
              </PropRow>
              <div className="flex items-center gap-3 px-2 pt-2.5 pb-1 text-xs">
                <span
                  className={`min-w-0 flex-1 ${note?.tone === 'ok' ? 'text-[var(--success)]' : note?.tone === 'err' ? 'text-[var(--error)]' : 'text-[var(--ink-muted)]'}`}
                  aria-live="polite"
                >
                  {note?.text ?? t(view.custom ? 'teamAi.config.customFoot' : 'teamAi.config.defaultFoot', kind)}
                </span>
                {view.custom && (
                  <button
                    className="shrink-0 text-[var(--accent-warm)] underline-offset-2 hover:underline disabled:opacity-40"
                    disabled={!editable}
                    onClick={() => confirm({
                      title: t('teamAi.profile.resetTitle'),
                      message: t('teamAi.profile.resetMessage'),
                      confirmText: t('teamAi.profile.resetConfirm'),
                      onConfirm: () => { void edit({ kind: 'clearProfile' }, t('teamAi.profile.resetDone')); },
                    })}
                  >
                    {t('teamAi.profile.reset')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function modelGroupId(selection: TeamPeerConfig['models'][number]['selection']) {
  return selection.kind === 'product-provider' ? selection.providerId : selection.runtime;
}

/** One label/value row whose value opens a popover editor. */
function PropRow({ label, value, disabled, children, menuClassName = '' }: { menuClassName?: string; label: string; value: ReactNode; disabled?: boolean; children: (close: () => void) => ReactNode }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div role="group" aria-label={label} className="flex min-h-10 items-center gap-3 rounded-[var(--radius-sm)] px-2 [&+&]:border-t [&+&]:border-[var(--line-subtle)]">
      <span className="w-[84px] shrink-0 text-sm text-[var(--ink-muted)]" aria-hidden="true">{label}</span>
      <button
        ref={anchor}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group -ml-2 flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-sm hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:hover:bg-transparent aria-expanded:bg-[var(--hover-bg)]"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{value}</span>
        {!disabled && <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-aria-expanded:opacity-100" />}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="bottom-start" maxHeight="360px" className={`min-w-[240px] max-w-[calc(100vw-16px)] overflow-y-auto p-1 ${menuClassName}`}>
        {open && children(() => setOpen(false))}
      </Popover>
    </div>
  );
}

function ToolsPanel({ view, runtimeName, edit }: { view: TeamPeerConfig; runtimeName: string; edit: RunTeamAction }) {
  const { t } = useTranslation('app');
  const [saving, setSaving] = useState(false);
  const canManage = view.tools.canManageExtensions;
  // Owned locally while the panel is open: each toggle builds on the previous one rather
  // than on a config view that refreshes asynchronously after the save.
  const [selected, setSelected] = useState(() => ({
    mcpEnabledServers: view.config.mcpEnabledServers ?? [],
    enabledPluginIds: view.config.enabledPluginIds ?? [],
    enabledOfficialToolIds: (view.config.enabledOfficialToolIds ?? []) as string[],
  }));
  const toggle = async (field: keyof typeof selected, id: string) => {
    const next = { ...selected, [field]: selected[field].includes(id) ? selected[field].filter(item => item !== id) : [...selected[field], id] };
    setSelected(next);
    setSaving(true);
    await edit({
      kind: 'updateConfig',
      change: { tools: { ...(canManage ? { mcpEnabledServers: next.mcpEnabledServers, enabledPluginIds: next.enabledPluginIds } : {}), enabledOfficialToolIds: next.enabledOfficialToolIds } },
    }, t('teamAi.done.updated', { what: t('teamAi.tools') }));
    setSaving(false);
  };
  const sections = [
    ['mcp', 'mcpEnabledServers', 'MCP'],
    ['plugins', 'enabledPluginIds', t('teamAi.plugins')],
    ['official', 'enabledOfficialToolIds', t('teamAi.official')],
  ] as const;
  return (
    <div className="w-[280px]" role="group" aria-busy={saving}>
      {sections.map(([items, field, title]) => (
        <div key={field}>
          <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-[var(--ink-subtle)]">{title}</div>
          {view.tools[items].length === 0 && <div className="px-2.5 py-1 text-xs text-[var(--ink-subtle)]">{t('teamAi.none')}</div>}
          {view.tools[items].map(item => (
            <div key={item.id} className="flex min-h-9 items-center gap-2 px-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
              <Toggle
                checked={selected[field].includes(item.id)}
                ariaLabel={item.name}
                disabled={saving || (field !== 'enabledOfficialToolIds' && !canManage)}
                onChange={() => { void toggle(field, item.id); }}
              />
            </div>
          ))}
        </div>
      ))}
      <p className="mt-1 border-t border-[var(--line-subtle)] px-2.5 pt-2 pb-1.5 text-xs text-[var(--ink-muted)]">
        {canManage ? t('teamAi.toolsFooter') : t('teamAi.toolsExternalFooter', { runtime: runtimeName })}
      </p>
    </div>
  );
}

/** Current and earlier Sessions in one list; the current one is tagged. Every row opens Chat. */
function SessionList({ row, sessions, states, disabled, pending, note, run, onOpen }: {
  row: PeerRow;
  sessions: SessionMetadata[];
  states: TeamSessionState[];
  disabled: boolean;
  pending: TeamPending | null;
  note: TeamNote | null;
  run: RunTeamAction;
  onOpen: (session: SessionMetadata) => void;
}) {
  const { t } = useTranslation('app');
  const { peer, current, activity } = row;
  const history = peerHistory(peer, sessions);
  const [menu, setMenu] = useState<{ x: number; y: number; session: SessionMetadata } | null>(null);
  const setCurrent = (session: SessionMetadata) => { void run({ kind: 'setPrimary', sessionId: session.id }, t('teamAi.done.setCurrent')); };
  const actions = (session: SessionMetadata): ContextMenuItem[] => [
    { label: t('teamAi.open'), icon: <ExternalIcon className="h-4 w-4" />, onClick: () => onOpen(session) },
    ...(session.id === peer.sessionId ? [] : [{ label: t('teamAi.setCurrentMenu'), icon: <CheckIcon className="h-4 w-4" />, disabled, onClick: () => setCurrent(session) }]),
    { label: t('teamAi.copyId'), icon: <CopyIcon className="h-4 w-4" />, onClick: () => { void copyPlainText(session.id).catch(() => undefined); } },
  ];
  const rows = [...(current ? [current] : []), ...history.items];
  return (
    <section className="mt-6">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-[var(--ink-muted)]">{t('teamAi.sessions')}</h3>
        {rows.length > 0 && <span className="text-xs text-[var(--ink-subtle)]">{rows.length}</span>}
        <div className="flex-1" />
        <button className={ghostButton} disabled={disabled} onClick={() => { void run({ kind: 'new' }, t('teamAi.done.created')); }}>
          <PlusIcon className="h-4 w-4" />
          {pending?.kind === 'new' ? t('teamAi.creating') : t('teamAi.new')}
        </button>
      </div>
      <p
        className={`px-2.5 text-xs empty:hidden ${note?.tone === 'ok' ? 'text-[var(--success)]' : note?.tone === 'err' ? 'text-[var(--error)]' : 'text-[var(--ink-muted)]'}`}
        aria-live="polite"
      >
        {note?.text}
      </p>
      {!current && <p className="px-2.5 py-2 text-sm text-[var(--ink-subtle)]">{t('teamAi.noCurrent')}</p>}
      {rows.map(session => {
        const isCurrent = session.id === peer.sessionId;
        const state = isCurrent ? activity : sessionActivity(states.find(s => s.channelId === row.channel.channelId && s.sessionKey === peer.sessionKey && s.sessionId === session.id));
        const switching = pending?.kind === 'setPrimary' && pending.sessionId === session.id;
        // Same row anatomy as the sidebar history: activity dot, title, date; actions float over the date.
        return (
          <div
            key={session.id}
            className={`group/session relative flex h-[38px] items-center rounded-[var(--radius-md)] hover:bg-[var(--hover-bg)] ${switching ? 'opacity-60' : ''}`}
            onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, session }); }}
          >
            <button
              type="button"
              title={t('teamAi.open')}
              onClick={() => onOpen(session)}
              className="flex h-full w-full min-w-0 items-center gap-2 rounded-[var(--radius-md)] px-2.5 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            >
              <TabActivityIndicator isGenerating={isBusyActivity(state)} />
              {isCurrent && <span className={`${tag} bg-[var(--ink)] text-[var(--paper)]`}>{t('teamAi.currentTag')}</span>}
              <span className={`min-w-0 flex-1 truncate text-sm ${isCurrent ? 'font-medium' : ''}`}>{getSessionDisplayText(session)}</span>
              <span className="ml-auto shrink-0 text-xs tabular-nums text-[var(--ink-muted)] transition-opacity group-focus-within/session:opacity-0 group-hover/session:opacity-0">
                {switching ? t('teamAi.switching') : session.lastActiveAt ? formatPastRelativeTime(Date.parse(session.lastActiveAt)) : ''}
              </span>
            </button>
            <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center opacity-0 transition-opacity group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100 group-hover/session:pointer-events-auto group-hover/session:opacity-100">
              <DropdownMenu
                title={t('teamAi.peerMenu')}
                sections={[{ items: actions(session).filter((item): item is Exclude<ContextMenuItem, { separator: true }> => !item.separator) }]}
              />
            </div>
          </div>
        );
      })}
      {history.missing > 0 && <p className="px-2.5 py-2 text-xs text-[var(--ink-subtle)]">{t('teamAi.deletedCount', { count: history.missing })}</p>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={actions(menu.session)} onClose={() => setMenu(null)} />}
    </section>
  );
}
