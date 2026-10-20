import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChannelConfig } from '../../../../shared/types/agent';
import { mutateChannelAccess, type ChannelAccessIntent } from '@/config/services/agentConfigService';
import { peerDisplayName } from '@/utils/peerDisplayName';
import { isImeComposingEvent } from '@/utils/imeKeyboard';

type Mode = ChannelConfig['accessMode'];

export function ChannelAccessMode({ value, disabled, onChange }: {
  value: Mode; disabled?: boolean; onChange: (mode: NonNullable<Mode>) => void;
}) {
  const { t } = useTranslation('settings');
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="text-sm font-semibold text-[var(--ink)]">{t('agentSettings.channelAccess.mode')}</legend>
    <div className="flex gap-2">
      {(['review', 'open'] as const).map(mode => <button type="button" key={mode}
        aria-pressed={(value ?? 'review') === mode} onClick={() => onChange(mode)}
        className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${(value ?? 'review') === mode ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--line)] text-[var(--ink)]'}`}>
        {t(`agentSettings.channelAccess.${mode}`)}
      </button>)}
    </div>
    <p className="text-xs text-[var(--ink-muted)]">{t(`agentSettings.channelAccess.${value ? `${value}Description` : 'legacyDescription'}`)}</p>
  </fieldset>;
}

export default function ChannelAccessPanel({ channel, refresh }: { channel: ChannelConfig; refresh: () => Promise<void> }) {
  const { t } = useTranslation('settings');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [id, setId] = useState('');
  const [blockedOnly, setBlockedOnly] = useState(false);
  const blocked = channel.blockedUserIds ?? [];
  const users = [...new Set([...(channel.allowedUsers ?? []), ...blocked])].filter(user => !blockedOnly || blocked.includes(user));
  const run = async (intent: ChannelAccessIntent) => {
    if (saving) return;
    setSaving(true); setError('');
    let saved = false;
    try {
      await mutateChannelAccess(channel.id, intent); saved = true;
      await refresh();
      if (intent.kind === 'addUser' || intent.kind === 'setUserBlocked') setId('');
    } catch (reason) {
      setError(`${saved ? t('agentSettings.channelAccess.savedRefreshFailed') : ''}${String(reason)}`);
    } finally { setSaving(false); }
  };
  const stableId = (user: string) => channel.type !== 'telegram' || /^\d+$/.test(user);
  return <section className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5" aria-busy={saving}>
    <ChannelAccessMode value={channel.accessMode} disabled={saving} onChange={mode => { void run({ kind: 'setMode', mode }); }} />
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-[var(--ink)]">{t('agentSettings.channelAccess.users')}</h3>
      <label className="flex items-center gap-2 text-xs text-[var(--ink-muted)]"><input type="checkbox" checked={blockedOnly} onChange={event => setBlockedOnly(event.target.checked)} />{t('agentSettings.channelAccess.blockedOnly')}</label>
    </div>
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
    <div className="flex flex-wrap gap-2">
      <input aria-label={t('agentSettings.channelAccess.userId')} value={id} disabled={saving} onChange={event => setId(event.target.value)}
        onKeyDown={event => { if (!isImeComposingEvent(event) && event.key === 'Enter' && id.trim() && stableId(id.trim())) { event.preventDefault(); void run({ kind: 'setUserBlocked', userId: id.trim(), blocked: true }); } }}
        placeholder={t('agentSettings.channelAccess.userId')} className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)]" />
      <button type="button" disabled={saving || !id.trim() || !stableId(id.trim())} onClick={() => { void run({ kind: 'setUserBlocked', userId: id.trim(), blocked: true }); }}
        className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink)] disabled:opacity-50">{t('agentSettings.channelAccess.blockById')}</button>
      {channel.type === 'telegram' && <button type="button" disabled={saving || !id.trim()} onClick={() => { void run({ kind: 'addUser', userId: id.trim() }); }}
        className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink)] disabled:opacity-50">{t('agentSettings.channelAccess.addUser')}</button>}
    </div>
    {error && <p role="alert" className="text-xs text-[var(--error)]">{error}</p>}
  </section>;
}
