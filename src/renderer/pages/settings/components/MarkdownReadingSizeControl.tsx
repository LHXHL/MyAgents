import { useTranslation } from 'react-i18next';

import type { MarkdownReadingSize } from '../../../../shared/config-types';

interface MarkdownReadingSizeControlProps {
  value: MarkdownReadingSize;
  onChange: (size: MarkdownReadingSize) => void;
}

export function MarkdownReadingSizeControl({ value, onChange }: MarkdownReadingSizeControlProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="mt-4 flex items-center justify-between gap-4 border-t border-[var(--line)] pt-4">
      <div className="min-w-0 flex-1 pr-4">
        <p className="text-sm font-medium text-[var(--ink)]">{t('general.markdownReadingSizeTitle')}</p>
        <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{t('general.markdownReadingSizeDescription')}</p>
      </div>
      <div className="flex shrink-0 gap-0.5 rounded-full bg-[var(--paper-inset)] p-0.5">
        {(['standard', 'large'] as const).map(size => (
          <button
            key={size}
            type="button"
            aria-pressed={value === size}
            onClick={() => onChange(size)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
              value === size
                ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm'
                : 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
            }`}
          >
            {t(`general.markdownReadingSize.${size}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
