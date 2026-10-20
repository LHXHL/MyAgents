import { peerDisplayName } from '@/utils/peerDisplayName';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, CloseIcon, TrashIcon } from '@/components/icons';
import ConfirmDialog from '@/components/ConfirmDialog';
import { getPlatformLabel } from '@/utils/platformLabel';
import type { GroupPermission } from '../../../../shared/types/im';

export default function GroupPermissionList({
    permissions,
    onApprove,
    onReject,
    onRemove,
    blockedGroupIds = [],
    onBlockChange,
    openAccess = false,
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
    const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
    const [loading, setLoading] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [blockedOnly, setBlockedOnly] = useState(false);

    const pending = permissions.filter(p => p.status === 'pending' && (!blockedOnly || blockedGroupIds.includes(p.groupId)));
    const approved = permissions.filter(p => p.status === 'approved' && (!blockedOnly || blockedGroupIds.includes(p.groupId)));

    const handleAction = async (action: () => Promise<void>, groupId: string) => {
        setLoading(groupId);
        setError(null);
        try {
            await action();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            console.error('[GroupPermission] Action failed:', msg);
        } finally {
            setLoading(null);
        }
    };

    const renderBlock = (groupId: string) => onBlockChange && <button type="button" disabled={loading !== null}
        onClick={() => { void handleAction(() => onBlockChange(groupId, !blockedGroupIds.includes(groupId)), groupId); }}
        className="rounded-md px-2 py-1 text-xs text-[var(--accent)] disabled:opacity-50">
        {t(`agentSettings.channelAccess.${blockedGroupIds.includes(groupId) ? 'unblock' : 'block'}`)}
    </button>;
    return (
        <div className="space-y-3">
            {/* Error display */}
            {onBlockChange && <label className="flex items-center gap-2 text-xs text-[var(--ink-muted)]"><input type="checkbox" checked={blockedOnly} onChange={event => setBlockedOnly(event.target.checked)} />{t('agentSettings.channelAccess.blockedOnly')}</label>}
            {blockedGroupIds.filter(id => !permissions.some(group => group.groupId === id)).map(id => <div key={id} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-sm text-[var(--ink)]"><span className="break-all">{id} · {t('agentSettings.channelAccess.blocked')}</span>{renderBlock(id)}</div>)}
            {error && (
                <p className="text-xs text-[var(--error)]">{error}</p>
            )}

            {/* Pending groups */}
            {pending.length > 0 && (
                <div className="space-y-2">
                    <label className="text-xs font-medium text-[var(--warning)]">
                        {openAccess ? t('agentSettings.channelAccess.discovered') : t('agentSettings.imComponents.pendingReview')}
                    </label>
                    {pending.map(g => (
                        <div
                            key={g.groupId}
                            className="flex items-center justify-between rounded-lg border border-[var(--warning)]/20 bg-[var(--warning)]/5 px-3 py-2"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-[var(--ink)]">{peerDisplayName(g.groupId, g.groupName)}{blockedGroupIds.includes(g.groupId) && <span className="ml-2 text-xs text-[var(--error)]">{t('agentSettings.channelAccess.blocked')}</span>}</p>
                                <p className="text-xs text-[var(--ink-muted)]">
                                    {getPlatformLabel(g.platform)}
                                    {g.addedBy && ` · ${t('agentSettings.imComponents.addedBy', { name: g.addedBy })}`}
                                </p>
                            </div>
                            <div className="ml-3 flex items-center gap-1.5">
                                {renderBlock(g.groupId)}
                                <button
                                    onClick={() => handleAction(() => onApprove(g.groupId), g.groupId)}
                                    disabled={loading !== null}
                                    className="rounded-md bg-[var(--accent)] p-1.5 text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-warm-hover)] disabled:opacity-50"
                                    title={t('agentSettings.imComponents.allow')}
                                >
                                    <CheckIcon className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    onClick={() => handleAction(() => onReject(g.groupId), g.groupId)}
                                    disabled={loading !== null}
                                    className="rounded-md bg-[var(--paper-inset)] p-1.5 text-[var(--ink-muted)] transition-colors hover:text-[var(--error)] disabled:opacity-50"
                                    title={t('agentSettings.imComponents.reject')}
                                >
                                    <CloseIcon className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Approved groups */}
            {approved.length > 0 && (
                <div className="space-y-2">
                    <label className="text-xs font-medium text-[var(--ink-muted)]">
                        {t('agentSettings.imComponents.approvedGroups')}
                    </label>
                    {approved.map(g => (
                        <div
                            key={g.groupId}
                            className="group flex items-center justify-between rounded-lg bg-[var(--paper-inset)] px-3 py-2"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm text-[var(--ink)]">{peerDisplayName(g.groupId, g.groupName)}{blockedGroupIds.includes(g.groupId) && <span className="ml-2 text-xs text-[var(--error)]">{t('agentSettings.channelAccess.blocked')}</span>}</p>
                                <p className="text-xs text-[var(--ink-muted)]">
                                    {getPlatformLabel(g.platform)}
                                </p>
                            </div>
                            {renderBlock(g.groupId)}
                            <button
                                disabled={loading !== null}
                                onClick={() => setConfirmRemove(g.groupId)}
                                className="ml-3 rounded-md p-1.5 text-[var(--ink-muted)] opacity-0 transition-all hover:text-[var(--error)] group-hover:opacity-100"
                                title={t('agentSettings.imComponents.remove')}
                            >
                                <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Empty state */}
            {permissions.length === 0 && (
                <p className="text-xs text-[var(--ink-muted)]">
                    {t('agentSettings.imComponents.groupsEmpty')}
                </p>
            )}

            {/* Remove confirmation */}
            {confirmRemove && (
                <ConfirmDialog
                    title={t('agentSettings.imComponents.removeGroupTitle')}
                    message={t('agentSettings.imComponents.removeGroupMessage', {
                        name: peerDisplayName(confirmRemove, approved.find(g => g.groupId === confirmRemove)?.groupName),
                    })}
                    confirmText={t('agentSettings.imComponents.removeGroupConfirm')}
                    cancelText={t('agentSettings.botRegistry.cancel')}
                    confirmVariant="danger"
                    onConfirm={async () => {
                        try {
                            await onRemove(confirmRemove);
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            setError(msg);
                        } finally {
                            setConfirmRemove(null);
                        }
                    }}
                    onCancel={() => setConfirmRemove(null)}
                />
            )}
        </div>
    );
}
