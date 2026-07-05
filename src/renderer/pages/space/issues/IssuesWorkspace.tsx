import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, RefreshCw, Search, X } from 'lucide-react';

import type { SpaceIssue } from '@/api/spaceCloud';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import { SpaceIdentityLine } from '@/pages/space/SpaceAvatar';
import { ACTIVE_ISSUE_STATE_FILTER, claimHandlerLabel, ISSUE_STATUSES, issueDisplayNumber, issueDisplayTitle, issueStatusLabel } from '@/pages/space/spaceHelpers';
import { recordSpaceMetric } from '@/pages/space/spaceMetrics';
import { SPACE_LIST_FRAME_CLASS, SPACE_PRIMARY_TOOL_BUTTON_CLASS, SPACE_REFRESH_TOOL_BUTTON_CLASS, formatTime, statusPillClass } from '@/pages/space/spaceUi';

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
  const statusFilterOptions = useMemo<SelectOption[]>(
    () => [
      { value: ACTIVE_ISSUE_STATE_FILTER, label: t('space.filters.activeStatuses') },
      ...ISSUE_STATUSES.map((status) => ({ value: status, label: issueStatusLabel(status, t) })),
    ],
    [t],
  );

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
            <CustomSelect value={selectedGoalId} options={goalOptions} onChange={onGoalChange} size="toolbar" className="w-[360px] min-w-0 max-xl:w-[320px] max-lg:w-64" />
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          <button type="button" onClick={onCreate} className={SPACE_PRIMARY_TOOL_BUTTON_CLASS}>
            <Plus className="h-4 w-4" />
            {t('space.common.create')}
          </button>
          <button
            type="button"
            onClick={() => void onRefresh()}
            className={SPACE_REFRESH_TOOL_BUTTON_CLASS}
            aria-label={t('space.common.refresh')}
            title={t('space.common.refresh')}
          >
            {issuesLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </section>

      <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-3">
        <section className={SPACE_LIST_FRAME_CLASS} aria-label="Issue list">
          <div className="border-y border-[var(--line-subtle)]">
            {issues.length === 0 && issuesLoading ? (
              <div className="grid gap-0">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="min-h-[68px] border-b border-[var(--line-subtle)] py-3 last:border-b-0">
                    <div className="h-3.5 w-44 rounded-md bg-[var(--paper-inset)]" />
                    <div className="mt-2 h-3 w-72 rounded-md bg-[var(--paper-inset)]" />
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
  const displayNumber = issueDisplayNumber(issue);
  const author = issue.creator ?? issue.author ?? null;
  const handlerName = claimHandlerLabel(issue.claim);
  const goalLabel = issue.goalPathLabel || issue.goalId || null;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ animationDelay: `${index * 42}ms` }}
      className={`grid min-h-[68px] w-full border-b border-[var(--line-subtle)] px-1 py-3 text-left transition-colors last:border-b-0 sm:px-3 ${
        active ? 'bg-[var(--paper-elevated)]/70 shadow-[inset_3px_0_0_var(--accent-warm)]' : 'hover:bg-[var(--hover-bg)]'
      }`}
    >
      <span className="min-w-0">
        <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
          <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-md px-2 text-xs font-semibold ${statusPillClass(issue.state)}`}>
            {issueStatusLabel(issue.state, t)}
          </span>
          <span className="truncate text-sm font-semibold leading-5 text-[var(--ink)]">{displayTitle}</span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-normal leading-5 text-[var(--ink-subtle)]">
          {displayNumber && (
            <>
              <span className="text-[var(--ink-muted)]">{displayNumber}</span>
              <span className="text-[var(--line-strong)]">·</span>
            </>
          )}
          <SpaceIdentityLine
            name={author?.name ?? author?.id ?? 'owner'}
            avatarUrl={author?.avatarUrl}
            avatarSize={18}
            nameClassName="font-medium text-[var(--ink-subtle)]"
          />
          <span className="text-[var(--line-strong)]">·</span>
          <span>{formatTime(issue.createdAt)}</span>
          <span className="text-[var(--line-strong)]">·</span>
          <span>{t('space.issues.comments', { count: issue.commentCount ?? 0 })}</span>
          {handlerName && (
            <>
              <span className="text-[var(--line-strong)]">·</span>
              <span className="rounded-md bg-[var(--warning-bg)]/70 px-2 py-0.5 text-xs font-semibold text-[var(--warning)]">
                {t('space.issues.claimHandler', { name: handlerName })}
              </span>
            </>
          )}
          {goalLabel && (
            <>
              <span className="text-[var(--line-strong)]">·</span>
              <span className="inline-flex max-w-[46ch] truncate rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)]/45 px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">{goalLabel}</span>
            </>
          )}
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
