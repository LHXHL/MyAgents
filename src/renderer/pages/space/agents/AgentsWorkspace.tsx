import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Loader2, Plus, Power, PowerOff, RefreshCw, Settings, Trash2, X } from 'lucide-react';

import type { LocalRegisteredAgent, SpaceGoal, SpaceIssueSubscriptionRunMode } from '@/api/spaceCloud';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import ConfirmDialog from '@/components/ConfirmDialog';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import type { Project } from '@/config/types';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { spaceErrorMessage } from '@/api/spaceCloud';
import { formatAgentSecondaryLabel } from '@/pages/space/spaceHelpers';
import type { SpaceActions } from '@/pages/space/spaceStore';
import { formatTime } from '@/pages/space/spaceUi';

function initials(value?: string | null): string {
  const source = value?.trim() || 'MA';
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

const DEFAULT_ISSUE_SUBSCRIPTION_RUN_MODE: SpaceIssueSubscriptionRunMode = 'single_session';

function normalizeIssueSubscriptionRunMode(
  value?: SpaceIssueSubscriptionRunMode | null,
): SpaceIssueSubscriptionRunMode {
  return value === 'new_session' ? 'new_session' : DEFAULT_ISSUE_SUBSCRIPTION_RUN_MODE;
}

function issueSubscriptionRunModeLabel(
  t: ReturnType<typeof useTranslation>['t'],
  mode?: SpaceIssueSubscriptionRunMode | null,
): string {
  return normalizeIssueSubscriptionRunMode(mode) === 'new_session'
    ? t('space.agents.issueSubscriptionNewSession')
    : t('space.agents.issueSubscriptionSingleSession');
}

export function AgentsWorkspace({
  admin,
  agents,
  projects,
  actions,
  onRefresh,
  onRegister,
}: {
  admin: boolean;
  agents: LocalRegisteredAgent[];
  projects: Project[];
  actions: SpaceActions;
  onRefresh: () => Promise<void>;
  onRegister: () => void;
}) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<LocalRegisteredAgent | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<LocalRegisteredAgent | null>(null);

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
  const stateFilterLabel = (agent: LocalRegisteredAgent) => (agent.stateFilter?.length ? agent.stateFilter : ['todo']).join(', ');

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
          <div className="mr-auto flex min-w-0 items-center gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
            <Bot className="h-4 w-4 shrink-0" />
            <span>Agents</span>
            <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">{agents.length}</span>
            <small className="truncate text-xs font-medium text-[var(--ink-muted)]">{t('space.agents.hint')}</small>
          </div>
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-transparent text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            aria-label={t('space.common.refresh')}
            title={t('space.common.refresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          {admin && (
            <button
              type="button"
              onClick={onRegister}
              className="flex h-9 shrink-0 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
            >
              <Plus className="h-4 w-4" />
              {t('space.agents.register')}
            </button>
          )}
        </section>
        <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-3">
          {agents.length === 0 ? (
            <div className="grid h-40 place-items-center rounded-[20px] border border-dashed border-[var(--line)] bg-[var(--paper-elevated)]/40 text-sm text-[var(--ink-muted)]">
              <div className="text-center">
                <Bot className="mx-auto mb-3 h-8 w-8 text-[var(--ink-muted)]" />
                <p>{t('space.agents.empty')}</p>
                {admin && (
                  <button
                    type="button"
                    onClick={onRegister}
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                  >
                    <Plus className="h-4 w-4" />
                    {t('space.agents.registerAgent')}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="max-w-[1180px]">
              <div className="border-y border-[var(--line-subtle)]">
                {agents.map((agent) => (
                  <article key={agent.id} className="border-b border-[var(--line-subtle)] px-2 py-3 last:border-b-0">
                    <div className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5">
                      <span className="grid h-[34px] w-[34px] place-items-center rounded-xl bg-[var(--accent-cool-subtle)] text-xs font-bold text-[var(--accent-cool)]">
                        {initials(agent.displayName)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-semibold text-[var(--ink)]">{agent.displayName}</h3>
                        <p className="truncate text-xs text-[var(--ink-muted)]">{formatAgentSecondaryLabel(agent, projects)}</p>
                      </div>
                      <span className="flex items-center gap-1.5">
                        <span className={`rounded-md px-2 py-1 text-xs font-semibold ${agent.status === 'active' || agent.status === 'online' ? 'bg-[var(--success-bg)] text-[var(--success)]' : 'bg-[var(--paper-inset)] text-[var(--ink-muted)]'}`}>{agent.status}</span>
                        {admin && (
                          <>
                            <button
                              type="button"
                              disabled={busyAgentId === agent.id || agent.status === 'revoked'}
                              onClick={() => setEditingAgent(agent)}
                              className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45"
                              aria-label={t('space.agents.editAgent', { name: agent.displayName })}
                              title={t('space.agents.edit')}
                            >
                              <Settings className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              disabled={busyAgentId === agent.id || agent.status === 'revoked'}
                              onClick={() => void toggleAgentStatus(agent)}
                              className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-45"
                              aria-label={agent.status === 'disabled' ? t('space.agents.enableAgent', { name: agent.displayName }) : t('space.agents.disableAgent', { name: agent.displayName })}
                              title={agent.status === 'disabled' ? t('space.agents.enable') : t('space.agents.disable')}
                            >
                              {busyAgentId === agent.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : agent.status === 'disabled' ? (
                                <Power className="h-4 w-4" />
                              ) : (
                                <PowerOff className="h-4 w-4" />
                              )}
                            </button>
                            <button
                              type="button"
                              disabled={busyAgentId === agent.id || agent.status === 'revoked'}
                              onClick={() => setRevokeTarget(agent)}
                              className="grid h-8 w-8 place-items-center rounded-lg text-[var(--error)] transition-colors hover:bg-[var(--error-bg)] disabled:cursor-not-allowed disabled:opacity-45"
                              aria-label={t('space.agents.revokeAgent', { name: agent.displayName })}
                              title={t('space.agents.revoke')}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2 pl-[46px]">
                      <div className="flex flex-wrap gap-2">
                        <span className="rounded-md bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs font-semibold text-[var(--accent-cool)]"># agent</span>
                      </div>
                      <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">{formatTime(agent.updatedAt) || t('space.common.notSynced')}</span>
                    </div>
                    <details className="mt-3 border-t border-dashed border-[var(--line-subtle)] pt-2.5 pl-[46px]">
                      <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-[var(--ink-muted)] hover:text-[var(--ink)] [&::-webkit-details-marker]:hidden">
                        <Settings className="h-4 w-4" />
                        {t('space.agents.viewSettings')}
                      </summary>
                      <div className="mt-3 grid grid-cols-5 gap-2 max-xl:grid-cols-3 max-lg:grid-cols-2">
                        <AgentStat label={t('space.agents.status')} value={agent.status} />
                        <AgentStat label={t('space.agents.lastSync')} value={formatTime(agent.updatedAt) || 'n/a'} />
                        <AgentStat label={t('space.agents.workspace')} value={agent.workspaceLabel || 'local'} />
                        <AgentStat label={t('space.agents.goal')} value={agent.goalPathLabel || agent.goalId || t('space.filters.inbox')} />
                        <AgentStat label={t('space.agents.issueSubscriptionStrategy')} value={issueSubscriptionRunModeLabel(t, agent.issueSubscriptionRunMode)} />
                      </div>
                      <div className="mt-3 whitespace-pre-wrap rounded-xl bg-[var(--paper-inset)]/40 p-3 text-sm leading-6 text-[var(--ink-secondary)]">
                        {t('space.agents.subscription')}:
                        {' '}
                        {stateFilterLabel(agent)}
                      </div>
                    </details>
                  </article>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
      {editingAgent && (
        <EditAgentDialog
          agent={editingAgent}
          actions={actions}
          onClose={() => setEditingAgent(null)}
          onSaved={() => setEditingAgent(null)}
        />
      )}
      {revokeTarget && (
        <ConfirmDialog
          title={t('space.agents.revokeTitle')}
          message={t('space.agents.revokeMessage', { name: revokeTarget.displayName })}
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

function EditAgentDialog({
  agent,
  actions,
  onClose,
  onSaved,
}: {
  agent: LocalRegisteredAgent;
  actions: SpaceActions;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [workspaceLabel, setWorkspaceLabel] = useState(agent.workspaceLabel ?? '');
  const [issueSubscriptionRunMode, setIssueSubscriptionRunMode] = useState<SpaceIssueSubscriptionRunMode>(
    normalizeIssueSubscriptionRunMode(agent.issueSubscriptionRunMode),
  );
  const [busy, setBusy] = useState(false);

  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  const submit = async () => {
    if (!displayName.trim()) return;
    setBusy(true);
    try {
      await actions.updateRegisteredAgent({
        id: agent.id,
        displayName: displayName.trim(),
        workspaceLabel: workspaceLabel.trim(),
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
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">{t('space.agents.workspaceLabel')}</span>
            <input
              value={workspaceLabel}
              onChange={(event) => setWorkspaceLabel(event.target.value)}
              className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
            />
          </label>
          <div className="rounded-xl bg-[var(--paper-inset)]/45 p-3 text-sm text-[var(--ink-secondary)]">
            <span className="block text-xs font-semibold text-[var(--ink-muted)]">{t('space.agents.goal')}</span>
            <strong className="mt-1 block truncate text-base font-semibold text-[var(--ink)]">{agent.goalPathLabel || agent.goalId || t('space.filters.inbox')}</strong>
            <span className="mt-2 block text-xs text-[var(--ink-muted)]">
              {t('space.agents.subscription')}: {(agent.stateFilter?.length ? agent.stateFilter : ['todo']).join(', ')}
            </span>
          </div>
          <IssueSubscriptionRunModeControl
            value={issueSubscriptionRunMode}
            onChange={setIssueSubscriptionRunMode}
            disabled={busy}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-xl bg-[var(--button-secondary-bg)] px-4 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-60">
            {t('space.common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy || !displayName.trim()}
            onClick={() => void submit()}
            className="flex h-10 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('space.common.save')}
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function AgentStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-h-14 border-b border-[var(--line-subtle)] px-1 py-2">
      <span className="block text-xs font-semibold text-[var(--ink-muted)]">{label}</span>
      <strong className="mt-1 block truncate font-mono text-base leading-tight text-[var(--ink)]">{value}</strong>
    </div>
  );
}

function IssueSubscriptionRunModeControl({
  value,
  onChange,
  disabled,
}: {
  value: SpaceIssueSubscriptionRunMode;
  onChange: (value: SpaceIssueSubscriptionRunMode) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('app');
  const normalized = normalizeIssueSubscriptionRunMode(value);
  const options: Array<{ value: SpaceIssueSubscriptionRunMode; label: string; description: string }> = [
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
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`h-8 rounded-md px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                selected
                  ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm'
                  : 'text-[var(--ink-muted)] hover:bg-[var(--paper)] hover:text-[var(--ink)]'
              }`}
              aria-pressed={selected}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-sm text-[var(--ink-muted)]">{active.description}</p>
    </div>
  );
}

export function RegisterAgentDialog({
  projects,
  goals,
  actions,
  onClose,
  onRegistered,
}: {
  projects: Project[];
  goals: SpaceGoal[];
  actions: SpaceActions;
  onClose: () => void;
  onRegistered: () => void;
}) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const [displayName, setDisplayName] = useState('');
  const [workspaceId, setWorkspaceId] = useState(projects[0]?.id ?? '');
  const [goalId, setGoalId] = useState(goals[0]?.id ?? '');
  const [issueSubscriptionRunMode, setIssueSubscriptionRunMode] = useState<SpaceIssueSubscriptionRunMode>(
    DEFAULT_ISSUE_SUBSCRIPTION_RUN_MODE,
  );
  const [busy, setBusy] = useState(false);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  const projectOptions = useMemo<SelectOption[]>(
    () => projects.map((project) => ({ value: project.id, label: project.displayName || project.name })),
    [projects],
  );
  const goalOptions = useMemo<SelectOption[]>(
    () => goals.map((goal) => ({ value: goal.id, label: goal.goalPathLabel || goal.title })),
    [goals],
  );

  const submit = async () => {
    const project = projects.find((item) => item.id === workspaceId);
    if (!project || !displayName.trim() || !goalId) return;
    setBusy(true);
    try {
      await actions.registerAgent({
        displayName: displayName.trim(),
        workspaceId: project.id,
        workspacePath: project.path,
        workspaceLabel: project.displayName || project.name,
        goalId,
        stateFilter: ['todo'],
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
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
              placeholder={t('space.agents.displayNamePlaceholder')}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">{t('space.agents.workspace')}</span>
            <CustomSelect value={workspaceId} options={projectOptions} onChange={setWorkspaceId} size="md" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">{t('space.agents.goal')}</span>
            <CustomSelect value={goalId} options={goalOptions} onChange={setGoalId} size="md" />
            <span className="mt-2 block text-xs text-[var(--ink-muted)]">{t('space.agents.subscriptionTodo')}</span>
          </label>
          <IssueSubscriptionRunModeControl
            value={issueSubscriptionRunMode}
            onChange={setIssueSubscriptionRunMode}
            disabled={busy}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-lg px-4 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            {t('space.common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy || !workspaceId || !displayName.trim() || !goalId}
            onClick={() => void submit()}
            className="flex h-10 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
            {t('space.agents.register')}
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
