// Cron Task Status Bar - non-blocking composer status for armed/running/stopped cron tasks.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Flag, Settings2, Square, Timer, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CronSchedule, GoalStatus } from '@/types/cronTask';
import { isSupportedLocale } from '@/../shared/i18n';
import {
  formatCronCountdown,
  formatCronExecutionCount,
  formatCronScheduleForStatusBar,
} from '@/utils/cronTaskI18n';

type CronTaskStatusBarMode = 'draft' | 'running' | 'executing' | 'stopped';

interface CronTaskStatusBarProps {
  mode?: CronTaskStatusBarMode;
  intervalMinutes: number;
  schedule?: CronSchedule | null;
  executionCount?: number;
  maxExecutions?: number;
  nextExecutionAt?: string | null;
  executionNumber?: number;
  goalStatus?: GoalStatus;
  goalObjective?: string | null;
  goalTerminalReason?: string | null;
  onGoalObjectiveClick?: () => void;
  onSettings?: () => void;
  onCancel?: () => void;
  onStop?: () => void;
  onDismissStopped?: () => void;
}

export default function CronTaskStatusBar({
  mode = 'draft',
  intervalMinutes,
  schedule,
  executionCount = 0,
  maxExecutions,
  nextExecutionAt,
  executionNumber,
  goalStatus,
  goalObjective,
  goalTerminalReason,
  onGoalObjectiveClick,
  onSettings,
  onCancel,
  onStop,
  onDismissStopped,
}: CronTaskStatusBarProps) {
  const { t, i18n } = useTranslation('task');
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
  const [now, setNow] = useState(() => Date.now());
  const isGoalMode = Boolean(goalStatus) || (mode === 'draft' && schedule?.kind === 'loop');
  const isGoalPaused = goalStatus === 'paused';
  const isGoalTerminal = goalStatus === 'complete' || goalStatus === 'blocked' || goalStatus === 'canceled';
  const isActive = (mode === 'running' || mode === 'executing') && !isGoalTerminal;
  const canStop = isGoalMode
    ? mode !== 'draft' && !isGoalTerminal
    : isActive;
  const statusColor = !isGoalMode
    ? 'var(--heartbeat)'
    : goalStatus === 'complete'
      ? 'var(--success)'
      : goalStatus === 'blocked'
        ? 'var(--warning)'
        : goalStatus === 'paused' || goalStatus === 'canceled' || mode === 'stopped'
          ? 'var(--ink-muted)'
          : 'var(--heartbeat)';
  const statusStyle = {
    '--goal-status-color': statusColor,
    borderColor: `color-mix(in srgb, ${statusColor} 24%, transparent)`,
    backgroundColor: `color-mix(in srgb, var(--paper) 92%, ${statusColor})`,
  } as CSSProperties;

  useEffect(() => {
    if (!isActive || !nextExecutionAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive, nextExecutionAt]);

  const countdown = useMemo(
    () => mode === 'running' ? formatCronCountdown(nextExecutionAt, now, t) : null,
    [mode, nextExecutionAt, now, t],
  );

  const title = isGoalMode
    ? mode === 'draft'
      ? t('cron.statusBar.goalDraftTitle')
      : goalStatus === 'complete'
        ? t('cron.statusBar.goalCompleteTitle')
        : goalStatus === 'blocked'
          ? t('cron.statusBar.goalBlockedTitle')
          : goalStatus === 'canceled' || mode === 'stopped'
            ? t('cron.statusBar.goalCanceledTitle')
            : isGoalPaused
              ? t('cron.statusBar.goalPausedTitle')
              : mode === 'executing'
                ? t('cron.statusBar.loopExecutingTitle')
                : t('cron.statusBar.loopRunningTitle')
    : mode === 'draft'
      ? t('cron.statusBar.draftTitle')
      : mode === 'stopped'
        ? t('cron.statusBar.stoppedTitle')
        : (mode === 'executing' ? t('cron.statusBar.executingTitle') : t('cron.statusBar.runningTitle'));

  const goalObjectiveText = (goalObjective ?? '').trim();
  const goalRound = executionNumber ?? executionCount + 1;
  const goalRoundText = mode === 'executing'
    ? t('cron.statusBar.roundExecuting', { count: goalRound })
    : t('cron.statusBar.roundRunning', { count: Math.max(1, executionCount) });
  const detail = isGoalMode
    ? goalTerminalReason?.trim()
      || (isGoalPaused
        ? t('cron.statusBar.goalPausedDetail')
        : mode === 'executing' || mode === 'running'
          ? goalRoundText
          : goalObjectiveText || t('cron.statusBar.goalObjectiveFallback'))
    : mode === 'stopped'
    ? t('cron.statusBar.stoppedDetail')
    : [
        formatCronScheduleForStatusBar(schedule, intervalMinutes, t, locale),
        mode === 'executing'
          ? t('cron.statusBar.roundExecuting', { count: executionNumber ?? executionCount + 1 })
          : countdown,
        isActive ? formatCronExecutionCount(executionCount, t, maxExecutions) : null,
      ].filter(Boolean).join(' · ');

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-t-lg border border-b-0 border-[var(--heartbeat-border)] px-3 py-2"
      style={statusStyle}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="relative shrink-0">
          {isGoalMode
            ? <Flag className={`h-4 w-4 text-[var(--goal-status-color)] ${mode === 'stopped' || isGoalTerminal ? 'opacity-60' : ''}`} />
            : <Timer className={`h-4 w-4 text-[var(--heartbeat)] ${mode === 'stopped' ? 'opacity-60' : ''}`} />}
          {mode === 'executing' && (
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--goal-status-color)] opacity-40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--goal-status-color)]" />
            </span>
          )}
        </span>
        <span className="shrink-0 text-sm font-medium text-[var(--goal-status-color)]">
          {title}
        </span>
        {isGoalMode && goalObjectiveText && !isGoalTerminal ? (
          <button
            type="button"
            onClick={onGoalObjectiveClick}
            className="min-w-0 truncate text-left text-sm text-[var(--ink-muted)] transition hover:text-[var(--ink)]"
            title={t('cron.statusBar.goalEditTitle')}
          >
            {`${goalRoundText} · ${goalObjectiveText}`}
          </button>
        ) : (
          <span className="min-w-0 truncate text-sm text-[var(--ink-muted)]">
            {detail}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {mode === 'draft' && onSettings && (
          <button
            type="button"
            onClick={onSettings}
            className="rounded-md p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--heartbeat-bg)] hover:text-[var(--heartbeat)]"
            title={t('cron.statusBar.settingsTitle')}
          >
            <Settings2 className="h-4 w-4" />
          </button>
        )}
        {mode === 'draft' && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--heartbeat-bg)] hover:text-[var(--heartbeat)]"
            title={t('cron.statusBar.cancelTitle')}
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {canStop && onStop && (
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--goal-status-color)] transition hover:bg-[var(--heartbeat-bg)]"
            title={isGoalMode ? t('cron.statusBar.cancelGoalTitle') : t('cron.statusBar.stopTitle')}
          >
            {isGoalMode ? <X className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
            {isGoalMode ? t('cron.statusBar.cancelGoalButton') : t('cron.statusBar.stopButton')}
          </button>
        )}
        {mode === 'stopped' && onDismissStopped && (
          <button
            type="button"
            onClick={onDismissStopped}
            className="rounded-md p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--heartbeat-bg)] hover:text-[var(--heartbeat)]"
            title={isGoalMode ? t('cron.statusBar.dismissGoalTitle') : t('cron.statusBar.dismissStoppedTitle')}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
