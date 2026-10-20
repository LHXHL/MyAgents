import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChannelConfig } from '../../../../shared/types/agent';
import { mutateChannelAccess, type ChannelAccessIntent } from '@/config/services/agentConfigService';
import { peerDisplayName } from '@/utils/peerDisplayName';

type Mode = ChannelConfig['accessMode'];

export function ChannelAccessMode({ value, disabled, onChange, platform }: {
  platform: string; value: Mode; disabled?: boolean; onChange: (mode: NonNullable<Mode>) => void;
}) {
  const { t } = useTranslation('settings');
  const mode = value ?? 'review';
  const descriptionKey = mode === 'open'
    ? 'agentSettings.channelAccess.openDescription'
    : platform === 'telegram'
      ? 'agentSettings.channelAccess.reviewDescriptionQr'
      : 'agentSettings.channelAccess.reviewDescription';
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="text-sm font-semibold text-[var(--ink)]">{t('agentSettings.channelAccess.mode')}</legend>
    <div className="flex gap-2">
      {(['review', 'open'] as const).map(mode => <button type="button" key={mode}
        aria-pressed={(value ?? 'review') === mode} onClick={() => onChange(mode)}
        className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${(value ?? 'review') === mode ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--line)] text-[var(--ink)]'}`}>
        {t(`agentSettings.channelAccess.${mode}`)}
      </button>)}
    </div>
    <p className="text-xs text-[var(--ink-muted)]">{t(descriptionKey)}</p>
  </fieldset>;
}

type AccessProps = { channel: ChannelConfig; refresh: () => Promise<void> };

function useAccessMutation(channelId: string, refresh: () => Promise<void>) {
  const { t } = useTranslation('settings');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const run = async (intent: ChannelAccessIntent) => {
    if (saving) return;
    setSaving(true); setError('');
    let saved = false;
    try {
      await mutateChannelAccess(channelId, intent); saved = true;
      await refresh();
    } catch (reason) {
      setError(`${saved ? t('agentSettings.channelAccess.savedRefreshFailed') : ''}${String(reason)}`);
    } finally { setSaving(false); }
  };
  return { saving, error, run };
}

export default function ChannelAccessPanel({ channel, refresh }: AccessProps) {
  const { t } = useTranslation('settings');
  const { saving, error, run } = useAccessMutation(channel.id, refresh);
  return <section aria-label={t('agentSettings.channelAccess.mode')} className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5" aria-busy={saving}>
    <ChannelAccessMode platform={channel.type} value={channel.accessMode} disabled={saving} onChange={mode => { void run({ kind: 'setMode', mode }); }} />
    {error && <p role="alert" className="text-xs text-[var(--error)]">{error}</p>}
  </section>;
}

export function ChannelUserList({ channel, refresh }: AccessProps) {
  const { t } = useTranslation('settings');
  const { saving, error, run } = useAccessMutation(channel.id, refresh);
  const blocked = channel.blockedUserIds ?? [];
  const users = [...new Set([...(channel.allowedUsers ?? []), ...blocked])];
  const stableId = (user: string) => channel.type !== 'telegram' || /^\d+$/.test(user);
  return <section aria-label={t('agentSettings.channelAccess.users')} className="space-y-3" aria-busy={saving}>
    <h3 className="text-sm font-semibold text-[var(--ink)]">{t('agentSettings.channelAccess.users')}</h3>
    {channel.accessMode === 'open' && <p className="text-xs text-[var(--ink-muted)]">{t('agentSettings.channelAccess.removeDescription')}</p>}
    {users.length === 0 && <p className="text-xs text-[var(--ink-muted)]">{t('agentSettings.channelAccess.emptyUsers')}</p>}
    <ul className="space-y-2">{users.map(user => <li key={user} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 break-all text-[var(--ink)]">{peerDisplayName(user, channel.userDisplayNames?.[user])}</span>
      {blocked.includes(user) && <span className="text-xs text-[var(--error)]">{t('agentSettings.channelAccess.blocked')}</span>}
      <button type="button" disabled={saving || !stableId(user)} title={!stableId(user) ? t('agentSettings.channelAccess.stableIdRequired') : undefined}
        onClick={() => { void run({ kind: 'setUserBlocked', userId: user, blocked: !blocked.includes(user) }); }}
        className="rounded px-2 py-1 text-xs text-[var(--accent)] disabled:opacity-50">{t(`agentSettings.channelAccess.${blocked.includes(user) ? 'unblock' : 'block'}`)}</button>
      {(channel.allowedUsers ?? []).includes(user) && <button type="button" disabled={saving}
        onClick={() => { void run({ kind: 'removeUser', userId: user }); }} className="rounded px-2 py-1 text-xs text-[var(--ink-muted)] disabled:opacity-50">{t('agentSettings.channelAccess.remove')}</button>}
    </li>)}</ul>
    {error && <p role="alert" className="text-xs text-[var(--error)]">{error}</p>}
  </section>;
}
