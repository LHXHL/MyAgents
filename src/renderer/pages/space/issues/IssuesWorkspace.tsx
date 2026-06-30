import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, RefreshCw, Search, X } from 'lucide-react';

import type { SpaceIssue } from '@/api/spaceCloud';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import { claimHandlerLabel, ISSUE_STATUSES, issueDisplayTitle, issueStatusLabel } from '@/pages/space/spaceHelpers';
import { recordSpaceMetric } from '@/pages/space/spaceMetrics';
import { formatTime, statusPillClass } from '@/pages/space/spaceUi';

export function IssuesWorkspace({
  admin,
  issues,
  issuesLoading,
  issueQ,
  selectedGoalId,
  selectedStatus,
  goalOptions,
  activeIssueId,
  onQueryChange,
  onGoalChange,
  onStatusChange,
  onRefresh,
  onCreate,
  onOpenIssue,
}: {
  admin: boolean;
  issues: SpaceIssue[];
  issuesLoading: boolean;
  issueQ: string;
  selectedGoalId: string;
  selectedStatus: string;
  goalOptions: SelectOption[];
  activeIssueId: string | null;
  onQueryChange: (value: string) => void;
  onGoalChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onRefresh: () => Promise<void>;
  onCreate: () => void;
  onOpenIssue: (id: string) => void;
}) {
  const { t } = useTranslation('app');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchActive = searchOpen || issueQ.trim().length > 0;
  const statusFilterOptions: SelectOption[] = [
    { value: '', label: t('space.filters.allStatuses') },
    ...ISSUE_STATUSES.map((status) => ({ value: status, label: issueStatusLabel(status) })),
  ];

  useEffect(() => {
    recordSpaceMetric('space_issue_list_render_count', { count: issues.length });
  }, [issues.length]);

  useEffect(() => {
    if (!searchOpen) return;
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [searchOpen]);

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
      <section className="flex min-h-12 items-center gap-2.5 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-1.5 backdrop-blur-md">
        {searchActive ? (
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-muted)]" />
            <input
              ref={searchInputRef}
              value={issueQ}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                if (issueQ.trim()) {
                  onQueryChange('');
                } else {
                  setSearchOpen(false);
                }
              }}
              className="h-9 w-full rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/85 pl-9 pr-10 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)]"
              placeholder={t('space.issues.searchPlaceholder')}
            />
            <button
              type="button"
              onClick={() => {
                onQueryChange('');
                setSearchOpen(false);
              }}
              className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              aria-label={t('space.issues.closeSearch')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </label>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/70 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              aria-label={t('space.issues.searchIssue')}
              title={t('space.issues.searchIssue')}
            >
              <Search className="h-4 w-4" />
            </button>
            <CustomSelect value={selectedStatus} options={statusFilterOptions} onChange={onStatusChange} size="toolbar" className="w-40 min-w-0 max-xl:w-36" />
            <CustomSelect value={selectedGoalId} options={goalOptions} onChange={onGoalChange} size="toolbar" className="w-56 min-w-0 max-xl:w-44" />
            <button
              type="button"
              onClick={() => void onRefresh()}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-transparent text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              aria-label={t('space.common.refresh')}
              title={t('space.common.refresh')}
            >
              {issuesLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onCreate}
          className="ml-auto flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] shadow-sm transition-colors hover:bg-[var(--button-primary-bg-hover)]"
        >
          <Plus className="h-4 w-4" />
          {t('space.common.create')}
        </button>
      </section>

      <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-3">
        <section className="mx-auto max-w-[1280px]" aria-label="Issue list">
          <div className="border-y border-[var(--line-subtle)]">
            {issues.length === 0 && issuesLoading ? (
              <div className="grid gap-0">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="min-h-[78px] border-b border-[var(--line-subtle)] py-4 last:border-b-0">
                    <div className="h-4 w-44 rounded-md bg-[var(--paper-inset)]" />
                    <div className="mt-3 h-3 w-72 rounded-md bg-[var(--paper-inset)]" />
                  </div>
                ))}
              </div>
            ) : issues.length === 0 ? (
              <div className="grid min-h-44 place-items-center border-x border-dashed border-[var(--line-subtle)] text-sm text-[var(--ink-muted)]">
                <div className="text-center">
                  <p>{t('space.issues.empty')}</p>
                  {admin && (
                    <button
                      type="button"
                      onClick={onCreate}
                      className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                    >
                      <Plus className="h-4 w-4" />
                      {t('space.issues.createIssue')}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              issues.map((issue, index) => (
                <IssueStreamRow
                  key={issue.id}
                  issue={issue}
                  active={activeIssueId === issue.id}
                  index={index}
                  onOpen={() => onOpenIssue(issue.id)}
                />
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function IssueStreamRow({
  issue,
  active,
  index,
  onOpen,
}: {
  issue: SpaceIssue;
  active: boolean;
  index: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation('app');
  const displayTitle = issueDisplayTitle(issue);
  const authorName = issue.creator?.name ?? issue.creator?.id ?? issue.author?.name ?? issue.author?.id ?? 'owner';
  const handlerName = claimHandlerLabel(issue.claim);
  const goalLabel = issue.goalPathLabel || (issue.goalId ? issue.goalId : t('space.filters.inbox'));
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ animationDelay: `${index * 42}ms` }}
      className={`grid min-h-[78px] w-full border-b border-[var(--line-subtle)] px-1 py-4 text-left transition-colors last:border-b-0 sm:px-3 ${
        active ? 'bg-[var(--paper-elevated)]/70 shadow-[inset_3px_0_0_var(--accent-warm)]' : 'hover:bg-[var(--paper-elevated)]/60'
      }`}
    >
      <span className="min-w-0">
        <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
          <span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusPillClass(issue.state)}`}>{issueStatusLabel(issue.state)}</span>
          <span className="truncate text-base font-semibold leading-6 text-[var(--ink)]">{displayTitle}</span>
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
          <span>{authorName}</span>
          <span className="text-[var(--line-strong)]">·</span>
          <span>{formatTime(issue.createdAt)}</span>
          <span className="text-[var(--line-strong)]">·</span>
          <span>{t('space.issues.comments', { count: issue.commentCount ?? 0 })}</span>
          {handlerName && (
            <>
              <span className="text-[var(--line-strong)]">·</span>
              <span className="rounded-md bg-[var(--warning-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--warning)]">
                {t('space.issues.claimHandler', { name: handlerName })}
              </span>
            </>
          )}
          <span className="text-[var(--line-strong)]">·</span>
          <span className="rounded-md bg-[var(--accent-cool)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--accent-cool)]">{goalLabel}</span>
          {issue.humanOnly && (
            <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
              {t('space.issues.humanOnly')}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
