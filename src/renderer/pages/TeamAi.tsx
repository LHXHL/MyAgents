import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listenWithCleanup } from "@/utils/tauriListen";
import { useConfigData } from "@/config/useConfigData";
import { useConfigActions } from "@/config/useConfigActions";
import { getSessions, type SessionMetadata } from "@/api/sessionClient";
import { isProjectVisibleToUser, isProjectArchived } from "@/config/types";
import type { TeamAction, TeamChannel, TeamPeer, TeamModelMenu, TeamTools, TeamSessionState } from "@/../shared/teamAi";
import { RUNTIME_DISPLAY_NAMES, type RuntimeType, type RuntimeSource } from "@/../shared/types/runtime";
import { teamAction, teamChannels, teamSession, teamStates, type TeamSessionData } from "@/features/team-ai/client";
import Message from "@/components/Message";
import { normalizeSessionMessageContent } from "@/context/sessionRestoreGuards";
import type { TeamAiBinding } from "@/features/team-ai/tabModule";
import ConfirmDialog from "@/components/ConfirmDialog";
import ContextMenu from "@/components/ContextMenu";
import CustomSelect from "@/components/CustomSelect";
import AgentWorkspacePickerDialog from "@/components/AgentWorkspacePickerDialog";
import { orderWorkspaceSelectorProjects } from "@/components/launcher/WorkspaceSelector";
import WorkspaceIcon from "@/components/launcher/WorkspaceIcon";
import RuntimeIcon from "@/components/RuntimeIcon";
import { sessionRuntimePresentation } from "@/components/runtimePresentation";
import DropdownMenu from "@/components/ui/DropdownMenu";
import McpToolsCard from "@/components/ImSettings/components/McpToolsCard";
import Tip from "@/components/Tip";
import { getChannelTypeLabel } from "@/utils/taskCenterUtils";
import { getSessionDisplayText } from "@/utils/sessionDisplay";
import { formatAbsoluteDateTime } from "@/i18n/format";
import {
  AtIcon,
  ChevronDownIcon,
  CloseIcon,
  RefreshIcon,
  PlusIcon,
  SlidersIcon,
  MessageIcon,
  UserIcon,
  ExternalIcon,
  CheckIcon,
  StopIcon,
} from "@/components/icons";
const WorkspaceConfigPanel = lazy(() => import("@/components/WorkspaceConfigPanel"));
const button =
  "compact-action gap-1.5 px-3 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40";
const primaryButton =
  "compact-action gap-1.5 bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
type Selection = { channelId: string; sessionKey: string; sessionId: string };

export default function TeamAi({
  isActive,
  onCreate,
  onOpenSession,
  projectId,
  onSelectProject,
}: Omit<TeamAiBinding, "onSelectProject"> & {
  isActive: boolean;
  projectId?: string;
  onSelectProject: (id: string) => void;
}) {
  const { t } = useTranslation("app");
  const { projects, config } = useConfigData();
  const { patchProject } = useConfigActions();
  const visible = useMemo(
    () => projects.filter((p) => isProjectVisibleToUser(p) && !isProjectArchived(p) && p.agentId),
    [projects],
  );
  const teams = useMemo(() => visible.filter((p) => p.purpose === "team-ai"), [visible]);
  const candidates = useMemo(
    () =>
      orderWorkspaceSelectorProjects(
        visible.filter((p) => p.purpose !== "team-ai"),
        config.defaultWorkspacePath,
      ),
    [visible, config.defaultWorkspacePath],
  );
  const project = teams.find((p) => p.id === projectId) ?? teams[0];
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
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    channel: TeamChannel;
    peer: TeamPeer;
    session: SessionMetadata;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<(() => void) | null>(null);
  const generation = useRef(0);
  const agentId = project?.agentId;
  const path = project?.path;
  const refresh = useCallback(async () => {
    if (!agentId || !path) {
      setChannels([]);
      setSessions([]);
      return;
    }
    const epoch = ++generation.current;
    setLoading(true);
    try {
      const [result, metadata] = await Promise.all([teamChannels(agentId), getSessions(path)]);
      if (generation.current !== epoch) return;
      setChannels(result.channels);
      setSessions(metadata);
      setError(null);
      const targets = result.channels
        .flatMap((channel) =>
          channel.peers.flatMap((peer) =>
            [...new Set([peer.sessionId, ...peer.sessionIds].filter((id): id is string => !!id))]
              .filter((id) => metadata.some((session) => session.id === id))
              .map((sessionId) => ({
                channelId: channel.channelId,
                sessionKey: peer.sessionKey,
                sessionId,
              })),
          ),
        )
        .slice(0, 64);
      try {
        const observed = await teamStates(agentId, targets);
        if (generation.current === epoch) setStates(observed.states);
      } catch {
        if (generation.current === epoch) setStates([]);
      }
    } catch (error) {
      if (generation.current === epoch) setError(errorText(error));
    } finally {
      if (generation.current === epoch) setLoading(false);
    }
  }, [agentId, path]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [agentId],
  );
  useEffect(() => {
    if (!isActive || !agentId) return;
    const controller = new AbortController();
    const subscriptions = ["agent:status-changed", "session:metadata-changed"].map((event) =>
      listenWithCleanup(
        event,
        () => {
          void refresh();
        },
        controller.signal,
      ),
    );
    for (const subscription of subscriptions)
      void subscription.catch((error) => console.warn("[team-ai] listener unavailable", error));
    const interval = setInterval(() => {
      void refresh();
    }, 8000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [agentId, isActive, refresh]);
  const selectedChannel = channels.find((c) => c.channelId === selection?.channelId);
  const selectedPeer = selectedChannel?.peers.find((p) => p.sessionKey === selection?.sessionKey);
  const selectedMetadata = sessions.find((s) => s.id === selection?.sessionId);
  const perform = useCallback(
    async (channel: TeamChannel, peer: TeamPeer, action: TeamAction) => {
      if (!agentId || busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const result = await teamAction(agentId, channel.channelId, peer, action);
        if (result.requiresNewSession && !("confirmed" in action && action.confirmed)) {
          if (action.kind === "selectModel")
            setConfirmation(() => () => {
              void perform(channel, peer, { ...action, confirmed: true });
            });
          return;
        }
        if (result.success === false)
          setNotice(
            [
              result.sessionConfig === "saved" ? t("teamAi.savedNotApplied") : "",
              result.error,
              result.createdSessionId ? t("teamAi.createdUnbound", { id: result.createdSessionId }) : "",
            ]
              .filter(Boolean)
              .join(" "),
          );
        else if (result.statePersisted === false || result.notified === false || result.warning)
          setNotice(result.warning ?? t("teamAi.deliveryWarning"));
        else if (result.runtimeApply === "deferred" || result.runtimeApply === "pending-next-turn")
          setNotice(t("teamAi.nextTurn"));
        if (result.sessionId)
          setSelection({
            channelId: channel.channelId,
            sessionKey: peer.sessionKey,
            sessionId: result.sessionId,
          });
        await refresh();
      } catch (error) {
        setNotice(errorText(error));
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [agentId, busy, refresh, t],
  );
  const join = async (id: string) => {
    setBusy(true);
    try {
      await patchProject(id, { purpose: "team-ai" });
      onSelectProject(id);
      setError(null);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const sessionActions = (channel: TeamChannel, peer: TeamPeer, session: SessionMetadata) => [
    {
      label: t("teamAi.open"),
      icon: <ExternalIcon className="h-4 w-4" />,
      onClick: () => {
        if (project) onOpenSession(session, project);
      },
    },
    {
      label: t("teamAi.setPrimary"),
      icon: <CheckIcon className="h-4 w-4" />,
      disabled: busy || !channel.online || peer.sessionId === session.id,
      onClick: () => {
        void perform(channel, peer, {
          kind: "setPrimary",
          sessionId: session.id,
        });
      },
    },
  ];
  return (
    <div
      className="@container/team-ai h-full overflow-y-auto bg-[var(--paper)] text-[var(--ink)]"
      data-testid="team-ai-page"
    >
      <div className="mx-auto max-w-6xl px-6 py-7">
        <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <AtIcon className="h-6 w-6 text-[var(--ink-muted)]" aria-hidden="true" />
              Team AI
            </h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">{t("teamAi.description")}</p>
          </div>
          <div className="flex gap-1">
            {/* Keep the trigger focusable while saving; selection closes the modal before the async patch completes. */}
            <button
              className={`${button} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
              autoFocus={isActive}
              aria-disabled={busy}
              aria-haspopup="dialog"
              aria-expanded={joining}
              onClick={(event) => {
                if (busy) return;
                event.currentTarget.focus();
                setJoining(true);
              }}
            >
              {t("teamAi.join")}
            </button>
            <button className={primaryButton} onClick={onCreate}>
              <PlusIcon className="h-4 w-4" />
              {t("teamAi.create")}
            </button>
          </div>
        </header>
        {joining && (
          <AgentWorkspacePickerDialog
            projects={candidates}
            title={t("teamAi.selectWorkspaceTitle")}
            description={t("teamAi.selectWorkspaceDescription")}
            emptyLabel={t("teamAi.noCandidates")}
            onClose={() => setJoining(false)}
            onSelect={(project) => {
              setJoining(false);
              void join(project.id);
            }}
          />
        )}
        {error && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--error-bg)] px-4 py-3 text-sm text-[var(--error)]"
          >
            {error}
            <button
              className={button}
              onClick={() => {
                void refresh();
              }}
            >
              {t("teamAi.retry")}
            </button>
          </div>
        )}
        {teams.length === 0 ? (
          <div className="py-20 text-center">
            <AtIcon className="mx-auto mb-4 h-6 w-6 text-[var(--ink-muted)]" aria-hidden="true" />
            <p className="text-base font-medium">{t("teamAi.empty")}</p>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">{t("teamAi.emptyHint")}</p>
          </div>
        ) : (
          <>
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <CustomSelect
                ariaLabel="Team AI"
                className="w-72 max-w-full"
                size="toolbar"
                disabled={busy}
                value={project?.id ?? ""}
                onChange={(id) => {
                  setSelection(null);
                  setChannels([]);
                  setSessions([]);
                  setStates([]);
                  onSelectProject(id);
                }}
                options={teams.map((p) => ({
                  value: p.id,
                  label: p.displayName || p.name,
                  icon: <WorkspaceIcon icon={p.icon} size={20} />,
                }))}
              />
              <button className={button} onClick={() => setSettings(true)}>
                <SlidersIcon className="h-4 w-4" />
                {t("teamAi.channels")}
              </button>
              <Tip label={t("teamAi.refresh")}>
                <button
                  className="compact-action text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-40"
                  disabled={loading}
                  aria-label={t("teamAi.refresh")}
                  onClick={() => {
                    void refresh();
                  }}
                >
                  <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} />
                </button>
              </Tip>
            </div>
            {notice && (
              <p role="status" className="mb-4 rounded-md bg-[var(--paper-inset)] p-3 text-sm">
                {notice}
              </p>
            )}
            {loading && channels.length === 0 && (
              <div className="space-y-3" aria-label={t("teamAi.loading")}>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-12 animate-pulse rounded-md bg-[var(--paper-inset)]" />
                ))}
              </div>
            )}
            {!loading && !error && channels.length === 0 && (
              <p className="py-12 text-sm text-[var(--ink-muted)]">{t("teamAi.noChannels")}</p>
            )}
            <div
              className={`grid items-start gap-6 ${selection ? "@[900px]/team-ai:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" : ""}`}
            >
              <div className="min-w-0">
                {channels.map((channel) => (
                  <section key={channel.channelId} className="mb-6">
                    <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
                      <h2 className="min-w-0 truncate text-sm font-semibold">
                        {channel.name || getChannelTypeLabel(channel.platform)}
                        {channel.name && channel.name !== getChannelTypeLabel(channel.platform) && (
                          <span className="ml-2 font-normal text-[var(--ink-muted)]">
                            {getChannelTypeLabel(channel.platform)}
                          </span>
                        )}
                      </h2>
                      <span
                        className={`shrink-0 text-xs ${!channel.enabled ? "text-[var(--ink-muted)]" : channel.status === "error" ? "text-[var(--error)]" : channel.status === "connecting" ? "text-[var(--warning)]" : channel.online ? "text-[var(--success)]" : "text-[var(--ink-muted)]"}`}
                      >
                        {t(
                          `teamAi.${!channel.enabled ? "disabled" : ["online", "connecting", "error"].includes(channel.status) ? channel.status : "offline"}`,
                        )}
                      </span>
                    </div>
                    {channel.error && (
                      <p role="alert" className="mb-2 text-xs text-[var(--error)]">
                        {channel.error}
                      </p>
                    )}
                    {channel.peers.length === 0 && (
                      <p className="py-3 text-sm text-[var(--ink-muted)]">{t("teamAi.noPeers")}</p>
                    )}
                    {channel.peers.map((peer) => (
                      <details key={peer.sessionKey} className="group/peer border-t border-[var(--line)] py-1">
                        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-3 hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] [&::-webkit-details-marker]:hidden">
                          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 -rotate-90 text-[var(--ink-muted)] transition-transform group-open/peer:rotate-0 motion-reduce:transition-none" />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2 text-sm">
                              {peer.sourceType === "group" ? (
                                <MessageIcon className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                              ) : (
                                <UserIcon className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                              )}
                              <span className="truncate">{peer.name || peer.sourceId}</span>
                            </span>
                            <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">
                              {sessions.find((s) => s.id === peer.sessionId)?.title || t("teamAi.noPrimary")} ·{" "}
                              {peer.lastActive && Number.isFinite(Date.parse(peer.lastActive))
                                ? formatAbsoluteDateTime(new Date(peer.lastActive))
                                : t("teamAi.noActivity")}
                            </span>
                          </span>
                          <span className="shrink-0 text-right text-xs text-[var(--ink-muted)]">
                            {t(`teamAi.${peer.sourceType}`)}
                            <span className="mt-1 block">
                              {t(
                                `teamAi.states.${states.find((s) => s.channelId === channel.channelId && s.sessionKey === peer.sessionKey && s.sessionId === peer.sessionId)?.state ?? "unknown"}`,
                                { defaultValue: t("teamAi.noLiveState") },
                              )}
                            </span>
                          </span>
                        </summary>
                        <div className="mb-2 ml-4 flex flex-wrap gap-1">
                          <Tip label={t("teamAi.offlineHelp")} disabled={channel.online}>
                            <button
                              className={button}
                              disabled={!channel.online || busy}
                              onClick={() => {
                                void perform(channel, peer, { kind: "new" });
                              }}
                            >
                              <PlusIcon className="h-4 w-4" />
                              {t("teamAi.new")}
                            </button>
                          </Tip>
                          <button
                            className={button}
                            disabled={!channel.online || !peer.sessionId || busy}
                            onClick={() => {
                              void perform(channel, peer, { kind: "stop" });
                            }}
                          >
                            <StopIcon className="h-4 w-4" />
                            {t("teamAi.stop")}
                          </button>
                        </div>
                        {[...new Set([peer.sessionId, ...peer.sessionIds].filter((id): id is string => !!id))].map(
                          (id) => {
                            const metadata = sessions.find((s) => s.id === id);
                            if (!metadata)
                              return (
                                <p key={id} className="ml-6 py-2 text-xs text-[var(--ink-muted)]">
                                  {t("teamAi.unavailable")} · {id.slice(0, 8)}
                                </p>
                              );
                            const observation = states.find(
                              (s) =>
                                s.channelId === channel.channelId &&
                                s.sessionKey === peer.sessionKey &&
                                s.sessionId === id,
                            );
                            return (
                              <div
                                key={id}
                                className={`group ml-4 flex items-center gap-1 rounded-md ${selection?.sessionId === id && selection.channelId === channel.channelId && selection.sessionKey === peer.sessionKey ? "bg-[var(--paper-inset)]" : "hover:bg-[var(--hover-bg)]"}`}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  setMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                    channel,
                                    peer,
                                    session: metadata,
                                  });
                                }}
                              >
                                <button
                                  className="min-w-0 flex-1 rounded-md px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                                  aria-pressed={
                                    selection?.sessionId === id &&
                                    selection.channelId === channel.channelId &&
                                    selection.sessionKey === peer.sessionKey
                                  }
                                  onClick={() =>
                                    setSelection({
                                      channelId: channel.channelId,
                                      sessionKey: peer.sessionKey,
                                      sessionId: id,
                                    })
                                  }
                                >
                                  <span className="block truncate text-sm">{getSessionDisplayText(metadata)}</span>
                                  <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-[var(--ink-muted)]">
                                    {peer.sessionId === id ? <CheckIcon className="h-3 w-3 shrink-0" /> : null}
                                    <span className="shrink-0">
                                      {peer.sessionId === id ? t("teamAi.primary") : t("teamAi.history")}
                                    </span>
                                    <span className="truncate">
                                      ·{" "}
                                      {metadata.runtime && metadata.runtime in RUNTIME_DISPLAY_NAMES
                                        ? sessionRuntimePresentation(
                                            metadata.runtime as RuntimeType,
                                            metadata.runtimeSource,
                                          ).name
                                        : metadata.runtime || "Claude Agent SDK"}{" "}
                                      · {metadata.model || t("teamAi.defaultModel")}
                                    </span>
                                  </span>
                                </button>
                                <Tip
                                  label={
                                    observation?.error ||
                                    t(`teamAi.states.${observation?.state ?? "unknown"}`, {
                                      defaultValue: t("teamAi.noLiveState"),
                                    })
                                  }
                                >
                                  <span className="shrink-0 text-xs text-[var(--ink-muted)]">
                                    {t(`teamAi.states.${observation?.state ?? "unknown"}`, {
                                      defaultValue: observation?.state ?? t("teamAi.noLiveState"),
                                    })}
                                  </span>
                                </Tip>
                                {isActive && (
                                  <DropdownMenu
                                    size="md"
                                    title={t("teamAi.sessionMenu")}
                                    sections={[
                                      {
                                        items: sessionActions(channel, peer, metadata),
                                      },
                                    ]}
                                  />
                                )}
                              </div>
                            );
                          },
                        )}
                      </details>
                    ))}
                  </section>
                ))}
              </div>
              {project && selection && selectedChannel && selectedPeer && selectedMetadata && (
                <SessionDetail
                  key={`${selection.channelId}:${selection.sessionId}:${selectedMetadata.configSnapshotAt}:${selectedPeer.sessionId}:${selectedChannel.online}`}
                  agentId={agentId!}
                  channel={selectedChannel}
                  peer={selectedPeer}
                  session={selectedMetadata}
                  active={isActive}
                  busy={busy}
                  onClose={() => setSelection(null)}
                  onOpen={() => onOpenSession(selectedMetadata, project)}
                  onAction={(action) => {
                    void perform(selectedChannel, selectedPeer, action);
                  }}
                  onConfirm={(callback) => setConfirmation(() => callback)}
                />
              )}
            </div>
          </>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={sessionActions(menu.channel, menu.peer, menu.session)}
        />
      )}
      {confirmation && (
        <ConfirmDialog
          title={t("teamAi.switchTitle")}
          message={t("teamAi.switchMessage")}
          confirmText={t("teamAi.new")}
          onConfirm={() => {
            const callback = confirmation;
            setConfirmation(null);
            callback();
          }}
          onCancel={() => setConfirmation(null)}
        />
      )}
      {settings && project && (
        <Suspense fallback={null}>
          <WorkspaceConfigPanel
            agentDir={project.path}
            initialTab="agent"
            onClose={() => {
              setSettings(false);
              void refresh();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

function SessionDetail({
  agentId,
  channel,
  peer,
  session,
  active,
  busy,
  onClose,
  onOpen,
  onAction,
  onConfirm,
}: {
  agentId: string;
  channel: TeamChannel;
  peer: TeamPeer;
  session: SessionMetadata;
  active: boolean;
  busy: boolean;
  onClose: () => void;
  onOpen: () => void;
  onAction: (action: TeamAction) => void;
  onConfirm: (callback: () => void) => void;
}) {
  const { t } = useTranslation("app");
  const [data, setData] = useState<TeamSessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<TeamModelMenu | null>(null);
  const [tools, setTools] = useState<TeamTools | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const primary = peer.sessionId === session.id;
  const editable = channel.online && primary && !busy;
  useEffect(() => {
    if (!active) return;
    let stale = false;
    const read = () => {
      void teamSession(agentId, channel.channelId, peer.sessionKey, session.id)
        .then((result) => {
          if (!stale) {
            setData(result.session);
            setError(null);
          }
        })
        .catch((error) => {
          if (!stale) setError(errorText(error));
        });
    };
    read();
    const timer = setInterval(read, 4000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [active, agentId, channel.channelId, peer.sessionKey, session.id]);
  useEffect(() => {
    if (!channel.online || !primary || !active) return;
    let stale = false;
    void teamAction<TeamModelMenu>(
      agentId,
      channel.channelId,
      { sessionKey: peer.sessionKey, sessionId: peer.sessionId },
      { kind: "options" },
    )
      .then((menu) => {
        if (!stale) setCatalog(menu);
      })
      .catch((error) => {
        if (!stale) setError(errorText(error));
      });
    return () => {
      stale = true;
    };
  }, [
    active,
    agentId,
    channel.channelId,
    channel.online,
    peer.sessionKey,
    peer.sessionId,
    primary,
    session.configSnapshotAt,
  ]);
  const showTools = async () => {
    setToolsLoading(true);
    try {
      setTools(
        await teamAction<TeamTools>(agentId, channel.channelId, peer, {
          kind: "tools",
        }),
      );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setToolsLoading(false);
    }
  };
  const runtimeOptions = (["builtin", "dsh", "codex", "claude-code"] as const).map((runtime) => ({
    value: runtime,
    label: sessionRuntimePresentation(runtime).name,
    icon: <RuntimeIcon type={runtime} size={16} />,
  }));
  return (
    <aside
      className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] p-4"
      aria-label={t("teamAi.detail")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{getSessionDisplayText(session)}</h2>
          <p className="mt-1 break-all text-xs text-[var(--ink-muted)]">{session.id}</p>
        </div>
        <Tip label={t("teamAi.close")}>
          <button
            className="compact-action text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            aria-label={t("teamAi.close")}
            onClick={onClose}
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </Tip>
      </div>
      <div className="my-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-[var(--ink-muted)]">
          {data?.liveSessionState
            ? t(`teamAi.states.${data.liveSessionState}`, {
                defaultValue: String(data.liveSessionState),
              })
            : t("teamAi.noLiveState")}
        </span>
        <button className={button} onClick={onOpen}>
          <ExternalIcon className="h-4 w-4" />
          {t("teamAi.open")}
        </button>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-xs text-[var(--error)]">
          {error}
        </p>
      )}
      {!primary && <p className="mb-4 text-xs text-[var(--ink-muted)]">{t("teamAi.historyHint")}</p>}
      {catalog && (
        <div className="mb-5 space-y-3">
          <div>
            <p className="mb-1 text-xs text-[var(--ink-muted)]">Runtime</p>
            <CustomSelect
              ariaLabel="Runtime"
              size="toolbar"
              value={catalog.runtimeSource === "managed-provider" ? "managed-provider" : catalog.runtime}
              disabled={!editable}
              onChange={(value) => {
                const runtime = value as RuntimeType;
                if (runtime === catalog.runtime && catalog.runtimeSource !== "managed-provider") return;
                onConfirm(() =>
                  onAction({
                    kind: "switchRuntime",
                    runtime,
                    snapshotObservation: catalog.snapshotObservation,
                  }),
                );
              }}
              options={
                catalog.runtimeSource === "managed-provider"
                  ? [
                      {
                        value: "managed-provider",
                        label: sessionRuntimePresentation(catalog.runtime, catalog.runtimeSource as RuntimeSource).name,
                        icon: <RuntimeIcon type={catalog.runtime} size={16} />,
                        isSeparator: true,
                      },
                      ...runtimeOptions,
                    ]
                  : runtimeOptions
              }
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-[var(--ink-muted)]">{t("teamAi.model")}</p>
            <CustomSelect
              ariaLabel={t("teamAi.model")}
              size="toolbar"
              disabled={!editable}
              value={String(catalog.options.findIndex((o) => o.isCurrent))}
              placeholder={session.model || t("teamAi.defaultModel")}
              onChange={(value) => {
                const option = catalog.options[Number(value)];
                if (!option) return;
                const apply = () =>
                  onAction({
                    kind: "selectModel",
                    selection: option.selection,
                    snapshotObservation: catalog.snapshotObservation,
                    confirmed: option.requiresNewSession,
                  });
                if (option.requiresNewSession) onConfirm(apply);
                else apply();
              }}
              options={catalog.options.flatMap((option, index) => [
                ...(index === 0 || option.group !== catalog.options[index - 1].group
                  ? [
                      {
                        value: `group-${index}`,
                        label: option.group,
                        isSeparator: true,
                      },
                    ]
                  : []),
                {
                  value: String(index),
                  label: option.name,
                  suffix: option.requiresNewSession ? t("teamAi.requiresNew") : undefined,
                },
              ])}
            />
          </div>
          {!!catalog.reasoningEffortChoices?.length && (
            <div>
              <p className="mb-1 text-xs text-[var(--ink-muted)]">{t("teamAi.effort")}</p>
              <CustomSelect
                ariaLabel={t("teamAi.effort")}
                size="toolbar"
                disabled={!editable}
                value={catalog.reasoningEffort ?? "default"}
                options={["default", ...catalog.reasoningEffortChoices].map((value) => ({
                  value,
                  label: t(`teamAi.efforts.${value}`, {
                    defaultValue: value,
                  }),
                }))}
                onChange={(effort) =>
                  onAction({
                    kind: "setEffort",
                    effort,
                    snapshotObservation: catalog.snapshotObservation,
                  })
                }
              />
            </div>
          )}
          <button
            className={button}
            disabled={!editable || toolsLoading}
            aria-expanded={!!tools}
            aria-busy={toolsLoading}
            onClick={() => {
              if (tools) setTools(null);
              else void showTools();
            }}
          >
            <SlidersIcon className="h-4 w-4" />
            {toolsLoading ? t("teamAi.loadingTools") : t("teamAi.tools")}
            <ChevronDownIcon className={`h-3.5 w-3.5 ${tools ? "rotate-180" : ""}`} />
          </button>
        </div>
      )}
      {tools && (
        <div className="mb-5 space-y-3">
          {(
            [
              ["mcp", "mcpEnabledServers", "MCP"],
              ["plugins", "enabledPluginIds", t("teamAi.plugins")],
              ["official", "enabledOfficialToolIds", t("teamAi.official")],
            ] as const
          ).map(([items, field, title]) => (
            <McpToolsCard
              key={field}
              title={title}
              subtitle={t("teamAi.toolsHint")}
              emptyHint={t("teamAi.none")}
              availableMcpServers={tools[items]}
              enabledServerIds={tools[field]}
              disabled={!editable || (field !== "enabledOfficialToolIds" && !tools.canManageExtensions)}
              onToggle={(id) =>
                setTools({
                  ...tools,
                  [field]: tools[field].includes(id)
                    ? tools[field].filter((item) => item !== id)
                    : [...tools[field], id],
                })
              }
            />
          ))}
          <button
            className={primaryButton}
            disabled={!editable}
            onClick={() =>
              onAction({
                kind: "saveTools",
                snapshotObservation: tools.snapshotObservation,
                ...(tools.canManageExtensions
                  ? {
                      mcpEnabledServers: tools.mcpEnabledServers,
                      enabledPluginIds: tools.enabledPluginIds,
                    }
                  : {}),
                enabledOfficialToolIds: tools.enabledOfficialToolIds,
              })
            }
          >
            {t("teamAi.saveTools")}
          </button>
        </div>
      )}
      {!channel.online && <p className="mb-4 text-xs text-[var(--ink-muted)]">{t("teamAi.offlineHelp")}</p>}
      <h3 className="mb-2 text-xs font-medium text-[var(--ink-muted)]">{t("teamAi.recent")}</h3>
      <div className="max-h-[520px] space-y-3 overflow-y-auto">
        {[
          ...(data?.messages ?? []).filter((message) => message.id !== data?.liveStreamingMessage?.id),
          ...(data?.liveStreamingMessage ? [data.liveStreamingMessage] : []),
        ].map((message) => (
          <Message
            key={message.id}
            isLoading={message.id === data?.liveStreamingMessage?.id}
            message={{
              ...message,
              attachments: message.attachments?.map((attachment) => ({
                ...attachment,
                size: 0,
                relativePath: attachment.path,
                isImage: attachment.mimeType.startsWith("image/"),
              })),
              content: normalizeSessionMessageContent(message.content),
              timestamp: new Date(message.timestamp),
            }}
          />
        ))}
        {data?.messages?.length === 0 && !data.liveStreamingMessage && (
          <p className="py-4 text-sm text-[var(--ink-muted)]">{t("teamAi.noMessages")}</p>
        )}
        {!data && !error && <div className="h-20 animate-pulse rounded-md bg-[var(--paper-inset)]" />}
      </div>
    </aside>
  );
}
