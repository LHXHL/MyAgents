import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listenWithCleanup } from '@/utils/tauriListen';
import { useConfigData } from '@/config/useConfigData';
import { useConfigActions } from '@/config/useConfigActions';
import { getSessions, type SessionMetadata } from '@/api/sessionClient';
import { isProjectVisibleToUser, isProjectArchived } from '@/config/types';
import type { TeamAction, TeamChannel, TeamPeer, TeamModelMenu, TeamTools, TeamSessionState } from '@/../shared/teamAi';
import { RUNTIME_DISPLAY_NAMES, type RuntimeType } from '@/../shared/types/runtime';
import { teamAction, teamChannels, teamSession, teamStates, type TeamSessionData } from '@/features/team-ai/client';
import Message from '@/components/Message';
import { normalizeSessionMessageContent } from '@/context/sessionRestoreGuards';
import type { TeamAiBinding } from '@/features/team-ai/tabModule';
import ConfirmDialog from '@/components/ConfirmDialog';
import ContextMenu from '@/components/ContextMenu';
import CustomSelect from '@/components/CustomSelect';
import AgentWorkspacePickerDialog from '@/components/AgentWorkspacePickerDialog';
import { orderWorkspaceSelectorProjects } from '@/components/launcher/WorkspaceSelector';
import { ChevronDownIcon, RefreshIcon, PlusIcon, SlidersIcon, MoreIcon } from '@/components/icons';
const WorkspaceConfigPanel = lazy(() => import('@/components/WorkspaceConfigPanel'));
const button = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm hover:bg-[var(--hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
type Selection = { channelId: string; sessionKey: string; sessionId: string };

export default function TeamAi({ isActive, onCreate, onOpenSession, projectId, onSelectProject }: Omit<TeamAiBinding, 'onSelectProject'> & { isActive: boolean; projectId?: string; onSelectProject: (id: string) => void }) {
  const { t } = useTranslation('app');
  const { projects, config } = useConfigData();
  const { patchProject } = useConfigActions();
  const visible = useMemo(() => projects.filter(p => isProjectVisibleToUser(p) && !isProjectArchived(p) && p.agentId), [projects]);
  const teams = useMemo(() => visible.filter(p => p.purpose === 'team-ai'), [visible]);
  const candidates = useMemo(() => orderWorkspaceSelectorProjects(visible.filter(p => p.purpose !== 'team-ai'), config.defaultWorkspacePath), [visible, config.defaultWorkspacePath]);
  const project = teams.find(p => p.id === projectId) ?? teams[0];
  const [joining, setJoining] = useState(false);
  const [channels, setChannels] = useState<TeamChannel[]>([]);
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [states, setStates] = useState<TeamSessionState[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; channel: TeamChannel; peer: TeamPeer; session: SessionMetadata } | null>(null);
  const [confirmation, setConfirmation] = useState<(() => void) | null>(null);
  const generation = useRef(0);
  const agentId = project?.agentId;
  const path = project?.path;
  const refresh = useCallback(async () => {
    if (!agentId || !path) { setChannels([]); setSessions([]); return; }
    const epoch = ++generation.current;
    setLoading(true);
    try {
      const [result, metadata] = await Promise.all([teamChannels(agentId), getSessions(path)]);
      if (generation.current !== epoch) return;
      setChannels(result.channels); setSessions(metadata); setError(null);
      const targets = result.channels.flatMap(channel => channel.peers.flatMap(peer =>
        [...new Set([peer.sessionId, ...peer.sessionIds].filter((id): id is string => !!id))]
          .filter(id => metadata.some(session => session.id === id))
          .map(sessionId => ({ channelId: channel.channelId, sessionKey: peer.sessionKey, sessionId })))).slice(0, 64);
      try { const observed = await teamStates(agentId, targets); if (generation.current === epoch) setStates(observed.states); }
      catch { if (generation.current === epoch) setStates([]); }
    } catch (error) { if (generation.current === epoch) setError(errorText(error)); }
    finally { if (generation.current === epoch) setLoading(false); }
  }, [agentId, path]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { generation.current += 1; }, [agentId]);
  useEffect(() => {
    if (!isActive || !agentId) return;
    const controller = new AbortController();
    const subscriptions = ['agent:status-changed', 'session:metadata-changed'].map(event => listenWithCleanup(event, () => { void refresh(); }, controller.signal));
    for (const subscription of subscriptions) void subscription.catch(error => console.warn('[team-ai] listener unavailable', error));
    const interval = setInterval(() => { void refresh(); }, 8000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [agentId, isActive, refresh]);
  const selectedChannel = channels.find(c => c.channelId === selection?.channelId);
  const selectedPeer = selectedChannel?.peers.find(p => p.sessionKey === selection?.sessionKey);
  const selectedMetadata = sessions.find(s => s.id === selection?.sessionId);
  const perform = useCallback(async (channel: TeamChannel, peer: TeamPeer, action: TeamAction) => {
    if (!agentId || busy) return;
    setBusy(true); setNotice(null);
    try {
      const result = await teamAction(agentId, channel.channelId, peer, action);
      if (result.requiresNewSession && !('confirmed' in action && action.confirmed)) {
        if (action.kind === 'selectModel') setConfirmation(() => () => { void perform(channel, peer, { ...action, confirmed: true }); });
        return;
      }
      if (result.success === false) setNotice([result.sessionConfig === 'saved' ? t('teamAi.savedNotApplied') : '', result.error,
        result.createdSessionId ? t('teamAi.createdUnbound', { id: result.createdSessionId }) : ''].filter(Boolean).join(' '));
      else if (result.statePersisted === false || result.notified === false || result.warning) setNotice(result.warning ?? t('teamAi.deliveryWarning'));
      else if (result.runtimeApply === 'deferred' || result.runtimeApply === 'pending-next-turn') setNotice(t('teamAi.nextTurn'));
      if (result.sessionId) setSelection({ channelId: channel.channelId, sessionKey: peer.sessionKey, sessionId: result.sessionId });
      await refresh();
    } catch (error) { setNotice(errorText(error)); await refresh(); }
    finally { setBusy(false); }
  }, [agentId, busy, refresh, t]);
  const join = async (id: string) => {
    setBusy(true);
    try { await patchProject(id, { purpose: 'team-ai' }); onSelectProject(id); setError(null); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  return <div className="h-full overflow-y-auto bg-[var(--paper)] text-[var(--ink)]" data-testid="team-ai-page">
    <div className="mx-auto max-w-6xl px-6 py-7">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-xl font-semibold tracking-tight"><span className="mr-2 text-[var(--ink-muted)]" aria-hidden="true">@</span>Team AI</h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">{t('teamAi.description')}</p></div>
        <div className="flex gap-1">
          {/* Keep the trigger focusable while saving; selection closes the modal before the async patch completes. */}
          <button
            className={`${button} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
            autoFocus={isActive}
            aria-disabled={busy}
            aria-haspopup="dialog"
            aria-expanded={joining}
            onClick={event => { if (busy) return; event.currentTarget.focus(); setJoining(true); }}
          >{t('teamAi.join')}</button>
          <button className={`${button} bg-[var(--accent)] text-white hover:opacity-90`} onClick={onCreate}><PlusIcon className="h-4 w-4" />{t('teamAi.create')}</button></div>
      </header>
      {joining && <AgentWorkspacePickerDialog
        projects={candidates}
        title={t('teamAi.selectWorkspaceTitle')}
        description={t('teamAi.selectWorkspaceDescription')}
        emptyLabel={t('teamAi.noCandidates')}
        onClose={() => setJoining(false)}
        onSelect={project => { setJoining(false); void join(project.id); }}
      />}
      {error && <div role="alert" className="mb-4 text-sm text-[var(--error)]">{error}<button className={button} onClick={() => { void refresh(); }}>{t('teamAi.retry')}</button></div>}
      {teams.length === 0 ? <div className="py-20 text-center"><p className="text-base font-medium">{t('teamAi.empty')}</p><p className="mt-2 text-sm text-[var(--ink-muted)]">{t('teamAi.emptyHint')}</p></div> : <>
        <div className="mb-5 flex items-center gap-2">
          <CustomSelect ariaLabel="Team AI" className="w-72 max-w-full" size="md" disabled={busy} value={project?.id ?? ''} onChange={id => { setSelection(null); setChannels([]); setSessions([]); setStates([]); onSelectProject(id); }} options={teams.map(p => ({ value: p.id, label: p.displayName || p.name }))} />
          <button className={button} onClick={() => setSettings(true)}><SlidersIcon className="h-4 w-4" />{t('teamAi.channels')}</button>
          <button className={button} disabled={loading} aria-label={t('teamAi.refresh')} onClick={() => { void refresh(); }}><RefreshIcon className="h-4 w-4" /></button>
        </div>
        {notice && <p role="status" className="mb-4 rounded-md bg-[var(--paper-inset)] p-3 text-sm">{notice}</p>}
        {loading && channels.length === 0 && <div className="space-y-3" aria-label={t('teamAi.loading')}>{[0, 1, 2].map(i => <div key={i} className="h-12 animate-pulse rounded-md bg-[var(--paper-inset)]" />)}</div>}
        {!loading && !error && channels.length === 0 && <p className="py-12 text-sm text-[var(--ink-muted)]">{t('teamAi.noChannels')}</p>}
        <div className={`grid gap-6 ${selection ? 'lg:grid-cols-[minmax(280px,0.85fr)_minmax(340px,1.15fr)]' : ''}`}>
          <div className="min-w-0">{channels.map(channel => <section key={channel.channelId} className="mb-6">
            <div className="mb-2 flex items-center justify-between gap-2"><h2 className="truncate text-sm font-semibold">{channel.name || channel.platform}<span className="ml-2 font-normal text-[var(--ink-muted)]">{channel.platform}</span></h2><span className="text-xs text-[var(--ink-muted)]">{t(`teamAi.${!channel.enabled ? 'disabled' : ['online', 'connecting', 'error'].includes(channel.status) ? channel.status : 'offline'}`)}</span></div>
            {channel.error && <p role="alert" className="mb-2 text-xs text-[var(--error)]">{channel.error}</p>}
            {channel.peers.length === 0 && <p className="py-3 text-sm text-[var(--ink-muted)]">{t('teamAi.noPeers')}</p>}
            {channel.peers.map(peer => <details key={peer.sessionKey} className="border-t border-[var(--line)] py-1">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-3 hover:bg-[var(--hover-bg)]"><ChevronDownIcon className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1"><span className="block truncate text-sm" title={peer.name || peer.sourceId}>{peer.name || peer.sourceId}</span><span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">{sessions.find(s => s.id === peer.sessionId)?.title || t('teamAi.noPrimary')} · {peer.lastActive ? new Date(peer.lastActive).toLocaleString() : t('teamAi.noActivity')}</span></span><span className="shrink-0 text-right text-xs text-[var(--ink-muted)]">{t(`teamAi.${peer.sourceType}`)}<span className="mt-1 block">{t(`teamAi.states.${states.find(s => s.channelId === channel.channelId && s.sessionKey === peer.sessionKey && s.sessionId === peer.sessionId)?.state ?? 'unknown'}`, { defaultValue: t('teamAi.noLiveState') })}</span></span></summary>
              <div className="mb-2 ml-4 flex flex-wrap gap-1"><button className={button} disabled={!channel.online || busy} title={!channel.online ? t('teamAi.offlineHelp') : undefined} onClick={() => { void perform(channel, peer, { kind: 'new' }); }}>{t('teamAi.new')}</button>
                <button className={button} disabled={!channel.online || !peer.sessionId || busy} onClick={() => { void perform(channel, peer, { kind: 'stop' }); }}>{t('teamAi.stop')}</button></div>
              {[...new Set([peer.sessionId, ...peer.sessionIds].filter((id): id is string => !!id))].map(id => {
                const metadata = sessions.find(s => s.id === id);
                if (!metadata) return <p key={id} className="ml-6 py-2 text-xs text-[var(--ink-muted)]">{t('teamAi.unavailable')} · {id.slice(0, 8)}</p>;
                const observation = states.find(s => s.channelId === channel.channelId && s.sessionKey === peer.sessionKey && s.sessionId === id);
                return <div key={id} className={`group ml-4 flex items-center rounded-md ${selection?.sessionId === id && selection.channelId === channel.channelId ? 'bg-[var(--paper-inset)]' : 'hover:bg-[var(--hover-bg)]'}`}
                  onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, channel, peer, session: metadata }); }}>
                  <button className="min-w-0 flex-1 px-3 py-2 text-left" onClick={() => setSelection({ channelId: channel.channelId, sessionKey: peer.sessionKey, sessionId: id })}><span className="block truncate text-sm">{metadata.title || t('teamAi.untitled')}</span><span className="mt-1 block text-xs text-[var(--ink-muted)]">{peer.sessionId === id ? t('teamAi.primary') : t('teamAi.history')} · {RUNTIME_DISPLAY_NAMES[metadata.runtime as RuntimeType] ?? metadata.runtime ?? 'Claude Agent SDK'} · {metadata.model || t('teamAi.defaultModel')}</span></button>
                  <span className="text-xs text-[var(--ink-muted)]" title={observation?.error}>{t(`teamAi.states.${observation?.state ?? 'unknown'}`, { defaultValue: observation?.state ?? t('teamAi.noLiveState') })}</span>
                  <button className={`${button} px-2`} aria-label={t('teamAi.sessionMenu')} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, channel, peer, session: metadata }); }}><MoreIcon className="h-4 w-4" /></button>
                </div>;
              })}
            </details>)}
          </section>)}</div>
          {project && selection && selectedChannel && selectedPeer && selectedMetadata && <SessionDetail key={`${selection.channelId}:${selection.sessionId}:${selectedMetadata.configSnapshotAt}:${selectedPeer.sessionId}:${selectedChannel.online}`} agentId={agentId!} channel={selectedChannel} peer={selectedPeer} session={selectedMetadata} active={isActive} busy={busy}
            onClose={() => setSelection(null)} onOpen={() => onOpenSession(selectedMetadata, project)} onAction={action => { void perform(selectedChannel, selectedPeer, action); }} onConfirm={callback => setConfirmation(() => callback)} />}
        </div>
      </>}
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
      { label: t('teamAi.open'), onClick: () => { if (project) onOpenSession(menu.session, project); setMenu(null); } },
      { label: t('teamAi.setPrimary'), disabled: busy || !menu.channel.online || menu.peer.sessionId === menu.session.id, onClick: () => { void perform(menu.channel, menu.peer, { kind: 'setPrimary', sessionId: menu.session.id }); setMenu(null); } },
    ]} />}
    {confirmation && <ConfirmDialog title={t('teamAi.switchTitle')} message={t('teamAi.switchMessage')} confirmText={t('teamAi.new')} onConfirm={() => { const callback = confirmation; setConfirmation(null); callback(); }} onCancel={() => setConfirmation(null)} />}
    {settings && project && <Suspense fallback={null}><WorkspaceConfigPanel agentDir={project.path} initialTab="agent" onClose={() => { setSettings(false); void refresh(); }} /></Suspense>}
  </div>;
}

function SessionDetail({ agentId, channel, peer, session, active, busy, onClose, onOpen, onAction, onConfirm }: {
  agentId: string; channel: TeamChannel; peer: TeamPeer; session: SessionMetadata; active: boolean; busy: boolean;
  onClose: () => void; onOpen: () => void; onAction: (action: TeamAction) => void; onConfirm: (callback: () => void) => void;
}) {
  const { t } = useTranslation('app');
  const [data, setData] = useState<TeamSessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<TeamModelMenu | null>(null);
  const [tools, setTools] = useState<TeamTools | null>(null);
  const primary = peer.sessionId === session.id;
  const editable = channel.online && primary && !busy;
  useEffect(() => {
    if (!active) return;
    let stale = false;
    const read = () => { void teamSession(agentId, channel.channelId, peer.sessionKey, session.id).then(result => { if (!stale) { setData(result.session); setError(null); } }).catch(error => { if (!stale) setError(errorText(error)); }); };
    read(); const timer = setInterval(read, 4000);
    return () => { stale = true; clearInterval(timer); };
  }, [active, agentId, channel.channelId, peer.sessionKey, session.id]);
  useEffect(() => {
    if (!channel.online || !primary || !active) return;
    let stale = false;
    void teamAction<TeamModelMenu>(agentId, channel.channelId, { sessionKey: peer.sessionKey, sessionId: peer.sessionId }, { kind: 'options' }).then(menu => { if (!stale) setCatalog(menu); }).catch(error => { if (!stale) setError(errorText(error)); });
    return () => { stale = true; };
  }, [active, agentId, channel.channelId, channel.online, peer.sessionKey, peer.sessionId, primary, session.configSnapshotAt]);
  const showTools = async () => { try { setTools(await teamAction<TeamTools>(agentId, channel.channelId, peer, { kind: 'tools' })); } catch (error) { setError(errorText(error)); } };
  return <aside className="min-w-0 rounded-lg border border-[var(--line)] p-4" aria-label={t('teamAi.detail')}>
    <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{session.title || t('teamAi.untitled')}</h2><p className="mt-1 break-all text-xs text-[var(--ink-muted)]">{session.id}</p></div><button className={button} aria-label={t('teamAi.close')} onClick={onClose}>×</button></div>
    <div className="my-3 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-[var(--ink-muted)]">{data?.liveSessionState ? String(data.liveSessionState) : t('teamAi.noLiveState')}</span><button className={`${button} bg-[var(--paper-inset)]`} onClick={onOpen}>{t('teamAi.open')}</button></div>
    {error && <p role="alert" className="mb-3 text-xs text-[var(--error)]">{error}</p>}
    {!primary && <p className="mb-4 text-xs text-[var(--ink-muted)]">{t('teamAi.historyHint')}</p>}
    {catalog && <div className="mb-5 space-y-3">
      <div><p className="mb-1 text-xs text-[var(--ink-muted)]">Runtime</p><CustomSelect ariaLabel="Runtime" size="md" value={catalog.runtime} disabled={!editable} onChange={value => { const runtime = value as RuntimeType; if (runtime === catalog.runtime && catalog.runtimeSource !== 'managed-provider') return; onConfirm(() => onAction({ kind: 'switchRuntime', runtime, snapshotObservation: catalog.snapshotObservation })); }}
        options={(['builtin', 'dsh', 'codex', 'claude-code'] as const).map(runtime => ({ value: runtime, label: RUNTIME_DISPLAY_NAMES[runtime] }))} /></div>
      <div><p className="mb-1 text-xs text-[var(--ink-muted)]">{t('teamAi.model')}</p><CustomSelect ariaLabel={t('teamAi.model')} size="md" disabled={!editable} value={String(catalog.options.findIndex(o => o.isCurrent))} placeholder={session.model || t('teamAi.defaultModel')}
        onChange={value => { const option = catalog.options[Number(value)]; if (!option) return; const apply = () => onAction({ kind: 'selectModel', selection: option.selection, snapshotObservation: catalog.snapshotObservation, confirmed: option.requiresNewSession }); if (option.requiresNewSession) onConfirm(apply); else apply(); }}
        options={catalog.options.map((option, index) => ({ value: String(index), label: `${option.group} · ${option.name}`, suffix: option.requiresNewSession ? t('teamAi.requiresNew') : undefined }))} /></div>
      <button className={button} disabled={!editable} onClick={() => { if (tools) setTools(null); else void showTools(); }}>{t('teamAi.tools')}</button>
      {!!catalog.reasoningEffortChoices?.length && <div><p className="mb-1 text-xs text-[var(--ink-muted)]">{t('teamAi.effort')}</p><CustomSelect ariaLabel={t('teamAi.effort')} size="md" disabled={!editable} value={catalog.reasoningEffort ?? 'default'} options={['default', ...catalog.reasoningEffortChoices].map(value => ({ value, label: t(`teamAi.efforts.${value}`, { defaultValue: value }) }))} onChange={effort => onAction({ kind: 'setEffort', effort, snapshotObservation: catalog.snapshotObservation })} /></div>}
    </div>}
    {tools && <div className="mb-5 space-y-3">{([
      ['mcp', 'mcpEnabledServers', 'MCP'], ['plugins', 'enabledPluginIds', t('teamAi.plugins')], ['official', 'enabledOfficialToolIds', t('teamAi.official')],
    ] as const).map(([items, field, title]) => <fieldset key={field} disabled={!editable || (field !== 'enabledOfficialToolIds' && !tools.canManageExtensions)}><legend className="mb-1 text-xs font-medium">{title}</legend>
      {tools[items].map(tool => <label key={tool.id} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" checked={tools[field].includes(tool.id)} onChange={event => setTools({ ...tools, [field]: event.target.checked ? [...tools[field], tool.id] : tools[field].filter(id => id !== tool.id) })} />{tool.name}</label>)}
      {tools[items].length === 0 && <span className="text-xs text-[var(--ink-muted)]">{t('teamAi.none')}</span>}
    </fieldset>)}<button className={`${button} bg-[var(--paper-inset)]`} disabled={!editable} onClick={() => onAction({ kind: 'saveTools', snapshotObservation: tools.snapshotObservation, ...(tools.canManageExtensions ? { mcpEnabledServers: tools.mcpEnabledServers, enabledPluginIds: tools.enabledPluginIds } : {}), enabledOfficialToolIds: tools.enabledOfficialToolIds })}>{t('teamAi.saveTools')}</button></div>}
    {!channel.online && <p className="mb-4 text-xs text-[var(--ink-muted)]">{t('teamAi.offlineHelp')}</p>}
    <h3 className="mb-2 text-xs font-medium text-[var(--ink-muted)]">{t('teamAi.recent')}</h3>
    <div className="max-h-[520px] space-y-3 overflow-y-auto">{[...(data?.messages ?? []).filter(message => message.id !== data?.liveStreamingMessage?.id), ...(data?.liveStreamingMessage ? [data.liveStreamingMessage] : [])].map(message => <Message key={message.id} isLoading={message.id === data?.liveStreamingMessage?.id} message={{ ...message, attachments: message.attachments?.map(attachment => ({ ...attachment, size: 0, relativePath: attachment.path, isImage: attachment.mimeType.startsWith('image/') })), content: normalizeSessionMessageContent(message.content), timestamp: new Date(message.timestamp) }} />)}
      {data?.messages?.length === 0 && !data.liveStreamingMessage && <p className="py-4 text-sm text-[var(--ink-muted)]">{t('teamAi.noMessages')}</p>}
      {!data && !error && <div className="h-20 animate-pulse rounded-md bg-[var(--paper-inset)]" />}
    </div>
  </aside>;
}
