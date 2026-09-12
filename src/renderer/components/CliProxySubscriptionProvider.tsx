import { useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { CliProxyStatus } from '../../shared/cliproxy';
import type { Provider } from '@/config/types';
import { cancelCliProxy, checkCliProxyUpdate, connectCliProxy, disconnectCliProxy, discoverCliProxyModels, retryCliProxyCleanup, verifyCliProxy } from '@/config/services/cliproxyService';
import SubscriptionProviderCardContent from './SubscriptionProviderCardContent';
import CustomSelect from './CustomSelect';

const buttonClass = 'rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:opacity-50';

export default function CliProxySubscriptionProvider({ status, refresh }: {
  status: CliProxyStatus; provider: Provider; refresh: () => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ generation: string; model: string } | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const account = status.candidate ?? status.active;
  const generation = account?.generation;
  const authorizing = status.candidate?.phase === 'authorizing';
  const verifying = status.verification?.phase === 'running' || status.candidate?.phase === 'verifying' || status.candidate?.phase === 'waiting-to-commit';
  // Opening settings reads the Rust projection only. Explicit refresh owns
  // native discovery; its result cannot replace a newer account's status.
  const models = status.models;
  const model = selection && selection.generation === generation && models.some(m => m.model === selection.model)
    ? selection.model : models[0]?.model ?? '';
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await operation(); }
    catch (failure) {
      if (mounted.current) setError(failure && typeof failure === 'object' && 'message' in failure
        ? String(failure.message) : t('providers.cliproxy.operationFailed'));
    } finally {
      await refresh();
      if (mounted.current) setBusy(false);
    }
  };
  return <div className="space-y-3">
    <SubscriptionProviderCardContent
      description={t('providers.cliproxy.description')}
      status={<>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        <span>{status.active
          ? `${status.active.email ?? t('providers.cliproxy.account')} · ${t(`providers.cliproxy.accountState.${status.active.status}`)}`
          : t('providers.cliproxy.disconnected')}</span>
      </>}
      actions={<>
        <button type="button" className={buttonClass} disabled={busy || !status.policy.usable || !!status.candidate || !!status.cleanup}
          onClick={() => { void run(connectCliProxy); }}>{t(status.active ? 'providers.cliproxy.reconnect' : 'providers.cliproxy.connect')}</button>
        {(status.active || status.candidate) && <button type="button" className={buttonClass} disabled={busy}
          onClick={() => { void run(disconnectCliProxy); }}>{t('providers.cliproxy.disconnect')}</button>}
        {status.cleanup && <button type="button" className={buttonClass} disabled={busy}
          onClick={() => { void run(retryCliProxyCleanup); }}>{t('providers.cliproxy.retryCleanup')}</button>}
      </>}
      error={(error || status.error?.message) && <p role="alert" className="text-sm text-[var(--error)]">{error ?? status.error?.message}</p>}
    />
    {status.candidate && <div className="space-y-2 rounded-lg bg-[var(--paper-inset)] p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>{status.candidate.email ?? t('providers.cliproxy.newAccount')} · {t(`providers.cliproxy.phase.${status.candidate.phase}`)}</span>
        <button type="button" className={buttonClass} disabled={busy}
          onClick={() => { void run(() => cancelCliProxy(status.candidate!.attemptId)); }}>{t('providers.cliproxy.cancel')}</button>
      </div>
      {authorizing && <p className="text-[var(--ink-muted)]">{t('providers.cliproxy.browserHint')}</p>}
    </div>}
    {generation && !authorizing && <div className="flex flex-wrap items-center gap-2">
      <CustomSelect ariaLabel={t('providers.cliproxy.verificationModel')} value={model}
        disabled={busy || verifying || !status.policy.usable}
        onChange={model => setSelection({ generation, model })}
        options={models.map(model => ({ value: model.model, label: model.modelName ?? model.model }))}
        placeholder={t('providers.cliproxy.noModels')} size="toolbar" className="min-w-0 flex-1" />
      <button type="button" className={buttonClass} disabled={busy || verifying || !model || !status.policy.usable || !!status.cleanup}
        onClick={() => { void run(() => verifyCliProxy(generation, model)); }}>{t('providers.cliproxy.verify')}</button>
      <button type="button" className={buttonClass} disabled={busy || verifying || !status.policy.usable || !!status.cleanup}
        onClick={() => { void run(() => discoverCliProxyModels(generation)); }}>{t('providers.cliproxy.refreshModels')}</button>
      {status.modelsStale && <p className="w-full text-xs text-[var(--ink-muted)]">{t('providers.cliproxy.modelsStale')}</p>}
      {model && <p className="w-full text-xs text-[var(--ink-muted)]">{t(`providers.cliproxy.modelState.${status.modelVerification?.[model]?.status ?? 'unknown'}`)}
        {status.modelVerification?.[model]?.checkedAt && ` · ${new Date(status.modelVerification[model].checkedAt).toLocaleString()}`}</p>}
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-3 text-xs text-[var(--ink-muted)]">
      <span>CLIProxy {status.component.version ?? status.component.bundledVersion ?? '—'} · {t(`providers.cliproxy.update.${status.update.phase}`)}</span>
      <button type="button" className={buttonClass} disabled={busy || ['checking', 'downloading', 'installing'].includes(status.update.phase)}
        onClick={() => { void run(checkCliProxyUpdate); }}>{t('providers.cliproxy.checkUpdate')}</button>
      {status.update.error && <p className="w-full">{status.update.error.message}</p>}
      {!status.policy.usable && <p className="w-full">{status.policy.error?.message ?? t('providers.cliproxy.disabled')}</p>}
    </div>
  </div>;
}
