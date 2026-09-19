import { invoke } from '@tauri-apps/api/core';
import {
  Copy,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Terminal,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useToast } from '@/components/Toast';
import { copyPlainText } from '@/utils/clipboard';
import { listenWithCleanup } from '@/utils/tauriListen';

interface ExternalCliAccessState {
  enabled: boolean;
  token?: string;
  createdAt?: string;
  launcherPath: string;
  skillPath: string;
  skillReady: boolean;
}

export function ExternalCliSettingsSection() {
  const { t, i18n } = useTranslation('settings');
  const toast = useToast();
  const [state, setState] = useState<ExternalCliAccessState | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const requestRevision = useRef(0);

  const refresh = useCallback(async () => {
    const revision = ++requestRevision.current;
    setRefreshing(true);
    setLoadFailed(false);
    try {
      const next = await invoke<ExternalCliAccessState>(
        'cmd_get_external_cli_access',
      );
      if (revision === requestRevision.current) {
        setState(next);
        setRefreshing(false);
        setLoadFailed(false);
      }
    } catch (error) {
      if (revision === requestRevision.current) {
        setRefreshing(false);
        setLoadFailed(true);
      }
      toast.error(t('externalCli.loadFailed', { message: String(error) }));
    }
  }, [t, toast]);

  useEffect(() => {
    void refresh();
    const controller = new AbortController();
    void (async () => {
      await listenWithCleanup(
        'external-cli-access-changed',
        () => void refresh(),
        controller.signal,
      );
      // Close the registration race: a change can be emitted after the first
      // read but before the native listener becomes active.
      if (!controller.signal.aborted) await refresh();
    })();
    return () => controller.abort();
  }, [refresh]);

  const updateEnabled = useCallback(
    async (enabled: boolean) => {
      if (busy) return;
      const revision = ++requestRevision.current;
      setBusy(true);
      try {
        const next = await invoke<ExternalCliAccessState>(
          'cmd_set_external_cli_enabled',
          { enabled },
        );
        if (revision === requestRevision.current) setState(next);
        if (!enabled) setRevealed(false);
        toast.success(
          t(enabled ? 'externalCli.enabledToast' : 'externalCli.disabledToast'),
        );
      } catch (error) {
        toast.error(t('externalCli.saveFailed', { message: String(error) }));
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, t, toast],
  );

  const resetToken = useCallback(async () => {
    if (busy) return;
    const revision = ++requestRevision.current;
    setBusy(true);
    try {
      const next = await invoke<ExternalCliAccessState>(
        'cmd_reset_external_cli_token',
      );
      if (revision === requestRevision.current) setState(next);
      setRevealed(true);
      toast.success(t('externalCli.resetToast'));
    } catch (error) {
      toast.error(t('externalCli.saveFailed', { message: String(error) }));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, t, toast]);

  const createdAt = useMemo(() => {
    if (!state?.createdAt) return '—';
    const date = new Date(state.createdAt);
    return Number.isNaN(date.getTime())
      ? state.createdAt
      : new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(date);
  }, [i18n.language, i18n.resolvedLanguage, state?.createdAt]);

  const copy = useCallback(
    async (value: string, messageKey: string) => {
      try {
        await copyPlainText(value);
        toast.success(t(messageKey));
      } catch {
        toast.error(t('externalCli.copyFailed'));
      }
    },
    [t, toast],
  );

  const buildTokenCommand = useCallback(
    (token: string) =>
      state?.launcherPath.toLowerCase().endsWith('.cmd')
        ? `$env:MYAGENTS_API_TOKEN = "${token}"`
        : `export MYAGENTS_API_TOKEN="${token}"`,
    [state?.launcherPath],
  );
  const promptReady = state?.skillReady === true && !refreshing && !loadFailed;
  const visibleHandoffPrompt = promptReady
    ? t('externalCli.handoffPrompt', {
        skillPath: state.skillPath,
        launcherPath: state.launcherPath,
        tokenCommand: buildTokenCommand('<token>'),
      })
    : '';
  const copiedHandoffPrompt =
    promptReady && state.enabled && state.token
      ? t('externalCli.handoffPrompt', {
          skillPath: state.skillPath,
          launcherPath: state.launcherPath,
          tokenCommand: buildTokenCommand(state.token),
        })
      : '';

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
      <div>
        <div className="flex items-center gap-2">
          <Terminal className="h-5 w-5 text-[var(--ink-secondary)]" />
          <h2 className="text-lg font-semibold text-[var(--ink)]">
            {t('externalCli.title')}
          </h2>
        </div>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          {t('externalCli.description')}
        </p>
      </div>

      <section className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-[var(--ink)]">
              {t('externalCli.enableTitle')}
            </h3>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              {t('externalCli.enableDescription')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={state?.enabled === true}
            disabled={!state || busy}
            onClick={() => void updateEnabled(!(state?.enabled === true))}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${state?.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'} disabled:opacity-50`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${state?.enabled ? 'translate-x-5' : 'translate-x-0'}`}
            />
          </button>
        </div>

        {state?.enabled && (
          <div className="mt-5 space-y-4 border-t border-[var(--line)] pt-5">
            <div>
              <label className="text-xs font-medium text-[var(--ink-muted)]">
                {t('externalCli.tokenLabel')}
              </label>
              <div className="mt-1 flex gap-2">
                <code className="min-w-0 flex-1 overflow-hidden text-ellipsis rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs text-[var(--ink)]">
                  {revealed ? state.token : '••••••••••••••••••••••••'}
                </code>
                <button
                  type="button"
                  onClick={() => setRevealed((value) => !value)}
                  className="rounded-lg border border-[var(--line)] p-2 text-[var(--ink-muted)] hover:text-[var(--ink)]"
                  aria-label={t(
                    revealed
                      ? 'externalCli.hideToken'
                      : 'externalCli.showToken',
                  )}
                >
                  {revealed ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
                <button
                  type="button"
                  disabled={!state.token}
                  onClick={() =>
                    void copy(state.token ?? '', 'externalCli.tokenCopied')
                  }
                  className="rounded-lg border border-[var(--line)] p-2 text-[var(--ink-muted)] hover:text-[var(--ink)] disabled:opacity-50"
                  aria-label={t('externalCli.copyToken')}
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                {t('externalCli.createdAt', { value: createdAt })}
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void resetToken()}
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--ink)] hover:bg-[var(--paper-inset)] disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t('externalCli.resetToken')}
            </button>
            <div className="flex gap-2 rounded-lg bg-[var(--warning-bg)] p-3 text-xs text-[var(--warning)]">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{t('externalCli.securityWarning')}</p>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
        <div>
          <h3 className="text-sm font-semibold text-[var(--ink)]">
            {t('externalCli.usageTitle')}
          </h3>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            {t('externalCli.usageDescription')}
          </p>
        </div>
        {promptReady ? (
          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-[var(--ink-muted)]">
                {t('externalCli.promptLabel')}
              </p>
              <button
                type="button"
                disabled={!copiedHandoffPrompt}
                onClick={() =>
                  void copy(copiedHandoffPrompt, 'externalCli.promptCopied')
                }
                className="text-xs text-[var(--accent)] hover:underline disabled:cursor-not-allowed disabled:text-[var(--ink-faint)] disabled:no-underline"
              >
                {t('externalCli.copyPrompt')}
              </button>
            </div>
            <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-[var(--paper-inset)] p-3 text-xs leading-5 text-[var(--ink)]">
              {visibleHandoffPrompt}
            </pre>
          </div>
        ) : (
          <p role="status" className="text-xs text-[var(--ink-muted)]">
            {t(
              refreshing
                ? 'externalCli.promptLoading'
                : loadFailed
                  ? 'externalCli.promptLoadFailed'
                  : state
                    ? 'externalCli.guideUnavailable'
                    : 'externalCli.promptLoading',
            )}
          </p>
        )}
      </section>
    </div>
  );
}
