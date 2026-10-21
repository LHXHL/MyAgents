import { peerDisplayName } from '@/utils/peerDisplayName';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, CloseIcon } from '@/components/icons';
import type { GroupPermission } from '../../../../shared/types/im';

/** Unknown/legacy ID-only names stay empty; identity always remains visible. */
function groupLabel(id: string, name?: string) {
    const label = peerDisplayName(id, name);
    return label === id ? `（${id}）` : label;
}

export default function GroupPermissionList({
    permissions, onApprove, onReject, onRemove, blockedGroupIds = [], onBlockChange, openAccess = false,
}: {
    permissions: GroupPermission[];
    blockedGroupIds?: string[];
    onBlockChange?: (groupId: string, blocked: boolean) => Promise<void>;
    openAccess?: boolean;
    onApprove: (groupId: string) => Promise<void>;
    onReject: (groupId: string) => Promise<void>;
    onRemove: (groupId: string) => Promise<void>;
}) {
    const { t } = useTranslation('settings');
    const [loading, setLoading] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const pending = permissions.filter(p => p.status === 'pending');
    const approved = permissions.filter(p => p.status === 'approved');
    const orphanedBlocked = blockedGroupIds.filter(id => !permissions.some(group => group.groupId === id));

    const handleAction = async (action: () => Promise<void>, groupId: string) => {
        if (loading !== null) return;
        setLoading(groupId);
        setError(null);
        try { await action(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setLoading(null); }
    };

    const renderBlock = (groupId: string) => onBlockChange && <button type="button" disabled={loading !== null}
        onClick={() => { void handleAction(() => onBlockChange(groupId, !blockedGroupIds.includes(groupId)), groupId); }}
        className="rounded px-2 py-1 text-xs text-[var(--accent)] disabled:opacity-50">
        {t(`agentSettings.channelAccess.${blockedGroupIds.includes(groupId) ? 'unblock' : 'block'}`)}
    </button>;
    const renderName = (groupId: string, groupName?: string) => <>
        <span className="min-w-0 flex-1 break-all text-sm text-[var(--ink)]">{groupLabel(groupId, groupName)}</span>
        {blockedGroupIds.includes(groupId) && <span className="text-xs text-[var(--error)]">{t('agentSettings.channelAccess.blocked')}</span>}
    </>;

    return <div className="space-y-3" aria-busy={loading !== null}>
        {error && <p role="alert" className="text-xs text-[var(--error)]">{error}</p>}
        {orphanedBlocked.map(id => <div key={id} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--paper-inset)] px-3 py-2">
            {renderName(id)}{renderBlock(id)}
        </div>)}
        {pending.length > 0 && <div className="space-y-2">
            <p className="text-xs font-medium text-[var(--warning)]">
                {openAccess ? t('agentSettings.channelAccess.discovered') : t('agentSettings.imComponents.pendingReview')}
            </p>
            {pending.map(g => <div key={g.groupId} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--warning)]/20 bg-[var(--warning)]/5 px-3 py-2">
                {renderName(g.groupId, g.groupName)}
                {renderBlock(g.groupId)}
                <button type="button" disabled={loading !== null}
                    onClick={() => { void handleAction(() => onApprove(g.groupId), g.groupId); }}
                    className="rounded-md bg-[var(--accent)] p-1.5 text-[var(--on-accent)] disabled:opacity-50"
                    title={t('agentSettings.imComponents.allow')}><CheckIcon className="h-3.5 w-3.5" /></button>
                <button type="button" disabled={loading !== null}
                    onClick={() => { void handleAction(() => onReject(g.groupId), g.groupId); }}
                    className="rounded-md bg-[var(--paper-inset)] p-1.5 text-[var(--ink-muted)] disabled:opacity-50"
                    title={t('agentSettings.imComponents.reject')}><CloseIcon className="h-3.5 w-3.5" /></button>
            </div>)}
        </div>}
        {approved.map(g => <div key={g.groupId} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--paper-inset)] px-3 py-2">
            {renderName(g.groupId, g.groupName)}
            {renderBlock(g.groupId)}
            <button type="button" disabled={loading !== null}
                onClick={() => { void handleAction(() => onRemove(g.groupId), g.groupId); }}
                className="rounded px-2 py-1 text-xs text-[var(--ink-muted)] disabled:opacity-50">{t('agentSettings.channelAccess.remove')}</button>
        </div>)}
        {permissions.length === 0 && orphanedBlocked.length === 0 && <p className="text-xs text-[var(--ink-muted)]">{t('agentSettings.imComponents.groupsEmpty')}</p>}
    </div>;
}
