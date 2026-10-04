import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { LoaderIcon, LogOutIcon, UserIcon } from '@/components/icons';
import { APP_SHELL_POPOVER_CHROME } from '@/components/global-sidebar/appShellPopoverChrome';
import { Popover } from '@/components/ui/Popover';
import { useToast } from '@/components/Toast';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { currentSupportedLocale } from '@/i18n/format';
import { SpaceAvatar, spaceDisplayName } from '@/pages/space/SpaceAvatar';
import SpaceProfileSettingsDialog from '@/pages/space/SpaceProfileSettingsDialog';
import { spaceErrorMessage } from '@/api/spaceCloud';
import { accountActions, getAccountSnapshot, type AccountSnapshot } from './accountStore';
import { useMyAgentsAccount } from './useMyAgentsAccount';

export default function AccountEntry({ expanded, available, environment, onOpenSpace }: {
  expanded: boolean;
  available: boolean;
  environment: string;
  onOpenSpace: () => void;
}) {
  const account = useMyAgentsAccount(environment, available);
  return (
    <AccountControls
      key={`${environment}:${account.generation}:${expanded}`}
      account={account} expanded={expanded} onOpenSpace={onOpenSpace}
    />
  );
}

function AccountControls({ account, expanded, onOpenSpace }: {
  account: AccountSnapshot;
  expanded: boolean;
  onOpenSpace: () => void;
}) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const session = account.view?.state === 'authenticated' ? account.view.session : null;
  const displayName = session ? spaceDisplayName(session.user) : t('account.signIn');
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [viewedAt, setViewedAt] = useState(Date.now);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const closeMenu = () => {
    setMenuOpen(false);
    triggerRef.current?.focus();
  };
  useCloseLayer(() => {
    if (!menuOpen) return false;
    closeMenu();
    return true;
  }, 200);

  const accountPlan = session?.accountPlan;
  const expiryMs = Date.parse(accountPlan?.membership?.expiresAt ?? '');
  const expiryValid = Number.isFinite(expiryMs);
  const activePro = accountPlan?.effectiveTier === 'pro'
    && accountPlan.membership?.status === 'active' && expiryValid && expiryMs > viewedAt;
  const daysRemaining = activePro ? Math.max(1, Math.ceil((expiryMs - viewedAt) / 86_400_000)) : null;
  const expiryLabel = expiryValid ? new Date(expiryMs).toLocaleDateString(currentSupportedLocale(), {
    year: 'numeric', month: 'long', day: 'numeric',
  }) : '';
  const planDescription = accountPlan?.membership?.status === 'revoked'
    ? null
    : activePro
      ? daysRemaining !== null && daysRemaining <= 7
        ? t('space.accountPlan.proDaysRemaining', { count: daysRemaining })
        : t('space.accountPlan.proUntil', { date: expiryLabel })
      : expiryValid && (accountPlan?.membership?.status === 'expired' || expiryMs <= viewedAt)
        ? t('space.accountPlan.expiredAt', { date: expiryLabel })
        : null;

  useEffect(() => {
    if (!menuOpen || !expiryValid || expiryMs <= Date.now()) return;
    const timer = window.setTimeout(() => setViewedAt(Date.now()), Math.min(expiryMs - Date.now() + 50, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [menuOpen, expiryValid, expiryMs, viewedAt]);

  const clickAccount = async () => {
    if (!session) {
      if (account.error) {
        await accountActions.refresh(true);
        if (!mountedRef.current) return;
        const current = getAccountSnapshot();
        if (current.error) { toast.error(current.error); return; }
        if (current.view?.state === 'authenticated') { setMenuOpen(true); return; }
      }
      onOpenSpace();
      return;
    }
    setMenuOpen(!menuOpen);
    if (!menuOpen) {
      setViewedAt(Date.now());
      const evaluatedAt = Date.parse(accountPlan?.evaluatedAt ?? '');
      if (!Number.isFinite(evaluatedAt) || Date.now() - evaluatedAt > 60_000) {
        void accountActions.refresh();
      }
    }
  };

  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await accountActions.logout();
      if (!mountedRef.current) return;
      setMenuOpen(false);
      toast.success(t('space.toasts.logoutSuccess'));
    } catch (error) {
      if (mountedRef.current) toast.error(spaceErrorMessage(error));
    } finally {
      if (mountedRef.current) setLoggingOut(false);
    }
  };

  if (!expanded) return null;
  const initialLoading = !session && account.loadState === 'loading';
  return (
    <>
      <button
        ref={triggerRef} type="button" disabled={initialLoading}
        onClick={() => void clickAccount()}
        aria-haspopup={session ? 'dialog' : undefined}
        aria-expanded={session ? menuOpen : undefined}
        className="global-sidebar-row relative flex h-8 min-w-0 items-center text-left text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-wait"
        data-global-account-trigger
      >
        <span className="absolute left-3 flex h-4 w-4 shrink-0 items-center justify-center">
          {session ? <SpaceAvatar name={displayName} email={session.user.email} avatarUrl={session.user.avatarUrl} size={20} />
          : initialLoading ? <LoaderIcon className="h-4 w-4 shrink-0 animate-spin" />
            : <UserIcon className="h-4 w-4 shrink-0" />}
        </span>
        <span className="min-w-0 flex-1 truncate pl-10 pr-3">{initialLoading ? t('common.loading') : displayName}</span>
      </button>
      <Popover
        open={menuOpen && !!session} onClose={closeMenu} anchorRef={triggerRef}
        placement="top-start" offset={8} zIndex={200}
        className={`${APP_SHELL_POPOVER_CHROME} w-[280px] max-w-[calc(100vw-16px)] p-2`} unstyled
      >
        {session && (
          <div role="dialog" aria-label={t('account.menu')}>
            <div className="mb-1 border-b border-dashed border-[var(--line-subtle)] pb-2.5">
              <button
                autoFocus type="button" aria-label={t('account.editProfile')}
                onClick={() => { setMenuOpen(false); setProfileOpen(true); }}
                className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg px-2 py-2.5 text-left outline-none transition-colors hover:bg-[var(--hover-bg)]"
              >
                <SpaceAvatar name={displayName} email={session.user.email} avatarUrl={session.user.avatarUrl} size={40} />
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-semibold leading-tight text-[var(--ink)]">{displayName}</strong>
                  <span className="mt-0.5 block truncate text-xs font-medium leading-tight text-[var(--ink-muted)]">{session.user.email}</span>
                </span>
                <span className={`rounded-md px-2 py-1 text-xs font-semibold tracking-wide ${activePro ? 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]' : 'bg-[var(--paper-inset)] text-[var(--ink-muted)]'}`}>
                  {activePro ? 'PRO' : 'FREE'}
                </span>
              </button>
              {planDescription && (
                <div className={`mt-2 flex items-center gap-1.5 px-2 text-xs font-semibold ${activePro && daysRemaining !== null && daysRemaining <= 7 ? 'text-[var(--warning)]' : 'text-[var(--ink-muted)]'}`}>
                  <span className="min-w-0 flex-1">{planDescription}</span>
                  {account.loadState === 'loading' && <LoaderIcon className="h-3.5 w-3.5 shrink-0 animate-spin" />}
                </div>
              )}
            </div>
            <button type="button" disabled={loggingOut} onClick={() => void logout()}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait">
              {loggingOut ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : <LogOutIcon className="h-3.5 w-3.5" />}
              {t('space.sidebar.logout')}
            </button>
          </div>
        )}
      </Popover>
      {profileOpen && session && createPortal(
        <SpaceProfileSettingsDialog session={session} actions={accountActions}
          avatarPresets={account.avatarPresets} onClose={() => { setProfileOpen(false); triggerRef.current?.focus(); }} />,
        document.body,
      )}
    </>
  );
}
