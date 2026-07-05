import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronDown, GitBranch, Loader2, LogIn, LogOut, MessageSquare, Package, Settings } from 'lucide-react';

import type { SpaceSession } from '@/api/spaceCloud';
import myagentsWebLogo from '@/assets/brand/myagents-web-logo.png';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { SpaceAvatar, SpaceIdentityLine, spaceDisplayName } from './SpaceAvatar';
import { PAPER_GRID_STYLE } from './spaceUi';

export type SpaceViewMode = 'issues' | 'goals' | 'skills' | 'agents';

function joinPolicyLabel(policy: string | null | undefined): string {
  const normalized = policy?.trim().toLowerCase() ?? '';
  if (!normalized) return 'unknown';
  return normalized.replace(/[_-]+/g, ' ');
}

export function SpaceLogin({ authBusy, authFlow, onLogin }: { authBusy: boolean; authFlow: { token: string; expiresAt: number } | null; onLogin: () => void }) {
  const { t } = useTranslation('app');
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-[var(--paper)] px-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40" style={PAPER_GRID_STYLE} />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 shadow-md">
        <div className="mb-6 flex items-center gap-3">
          <img src={myagentsWebLogo} alt="" className="h-11 w-11 rounded-xl shadow-sm" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--accent-warm)]">{t('space.login.eyebrow')}</p>
            <h1 className="truncate text-xl font-semibold text-[var(--ink)]">{t('space.login.title')}</h1>
            <p className="text-sm text-[var(--ink-muted)]">{t('space.login.description')}</p>
          </div>
        </div>
        <button type="button" disabled={authBusy} onClick={onLogin} className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70">
          {authBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          {authFlow ? t('space.login.waiting') : t('space.login.continueWithGoogle')}
        </button>
        <p className="mt-3 text-center text-xs text-[var(--ink-muted)]">{t('space.login.returnHint')}</p>
      </div>
    </div>
  );
}

export function SpaceSidebar({ session, mode, onSpaceTabChange, onLogout, onOpenProfileSettings }: { session: SpaceSession; mode: SpaceViewMode; onSpaceTabChange: (mode: SpaceViewMode) => void; onLogout: () => void; onOpenProfileSettings: () => void }) {
  const { t } = useTranslation('app');
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const displayName = spaceDisplayName(session.user);
  useCloseLayer(() => {
    if (!accountMenuOpen) return false;
    setAccountMenuOpen(false);
    return true;
  }, 20);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (accountMenuRef.current?.contains(target)) return;
      setAccountMenuOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [accountMenuOpen]);

  const communityItems: Array<{
    mode: SpaceViewMode;
    label: string;
    icon: typeof MessageSquare;
  }> = [
    { mode: 'issues', label: t('space.sidebar.issues'), icon: MessageSquare },
    { mode: 'goals', label: t('space.sidebar.goals'), icon: GitBranch },
    { mode: 'skills', label: t('space.sidebar.skills'), icon: Package },
    { mode: 'agents', label: t('space.sidebar.agents'), icon: Bot },
  ];

  return (
    <aside className="grid w-64 shrink-0 grid-rows-[minmax(0,1fr)_auto] gap-3.5 border-r border-[var(--line)] bg-[var(--paper)]/70 p-3.5">
      <div className="min-h-0 overflow-y-auto">
        <details className="group/space mb-2.5 border-b border-[var(--line-subtle)] pb-2.5" open>
          <summary className="grid min-h-10 cursor-pointer list-none grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-[var(--paper-elevated)]/70 [&::-webkit-details-marker]:hidden">
            <img src={myagentsWebLogo} alt="" className="h-8 w-8 rounded-lg shadow-sm" />
            <span className="min-w-0">
              <strong className="block truncate text-sm font-semibold text-[var(--ink)]">{session.space.name}</strong>
              <span className="mt-0.5 block truncate text-xs font-medium text-[var(--ink-muted)]">{joinPolicyLabel(session.space.joinPolicy)}</span>
            </span>
            <ChevronDown className="h-4 w-4 -rotate-90 text-[var(--ink-muted)] transition-transform group-open/space:rotate-0" />
          </summary>
          <nav className="grid gap-1 pt-1 pl-5" aria-label={session.space.name}>
            {communityItems.map((item) => {
              const Icon = item.icon;
              const selected = mode === item.mode;
              return (
                <button key={item.mode} type="button" onClick={() => onSpaceTabChange(item.mode)} className={`grid min-h-8 w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold transition-colors ${selected ? 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]' : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'}`}>
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </details>
      </div>

      <div ref={accountMenuRef} className="relative border-t border-[var(--line-subtle)] pt-3">
        <button type="button" onClick={() => setAccountMenuOpen((value) => !value)} aria-expanded={accountMenuOpen} className="flex h-9 w-full items-center gap-2 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)]/60 px-2.5 text-left text-xs font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]">
          <SpaceAvatar name={displayName} email={session.user.email} avatarUrl={session.user.avatarUrl} size={22} />
          <span className="min-w-0 flex-1 truncate">{displayName}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
        <div aria-hidden={!accountMenuOpen} className={`absolute bottom-full left-0 right-0 z-20 mb-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/95 p-2 shadow-md backdrop-blur-md transition-all ${accountMenuOpen ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-[-4px] opacity-0'}`}>
          <div className="mb-1 border-b border-dashed border-[var(--line-subtle)] px-2 py-2.5">
            <SpaceIdentityLine
              name={displayName}
              email={session.user.email}
              avatarUrl={session.user.avatarUrl}
              avatarSize={32}
              nameClassName="text-sm font-semibold text-[var(--ink)]"
            />
            <p className="mt-1 truncate pl-10 text-xs font-medium text-[var(--ink-muted)]">{session.user.email}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setAccountMenuOpen(false);
              onOpenProfileSettings();
            }}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <Settings className="h-3.5 w-3.5" />
            {t('space.sidebar.settings')}
          </button>
          <button
            type="button"
            onClick={() => {
              setAccountMenuOpen(false);
              onLogout();
            }}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <LogOut className="h-3.5 w-3.5" />
            {t('space.sidebar.logout')}
          </button>
        </div>
      </div>
    </aside>
  );
}
