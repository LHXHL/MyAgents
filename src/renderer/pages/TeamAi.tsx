import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listenWithCleanup } from '@/utils/tauriListen';
import { useConfigData } from '@/config/useConfigData';
import { useConfigActions } from '@/config/useConfigActions';
import { getSessions, type SessionMetadata } from '@/api/sessionClient';
import { isProjectVisibleToUser, isProjectArchived, type Project } from '@/config/types';
import { startAndEnableAgentChannel } from '@/config/services/agentConfigService';
import type { TeamAction, TeamActionResult, TeamChannel, TeamSessionState } from '@/../shared/teamAi';
import { teamAction, teamChannels, teamStates } from '@/features/team-ai/client';
import type { TeamAiBinding } from '@/features/team-ai/tabModule';
import { buildPeerRows, observationTargets, peerRowKey, unobserved, type PeerRow } from '@/features/team-ai/model';
import { PeerList } from '@/features/team-ai/PeerList';
import {
  PeerDetail,
  ghostButton,
  primaryButton,
  secondaryButton,
  type ConfirmRequest,
  type TeamNote,
  type TeamPending,
} from '@/features/team-ai/PeerDetail';
import ConfirmDialog from '@/components/ConfirmDialog';
import AgentWorkspacePickerDialog from '@/components/AgentWorkspacePickerDialog';
import { orderWorkspaceSelectorProjects } from '@/components/launcher/WorkspaceSelector';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { DropdownMenu } from '@/components/ui/DropdownMenu';
import { Popover } from '@/components/ui/Popover';
import { AtIcon, CheckIcon, ChevronDownIcon, CloseIcon, FolderIcon, FolderOpenIcon, MessageIcon, PlusIcon, SettingsIcon } from '@/components/icons';
import { ChannelOverlay, type ChannelOverlayEntry } from '@/components/AgentSettings/sections/AgentChannelsSection';
import { getAgentById } from '@/config/services/agentConfigService';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';

const WorkspaceConfigPanel = lazy(() => import('@/components/WorkspaceConfigPanel'));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Turn a committed action result into the one line of feedback the operator needs. */
function noteFor(result: TeamActionResult, done: string, hadProfile: boolean, t: (key: string, options?: Record<string, unknown>) => string): Omit<TeamNote, 'scope'> {
  // A config edit commits the peer profile first; the current Session may then fail on its own.
  if (result.sessionApply === 'failed') {
    return { tone: 'err', text: [t('teamAi.apply.failed'), result.error].filter(Boolean).join(' ') };
  }
  if (result.success === false) {
    return {
      tone: 'err',
      text: [
        result.error,
        result.createdSessionId ? t('teamAi.createdUnbound', { id: result.createdSessionId.slice(0, 8) }) : '',
      ].filter(Boolean).join(' '),
    };
  }
  if (result.statePersisted === false || result.notified === false || result.warning) {
    return { tone: 'info', text: result.warning ?? t('teamAi.deliveryWarning') };
  }
  if (!result.sessionApply) return { tone: 'ok', text: done };
  const head = hadProfile ? done : t('teamAi.done.savedAsOwn');
  const tail = result.sessionApply === 'skipped' ? 'teamAi.apply.skipped'
    : result.sessionApply === 'applied' ? 'teamAi.apply.applied' : 'teamAi.apply.deferred';
  return { tone: 'ok', text: head + t(tail) };
}

export default function TeamAi({
  isActive,
  onCreate,
  onOpenSession,
  projectId,
  onSelectProject,
}: Omit<TeamAiBinding, 'onSelectProject'> & {
  isActive: boolean;
  projectId?: string;
  onSelectProject: (id: string) => void;
}) {
  const { t } = useTranslation('app');
  const { projects, config } = useConfigData();
  const { patchProject, refreshConfig } = useConfigActions();
  const visible = useMemo(() => projects.filter(p => isProjectVisibleToUser(p) && !isProjectArchived(p) && p.agentId), [projects]);
  const teams = useMemo(() => visible.filter(p => p.purpose === 'team-ai'), [visible]);
  const candidates = useMemo(
    () => orderWorkspaceSelectorProjects(visible.filter(p => p.purpose !== 'team-ai'), config.defaultWorkspacePath),
    [visible, config.defaultWorkspacePath],
  );
  const project = teams.find(p => p.id === projectId) ?? teams[0];
  const agentId = project?.agentId;
  const agent = agentId ? getAgentById(config, agentId) : undefined;
  const path = project?.path;

  const [channels, setChannels] = useState<TeamChannel[]>([]);
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [states, setStates] = useState<TeamSessionState[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [pending, setPending] = useState<TeamPending | null>(null);
  const [note, setNote] = useState<{ key: string; note: TeamNote } | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmRequest | null>(null);
  const [joining, setJoining] = useState(false);
  // Agent settings opens the whole settings panel; a Bot or "add Channel" opens only that Channel page.
  // One overlay at a time, so a Channel page can never stack over (and later reveal) the settings panel.
  const [overlay, setOverlay] = useState<{ kind: 'settings' } | { kind: 'channel'; entry: ChannelOverlayEntry } | null>(null);
  const setChannelPage = (entry: ChannelOverlayEntry) => setOverlay({ kind: 'channel', entry });
  const { openPathExternal } = useWorkspaceFileService(null);
  const generation = useRef(0);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!agentId || !path) {
      setChannels([]);
      setSessions([]);
      return;
    }
    const epoch = ++generation.current;
    try {
      const [result, metadata] = await Promise.all([teamChannels(agentId), getSessions(path)]);
      if (generation.current !== epoch) return;
      setChannels(result.channels);
      setSessions(metadata);
      setError(null);
      const targets = observationTargets(result.channels, metadata);
      try {
        const observed = await teamStates(agentId, targets);
        if (generation.current === epoch) setStates(observed.states);
      } catch {
        if (generation.current === epoch) setStates(unobserved(targets));
      }
    } catch (failure) {
      if (generation.current === epoch) setError(errorText(failure));
    } finally {
      if (generation.current === epoch) setLoaded(true);
    }
  }, [agentId, path]);

  useEffect(() => {
    setLoaded(false);
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);

  useEffect(() => {
    if (!isActive || !agentId) return;
    const controller = new AbortController();
    for (const event of ['agent:status-changed', 'session:metadata-changed']) {
      void listenWithCleanup(event, () => { void refresh(); }, controller.signal)
        .catch(failure => console.warn('[team-ai] listener unavailable', failure));
    }
    const interval = setInterval(() => { void refresh(); }, 8000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [agentId, isActive, refresh]);

  useEffect(() => () => clearTimeout(noteTimer.current), []);

  const rows = useMemo(() => buildPeerRows(channels, sessions, states), [channels, sessions, states]);
  const selected = rows.find(row => peerRowKey(row.channel.channelId, row.peer.sessionKey) === selectedKey);

  const showNote = useCallback((key: string, next: TeamNote) => {
    clearTimeout(noteTimer.current);
    setNote({ key, note: next });
    if (next.tone === 'ok') noteTimer.current = setTimeout(() => setNote(null), 5000);
  }, []);

  const run = useCallback(async (row: PeerRow, action: TeamAction, done: string) => {
    if (!agentId || pending) return null;
    const key = peerRowKey(row.channel.channelId, row.peer.sessionKey);
    const scope = action.kind === 'updateConfig' || action.kind === 'clearProfile' ? 'config' : 'sessions';
    setPending({ key, kind: action.kind, sessionId: action.kind === 'setPrimary' ? action.sessionId : undefined });
    setNote(null);
    try {
      const result = await teamAction(agentId, row.channel.channelId, row.peer, action);
      showNote(key, { ...noteFor(result, done, row.peer.hasProfile, t), scope });
      return result;
    } catch (failure) {
      showNote(key, { tone: 'err', text: errorText(failure), scope });
      return null;
    } finally {
      setPending(null);
      await refresh();
    }
  }, [agentId, pending, refresh, showNote, t]);

  const selectProject = (id: string) => {
    setSelectedKey(null);
    setShowDetail(false);
    setChannels([]);
    setSessions([]);
    setStates([]);
    onSelectProject(id);
  };

  const join = async (target: Project) => {
    try {
      await patchProject(target.id, { purpose: 'team-ai' });
      selectProject(target.id);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const leave = () => {
    if (!project) return;
    setConfirmation({
      title: t('teamAi.leaveTitle', { name: project.displayName || project.name }),
      message: t('teamAi.leaveMessage'),
      confirmText: t('teamAi.leaveConfirm'),
      onConfirm: () => {
        void patchProject(project.id, { purpose: undefined })
          .then(() => selectProject(teams.find(p => p.id !== project.id)?.id ?? ''))
          .catch(failure => setError(errorText(failure)));
      },
    });
  };

  const picker = joining && (
    <AgentWorkspacePickerDialog
      projects={candidates}
      title={t('teamAi.selectWorkspaceTitle')}
      description={t('teamAi.selectWorkspaceDescription')}
      emptyLabel={t('teamAi.noCandidates')}
      onClose={() => setJoining(false)}
      onSelect={target => {
        setJoining(false);
        void join(target);
      }}
    />
  );

  if (!project) {
    return (
      <div className="h-full overflow-y-auto bg-[var(--paper)] text-[var(--ink)]" data-testid="team-ai-page">
        <Onboarding onCreate={onCreate} onJoin={() => setJoining(true)} />
        {picker}
      </div>
    );
  }

  const noChannels = loaded && !error && channels.length === 0;
  return (
    <div className="@container/team-ai flex h-full flex-col bg-[var(--paper)] text-[var(--ink)]" data-testid="team-ai-page">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--line)] px-4">
        <AgentSwitcher
          teams={teams}
          current={project}
          onSelect={selectProject}
          onCreate={onCreate}
          onJoin={() => setJoining(true)}
        />
        <div className="flex-1" />
        <button className={ghostButton} aria-label={t('teamAi.agentSettings')} title={t('teamAi.agentSettings')} onClick={() => setOverlay({ kind: 'settings' })}>
          <SettingsIcon className="h-4 w-4" />
          <span className="hidden @[560px]/team-ai:inline">{t('teamAi.agentSettings')}</span>
        </button>
        <DropdownMenu
          size="md"
          title={t('teamAi.agentMenu')}
          sections={[
            { items: [
              { icon: <FolderOpenIcon className="h-4 w-4" />, label: t('teamAi.openFolder'), onClick: () => { void openPathExternal({ fullPath: project.path, workspace: project.path }).catch(failure => setError(errorText(failure))); } },
              { icon: <PlusIcon className="h-4 w-4" />, label: t('teamAi.connectBot'), onClick: () => setChannelPage({ view: 'add' }) },
            ] },
            { items: [{ icon: <CloseIcon className="h-4 w-4" />, label: t('teamAi.leave'), onClick: leave }] },
          ]}
        />
      </header>

      {error && (
        <div role="alert" className="mx-4 mt-3 flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--error-bg)] px-3.5 py-2.5 text-sm text-[var(--error)]">
          <span className="min-w-0 flex-1">{error}</span>
          <button className="shrink-0 font-medium underline-offset-2 hover:underline" onClick={() => { void refresh(); }}>{t('teamAi.retry')}</button>
        </div>
      )}

      {noChannels ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--paper-inset)] text-[var(--ink-muted)]">
            <MessageIcon className="h-5 w-5" />
          </span>
          <h2 className="text-lg font-semibold">{t('teamAi.noChannelTitle', { name: project.displayName || project.name })}</h2>
          <p className="mt-2 max-w-sm text-sm text-[var(--ink-muted)]">{t('teamAi.noChannelBody')}</p>
          <button className={`${primaryButton} mt-5`} onClick={() => setChannelPage({ view: 'add' })}>
            <PlusIcon className="h-4 w-4" />
            {t('teamAi.connectBot')}
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className={`${showDetail ? 'hidden' : 'flex'} min-h-0 w-full flex-col @[720px]/team-ai:flex @[720px]/team-ai:w-[300px] @[720px]/team-ai:shrink-0 @[720px]/team-ai:border-r @[720px]/team-ai:border-[var(--line)]`}>
            {!loaded ? (
              <div className="space-y-2 p-3" aria-label={t('teamAi.loading')}>
                {[0, 1, 2, 3].map(i => <div key={i} className="h-[52px] animate-pulse rounded-[var(--radius-md)] bg-[var(--paper-inset)]" />)}
              </div>
            ) : (
              <PeerList
                rows={rows}
                channels={channels}
                onOpenChannel={channelId => setChannelPage({ view: 'detail', channelId })}
                onAddChannel={() => setChannelPage({ view: 'add' })}
                selectedKey={selectedKey}
                onSelect={row => {
                  setSelectedKey(peerRowKey(row.channel.channelId, row.peer.sessionKey));
                  setShowDetail(true);
                }}
                onRetry={() => { void refresh(); }}
              />
            )}
          </div>
          <main className={`${showDetail ? 'block' : 'hidden'} min-w-0 flex-1 overflow-y-auto @[720px]/team-ai:block`}>
            {selected && agentId ? (
              <PeerDetail
                key={selectedKey}
                agentId={agentId}
                row={selected}
                sessions={sessions}
                states={states}
                pending={pending?.key === selectedKey ? pending : null}
                note={note?.key === selectedKey ? note.note : null}
                run={(action, done) => run(selected, action, done)}
                confirm={setConfirmation}
                onOpen={session => onOpenSession(session, project)}
                onEnable={() => {
                  void startAndEnableAgentChannel(agentId, selected.channel.channelId)
                    .catch(failure => setError(errorText(failure)))
                    .finally(() => { void refresh(); });
                }}
                onBack={() => setShowDetail(false)}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-[var(--ink-muted)]">
                <MessageIcon className="h-7 w-7 text-[var(--ink-subtle)]" />
                {t('teamAi.selectPeer')}
              </div>
            )}
          </main>
        </div>
      )}

      {picker}
      {confirmation && (
        <ConfirmDialog
          title={confirmation.title}
          message={confirmation.message}
          confirmText={confirmation.confirmText}
          onConfirm={() => {
            const request = confirmation;
            setConfirmation(null);
            request.onConfirm();
          }}
          onCancel={() => setConfirmation(null)}
        />
      )}
      {overlay?.kind === 'settings' && (
        <Suspense fallback={null}>
          <WorkspaceConfigPanel
            agentDir={project.path}
            initialTab="general"
            onClose={() => {
              setOverlay(null);
              void refresh();
            }}
          />
        </Suspense>
      )}
      {overlay?.kind === 'channel' && agent && (
        <ChannelOverlay
          key={JSON.stringify(overlay.entry)}
          agent={agent}
          entry={overlay.entry}
          onClose={() => {
            setOverlay(null);
            void refreshConfig().then(refresh);
          }}
          onChanged={() => { void refreshConfig().then(refresh); }}
        />
      )}
    </div>
  );
}

function AgentSwitcher({ teams, current, onSelect, onCreate, onJoin }: {
  teams: Project[];
  current: Project;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}) {
  const { t } = useTranslation('app');
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const item = 'flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-sm hover:bg-[var(--hover-bg)]';
  return (
    <>
      <button
        ref={anchor}
        className="flex h-9 min-w-0 items-center gap-2 rounded-[var(--radius-md)] px-2 hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('teamAi.switchAgent')}
        onClick={() => setOpen(!open)}
      >
        <WorkspaceIcon icon={current.icon} size={24} />
        <span className="truncate text-base font-semibold">{current.displayName || current.name}</span>
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="bottom-start" className="min-w-[260px] p-1">
        <div role="menu">
          {teams.map(team => (
            <button key={team.id} role="menuitem" className={item} onClick={() => { setOpen(false); if (team.id !== current.id) onSelect(team.id); }}>
              <WorkspaceIcon icon={team.icon} size={22} />
              <span className="min-w-0 flex-1 truncate">{team.displayName || team.name}</span>
              {team.id === current.id && <CheckIcon className="h-4 w-4 text-[var(--accent)]" />}
            </button>
          ))}
          <div className="my-1 border-t border-[var(--line-subtle)]" />
          <button role="menuitem" className={item} onClick={() => { setOpen(false); onCreate(); }}>
            <PlusIcon className="h-4 w-4 text-[var(--ink-muted)]" />
            {t('teamAi.create')}
          </button>
          <button role="menuitem" className={item} onClick={() => { setOpen(false); onJoin(); }}>
            <FolderIcon className="h-4 w-4 text-[var(--ink-muted)]" />
            {t('teamAi.join')}…
          </button>
        </div>
      </Popover>
    </>
  );
}

function Onboarding({ onCreate, onJoin }: { onCreate: () => void; onJoin: () => void }) {
  const { t } = useTranslation('app');
  return (
    <div className="mx-auto flex max-w-[640px] flex-col items-center px-6 py-20 text-center">
      <span className="mb-5 flex h-[52px] w-[52px] items-center justify-center rounded-[14px] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
        <AtIcon className="h-6 w-6" />
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">{t('teamAi.onboarding.title')}</h1>
      <p className="mt-3 max-w-[480px] text-sm leading-relaxed text-[var(--ink-muted)]">{t('teamAi.onboarding.body')}</p>
      <ol className="mt-8 grid w-full gap-3 text-left @[560px]:grid-cols-3 sm:grid-cols-3">
        {[1, 2, 3].map(step => (
          <li key={step} className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
            <span className="mb-2 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--paper-inset)] text-xs font-semibold text-[var(--ink-muted)]">{step}</span>
            <b className="block text-sm font-semibold">{t(`teamAi.onboarding.step${step}`)}</b>
            <span className="mt-1 block text-xs leading-relaxed text-[var(--ink-muted)]">{t(`teamAi.onboarding.step${step}Body`)}</span>
          </li>
        ))}
      </ol>
      <div className="mt-8 flex gap-2">
        <button className={secondaryButton} onClick={onJoin}>{t('teamAi.join')}</button>
        <button className={primaryButton} onClick={onCreate}>
          <PlusIcon className="h-4 w-4" />
          {t('teamAi.create')}
        </button>
      </div>
    </div>
  );
}
