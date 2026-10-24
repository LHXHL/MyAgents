import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionMetadata } from '@/api/sessionClient';
import { ChannelPlatformIcon } from '@/components/AgentSettings/channelPlatform';
import ContextMenu, { type ContextMenuItem } from '@/components/ContextMenu';
import RuntimeIcon from '@/components/RuntimeIcon';
import { sessionRuntimePresentation } from '@/components/runtimePresentation';
import { Toggle } from '@/components/task-center/editors/PanelChrome';
import { DropdownMenu } from '@/components/ui/DropdownMenu';
import { Popover } from '@/components/ui/Popover';
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalIcon,
  InfoIcon,
  PlusIcon,
  PowerIcon,
  ShieldIcon,
  StopIcon,
} from '@/components/icons';
import { formatAbsoluteDateTime, formatPastRelativeTime } from '@/i18n/format';
import { getSessionDisplayText } from '@/utils/sessionDisplay';
import { copyPlainText } from '@/utils/clipboard';
import { canManageSessionExtensions, type TeamAction, type TeamModelMenu, type TeamSessionState, type TeamTools } from '@/../shared/teamAi';
import type { RuntimeSource, RuntimeType } from '@/../shared/types/runtime';
import { teamAction } from './client';
import { channelOffline, isBusyActivity, peerHistory, peerLabel, sessionActivity, type PeerRow } from './model';
import { ActivityMark, PeerAvatar } from './PeerList';

export const ghostButton =
  'compact-action gap-1.5 px-2.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40';
export const secondaryButton =
  'compact-action gap-1.5 border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm text-[var(--ink)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-40';
export const primaryButton =
  'compact-action gap-1.5 bg-[var(--button-primary-bg)] px-3.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40';
const menuOption =
  'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-sm text-[var(--ink)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-40';

export type TeamNote = { tone: 'ok' | 'err' | 'info'; text: string };
export type TeamPending = { key: string; kind: TeamAction['kind']; sessionId?: string };
/** Execute a Team AI action; the page owns feedback. `done` is the success text. */
export type RunTeamAction = (action: TeamAction, done: string) => Promise<void>;
export type ConfirmRequest = { title: string; message: string; confirmText: string; onConfirm: () => void };

const RUNTIMES: RuntimeType[] = ['builtin', 'dsh', 'codex', 'claude-code'];

export function PeerDetail({ agentId, row, sessions, states, pending, note, run, confirm, onOpen, onAccess, onEnable, onBack }: {
  agentId: string;
  row: PeerRow;
  sessions: SessionMetadata[];
  states: TeamSessionState[];
  pending: TeamPending | null;
  note: TeamNote | null;
  run: RunTeamAction;
  confirm: (request: ConfirmRequest) => void;
  onOpen: (session: SessionMetadata) => void;
  onAccess: () => void;
  onEnable: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('app');
  const { channel, peer, current } = row;
  const off = channelOffline(channel);
  const history = peerHistory(peer, sessions);
  const kind = t(`teamAi.${peer.sourceType}`);
  const copy = (value: string) => { void copyPlainText(value).catch(() => undefined); };
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pt-5 pb-10">
      <button className={`${ghostButton} -ml-2 mb-2 @[720px]/team-ai:hidden`} onClick={onBack}>
        <ArrowLeftIcon className="h-4 w-4" />
        {t('teamAi.back')}
      </button>
      <header className="flex items-center gap-3 pb-4">
        <PeerAvatar peer={peer} size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold" title={peer.name ? undefined : peer.sourceId}>{peerLabel(peer)}</h2>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--ink-muted)]">
            <ChannelPlatformIcon type={channel.platform} className="h-3.5 w-3.5" />
            <span className="truncate">{channel.name || channel.platform}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{kind}</span>
          </p>
        </div>
        <button className={ghostButton} onClick={onAccess}>
          <ShieldIcon className="h-4 w-4" />
          {t('teamAi.access')}
        </button>
        <DropdownMenu
          size="md"
          title={t('teamAi.peerMenu')}
          sections={[{ items: [
            { icon: <CopyIcon className="h-4 w-4" />, label: t('teamAi.copyPeerId'), onClick: () => copy(peer.sourceId) },
            ...(peer.sessionId ? [{ icon: <CopyIcon className="h-4 w-4" />, label: t('teamAi.copySessionId'), onClick: () => copy(peer.sessionId!) }] : []),
          ] }]}
        />
      </header>
      {off && (
        <div className="mb-4 flex items-center gap-2.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] px-3.5 py-2.5 text-sm text-[var(--ink-muted)]">
          <InfoIcon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{t('teamAi.channelOff', { name: channel.name || channel.platform, status: t(`teamAi.${off}`) })}</span>
          {off === 'disabled' && (
            <button className={secondaryButton} onClick={onEnable}>
              <PowerIcon className="h-4 w-4" />
              {t('teamAi.enable')}
            </button>
          )}
        </div>
      )}
      <section className="mt-2">
        <h3 className="mb-2.5 text-sm font-semibold text-[var(--ink-muted)]">{t('teamAi.current')}</h3>
        {current ? (
          <CurrentSessionCard
            agentId={agentId}
            row={row}
            session={current}
            editable={!off && !pending}
            pending={pending}
            note={note}
            run={run}
            confirm={confirm}
            onOpen={() => onOpen(current)}
          />
        ) : (
          <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3.5 text-sm text-[var(--ink-muted)]">
            <p>{t('teamAi.noCurrent')}</p>
            <div className="mt-3 flex items-center gap-2">
              <span className="min-w-0 flex-1 text-xs" aria-live="polite">{note?.text}</span>
              <button className={secondaryButton} disabled={!!off || !!pending} onClick={() => { void run({ kind: 'new' }, t('teamAi.done.created')); }}>
                <PlusIcon className="h-4 w-4" />
                {pending?.kind === 'new' ? t('teamAi.creating') : t('teamAi.new')}
              </button>
            </div>
          </div>
        )}
      </section>
      <section className="mt-7">
        <h3 className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-[var(--ink-muted)]">
          {t('teamAi.history')}
          {history.items.length > 0 && <span className="font-normal text-[var(--ink-subtle)]">{history.items.length}</span>}
        </h3>
        <HistoryList
          items={history.items}
          missing={history.missing}
          row={row}
          states={states}
          disabled={!!off || !!pending}
          pending={pending}
          run={run}
          onOpen={onOpen}
        />
      </section>
    </div>
  );
}

function CurrentSessionCard({ agentId, row, session, editable, pending, note, run, confirm, onOpen }: {
  agentId: string;
  row: PeerRow;
  session: SessionMetadata;
  editable: boolean;
  pending: TeamPending | null;
  note: TeamNote | null;
  run: RunTeamAction;
  confirm: (request: ConfirmRequest) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation('app');
  const { channel, peer, activity } = row;
  const target = { sessionKey: peer.sessionKey, sessionId: peer.sessionId };
  const [catalog, setCatalog] = useState<TeamModelMenu | null>(null);
  const online = !channelOffline(channel);
  useEffect(() => {
    if (!online) return;
    let stale = false;
    void teamAction<TeamModelMenu>(agentId, channel.channelId, target, { kind: 'options' })
      .then(menu => { if (!stale) setCatalog(menu); })
      .catch(() => { if (!stale) setCatalog(null); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `target` is derived from these keys; the snapshot marker invalidates the catalog
  }, [agentId, channel.channelId, peer.sessionKey, peer.sessionId, session.configSnapshotAt, online]);

  const runtime = (session.runtime ?? 'builtin') as RuntimeType;
  const runtimeName = sessionRuntimePresentation(runtime, session.runtimeSource as RuntimeSource | undefined).name;
  const currentModel = catalog?.options.find(option => option.isCurrent);
  const effort = catalog?.reasoningEffort ?? session.reasoningEffort ?? 'default';
  const effortChoices = catalog?.reasoningEffortChoices ?? null;
  const canManage = canManageSessionExtensions(session.runtime, session.runtimeSource);
  const toolCounts = { mcp: session.mcpEnabledServers?.length ?? 0, plugins: session.enabledPluginIds?.length ?? 0, official: session.enabledOfficialToolIds?.length ?? 0 };
  const context = session.lastContextUsage?.usedPercent;
  const kindContext = { context: peer.sourceType };

  const switchTo = (targetName: string, action: TeamAction) => confirm({
    title: t('teamAi.switchTitle', { target: targetName }),
    message: t('teamAi.switchMessage', { target: targetName, peer: peerLabel(peer) }),
    confirmText: t('teamAi.switchConfirm'),
    onConfirm: () => { void run(action, t('teamAi.done.created')); },
  });

  const status = (() => {
    const lastActive = session.lastActiveAt ? formatPastRelativeTime(Date.parse(session.lastActiveAt)) : '';
    const desc = activity === 'dormant' || activity === 'unknown' || activity === 'error'
      ? t(`teamAi.statusDesc.${activity}`)
        : lastActive ? t('teamAi.statusDesc.lastActive', { time: lastActive }) : '';
    return { label: t(`teamAi.status.${activity}`), desc };
  })();

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)]">
      <div className="flex items-baseline gap-3 px-4 pt-3.5">
        <span className="min-w-0 flex-1 truncate text-base font-semibold">{getSessionDisplayText(session)}</span>
        {session.createdAt && (
          <span className="shrink-0 text-xs text-[var(--ink-muted)]" title={formatAbsoluteDateTime(new Date(session.createdAt))}>
            {t('teamAi.createdAt', { time: formatPastRelativeTime(Date.parse(session.createdAt)) })}
          </span>
        )}
      </div>
      <div className={`mx-3 mt-3 flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 ${activity === 'error' ? 'bg-[var(--error-bg)]' : 'bg-[var(--paper-inset)]'}`}>
        <div className="min-w-0 flex-1">
          <div className={`flex items-center gap-2 text-sm font-medium ${isBusyActivity(activity) ? 'text-[var(--success)]' : activity === 'error' ? 'text-[var(--error)]' : activity === 'dormant' || activity === 'unknown' ? 'text-[var(--ink-muted)]' : ''}`}>
            {isBusyActivity(activity) || activity === 'error'
              ? <ActivityMark activity={activity} />
              : <span className={`h-1.5 w-1.5 rounded-full ${activity === 'dormant' ? 'border border-[var(--ink-subtle)]' : 'bg-[var(--ink-muted)]'}`} />}
            {status.label}
          </div>
          {status.desc && <div className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">{status.desc}</div>}
        </div>
        {typeof context === 'number' && (
          <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--ink-muted)]" title={t('teamAi.contextHint')}>
            {t('teamAi.context')}
            <span className="h-1 w-16 overflow-hidden rounded-full bg-[var(--line-strong)]">
              <span className={`block h-full rounded-full ${context >= 60 ? 'bg-[var(--warning)]' : 'bg-[var(--ink-muted)]'}`} style={{ width: `${Math.min(100, Math.max(0, context))}%` }} />
            </span>
            {Math.round(context)}%
          </span>
        )}
        {activity === 'running' && (
          <button className={secondaryButton} disabled={!editable} onClick={() => { void run({ kind: 'stop' }, t('teamAi.done.stopped')); }}>
            <StopIcon className="h-3.5 w-3.5" />
            {t('teamAi.stop')}
          </button>
        )}
      </div>

      <div className="px-2 pt-3 pb-1">
        <div className="flex min-h-7 items-center gap-2 px-2 pb-1 text-xs text-[var(--ink-muted)]">
          {peer.hasProfile ? (
            <>
              <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-[var(--accent-warm-subtle)] px-1.5 text-xs text-[var(--accent-warm)]">{t('teamAi.profile.custom')}</span>
              <span className="min-w-0 flex-1 truncate">{t('teamAi.profile.customHint', kindContext)}</span>
              <button
                className="shrink-0 text-[var(--accent-warm)] underline-offset-2 hover:underline disabled:opacity-40"
                disabled={!editable}
                onClick={() => confirm({
                  title: t('teamAi.profile.resetTitle'),
                  message: t('teamAi.profile.resetMessage'),
                  confirmText: t('teamAi.profile.resetConfirm'),
                  onConfirm: () => { void run({ kind: 'clearProfile' }, t('teamAi.profile.resetDone')); },
                })}
              >
                {t('teamAi.profile.reset')}
              </button>
            </>
          ) : (
            <>
              <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-[var(--paper-inset)] px-1.5 text-xs">{t('teamAi.profile.default')}</span>
              <span className="min-w-0 flex-1 truncate">{t('teamAi.profile.defaultHint', kindContext)}</span>
            </>
          )}
        </div>

        <PropRow label={t('teamAi.runtime')} disabled={!editable || !catalog} value={<><RuntimeIcon type={runtime} size={16} />{runtimeName}</>}>
          {close => RUNTIMES.map(option => {
            const name = sessionRuntimePresentation(option).name;
            const isCurrent = option === runtime && session.runtimeSource !== 'managed-provider';
            return (
              <button key={option} className={menuOption} onClick={() => {
                close();
                if (!isCurrent && catalog) switchTo(name, { kind: 'switchRuntime', runtime: option, snapshotObservation: catalog.snapshotObservation });
              }}>
                <RuntimeIcon type={option} size={16} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {isCurrent ? <CheckIcon className="h-4 w-4 text-[var(--accent)]" /> : <NewSessionTag />}
              </button>
            );
          })}
        </PropRow>

        <PropRow
          label={t('teamAi.model')}
          disabled={!editable || !catalog?.options.length}
          value={<>{currentModel?.name ?? session.model ?? t('teamAi.defaultModel')}{currentModel && <span className="truncate text-xs text-[var(--ink-subtle)]">{currentModel.group}</span>}</>}
        >
          {close => catalog?.options.map((option, index) => (
            <div key={`${option.group}:${option.name}:${index}`}>
              {(index === 0 || option.group !== catalog.options[index - 1].group) && (
                <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-[var(--ink-subtle)]">{option.group}</div>
              )}
              <button className={menuOption} onClick={() => {
                close();
                if (option.isCurrent) return;
                const action: TeamAction = { kind: 'selectModel', selection: option.selection, snapshotObservation: catalog.snapshotObservation, confirmed: option.requiresNewSession };
                if (option.requiresNewSession) switchTo(option.name, action);
                else void run(action, t('teamAi.done.model', { name: option.name }));
              }}>
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                {option.isCurrent ? <CheckIcon className="h-4 w-4 text-[var(--accent)]" /> : option.requiresNewSession ? <NewSessionTag /> : null}
              </button>
            </div>
          ))}
        </PropRow>

        {(effortChoices?.length || (!catalog && session.reasoningEffort)) ? (
          <PropRow label={t('teamAi.effort')} disabled={!editable || !effortChoices?.length} value={t(`teamAi.efforts.${effort}`, { defaultValue: effort })}>
            {close => ['default', ...(effortChoices ?? [])].map(value => (
              <button key={value} className={menuOption} onClick={() => {
                close();
                if (value !== effort && catalog) void run({ kind: 'setEffort', effort: value, snapshotObservation: catalog.snapshotObservation }, t('teamAi.done.effort'));
              }}>
                <span className="min-w-0 flex-1">{t(`teamAi.efforts.${value}`, { defaultValue: value })}</span>
                {value === effort && <CheckIcon className="h-4 w-4 text-[var(--accent)]" />}
              </button>
            ))}
          </PropRow>
        ) : null}

        <PropRow
          label={t('teamAi.tools')}
          disabled={!editable}
          value={canManage
            ? <>{t('teamAi.toolsCount', { count: toolCounts.mcp + toolCounts.plugins + toolCounts.official })}<span className="truncate text-xs text-[var(--ink-subtle)]">{t('teamAi.toolsBreakdown', toolCounts)}</span></>
            : <span className="text-[var(--ink-muted)]">{t('teamAi.toolsExternal', { runtime: runtimeName })}</span>}
        >
          {() => <ToolsPanel agentId={agentId} channelId={channel.channelId} target={target} runtimeName={runtimeName} run={run} />}
        </PropRow>
      </div>

      <div className="mt-1 flex items-center gap-2 border-t border-[var(--line-subtle)] px-4 py-3">
        <span
          className={`min-w-0 flex-1 truncate text-xs ${note?.tone === 'ok' ? 'text-[var(--success)]' : note?.tone === 'err' ? 'text-[var(--error)]' : 'text-[var(--ink-muted)]'}`}
          aria-live="polite"
          title={note?.text}
        >
          {pending && !pending.sessionId ? t(pending.kind === 'new' ? 'teamAi.creating' : 'teamAi.saving') : note?.text}
        </span>
        <button className={secondaryButton} disabled={!editable} onClick={() => { void run({ kind: 'new' }, t('teamAi.done.created')); }}>
          <PlusIcon className="h-4 w-4" />
          {t('teamAi.new')}
        </button>
        <button className={primaryButton} onClick={onOpen}>
          <ExternalIcon className="h-4 w-4" />
          {t('teamAi.open')}
        </button>
      </div>
    </div>
  );
}

function NewSessionTag() {
  const { t } = useTranslation('app');
  return <span className="ml-auto inline-flex h-[18px] shrink-0 items-center rounded-full bg-[var(--warning-bg)] px-1.5 text-xs text-[var(--warning)]">{t('teamAi.requiresNew')}</span>;
}

/** One label/value row whose value opens a popover editor. */
function PropRow({ label, value, disabled, children }: { label: string; value: ReactNode; disabled?: boolean; children: (close: () => void) => ReactNode }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div role="group" aria-label={label} className="flex min-h-10 items-center gap-3 rounded-[var(--radius-sm)] px-2 [&+&]:border-t [&+&]:border-[var(--line-subtle)]">
      <span className="w-[84px] shrink-0 text-sm text-[var(--ink-muted)]" aria-hidden="true">{label}</span>
      <button
        ref={anchor}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group -ml-2 flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-sm hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:hover:bg-transparent aria-expanded:bg-[var(--hover-bg)]"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{value}</span>
        {!disabled && <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-aria-expanded:opacity-100" />}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="bottom-start" className="max-h-[360px] min-w-[240px] overflow-y-auto p-1">
        {open && children(() => setOpen(false))}
      </Popover>
    </div>
  );
}

function ToolsPanel({ agentId, channelId, target, runtimeName, run }: {
  agentId: string;
  channelId: string;
  target: { sessionKey: string; sessionId: string | null };
  runtimeName: string;
  run: RunTeamAction;
}) {
  const { t } = useTranslation('app');
  const [tools, setTools] = useState<TeamTools | null>(null);
  const [saving, setSaving] = useState(false);
  const load = () => teamAction<TeamTools>(agentId, channelId, target, { kind: 'tools' }).then(setTools).catch(() => setTools(null));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per open; each save re-reads below
  useEffect(() => { void load(); }, []);
  if (!tools) return <div className="h-24 w-[280px] animate-pulse rounded-[var(--radius-sm)] bg-[var(--paper-inset)]" />;
  const toggle = async (field: 'mcpEnabledServers' | 'enabledPluginIds' | 'enabledOfficialToolIds', id: string) => {
    const next = { ...tools, [field]: tools[field].includes(id) ? tools[field].filter(item => item !== id) : [...tools[field], id] };
    setTools(next);
    setSaving(true);
    await run({
      kind: 'saveTools',
      snapshotObservation: tools.snapshotObservation,
      ...(tools.canManageExtensions ? { mcpEnabledServers: next.mcpEnabledServers, enabledPluginIds: next.enabledPluginIds } : {}),
      enabledOfficialToolIds: next.enabledOfficialToolIds,
    }, t('teamAi.done.tools'));
    await load();
    setSaving(false);
  };
  const sections = [
    ['mcp', 'mcpEnabledServers', 'MCP'],
    ['plugins', 'enabledPluginIds', t('teamAi.plugins')],
    ['official', 'enabledOfficialToolIds', t('teamAi.official')],
  ] as const;
  return (
    <div className="w-[280px]" role="group" aria-busy={saving}>
      {sections.map(([items, field, title]) => (
        <div key={field}>
          <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-[var(--ink-subtle)]">{title}</div>
          {tools[items].length === 0 && <div className="px-2.5 py-1 text-xs text-[var(--ink-subtle)]">{t('teamAi.none')}</div>}
          {tools[items].map(item => (
            <div key={item.id} className="flex min-h-9 items-center gap-2 px-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
              <Toggle
                checked={tools[field].includes(item.id)}
                ariaLabel={item.name}
                disabled={saving || (field !== 'enabledOfficialToolIds' && !tools.canManageExtensions)}
                onChange={() => { void toggle(field, item.id); }}
              />
            </div>
          ))}
        </div>
      ))}
      <p className="mt-1 border-t border-[var(--line-subtle)] px-2.5 pt-2 pb-1.5 text-xs text-[var(--ink-muted)]">
        {tools.canManageExtensions ? t('teamAi.toolsFooter') : t('teamAi.toolsExternalFooter', { runtime: runtimeName })}
      </p>
    </div>
  );
}

function HistoryList({ items, missing, row, states, disabled, pending, run, onOpen }: {
  items: SessionMetadata[];
  missing: number;
  row: PeerRow;
  states: TeamSessionState[];
  disabled: boolean;
  pending: TeamPending | null;
  run: RunTeamAction;
  onOpen: (session: SessionMetadata) => void;
}) {
  const { t } = useTranslation('app');
  const [menu, setMenu] = useState<{ x: number; y: number; session: SessionMetadata } | null>(null);
  const setCurrent = (session: SessionMetadata) => { void run({ kind: 'setPrimary', sessionId: session.id }, t('teamAi.done.setCurrent')); };
  const actions = (session: SessionMetadata): ContextMenuItem[] => [
    { label: t('teamAi.open'), icon: <ExternalIcon className="h-4 w-4" />, onClick: () => onOpen(session) },
    { label: t('teamAi.setCurrentMenu'), icon: <CheckIcon className="h-4 w-4" />, disabled, onClick: () => setCurrent(session) },
    { label: t('teamAi.copyId'), icon: <CopyIcon className="h-4 w-4" />, onClick: () => { void copyPlainText(session.id).catch(() => undefined); } },
  ];
  return (
    <div>
      {items.map(session => {
        const busy = isBusyActivity(sessionActivity(states.find(s => s.channelId === row.channel.channelId && s.sessionKey === row.peer.sessionKey && s.sessionId === session.id)));
        const switching = pending?.kind === 'setPrimary' && pending.sessionId === session.id;
        return (
          <div
            key={session.id}
            role="button"
            tabIndex={0}
            title={t('teamAi.open')}
            onClick={() => onOpen(session)}
            onKeyDown={event => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onOpen(session);
              }
            }}
            onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, session }); }}
            className={`group/history flex h-[38px] cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-2.5 outline-none hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${switching ? 'opacity-60' : ''}`}
          >
            <span className="min-w-0 flex-1 truncate text-sm">{getSessionDisplayText(session)}</span>
            {busy && (
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--ink-muted)]" title={t('teamAi.finishingHint')}>
                <ActivityMark activity="running" />
                {t('teamAi.finishing')}
              </span>
            )}
            {switching ? (
              <span className="shrink-0 text-xs text-[var(--ink-muted)]">{t('teamAi.switching')}</span>
            ) : (
              <>
                <span className="shrink-0 text-xs text-[var(--ink-muted)] group-focus-within/history:hidden group-hover/history:hidden">
                  {session.lastActiveAt ? formatPastRelativeTime(Date.parse(session.lastActiveAt)) : ''}
                </span>
                <span className="hidden shrink-0 items-center gap-0.5 group-focus-within/history:flex group-hover/history:flex" onClick={event => event.stopPropagation()}>
                  <button className={`${ghostButton} h-7 min-w-0 text-xs`} disabled={disabled} onClick={() => setCurrent(session)}>{t('teamAi.setCurrent')}</button>
                  <DropdownMenu
                    title={t('teamAi.peerMenu')}
                    sections={[{ items: actions(session).filter((item): item is Exclude<ContextMenuItem, { separator: true }> => !item.separator) }]}
                  />
                </span>
              </>
            )}
          </div>
        );
      })}
      {items.length === 0 && <p className="px-2.5 py-2 text-sm text-[var(--ink-subtle)]">{t('teamAi.noHistory')}</p>}
      {missing > 0 && <p className="px-2.5 py-2 text-xs text-[var(--ink-subtle)]">{t('teamAi.deletedCount', { count: missing })}</p>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={actions(menu.session)} onClose={() => setMenu(null)} />}
    </div>
  );
}
