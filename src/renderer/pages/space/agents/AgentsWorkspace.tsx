import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Bot, Check, Clock, Computer, FolderOpen, Loader2, Plus, Power, PowerOff, RefreshCw, Settings, Target, Trash2, X } from 'lucide-react';

import type { LocalRegisteredAgent, SpaceGoal, SpaceIssueSubscriptionRunMode } from '@/api/spaceCloud';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import ConfirmDialog from '@/components/ConfirmDialog';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import type { Project } from '@/config/types';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { spaceErrorMessage } from '@/api/spaceCloud';
import { issueStatusLabel } from '@/pages/space/spaceHelpers';
import { GoalPathSelectLabel } from '@/pages/space/GoalPathSelectLabel';
import type { SpaceActions } from '@/pages/space/spaceStore';
import { SPACE_LIST_FRAME_CLASS, SPACE_PRIMARY_TOOL_BUTTON_CLASS, SPACE_REFRESH_TOOL_BUTTON_CLASS, SPACE_TWO_COLUMN_GRID_CLASS, formatTime } from '@/pages/space/spaceUi';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import { workspacePathsEqual } from '../../../../shared/workspacePath';

function initials(value?: string | null): string {
  const source = value?.trim() || 'MA';
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

const DEFAULT_ISSUE_SUBSCRIPTION_RUN_MODE: SpaceIssueSubscriptionRunMode = 'single_session';
const DEFAULT_AGENT_STATE_FILTER = ['todo'];
const AGENT_SUBSCRIPTION_STATE_OPTIONS = ['todo', 'open'] as const;

function normalizeIssueSubscriptionRunMode(value?: SpaceIssueSubscriptionRunMode | null): SpaceIssueSubscriptionRunMode {
  return value === 'new_session' ? 'new_session' : DEFAULT_ISSUE_SUBSCRIPTION_RUN_MODE;
}

function issueSubscriptionRunModeLabel(t: ReturnType<typeof useTranslation>['t'], mode?: SpaceIssueSubscriptionRunMode | null): string {
  return normalizeIssueSubscriptionRunMode(mode) === 'new_session' ? t('space.agents.issueSubscriptionNewSession') : t('space.agents.issueSubscriptionSingleSession');
}

function issueStateFilterLabel(t: ReturnType<typeof useTranslation>['t'], states?: string[] | null): string {
  return normalizeAgentStateFilter(states).map((state) => issueStatusLabel(state, t)).join(', ');
}

function normalizeAgentStateFilter(states?: string[] | null): string[] {
  const allowed = new Set<string>(AGENT_SUBSCRIPTION_STATE_OPTIONS);
  const selected = new Set((states?.length ? states : DEFAULT_AGENT_STATE_FILTER)
    .map((state) => state.trim().toLowerCase())
    .filter((state) => allowed.has(state)));
  const normalized = AGENT_SUBSCRIPTION_STATE_OPTIONS.filter((state) => selected.has(state));
  return normalized.length > 0 ? normalized : [...DEFAULT_AGENT_STATE_FILTER];
}

function agentStatusClass(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'active' || normalized === 'online') return 'bg-[var(--success-bg)] text-[var(--success)]';
  if (normalized === 'revoked') return 'bg-[var(--error-bg)] text-[var(--error)]';
  return 'bg-[var(--paper-inset)] text-[var(--ink-muted)]';
}

function agentTargetLabel(agent: LocalRegisteredAgent, t: ReturnType<typeof useTranslation>['t']): string {
  const target = agent.goalPathLabel?.trim() || agent.goalId?.trim();
  return target || t('space.agents.targetNotSet');
}

function localComputerLabel(agent: LocalRegisteredAgent, t: ReturnType<typeof useTranslation>['t']): string {
  return agent.deviceName?.trim() || agent.clientId?.trim() || t('space.agents.localComputerFallback');
}

function agentWorkspacePathLabel(agent: LocalRegisteredAgent, t: ReturnType<typeof useTranslation>['t']): string {
  const path = agent.workspacePath?.trim();
  if (path) return shortenPathForDisplay(path);
  return agent.workspaceLabel?.trim() || t('space.agents.workspacePathUnavailable');
}

function projectLabel(project: Project): string {
  return project.displayName || project.name;
}

function findAgentProject(agent: LocalRegisteredAgent, projects: Project[]): Project | undefined {
  const workspaceId = agent.localWorkspaceId || agent.workspaceId;
  return (workspaceId ? projects.find((project) => project.id === workspaceId) : undefined)
    ?? projects.find((project) => workspacePathsEqual(project.path, agent.workspacePath));
}

export function AgentsWorkspace({ admin, agents, goals, projects, actions, onRefresh, onRegister }: { admin: boolean; agents: LocalRegisteredAgent[]; goals: SpaceGoal[]; projects: Project[]; actions: SpaceActions; onRefresh: () => Promise<void>; onRegister: () => void }) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<LocalRegisteredAgent | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<LocalRegisteredAgent | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;

  const toggleAgentStatus = async (agent: LocalRegisteredAgent) => {
    const nextStatus = agent.status === 'disabled' ? 'active' : 'disabled';
    setBusyAgentId(agent.id);
    try {
      await actions.updateRegisteredAgent({ id: agent.id, status: nextStatus });
      toast.success(nextStatus === 'active' ? t('space.toasts.agentEnabled') : t('space.toasts.agentDisabled'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusyAgentId(null);
    }
  };
  const revokeAgent = async () => {
    if (!revokeTarget) return;
    setBusyAgentId(revokeTarget.id);
    try {
      await actions.revokeRegisteredAgent(revokeTarget.id);
      toast.success(t('space.toasts.agentRevoked'));
      setRevokeTarget(null);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusyAgentId(null);
    }
  };

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
        <section className="flex min-h-12 items-center gap-2.5 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-1.5 backdrop-blur-md">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
            <Bot className="h-4 w-4 shrink-0" />
            <span>Agents</span>
            <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">{agents.length}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            {admin && (
              <button type="button" onClick={onRegister} className={SPACE_PRIMARY_TOOL_BUTTON_CLASS}>
                <Plus className="h-4 w-4" />
                {t('space.agents.register')}
              </button>
            )}
            <button type="button" onClick={() => void onRefresh()} className={SPACE_REFRESH_TOOL_BUTTON_CLASS} aria-label={t('space.common.refresh')} title={t('space.common.refresh')}>
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </section>
        <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-3">
          {agents.length === 0 ? (
            <div className={`${SPACE_LIST_FRAME_CLASS} grid h-40 place-items-center rounded-[20px] border border-dashed border-[var(--line)] bg-[var(--paper-elevated)]/40 text-sm text-[var(--ink-muted)]`}>
              <div className="text-center">
                <Bot className="mx-auto mb-3 h-8 w-8 text-[var(--ink-muted)]" />
                <p>{t('space.agents.empty')}</p>
                {admin && (
                  <button type="button" onClick={onRegister} className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]">
                    <Plus className="h-4 w-4" />
                    {t('space.agents.registerAgent')}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className={`${SPACE_LIST_FRAME_CLASS} ${SPACE_TWO_COLUMN_GRID_CLASS}`}>
              {agents.map((agent) => (
                <AgentCard key={agent.id} agent={agent} admin={admin} busy={busyAgentId === agent.id} t={t} onOpen={() => setSelectedAgentId(agent.id)} onEdit={() => setEditingAgent(agent)} onToggle={() => void toggleAgentStatus(agent)} onRevoke={() => setRevokeTarget(agent)} />
              ))}
            </div>
          )}
        </main>
      </div>
      {selectedAgent && <AgentDetailOverlay agent={selectedAgent} admin={admin} busy={busyAgentId === selectedAgent.id} t={t} onClose={() => setSelectedAgentId(null)} onEdit={() => setEditingAgent(selectedAgent)} onToggle={() => void toggleAgentStatus(selectedAgent)} onRevoke={() => setRevokeTarget(selectedAgent)} />}
      {editingAgent && <EditAgentDialog agent={editingAgent} goals={goals} projects={projects} actions={actions} onClose={() => setEditingAgent(null)} onSaved={() => setEditingAgent(null)} />}
      {revokeTarget && (
        <ConfirmDialog
          title={t('space.agents.revokeTitle')}
          message={t('space.agents.revokeMessage', {
            name: revokeTarget.displayName,
          })}
          confirmText={t('space.agents.revoke')}
          cancelText={t('space.common.cancel')}
          confirmVariant="danger"
          loading={busyAgentId === revokeTarget.id}
          onConfirm={() => void revokeAgent()}
          onCancel={() => setRevokeTarget(null)}
        />
      )}
    </>
  );
}

function EditAgentDialog({ agent, goals, projects, actions, onClose, onSaved }: { agent: LocalRegisteredAgent; goals: SpaceGoal[]; projects: Project[]; actions: SpaceActions; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const [displayName, setDisplayName] = useState(agent.displayName);
  const canEditWorkspace = agent.isLocal !== false;
  const currentProject = useMemo(() => findAgentProject(agent, projects), [agent, projects]);
  const currentWorkspaceId = agent.localWorkspaceId || agent.workspaceId || 'current-agent-workspace';
  const [workspaceId, setWorkspaceId] = useState(currentProject?.id ?? currentWorkspaceId);
  const [goalId, setGoalId] = useState(agent.goalId ?? goals[0]?.id ?? '');
  const [stateFilter, setStateFilter] = useState<string[]>(() => normalizeAgentStateFilter(agent.stateFilter));
  const [issueSubscriptionRunMode, setIssueSubscriptionRunMode] = useState<SpaceIssueSubscriptionRunMode>(normalizeIssueSubscriptionRunMode(agent.issueSubscriptionRunMode));
  const [busy, setBusy] = useState(false);

  const projectOptions = useMemo<SelectOption[]>(() => {
    const options = projects.map((project) => ({
      value: project.id,
      label: projectLabel(project),
    }));
    if (!options.some((option) => option.value === workspaceId)) {
      options.unshift({
        value: workspaceId,
        label: agent.workspaceLabel?.trim() || agentWorkspacePathLabel(agent, t),
      });
    }
    return options;
  }, [agent, projects, t, workspaceId]);

  const goalOptions = useMemo<SelectOption[]>(() => {
    const options = goals.map((goal) => {
      const label = goal.goalPathLabel || goal.title;
      return {
        value: goal.id,
        label,
        content: <GoalPathSelectLabel label={label} />,
      };
    });
    if (agent.goalId && !options.some((option) => option.value === agent.goalId)) {
      const label = agentTargetLabel(agent, t);
      options.unshift({
        value: agent.goalId,
        label,
        content: <GoalPathSelectLabel label={label} />,
      });
    }
    return options;
  }, [agent, goals, t]);

  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  const submit = async () => {
    const selectedProject = canEditWorkspace ? projects.find((project) => project.id === workspaceId) : undefined;
    const nextWorkspace: { workspaceId?: string; workspacePath?: string; workspaceLabel?: string } = canEditWorkspace
      ? selectedProject
        ? {
          workspaceId: selectedProject.id,
          workspacePath: selectedProject.path,
          workspaceLabel: projectLabel(selectedProject),
        }
        : {
          workspaceId: agent.localWorkspaceId || agent.workspaceId || '',
          workspacePath: agent.workspacePath,
          workspaceLabel: agent.workspaceLabel ?? undefined,
        }
      : {};
    if (!displayName.trim() || !goalId || stateFilter.length === 0) return;
    if (canEditWorkspace && (!nextWorkspace.workspaceId || !nextWorkspace.workspacePath)) return;
    setBusy(true);
    try {
      await actions.updateRegisteredAgent({
        id: agent.id,
        displayName: displayName.trim(),
        ...nextWorkspace,
        goalId,
        stateFilter,
        issueSubscriptionRunMode,
      });
      toast.success(t('space.toasts.agentUpdated'));
      onSaved();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220] items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="w-[min(720px,calc(100vw-48px))] rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ink)]">{t('space.agents.editTitle')}</h2>
            <p className="text-sm text-[var(--ink-muted)]">{agent.id}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">{t('space.agents.name')}</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">{t('space.agents.localAgentWorkspace')}</span>
            {canEditWorkspace ? (
              <CustomSelect value={workspaceId} options={projectOptions} onChange={setWorkspaceId} size="md" />
            ) : (
              <>
                <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-inset)]/55 px-3 py-2.5">
                  <p className="truncate text-sm font-semibold text-[var(--ink-secondary)]">
                    {agent.workspaceLabel?.trim() || agentWorkspacePathLabel(agent, t)}
                  </p>
                  {agent.workspacePath ? (
                    <p className="mt-1 truncate font-mono text-xs text-[var(--ink-muted)]">{agentWorkspacePathLabel(agent, t)}</p>
                  ) : null}
                </div>
                <p className="mt-2 text-xs text-[var(--ink-muted)]">
                  {t('space.agents.remoteWorkspaceLocked', { device: localComputerLabel(agent, t) })}
                </p>
              </>
            )}
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">{t('space.agents.subscriptionTarget')}</span>
            {goalOptions.length > 0 ? (
              <CustomSelect value={goalId} options={goalOptions} onChange={setGoalId} size="md" />
            ) : (
              <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] px-3 py-2.5 text-sm font-semibold text-[var(--ink-subtle)]">
                {t('space.agents.targetNotSet')}
              </div>
            )}
          </label>
          <IssueSubscriptionScopeControl value={stateFilter} onChange={setStateFilter} disabled={busy} />
          <IssueSubscriptionRunModeControl value={issueSubscriptionRunMode} onChange={setIssueSubscriptionRunMode} disabled={busy} />
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-xl bg-[var(--button-secondary-bg)] px-4 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-60">
            {t('space.common.cancel')}
          </button>
          <button type="button" disabled={busy || !displayName.trim() || !goalId || stateFilter.length === 0 || (canEditWorkspace && !workspaceId)} onClick={() => void submit()} className="flex h-10 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-70">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('space.common.save')}
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function AgentCard({ agent, admin, busy, t, onOpen, onEdit, onToggle, onRevoke }: { agent: LocalRegisteredAgent; admin: boolean; busy: boolean; t: ReturnType<typeof useTranslation>['t']; onOpen: () => void; onEdit: () => void; onToggle: () => void; onRevoke: () => void }) {
  const disabled = agent.status === 'revoked';
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen();
  };

  return (
    <article role="button" tabIndex={0} onClick={onOpen} onKeyDown={handleKeyDown} className="group min-h-[236px] rounded-xl bg-[var(--paper-elevated)] px-4 py-4 text-left shadow-sm shadow-[var(--line-subtle)] outline-none transition hover:-translate-y-px hover:shadow-md focus-visible:ring-2 focus-visible:ring-[var(--accent-warm)]/30">
      <div className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-start gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--accent-cool-subtle)] text-xs font-bold text-[var(--accent-cool)]">{initials(agent.displayName)}</span>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-base font-semibold text-[var(--ink)]">{agent.displayName}</h3>
            <span className={`rounded-md px-2 py-1 text-xs font-semibold ${agentStatusClass(agent.status)}`}>{agent.status}</span>
          </div>
          <p className="mt-1 truncate text-xs font-medium text-[var(--ink-muted)]">{formatTime(agent.updatedAt) || t('space.common.notSynced')}</p>
        </div>
        {admin && <AgentActionButtons agent={agent} busy={busy} disabled={disabled} t={t} onEdit={onEdit} onToggle={onToggle} onRevoke={onRevoke} />}
      </div>

      <div className="mt-4 grid gap-2.5">
        <AgentCardField icon={Computer} label={t('space.agents.localComputer')} value={localComputerLabel(agent, t)} />
        <AgentCardField icon={FolderOpen} label={t('space.agents.workspacePath')} value={agentWorkspacePathLabel(agent, t)} title={agent.workspacePath || undefined} mono />
        <AgentCardField icon={Target} label={t('space.agents.goal')} value={agentTargetLabel(agent, t)} muted={!agent.goalPathLabel && !agent.goalId} />
      </div>
    </article>
  );
}

function AgentActionButtons({ agent, busy, disabled, t, onEdit, onToggle, onRevoke }: { agent: LocalRegisteredAgent; busy: boolean; disabled: boolean; t: ReturnType<typeof useTranslation>['t']; onEdit: () => void; onToggle: () => void; onRevoke: () => void }) {
  const stopAndRun = (event: React.MouseEvent<HTMLButtonElement>, action: () => void) => {
    event.stopPropagation();
    action();
  };

  return (
    <span className="flex shrink-0 items-center gap-1">
      <button type="button" disabled={busy || disabled} onClick={(event) => stopAndRun(event, onEdit)} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45" aria-label={t('space.agents.editAgent', { name: agent.displayName })} title={t('space.agents.edit')}>
        <Settings className="h-4 w-4" />
      </button>
      <button type="button" disabled={busy || disabled} onClick={(event) => stopAndRun(event, onToggle)} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-45" aria-label={agent.status === 'disabled' ? t('space.agents.enableAgent', { name: agent.displayName }) : t('space.agents.disableAgent', { name: agent.displayName })} title={agent.status === 'disabled' ? t('space.agents.enable') : t('space.agents.disable')}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : agent.status === 'disabled' ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
      </button>
      <button type="button" disabled={busy || disabled} onClick={(event) => stopAndRun(event, onRevoke)} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--error)] transition-colors hover:bg-[var(--error-bg)] disabled:cursor-not-allowed disabled:opacity-45" aria-label={t('space.agents.revokeAgent', { name: agent.displayName })} title={t('space.agents.revoke')}>
        <Trash2 className="h-4 w-4" />
      </button>
    </span>
  );
}

function AgentCardField({ icon: Icon, label, value, title, mono = false, muted = false }: { icon: typeof Computer; label: string; value: string; title?: string; mono?: boolean; muted?: boolean }) {
  return (
    <div className="grid grid-cols-[16px_112px_minmax(0,1fr)] items-center gap-2 rounded-lg bg-[var(--paper)]/55 px-2.5 py-2">
      <Icon className="h-4 w-4 text-[var(--ink-subtle)]" />
      <span className="truncate text-xs font-semibold text-[var(--ink-subtle)]">{label}</span>
      <span title={title ?? value} className={`truncate text-sm font-semibold ${mono ? 'font-mono' : ''} ${muted ? 'text-[var(--ink-subtle)]' : 'text-[var(--ink-secondary)]'}`}>{value}</span>
    </div>
  );
}

function AgentDetailOverlay({ agent, admin, busy, t, onClose, onEdit, onToggle, onRevoke }: { agent: LocalRegisteredAgent; admin: boolean; busy: boolean; t: ReturnType<typeof useTranslation>['t']; onClose: () => void; onEdit: () => void; onToggle: () => void; onRevoke: () => void }) {
  useCloseLayer(() => {
    onClose();
    return true;
  }, 230);

  return (
    <OverlayBackdrop onClose={onClose} className="z-[230] items-stretch justify-end bg-black/20 backdrop-blur-sm">
      <aside className="h-full w-[min(72vw,900px)] overflow-y-auto border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl max-lg:w-[min(92vw,820px)]">
        <header className="sticky top-0 z-10 border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)]/95 px-7 py-5 backdrop-blur-md">
          <div className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-start gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-[var(--accent-cool-subtle)] text-sm font-bold text-[var(--accent-cool)]">{initials(agent.displayName)}</span>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="truncate text-xl font-semibold leading-tight text-[var(--ink)]">{agent.displayName}</h2>
                <span className={`rounded-md px-2 py-1 text-xs font-semibold ${agentStatusClass(agent.status)}`}>{agent.status}</span>
              </div>
              <p className="mt-1 truncate text-sm font-medium text-[var(--ink-muted)]">{localComputerLabel(agent, t)}</p>
            </div>
            <div className="flex items-center gap-1.5">
              {admin && <AgentActionButtons agent={agent} busy={busy} disabled={agent.status === 'revoked'} t={t} onEdit={onEdit} onToggle={onToggle} onRevoke={onRevoke} />}
              <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]" aria-label={t('space.detail.close')}>
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        <div className="px-7 py-6">
          <section className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
            <AgentSummaryBlock icon={Computer} label={t('space.agents.localComputer')} value={localComputerLabel(agent, t)} />
            <AgentSummaryBlock icon={Target} label={t('space.agents.subscriptionTarget')} value={agentTargetLabel(agent, t)} muted={!agent.goalPathLabel && !agent.goalId} />
            <AgentSummaryBlock icon={FolderOpen} label={t('space.agents.workspacePath')} value={agentWorkspacePathLabel(agent, t)} title={agent.workspacePath || undefined} mono wide />
            <AgentSummaryBlock icon={Clock} label={t('space.agents.lastSync')} value={formatTime(agent.updatedAt) || t('space.common.notSynced')} />
          </section>

          <section className="mt-6 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper)]/45 px-4 py-4">
            <h3 className="flex items-center gap-2 text-base font-semibold text-[var(--ink)]">
              <Activity className="h-4 w-4 text-[var(--ink-muted)]" />
              {t('space.agents.dispatchSettings')}
            </h3>
            <div className="mt-3 divide-y divide-[var(--line-subtle)]">
              <AgentDetailRow label={t('space.agents.subscriptionTarget')} value={agentTargetLabel(agent, t)} />
              <AgentDetailRow label={t('space.agents.subscriptionScope')} value={issueStateFilterLabel(t, agent.stateFilter)} />
              <AgentDetailRow label={t('space.agents.issueSubscriptionStrategy')} value={issueSubscriptionRunModeLabel(t, agent.issueSubscriptionRunMode)} />
            </div>
          </section>

          <section className="mt-4 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper)]/45 px-4 py-4">
            <h3 className="text-base font-semibold text-[var(--ink)]">{t('space.agents.registrationInfo')}</h3>
            <div className="mt-3 divide-y divide-[var(--line-subtle)]">
              <AgentDetailRow label={t('space.agents.agentId')} value={agent.id} mono />
              <AgentDetailRow label={t('space.agents.createdAt')} value={formatTime(agent.createdAt) || 'n/a'} />
              <AgentDetailRow label={t('space.agents.updatedAt')} value={formatTime(agent.updatedAt) || 'n/a'} />
            </div>
          </section>
        </div>
      </aside>
    </OverlayBackdrop>
  );
}

function AgentSummaryBlock({ icon: Icon, label, value, title, mono = false, muted = false, wide = false }: { icon: typeof Computer; label: string; value: string; title?: string; mono?: boolean; muted?: boolean; wide?: boolean }) {
  return (
    <div className={`rounded-xl bg-[var(--paper)]/55 px-4 py-3 ${wide ? 'col-span-2 max-md:col-span-1' : ''}`}>
      <div className="flex items-center gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <p title={title ?? value} className={`mt-2 break-words text-sm font-semibold leading-6 ${mono ? 'font-mono' : ''} ${muted ? 'text-[var(--ink-subtle)]' : 'text-[var(--ink-secondary)]'}`}>{value}</p>
    </div>
  );
}

function AgentDetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid min-h-11 grid-cols-[140px_minmax(0,1fr)] items-center gap-3 py-2.5 max-sm:grid-cols-1 max-sm:gap-1">
      <span className="text-xs font-semibold text-[var(--ink-subtle)]">{label}</span>
      <span className={`min-w-0 break-words text-sm font-semibold text-[var(--ink-secondary)] ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function IssueSubscriptionRunModeControl({ value, onChange, disabled }: { value: SpaceIssueSubscriptionRunMode; onChange: (value: SpaceIssueSubscriptionRunMode) => void; disabled?: boolean }) {
  const { t } = useTranslation('app');
  const normalized = normalizeIssueSubscriptionRunMode(value);
  const options: Array<{
    value: SpaceIssueSubscriptionRunMode;
    label: string;
    description: string;
  }> = [
    {
      value: 'single_session',
      label: t('space.agents.issueSubscriptionSingleSession'),
      description: t('space.agents.issueSubscriptionSingleSessionDescription'),
    },
    {
      value: 'new_session',
      label: t('space.agents.issueSubscriptionNewSession'),
      description: t('space.agents.issueSubscriptionNewSessionDescription'),
    },
  ];
  const active = options.find((option) => option.value === normalized) ?? options[0];

  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-[var(--ink)]">{t('space.agents.issueSubscriptionStrategy')}</span>
      <div className="inline-flex rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] p-1">
        {options.map((option) => {
          const selected = option.value === normalized;
          return (
            <button key={option.value} type="button" disabled={disabled} onClick={() => onChange(option.value)} className={`h-8 rounded-md px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${selected ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm' : 'text-[var(--ink-muted)] hover:bg-[var(--paper)] hover:text-[var(--ink)]'}`} aria-pressed={selected}>
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-sm text-[var(--ink-muted)]">{active.description}</p>
    </div>
  );
}

function IssueSubscriptionScopeControl({ value, onChange, disabled }: { value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  const { t } = useTranslation('app');
  const normalized = normalizeAgentStateFilter(value);
  const toggleState = (state: string) => {
    if (disabled) return;
    const selected = normalized.includes(state);
    const next = selected ? normalized.filter((item) => item !== state) : [...normalized, state];
    onChange(normalizeAgentStateFilter(next.length > 0 ? next : normalized));
  };

  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-[var(--ink)]">{t('space.agents.subscriptionScope')}</span>
      <div className="flex flex-wrap gap-2">
        {AGENT_SUBSCRIPTION_STATE_OPTIONS.map((state) => {
          const selected = normalized.includes(state);
          return (
            <button
              key={state}
              type="button"
              disabled={disabled}
              onClick={() => toggleState(state)}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                selected
                  ? 'border-[var(--accent-warm)]/35 bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]'
                  : 'border-[var(--line)] bg-[var(--paper)] text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]'
              }`}
              aria-pressed={selected}
            >
              {selected ? <Check className="h-3.5 w-3.5" /> : null}
              {issueStatusLabel(state, t)}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-sm text-[var(--ink-muted)]">{t('space.agents.subscriptionScopeDescription')}</p>
    </div>
  );
}

export function RegisterAgentDialog({ projects, goals, actions, onClose, onRegistered }: { projects: Project[]; goals: SpaceGoal[]; actions: SpaceActions; onClose: () => void; onRegistered: () => void }) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const [displayName, setDisplayName] = useState('');
  const [workspaceId, setWorkspaceId] = useState(projects[0]?.id ?? '');
  const [goalId, setGoalId] = useState(goals[0]?.id ?? '');
  const [stateFilter, setStateFilter] = useState<string[]>(() => [...DEFAULT_AGENT_STATE_FILTER]);
  const [issueSubscriptionRunMode, setIssueSubscriptionRunMode] = useState<SpaceIssueSubscriptionRunMode>(DEFAULT_ISSUE_SUBSCRIPTION_RUN_MODE);
  const [busy, setBusy] = useState(false);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  const projectOptions = useMemo<SelectOption[]>(
    () =>
      projects.map((project) => ({
        value: project.id,
        label: projectLabel(project),
      })),
    [projects],
  );
  const goalOptions = useMemo<SelectOption[]>(
    () =>
      goals.map((goal) => {
        const label = goal.goalPathLabel || goal.title;
        return {
          value: goal.id,
          label,
          content: <GoalPathSelectLabel label={label} />,
        };
      }),
    [goals],
  );

  const submit = async () => {
    const project = projects.find((item) => item.id === workspaceId);
    if (!project || !displayName.trim() || !goalId || stateFilter.length === 0) return;
    setBusy(true);
    try {
      await actions.registerAgent({
        displayName: displayName.trim(),
        workspaceId: project.id,
        workspacePath: project.path,
        workspaceLabel: projectLabel(project),
        goalId,
        stateFilter,
        issueSubscriptionRunMode,
      });
      toast.success(t('space.toasts.agentCreated'));
      onRegistered();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220] items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="w-[min(720px,calc(100vw-48px))] rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ink)]">{t('space.agents.registerTitle')}</h2>
            <p className="text-sm text-[var(--ink-muted)]">{t('space.agents.officialSpace')}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">{t('space.agents.name')}</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]" placeholder={t('space.agents.displayNamePlaceholder')} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">{t('space.agents.localAgentWorkspace')}</span>
            <CustomSelect value={workspaceId} options={projectOptions} onChange={setWorkspaceId} size="md" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">{t('space.agents.subscriptionTarget')}</span>
            <CustomSelect value={goalId} options={goalOptions} onChange={setGoalId} size="md" />
          </label>
          <IssueSubscriptionScopeControl value={stateFilter} onChange={setStateFilter} disabled={busy} />
          <IssueSubscriptionRunModeControl value={issueSubscriptionRunMode} onChange={setIssueSubscriptionRunMode} disabled={busy} />
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button type="button" onClick={onClose} className="h-10 rounded-lg px-4 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            {t('space.common.cancel')}
          </button>
          <button type="button" disabled={busy || !workspaceId || !displayName.trim() || !goalId || stateFilter.length === 0} onClick={() => void submit()} className="flex h-10 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
            {t('space.agents.register')}
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
