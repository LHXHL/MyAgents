import { AlertTriangle, Loader2, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useTabApi } from '@/context/TabContext';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import type {
  RuntimePermissionDiagnostics,
  RuntimePermissionRulesSnapshot,
} from '../../shared/types/runtime';

interface DshPermissionRulesDialogProps {
  onClose: () => void;
  desiredProductMode?: string;
  permissionStatus?: RuntimePermissionDiagnostics;
}

type PermissionRulesResponse = RuntimePermissionRulesSnapshot & {
  success: true;
};

function expiresLabel(timestamp: number, locale: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? String(timestamp)
    : new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
}

export default function DshPermissionRulesDialog({
  onClose,
  desiredProductMode,
  permissionStatus,
}: DshPermissionRulesDialogProps) {
  const { t, i18n } = useTranslation('chat');
  const { apiGet, apiDelete } = useTabApi();
  const [snapshot, setSnapshot] = useState<RuntimePermissionRulesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingRuleId, setRevokingRuleId] = useState<string | null>(null);
  const visibleProductMode = desiredProductMode ?? permissionStatus?.desiredProductMode;
  const expectedRuntimeMode = visibleProductMode === 'fullAgency'
    ? 'bypassPermissions'
    : visibleProductMode === 'auto' || visibleProductMode === 'plan'
      ? 'acceptEdits'
      : permissionStatus?.desiredRuntimeMode;
  const permissionDrift = snapshot && expectedRuntimeMode
    ? snapshot.permissionMode !== expectedRuntimeMode
    : permissionStatus?.state === 'drift';

  useCloseLayer(() => {
    if (revokingRuleId) return false;
    onClose();
    return true;
  }, 220);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<PermissionRulesResponse>(
        '/api/session/permission-rules',
        { signal },
      );
      setSnapshot({
        permissionMode: response.permissionMode,
        autoAllowTools: [...response.autoAllowTools],
        revision: response.revision,
        rules: [...response.rules],
      });
    } catch (loadError) {
      if (signal?.aborted) return;
      setError(loadError instanceof Error ? loadError.message : t('input.permissionRules.loadFailed'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiGet, t]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const revoke = useCallback(async (ruleId: string) => {
    if (!snapshot || revokingRuleId) return;
    setRevokingRuleId(ruleId);
    setError(null);
    try {
      const query = new URLSearchParams({
        expectedRevision: snapshot.revision,
        ruleId,
      });
      await apiDelete(`/api/session/permission-rules?${query.toString()}`);
      await load();
    } catch (revokeError) {
      const message = revokeError instanceof Error
        ? revokeError.message
        : t('input.permissionRules.revokeFailed');
      // A stale expected revision means the Runtime changed underneath this
      // dialog. Read it back so a retry can use the authoritative revision.
      await load();
      setError(message);
    } finally {
      setRevokingRuleId(null);
    }
  }, [apiDelete, load, revokingRuleId, snapshot, t]);

  return (
    <OverlayBackdrop
      onClose={revokingRuleId ? undefined : onClose}
      className="z-[220] p-4"
      portal
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('input.permissionRules.title')}
        className="glass-panel flex max-h-[min(680px,90vh)] w-full max-w-2xl flex-col overflow-hidden"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
          <div className="flex min-w-0 gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/10">
              <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-[var(--ink)]">
                {t('input.permissionRules.title')}
              </h2>
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--ink-muted)]">
                {t('input.permissionRules.description')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={Boolean(revokingRuleId)}
            aria-label={t('input.permissionRules.close')}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && (
            <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--error)]/25 bg-[var(--error)]/8 px-3 py-2 text-sm text-[var(--error)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}

          {permissionDrift && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-sm text-[var(--ink)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
              <span>{t('input.permissionRules.drift')}</span>
            </div>
          )}

          {loading && !snapshot ? (
            <div className="flex h-32 items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('input.permissionRules.loading')}
            </div>
          ) : snapshot ? (
            <>
              <div className="mb-4 grid grid-cols-3 gap-3 rounded-lg bg-[var(--paper-inset)]/60 p-3 text-xs max-sm:grid-cols-1">
                <div>
                  <span className="text-[var(--ink-muted)]">{t('input.permissionRules.productMode')}</span>
                  <div className="mt-0.5 font-medium text-[var(--ink)]">
                    {visibleProductMode ?? '—'}
                  </div>
                </div>
                <div>
                  <span className="text-[var(--ink-muted)]">{t('input.permissionRules.effectiveMode')}</span>
                  <div className="mt-0.5 font-medium text-[var(--ink)]">
                    {snapshot.permissionMode}
                  </div>
                </div>
                <div>
                  <span className="text-[var(--ink-muted)]">{t('input.permissionRules.ruleCount')}</span>
                  <div className="mt-0.5 font-medium text-[var(--ink)]">{snapshot.rules.length}</div>
                </div>
              </div>

              {snapshot.rules.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                  {t('input.permissionRules.empty')}
                </div>
              ) : (
                <div className="space-y-3">
                  {snapshot.rules.map(rule => (
                    <div key={rule.ruleId} className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-[var(--ink)]">{rule.tool}</span>
                            <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
                              {rule.permissionClass}
                            </span>
                          </div>
                          <code className="mt-2 block select-text break-all rounded bg-[var(--paper-inset)]/70 px-2 py-1.5 text-xs text-[var(--ink-secondary)]">
                            {rule.target}
                          </code>
                          <div className="mt-2 text-xs text-[var(--ink-muted)]">
                            {t('input.permissionRules.expires', {
                              value: expiresLabel(rule.expiresAt, i18n.language),
                            })}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => { void revoke(rule.ruleId); }}
                          disabled={Boolean(revokingRuleId)}
                          aria-label={t('input.permissionRules.revokeRule', { tool: rule.tool })}
                          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-[var(--error)] transition-colors hover:bg-[var(--error)]/10 disabled:opacity-50"
                        >
                          {revokingRuleId === rule.ruleId
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Trash2 className="h-3.5 w-3.5" />}
                          {t('input.permissionRules.revoke')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--line)] px-5 py-3">
          <p className="text-xs text-[var(--ink-muted)]">{t('input.permissionRules.addHint')}</p>
          <button
            type="button"
            onClick={() => { void load(); }}
            disabled={loading || Boolean(revokingRuleId)}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--button-secondary-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('input.permissionRules.refresh')}
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
