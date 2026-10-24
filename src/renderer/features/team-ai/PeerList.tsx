import { useTranslation } from 'react-i18next';
import { AlertIcon, SearchIcon, TeamIcon } from '@/components/icons';
import { ChannelPlatformIcon } from '@/components/AgentSettings/channelPlatform';
import { formatPastRelativeTime } from '@/i18n/format';
import type { TeamChannel, TeamPeer } from '@/../shared/teamAi';
import { channelOffline, hasPeerName, isBusyActivity, peerLabel, peerRowKey, type PeerRow } from './model';

const AVATAR_COLORS = ['#c9734f', '#5b8fd4', '#4aa37a', '#9b6bd1', '#c99a3c', '#cf5f7a', '#3f9ea6'];

export function PeerAvatar({ peer, platform, size = 32 }: { peer: Pick<TeamPeer, 'name' | 'sourceId' | 'sourceType'>; platform?: string; size?: number }) {
  const badge = platform ? (
    <span className="absolute -right-1 -bottom-1 flex rounded-[5px] bg-[var(--paper)] p-px">
      <ChannelPlatformIcon type={platform} className="h-3.5 w-3.5" />
    </span>
  ) : null;
  if (peer.sourceType === 'group') {
    return (
      <span className="relative flex shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--paper-inset)] text-[var(--ink-muted)]" style={{ width: size, height: size }}>
        <TeamIcon className="h-[55%] w-[55%]" />
        {badge}
      </span>
    );
  }
  const name = peerLabel(peer);
  const seed = [...peer.sourceId].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return (
    <span
      className="relative flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{ width: size, height: size, background: AVATAR_COLORS[seed % AVATAR_COLORS.length], fontSize: Math.round(size * 0.42) }}
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

export function PeerList({ rows, channels, query, onQuery, selectedKey, onSelect, onRetry }: {
  rows: PeerRow[];
  channels: TeamChannel[];
  query: string;
  onQuery: (value: string) => void;
  selectedKey: string | null;
  onSelect: (row: PeerRow) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation('app');
  const failed = channels.filter(channel => channel.loadError);
  const quiet = channels.filter(channel => !channel.loadError && channel.peers.length === 0);
  const select = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    onSelect(row);
    document.querySelector<HTMLElement>(`[data-peer-row="${CSS.escape(peerRowKey(row.channel.channelId, row.peer.sessionKey))}"]`)?.focus();
  };
  return (
    <nav className="flex min-h-0 flex-1 flex-col" aria-label={t('tabs.teamAi')}>
      <div className="px-3 pt-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--paper-inset)] px-2.5 text-sm text-[var(--ink-muted)] focus-within:outline-2 focus-within:outline-[var(--accent)]">
          <SearchIcon className="h-4 w-4 shrink-0" />
          <input
            value={query}
            onChange={event => onQuery(event.target.value)}
            placeholder={t('teamAi.search')}
            aria-label={t('teamAi.search')}
            className="min-w-0 flex-1 bg-transparent text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label={t('teamAi.selectPeer')}>
        {rows.map((row, index) => {
          const key = peerRowKey(row.channel.channelId, row.peer.sessionKey);
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
                  <span className="truncate">{row.channel.name || row.channel.platform}</span>
                  <OfflineTag channel={row.channel} />
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--ink-muted)]">
                <ActivityMark activity={row.activity} />
                {row.lastActiveMs ? formatPastRelativeTime(row.lastActiveMs) : null}
              </span>
            </div>
          );
        })}
        {rows.length === 0 && query.trim() && <p className="px-3 py-6 text-center text-sm text-[var(--ink-muted)]">{t('teamAi.noResults')}</p>}
        {failed.map(channel => (
          <div key={channel.channelId} className="mx-1 mt-2 flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--error-bg)] px-2.5 py-2 text-xs text-[var(--error)]" role="alert">
            <span className="min-w-0 flex-1 truncate" title={channel.loadError ?? undefined}>{t('teamAi.loadFailed', { name: channel.name || channel.platform })}</span>
            <button className="shrink-0 font-medium underline-offset-2 hover:underline" onClick={onRetry}>{t('teamAi.retry')}</button>
          </div>
        ))}
        {!query.trim() && quiet.map(channel => (
          <p key={channel.channelId} className="truncate px-3 pt-3 text-xs text-[var(--ink-subtle)]">{t('teamAi.botNoPeers', { name: channel.name || channel.platform })}</p>
        ))}
      </div>
    </nav>
  );
}
