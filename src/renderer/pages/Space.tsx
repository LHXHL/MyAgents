import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  RefreshCw,
} from 'lucide-react';

import {
  DEFAULT_SPACE_ID,
  spaceAuthAck,
  spaceAuthPoll,
  spaceAuthStart,
  spaceErrorMessage,
  type SpaceEvent,
} from '@/api/spaceCloud';
import { type SelectOption } from '@/components/CustomSelect';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import {
  buildIssueQueryKey,
  isSpaceAdmin,
  type IssueQueryParams,
} from '@/pages/space/spaceHelpers';
import {
  getIssueListState,
  SPACE_VISIBLE_REFRESH_TTL_MS,
} from '@/pages/space/spaceStore';
import { useSpaceData } from '@/pages/space/useSpaceData';
import { IssuesWorkspace } from '@/pages/space/issues/IssuesWorkspace';
import { CreateIssueDialog } from '@/pages/space/issues/CreateIssueDialog';
import { IssueDetailDrawer } from '@/pages/space/issues/IssueDetailDrawer';
import { AgentsWorkspace, RegisterAgentDialog } from '@/pages/space/agents/AgentsWorkspace';
import { GoalsWorkspace } from '@/pages/space/goals/GoalsWorkspace';
import { SkillsWorkspace } from '@/pages/space/skills/SkillsWorkspace';
import { SpaceLogin, SpaceSidebar, type SpaceViewMode as ViewMode } from '@/pages/space/SpaceChrome';
import { nowForSpaceMetric, recordSpaceMetric } from '@/pages/space/spaceMetrics';
import { PAPER_GRID_STYLE, SPACE_BACKGROUND_STYLE } from '@/pages/space/spaceUi';

const AUTH_POLL_DELAY_MS = 2000;
const SPACE_EVENTS_SYNC_INTERVAL_MS = 15_000;

function errMessage(error: unknown): string {
  return spaceErrorMessage(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}


export default function Space({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const { projects } = useConfig();
  const spaceData = useSpaceData({ isActive });
  const { actions } = spaceData;
  const [authBusy, setAuthBusy] = useState(false);
  const [authFlow, setAuthFlow] = useState<{ token: string; expiresAt: number } | null>(null);
  const authPollWarningShownRef = useRef(false);
  const [mode, setMode] = useState<ViewMode>('issues');
  const [issueQ, setIssueQ] = useState('');
  const [selectedGoalId, setSelectedGoalId] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [issueDetailId, setIssueDetailId] = useState<string | null>(null);
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);

  const session = spaceData.session;
  const goals = spaceData.goals;
  const issueQuery = useMemo<IssueQueryParams>(() => ({
    q: issueQ,
    goalId: selectedGoalId,
    includeSubtree: Boolean(selectedGoalId),
    state: selectedStatus,
    limit: 50,
  }), [issueQ, selectedGoalId, selectedStatus]);
  const issueQueryRef = useRef(issueQuery);
  const issueQueryKey = useMemo(() => buildIssueQueryKey(issueQuery), [issueQuery]);
  const issueList = getIssueListState(issueQuery);
  const issues = issueList.items;
  const issuesLoading = issueList.isLoading || (spaceData.boot === 'ready' && issueList.lastFetchedAt === 0);
  const skills = spaceData.skills.items;
  const skillsLoading = spaceData.skills.isLoading || (spaceData.boot === 'ready' && spaceData.skills.lastFetchedAt === 0);
  const effectiveSelectedSkillId = selectedSkillId ?? skills[0]?.id ?? null;
  const localAgents = spaceData.localAgents.items;
  const admin = isSpaceAdmin(session);
  const activeCacheSpaceId = spaceData.spaceId || session?.space?.id || session?.space?.slug || DEFAULT_SPACE_ID;
  const spaceCacheKey = useCallback((id: string) => `${activeCacheSpaceId}\n${id}`, [activeCacheSpaceId]);

  const goalOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: t('space.filters.allGoals') },
      ...goals.map((goal) => ({ value: goal.id, label: goal.goalPathLabel || goal.title })),
    ],
    [goals, t],
  );

  useEffect(() => {
    issueQueryRef.current = issueQuery;
  }, [issueQuery]);

  useEffect(() => {
    if (spaceData.boot !== 'ready') return;
    if (mode === 'issues') {
      const handle = window.setTimeout(() => {
        actions.refreshIssues(issueQuery, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(spaceErrorMessage(error)));
      }, 220);
      return () => window.clearTimeout(handle);
    }
    if (mode === 'goals') {
      void actions.refreshGoals({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(spaceErrorMessage(error)));
    }
    if (mode === 'skills') {
      void actions.refreshSkills({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(spaceErrorMessage(error)));
    }
    if (mode === 'agents') {
      void Promise.all([
        actions.refreshLocalAgents({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }),
        actions.refreshRegisteredAgents({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }),
      ]).catch((error) => toast.error(spaceErrorMessage(error)));
    }
  }, [actions, issueQuery, issueQueryKey, mode, spaceData.boot, toast]);

  const revalidateForEvents = useCallback(async (events: SpaceEvent[]) => {
    if (events.length === 0) return;
    const startedAt = nowForSpaceMetric();
    recordSpaceMetric('space_tab_visible_revalidate_start', { count: events.length });
    let refreshIssueList = false;
    let refreshSkills = false;
    let refreshAgents = false;
    let refreshBoot = false;
    const touchedIssueIds = new Set<string>();

    for (const event of events) {
      const type = event.type;
      const resourceType = event.resourceType ?? '';
      if (resourceType === 'issue' || resourceType === 'comment' || type.startsWith('issue.') || type.startsWith('comment.')) {
        refreshIssueList = true;
        if (resourceType === 'issue' && event.resourceId) touchedIssueIds.add(event.resourceId);
      }
      if (resourceType === 'skill' || type.startsWith('skill.')) {
        refreshSkills = true;
      }
      if (
        resourceType === 'registered_agent'
        || resourceType === 'delivery'
        || resourceType === 'subscription'
        || type.startsWith('registered_agent.')
        || type.startsWith('delivery.')
        || type.startsWith('subscription.')
      ) {
        refreshAgents = true;
        if (resourceType === 'delivery') refreshIssueList = true;
      }
      if (resourceType === 'goal' || type.startsWith('goal.')) {
        refreshBoot = true;
        refreshIssueList = true;
      }
    }

    const jobs: Array<Promise<void>> = [];
    if (refreshBoot) jobs.push(actions.ensureBootstrapped({ force: true, silent: true }));
    if (refreshIssueList) jobs.push(actions.refreshIssues(issueQueryRef.current, { force: true, silent: true }));
    if (issueDetailId && (refreshIssueList || touchedIssueIds.has(issueDetailId))) {
      jobs.push(actions.refreshIssueDetail(issueDetailId, { force: true, silent: true }));
    }
    if (refreshSkills) {
      jobs.push(actions.refreshSkills({ force: true, silent: true }));
      if (effectiveSelectedSkillId) {
        jobs.push(actions.refreshSkillDetail(effectiveSelectedSkillId, { force: true, silent: true }));
      }
    }
    if (refreshAgents) {
      jobs.push(actions.refreshLocalAgents({ force: true, silent: true }));
      jobs.push(actions.refreshRegisteredAgents({ force: true, silent: true }));
    }
    try {
      await Promise.all(jobs);
      recordSpaceMetric('space_tab_visible_revalidate_end', {
        count: events.length,
        durationMs: Math.round(nowForSpaceMetric() - startedAt),
        ok: true,
      });
    } catch (error) {
      recordSpaceMetric('space_tab_visible_revalidate_end', {
        count: events.length,
        durationMs: Math.round(nowForSpaceMetric() - startedAt),
        ok: false,
        error: spaceErrorMessage(error),
      });
      throw error;
    }
  }, [actions, effectiveSelectedSkillId, issueDetailId]);

  useEffect(() => {
    if (!isActive || spaceData.boot !== 'ready') return;
    let cancelled = false;
    const sync = async () => {
      try {
        const events = await actions.syncEvents({ maxAgeMs: 5_000, silent: true });
        if (!cancelled) await revalidateForEvents(events);
      } catch (error) {
        if (!cancelled) toast.error(spaceErrorMessage(error));
      }
    };
    void sync();
    const handle = window.setInterval(() => {
      void sync();
    }, SPACE_EVENTS_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [actions, isActive, revalidateForEvents, spaceData.boot, toast]);

  useEffect(() => {
    if (!authFlow) return;
    let cancelled = false;

    const stopAuth = () => {
      authPollWarningShownRef.current = false;
      setAuthFlow(null);
      setAuthBusy(false);
    };

    const poll = async () => {
      while (!cancelled && Date.now() < authFlow.expiresAt) {
        const startedAt = Date.now();
        try {
          const result = await spaceAuthPoll(authFlow.token);
          if (cancelled) return;
          if (result.status === 'done') {
            stopAuth();
            toast.success(t('space.toasts.loginSuccess'));
            await actions.ensureBootstrapped({ force: true });
            void spaceAuthAck(authFlow.token).catch((error) => {
              console.warn('[Space] auth ack failed:', errMessage(error));
            });
            return;
          }
          if (result.status === 'failed') {
            stopAuth();
            toast.error(String(result.error ?? t('space.toasts.loginFailed')));
            void spaceAuthAck(authFlow.token).catch((error) => {
              console.warn('[Space] auth ack failed:', errMessage(error));
            });
            return;
          }
        } catch (_error) {
          if (cancelled) return;
          if (!authPollWarningShownRef.current && Date.now() < authFlow.expiresAt) {
            authPollWarningShownRef.current = true;
            toast.warning(t('space.toasts.loginSlow'));
          }
        }
        const elapsed = Date.now() - startedAt;
        await wait(Math.max(0, AUTH_POLL_DELAY_MS - elapsed));
      }

      if (!cancelled) {
        stopAuth();
        toast.error(t('space.toasts.loginTimeout'));
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [actions, authFlow, t, toast]);

  const startLogin = useCallback(async () => {
    setAuthBusy(true);
    try {
      const result = await spaceAuthStart();
      authPollWarningShownRef.current = false;
      setAuthFlow({
        token: result.loginToken,
        expiresAt: Date.now() + result.expiresInSeconds * 1000,
      });
      toast.info(t('space.toasts.browserLoginOpened'));
    } catch (error) {
      setAuthBusy(false);
      toast.error(spaceErrorMessage(error));
    }
  }, [t, toast]);

  const selectSpaceTab = useCallback((next: ViewMode) => {
    setMode(next);
    setIssueDetailId(null);
  }, []);

  const refreshCurrent = useCallback(async () => {
    if (mode === 'issues') await actions.refreshIssues(issueQuery, { force: true });
    if (mode === 'goals') await actions.refreshGoals({ force: true });
    if (mode === 'skills') await actions.refreshSkills({ force: true });
    if (mode === 'agents') {
      await Promise.all([
        actions.refreshLocalAgents({ force: true }),
        actions.refreshRegisteredAgents({ force: true }),
      ]);
    }
    toast.success(t('space.toasts.refreshed'));
  }, [actions, issueQuery, mode, t, toast]);

  const logout = useCallback(async () => {
    try {
      await actions.logout();
      setIssueDetailId(null);
      toast.success(t('space.toasts.logoutSuccess'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  }, [actions, t, toast]);

  if (spaceData.boot === 'idle' || spaceData.boot === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('space.common.loadingTeam')}
      </div>
    );
  }

  if (spaceData.boot === 'error') {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]">
        <div className="text-center">
          <p>{spaceData.bootError ?? t('space.common.teamLoadFailed')}</p>
          <button
            type="button"
            onClick={() => void actions.ensureBootstrapped({ force: true }).catch((error) => toast.error(spaceErrorMessage(error)))}
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]"
          >
            <RefreshCw className="h-4 w-4" />
            {t('space.common.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (!session) {
    return <SpaceLogin authBusy={authBusy} authFlow={authFlow} onLogin={startLogin} />;
  }

  return (
    <div className="relative h-full overflow-hidden bg-[var(--paper)]" style={SPACE_BACKGROUND_STYLE}>
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-20" style={PAPER_GRID_STYLE} />
      <div className="relative z-10 flex h-full min-h-0">
        <SpaceSidebar
          session={session}
          mode={mode}
          onSpaceTabChange={selectSpaceTab}
          onLogout={logout}
        />
        <section className="flex min-w-0 flex-1 flex-col">
          {mode === 'issues' && (
            <IssuesWorkspace
              admin={admin}
              issues={issues}
              issuesLoading={issuesLoading}
              issueQ={issueQ}
              selectedGoalId={selectedGoalId}
              selectedStatus={selectedStatus}
              goalOptions={goalOptions}
              activeIssueId={issueDetailId}
              onQueryChange={setIssueQ}
              onGoalChange={setSelectedGoalId}
              onStatusChange={setSelectedStatus}
              onRefresh={refreshCurrent}
              onCreate={() => setCreateIssueOpen(true)}
              onOpenIssue={setIssueDetailId}
            />
          )}
          {mode === 'skills' && (
            <SkillsWorkspace
              admin={admin}
              skills={skills}
              loading={skillsLoading}
              selectedSkillId={effectiveSelectedSkillId}
              projects={projects}
              actions={actions}
              skillDetailState={effectiveSelectedSkillId ? spaceData.skillDetails[spaceCacheKey(effectiveSelectedSkillId)] : undefined}
              onSelectSkill={setSelectedSkillId}
              onRefresh={refreshCurrent}
              onUploaded={(id) => setSelectedSkillId(id)}
            />
          )}
          {mode === 'goals' && (
            <GoalsWorkspace
              admin={admin}
              session={session}
              goals={goals}
              actions={actions}
              onRefresh={() => actions.refreshGoals({ force: true })}
              onOpenIssuesForGoal={(goalId) => {
                setSelectedGoalId(goalId);
                setMode('issues');
              }}
            />
          )}
          {mode === 'agents' && (
            <AgentsWorkspace
              admin={admin}
              agents={localAgents}
              projects={projects}
              actions={actions}
              onRefresh={refreshCurrent}
              onRegister={() => setRegisterOpen(true)}
            />
          )}
        </section>
      </div>

      {issueDetailId && (
        <IssueDetailDrawer
          issueId={issueDetailId}
          session={session}
          projects={projects}
          detailState={spaceData.issueDetails[spaceCacheKey(issueDetailId)]}
          actions={actions}
          onClose={() => setIssueDetailId(null)}
          onChanged={() => void actions.refreshIssues(issueQuery, { force: true, silent: true })}
        />
      )}

      {createIssueOpen && (
        <CreateIssueDialog
          goals={goals}
          actions={actions}
          issueQuery={issueQuery}
          onClose={() => setCreateIssueOpen(false)}
          onCreated={(keepOpen) => {
            if (!keepOpen) setCreateIssueOpen(false);
            void actions.refreshIssues(issueQuery, { force: true, silent: true });
          }}
        />
      )}

      {registerOpen && (
        <RegisterAgentDialog
          projects={projects}
          goals={goals}
          actions={actions}
          onClose={() => setRegisterOpen(false)}
          onRegistered={() => {
            setRegisterOpen(false);
            void Promise.all([
              actions.refreshLocalAgents({ force: true, silent: true }),
              actions.refreshRegisteredAgents({ force: true, silent: true }),
            ]);
          }}
        />
      )}
    </div>
  );
}
