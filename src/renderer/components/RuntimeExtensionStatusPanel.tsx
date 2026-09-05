import { useTranslation } from 'react-i18next';
import type { RuntimeExtensionDiagnostics } from '../../shared/types/runtime';

/** Current Session receipts; installed inventory and permission remain separate facts. */
export function RuntimeExtensionStatusPanel({ status }: { status?: RuntimeExtensionDiagnostics }) {
  const { t } = useTranslation('settings');
  const rows = status?.components.filter((item, index, all) => item.admission !== undefined
    || !all.some((other, otherIndex) => otherIndex !== index && other.component === item.component
      && other.id === item.id && other.admission !== undefined)) ?? [];
  return <section className="mb-6 rounded-lg border border-[var(--line)] p-4" aria-label={t('runtimeAvailability.title')}>
    <h3 className="text-sm font-semibold text-[var(--ink)]">{t('runtimeAvailability.title')}</h3>
    <p className="mt-1 text-sm text-[var(--ink-muted)]">{t('runtimeAvailability.explanation')}</p>
    <p className="mt-2 break-all text-xs text-[var(--ink-muted)]">
      {t('runtimeAvailability.generation', { effective: status?.effectiveRevision ?? t('runtimeAvailability.unknown'), desired: status?.desiredRevision ?? t('runtimeAvailability.unknown') })}
    </p>
    {rows.length === 0 ? <p className="mt-2 text-sm text-[var(--ink-muted)]">{t('runtimeAvailability.noReceipts')}</p>
      : <ul className="mt-3 space-y-3">
        {rows.map((item, index) => <li key={`${item.component}:${item.id ?? ''}:${index}`} className="text-sm text-[var(--ink)]">
          <span className="font-medium">{item.id ?? item.component}</span>{' · '}{item.component}{' · '}
          {t(`runtimeAvailability.${item.admission ?? (item.state === 'unsupported' || item.state === 'failed' ? 'rejected' : 'unknown')}`)}
          <p className="text-xs text-[var(--ink-muted)]">
            {t('runtimeAvailability.enabled', { value: t(`runtimeAvailability.${item.enabled === true ? 'yes' : item.enabled === false ? 'no' : 'unknown'}`) })}{' · '}
            {t('runtimeAvailability.invocation', { value: t(`runtimeAvailability.${item.modelInvocable === true ? 'yes' : item.modelInvocable === false ? 'no' : 'unknown'}`) })}
          </p>
          {item.admission !== 'ready' && <p className="break-words text-xs text-[var(--ink-muted)]">{item.message ?? item.code}</p>}
        </li>)}
      </ul>}
  </section>;
}
