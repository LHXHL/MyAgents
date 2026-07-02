import { Check, Square, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import type { Provider } from '@/config/types';
import { isRuntimeBackedProvider } from '../../shared/providerExecution';

interface ProxyScopeDialogProps {
  providers: Provider[];
  initialProviderIds: string[];
  onClose: () => void;
  onSave: (providerIds: string[]) => void;
}

function providerKindKey(provider: Provider): string {
  if (isRuntimeBackedProvider(provider)) return 'general.proxyScopeDialogManaged';
  if (provider.type === 'subscription') return 'general.proxyScopeDialogSubscription';
  return 'general.proxyScopeDialogApi';
}

export default function ProxyScopeDialog({
  providers,
  initialProviderIds,
  onClose,
  onSave,
}: ProxyScopeDialogProps) {
  const { t } = useTranslation('settings');
  const providerIds = useMemo(() => providers.map(provider => provider.id), [providers]);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const allowed = new Set(providerIds);
    const seen = new Set<string>();
    return initialProviderIds.filter(id => {
      if (!allowed.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  });
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggle = (providerId: string) => {
    setSelectedIds(prev => (
      prev.includes(providerId)
        ? prev.filter(id => id !== providerId)
        : [...prev, providerId]
    ));
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-50 overflow-y-auto px-4 py-8">
      <div
        className="mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--line-subtle)] px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-[var(--ink)]">{t('general.proxyScopeDialogTitle')}</h3>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">{t('general.proxyScopeDialogDescription')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            aria-label={t('general.proxyScopeDialogCancel')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-[var(--line-subtle)] px-5 py-3">
          <span className="text-sm text-[var(--ink-muted)]">
            {t('general.proxyScopeDialogSelected', { count: selectedIds.length })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedIds(providerIds)}
              className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
            >
              {t('general.proxyScopeDialogSelectAll')}
            </button>
          </div>
        </div>

        <div className="max-h-[56vh] overflow-y-auto">
          {providers.map((provider) => {
            const selected = selectedSet.has(provider.id);
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => toggle(provider.id)}
                className="flex w-full items-center gap-3 border-b border-[var(--line-subtle)] px-5 py-3 text-left transition-colors last:border-b-0 hover:bg-[var(--hover-bg)]"
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--accent)]"
                  aria-hidden="true"
                >
                  {selected ? <Check size={18} /> : <Square size={18} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--ink)]">{provider.name}</span>
                  <span className="block truncate text-xs text-[var(--ink-muted)]">{provider.id}</span>
                </span>
                <span className="shrink-0 rounded-md bg-[var(--paper-elevated)] px-2 py-1 text-xs text-[var(--ink-muted)]">
                  {t(providerKindKey(provider))}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--line-subtle)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--line)] px-4 py-2 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
          >
            {t('general.proxyScopeDialogCancel')}
          </button>
          <button
            type="button"
            disabled={selectedIds.length === 0}
            onClick={() => onSave(selectedIds)}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check size={16} />
            {t('general.proxyScopeDialogSave')}
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
