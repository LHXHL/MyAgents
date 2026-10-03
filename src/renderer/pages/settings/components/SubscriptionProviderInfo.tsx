import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InfoIcon } from '@/components/icons';
import { Popover } from '@/components/ui/Popover';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import {
  SUBSCRIPTION_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID,
} from '@/config/types';

const INFO_KEYS: Record<string, string> = {
  [SUBSCRIPTION_PROVIDER_ID]: 'providers.subscriptionInfo.claude',
  [CODEX_SUBSCRIPTION_PROVIDER_ID]: 'providers.subscriptionInfo.codex',
  [XAI_SUBSCRIPTION_PROVIDER_ID]: 'providers.subscriptionInfo.reverseProxy',
  [ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID]: 'providers.subscriptionInfo.reverseProxy',
};

export function SubscriptionProviderInfo({ providerId }: { providerId: string }) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  const infoKey = INFO_KEYS[providerId];

  useCloseLayer(() => {
    if (!open) return false;
    setOpen(false);
    return true;
  }, 260);

  if (!infoKey) return null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={t('providers.subscriptionInfo.label')}
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={() => setOpen((previous) => !previous)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-border)]"
      >
        <InfoIcon className="h-4 w-4" aria-hidden="true" />
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        placement="bottom-start"
        className="max-w-[min(20rem,calc(100vw-1rem))] px-3 py-2 text-sm text-[var(--ink)]"
      >
        <p id={contentId}>{t(infoKey)}</p>
      </Popover>
    </>
  );
}
