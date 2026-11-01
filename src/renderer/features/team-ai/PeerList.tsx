import { useTranslation } from 'react-i18next';
import { AlertIcon, PlusIcon } from '@/components/icons';
import { GROUP_AVATAR_IMAGES } from '@/assets/team-avatars';
import { ChannelPlatformIcon, getChannelPlatformLabel } from '@/components/AgentSettings/channelPlatform';
import { formatPastRelativeTime } from '@/i18n/format';
import type { TeamChannel, TeamPeer } from '@/../shared/teamAi';
import { channelOffline, hasPeerName, isBusyActivity, peerLabel, peerRowKey, type PeerRow } from './model';
import { PEER_AVATAR_PALETTE } from './peerAvatarPalette';

export function PeerAvatar({ peer, platform, size = 32 }: { peer: Pick<TeamPeer, 'name' | 'sourceId' | 'sourceType'>; platform?: string; size?: number }) {
  const badge = platform ? (
    <span className="absolute -right-1 -bottom-1 flex rounded-[5px] bg-[var(--paper)] p-px">
      <ChannelPlatformIcon type={platform} className="h-3.5 w-3.5" />
    </span>
  ) : null;
  const seed = [...peer.sourceId].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  if (peer.sourceType === 'group') {
    return (
      <span className="relative flex shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--paper-inset)] text-[var(--ink-muted)]" style={{ width: size, height: size }}>
        <img
          src={GROUP_AVATAR_IMAGES[seed % GROUP_AVATAR_IMAGES.length]}
          alt=""
          aria-hidden="true"
          draggable={false}
          width={size}
          height={size}
          className="h-full w-full rounded-[inherit] object-cover"
        />
        {badge}
      </span>
    );
  }
  const name = peerLabel(peer);
  const colors = PEER_AVATAR_PALETTE[seed % PEER_AVATAR_PALETTE.length];
  return (
    <span
      className="relative flex shrink-0 items-center justify-center rounded-full font-medium"
      style={{ width: size, height: size, background: colors.background, color: colors.foreground, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {hasPeerName(peer) ? Array.from(name).slice(-1)[0] : '?'}
      {badge}
    </span>
  );
}

/** Running → pulse; failed → alert; otherwise only recency. The list surfaces only what needs attention. */
export function ActivityMark({ activity }: { activity: PeerRow['activity'] }) {
  const { t } = useTranslation('app');
  if (isBusyActivity(activity)) {
    return (
      <span className="relative flex h-2 w-2 shrink-0" title={t(`teamAi.status.${activity}`)}>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--success)] opacity-40 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--success)]" />
      </span>
    );
  }
  if (activity === 'error') return <AlertIcon className="h-3.5 w-3.5 shrink-0 text-[var(--error)]" aria-label={t('teamAi.status.error')} />;
  return null;
}

export function OfflineTag({ channel }: { channel: TeamChannel }) {
  const { t } = useTranslation('app');
  const off = channelOffline(channel);
  if (!off) return null;
  const tone = off === 'error' ? 'bg-[var(--error-bg)] text-[var(--error)]' : off === 'connecting' ? 'bg-[var(--warning-bg)] text-[var(--warning)]' : 'bg-[var(--paper-inset)] text-[var(--ink-muted)]';
  return <span className={`inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-xs ${tone}`}>{t(`teamAi.${off}`)}</span>;
}

export function PeerList({ rows, channels, selectedKey, onSelect, onRetry, onOpenChannel, onAddChannel }: {
  rows: PeerRow[];
  channels: TeamChannel[];
  selectedKey: string | null;
  onSelect: (row: PeerRow) => void;
  onRetry: () => void;
  onOpenChannel: (channelId: string) => void;
  onAddChannel: () => void;
}) {
  const { t } = useTranslation('app');
  const select = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    onSelect(row);
    document.querySelector<HTMLElement>(`[data-peer-row="${CSS.escape(peerRowKey(row.channel.channelId, row.peer.id))}"]`)?.focus();
  };
  const heading = 'flex h-8 items-center gap-2 px-3 text-xs font-medium text-[var(--ink-muted)]';
  return (
    <nav className="flex min-h-0 flex-1 flex-col" aria-label={t('tabs.teamAi')}>
      {/* Connected Bots: transport, access and status live in each Bot's own settings. */}
      {/* Bounded so many Bots never squeeze the conversation list out of view. */}
      <section className="flex max-h-[40%] shrink-0 flex-col border-b border-[var(--line)] px-2 pt-2 pb-2" aria-label={t('teamAi.connectedChannels')}>
        <div className={heading}>
          <span className="flex-1">{t('teamAi.connectedChannels')}</span>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            title={t('teamAi.connectBot')}
            aria-label={t('teamAi.connectBot')}
            onClick={onAddChannel}
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto">
        {channels.map(channel => (
          <button
            key={channel.channelId}
            className="flex h-8 w-full items-center gap-2 rounded-[var(--radius-md)] px-3 text-left text-sm hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            title={t('teamAi.channelSettings', { name: channel.name || getChannelPlatformLabel(channel.platform) })}
            onClick={() => (channel.loadError ? onRetry() : onOpenChannel(channel.channelId))}
          >
            <ChannelPlatformIcon type={channel.platform} className="h-4 w-4" />
            <span className="min-w-0 flex-1 truncate">{channel.name || getChannelPlatformLabel(channel.platform)}</span>
            {channel.loadError
              ? <span className="shrink-0 text-xs text-[var(--error)]" title={channel.loadError}>{t('teamAi.loadFailedRetry')}</span>
              : <OfflineTag channel={channel} />}
          </button>
        ))}
        </div>
      </section>
      <div className={`${heading} mt-2 px-5`}>
        <span>{t('teamAi.peerList')}</span>
        {rows.length > 0 && <span className="font-normal text-[var(--ink-subtle)]">{rows.length}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label={t('teamAi.peerList')}>
        {rows.map((row, index) => {
          const key = peerRowKey(row.channel.channelId, row.peer.id);
          const selected = key === selectedKey;
          return (
            <div
              key={key}
              role="option"
              aria-selected={selected}
              tabIndex={selected || (!selectedKey && index === 0) ? 0 : -1}
              data-peer-row={key}
              onClick={() => onSelect(row)}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  select(index + (event.key === 'ArrowDown' ? 1 : -1));
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(row);
                }
              }}
              className={`flex h-[52px] cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] px-2 outline-none focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${selected ? 'bg-[var(--paper-inset)]' : 'hover:bg-[var(--hover-bg)]'}`}
            >
              <PeerAvatar peer={row.peer} platform={row.channel.platform} />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm ${hasPeerName(row.peer) ? '' : 'font-[var(--font-code)]'}`} title={hasPeerName(row.peer) ? undefined : row.peer.sourceId}>
                  {peerLabel(row.peer)}
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-[var(--ink-muted)]">
                  <span className="shrink-0">{t(`teamAi.${row.peer.sourceType}`)}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{row.channel.name || getChannelPlatformLabel(row.channel.platform)}</span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--ink-muted)]">
                {row.peer.access === 'pending' ? <span className="rounded-full bg-[var(--warning-bg)] px-1.5 py-0.5 text-xs text-[var(--warning)]">{t('teamAi.access.pending')}</span>
                  : row.peer.access === 'blocked' ? <span>{t('teamAi.access.blocked')}</span>
                  : !row.peer.sessionKey && row.peer.access === 'bound' ? <span>{t('teamAi.access.bound')}</span> : null}
                <ActivityMark activity={row.activity} />
                {row.peer.access !== 'pending' && row.lastActiveMs ? formatPastRelativeTime(row.lastActiveMs) : null}
              </span>
            </div>
          );
        })}
        {rows.length === 0 && <p className="px-3 py-6 text-center text-sm text-[var(--ink-muted)]">{t('teamAi.noPeers')}</p>}
      </div>
    </nav>
  );
}
