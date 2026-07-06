import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw, X } from "lucide-react";

import {
  DEFAULT_SPACE_ID,
  spaceAuthAck,
  spaceAuthPoll,
  spaceAuthStart,
  spaceCreateSpace,
  spaceErrorMessage,
  spaceJoinSpace,
  spaceUpdateSpace,
  type LocalRegisteredAgent,
  type SpaceIssueSubscriptionRunMode,
  type SpaceEvent,
  type SpaceRegisteredAgent,
  type SpaceUserDeviceSummary,
} from "@/api/spaceCloud";
import { type SelectOption } from "@/components/CustomSelect";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useToast } from "@/components/Toast";
import { useConfig } from "@/hooks/useConfig";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { useWorkspaceFileService } from "@/hooks/useWorkspaceFileService";
import { getDeviceId, preloadDeviceId } from "@/identity/deviceIdentity";
import {
  ACTIVE_ISSUE_STATE_FILTER,
  buildIssueQueryKey,
  isRegisteredAgentVisibleInList,
  isSpaceAdmin,
  localAgentMatchesCurrentSpaceIdentity,
  type IssueQueryParams,
} from "@/pages/space/spaceHelpers";
import {
  getIssueListState,
  SPACE_VISIBLE_REFRESH_TTL_MS,
} from "@/pages/space/spaceStore";
import { useSpaceData } from "@/pages/space/useSpaceData";
import { IssuesWorkspace } from "@/pages/space/issues/IssuesWorkspace";
import { CreateIssueDialog } from "@/pages/space/issues/CreateIssueDialog";
import { IssueDetailDrawer } from "@/pages/space/issues/IssueDetailDrawer";
import {
  RegisterAgentDialog,
} from "@/pages/space/agents/AgentsWorkspace";
import { SpaceSettingsWorkspace } from "@/pages/space/settings/SpaceSettingsWorkspace";
import { GoalsWorkspace } from "@/pages/space/goals/GoalsWorkspace";
import { GoalPathSelectLabel } from "@/pages/space/GoalPathSelectLabel";
import { SkillsWorkspace } from "@/pages/space/skills/SkillsWorkspace";
import {
  SpaceLogin,
  SpaceSidebar,
  type SpaceViewMode as ViewMode,
} from "@/pages/space/SpaceChrome";
import { SpaceAvatar } from "@/pages/space/SpaceAvatar";
import SpaceProfileSettingsDialog from "@/pages/space/SpaceProfileSettingsDialog";
import {
  nowForSpaceMetric,
  recordSpaceMetric,
} from "@/pages/space/spaceMetrics";
import {
  PAPER_GRID_STYLE,
  SPACE_BACKGROUND_STYLE,
} from "@/pages/space/spaceUi";
import { spaceSlugCandidate } from "@/pages/space/spaceSlug";

const AUTH_POLL_DELAY_MS = 2000;
const SPACE_EVENTS_SYNC_INTERVAL_MS = 15_000;

type SpaceQuickActionSubmitInput =
  | { mode: "join"; slug: string }
  | {
      mode: "create";
      name: string;
      slug: string;
      avatarFilePath?: string | null;
    };

async function readPickedImagePreview(
  fileService: ReturnType<typeof useWorkspaceFileService>,
  path: string,
): Promise<string> {
  const result = await fileService.readPathsAsBase64({ paths: [path] });
  const file = result.files[0];
  if (!file || file.error) {
    throw new Error(file?.error || "Avatar preview failed");
  }
  return `data:${file.mimeType};base64,${file.data}`;
}

function SpaceQuickActionDialog({
  mode,
  busy,
  onClose,
  onSubmit,
}: {
  mode: "join" | "create";
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: SpaceQuickActionSubmitInput) => void | Promise<void>;
}) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const fileService = useWorkspaceFileService(null);
  const [joinSlug, setJoinSlug] = useState("");
  const [name, setName] = useState("");
  const [createSlug, setCreateSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [avatarFilePath, setAvatarFilePath] = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  useCloseLayer(() => {
    if (busy) return false;
    onClose();
    return true;
  }, 220);
  const title =
    mode === "join" ? t("space.spaceActions.joinTitle") : t("space.spaceActions.createTitle");
  const canSubmit =
    mode === "join" ? Boolean(joinSlug.trim()) : Boolean(name.trim() && createSlug.trim());
  const submit = () => {
    if (!canSubmit || busy) return;
    if (mode === "join") {
      void onSubmit({ mode: "join", slug: joinSlug.trim() });
      return;
    }
    void onSubmit({
      mode: "create",
      name: name.trim(),
      slug: createSlug.trim(),
      avatarFilePath,
    });
  };
  const pickAvatar = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: t("space.profile.imageFilter"), extensions: ["png", "jpg", "jpeg", "webp"] },
        ],
      });
      if (!selected || Array.isArray(selected)) return;
      setAvatarFilePath(selected);
      setAvatarPreview(await readPickedImagePreview(fileService, selected));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };
  return (
    <OverlayBackdrop onClose={busy ? undefined : onClose} className="z-[220] items-center justify-center px-4 py-8">
      <section className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <header className="flex min-h-12 items-center justify-between border-b border-[var(--line-subtle)] px-4">
          <h2 className="text-lg font-semibold text-[var(--ink)]">{title}</h2>
          <button type="button" disabled={busy} onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-3 p-4">
          {mode === "join" ? (
            <label className="block text-xs font-semibold text-[var(--ink-muted)]">
              {t("space.spaceActions.slug")}
              <input
                value={joinSlug}
                autoFocus
                onChange={(event) => setJoinSlug(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit();
                }}
                className="mt-1 h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
              />
            </label>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <SpaceAvatar name={name} avatarUrl={avatarPreview} size={44} />
                <button type="button" onClick={pickAvatar} disabled={busy} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-60">
                  {t("space.spaceActions.chooseAvatar")}
                </button>
              </div>
              <label className="block text-xs font-semibold text-[var(--ink-muted)]">
                {t("space.spaceActions.name")}
                <input
                  value={name}
                  autoFocus
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setName(nextName);
                    if (!slugEdited) setCreateSlug(spaceSlugCandidate(nextName));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submit();
                  }}
                  className="mt-1 h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
                />
              </label>
              <label className="block text-xs font-semibold text-[var(--ink-muted)]">
                {t("space.spaceActions.slug")}
                <input
                  value={createSlug}
                  onChange={(event) => {
                    setSlugEdited(true);
                    setCreateSlug(spaceSlugCandidate(event.target.value));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submit();
                  }}
                  className="mt-1 h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
                />
              </label>
            </>
          )}
          <button type="button" disabled={!canSubmit || busy} onClick={submit} className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] disabled:cursor-not-allowed disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {title}
          </button>
        </div>
      </section>
    </OverlayBackdrop>
  );
}

function errMessage(error: unknown): string {
  return spaceErrorMessage(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function agentIssueSubscriptionRunMode(
  value?: SpaceIssueSubscriptionRunMode | null,
): SpaceIssueSubscriptionRunMode {
  return value === "new_session" ? "new_session" : "single_session";
}

function normalizedIdentityValue(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mergeAgentDevice(
  agent: SpaceRegisteredAgent,
  localAgent: LocalRegisteredAgent | undefined,
): SpaceUserDeviceSummary | null {
  const source = agent.device ?? localAgent?.device ?? null;
  const deviceId = normalizedIdentityValue(
    agent.deviceId ??
      agent.device?.deviceId ??
      localAgent?.deviceId ??
      localAgent?.device?.deviceId,
  );
  if (!deviceId) return source;
  return {
    deviceId,
    deviceName:
      agent.device?.deviceName ??
      agent.deviceName ??
      localAgent?.device?.deviceName ??
      localAgent?.deviceName ??
      source?.deviceName,
    platform:
      agent.device?.platform ??
      localAgent?.device?.platform ??
      source?.platform,
    osVersion:
      agent.device?.osVersion ??
      localAgent?.device?.osVersion ??
      source?.osVersion,
    appVersion:
      agent.device?.appVersion ??
      localAgent?.device?.appVersion ??
      source?.appVersion,
    status:
      agent.device?.status ?? localAgent?.device?.status ?? source?.status,
    lastSeenAt:
      agent.device?.lastSeenAt ??
      localAgent?.device?.lastSeenAt ??
      source?.lastSeenAt,
  };
}

function registeredAgentToListItem(
  agent: SpaceRegisteredAgent,
  localAgent: LocalRegisteredAgent | undefined,
  fallbackBaseUrl: string,
  fallbackSpaceId: string,
  currentSpaceId: string,
  currentUserId: string | null,
  currentLocalDeviceId: string | null,
): LocalRegisteredAgent {
  const subscription = agent.subscriptions?.[0] ?? null;
  const cloudOwnerUserId = normalizedIdentityValue(agent.ownerUserId);
  const canUseLocalFallback = Boolean(
    cloudOwnerUserId &&
      currentUserId &&
      cloudOwnerUserId === currentUserId &&
      localAgentMatchesCurrentSpaceIdentity(
        localAgent,
        currentSpaceId,
        currentUserId,
        currentLocalDeviceId,
      ),
  );
  const localFallback = canUseLocalFallback ? localAgent : undefined;
  const ownerUserId = cloudOwnerUserId;
  const device = mergeAgentDevice(agent, localFallback);
  const deviceId = normalizedIdentityValue(
    device?.deviceId ?? agent.deviceId ?? localFallback?.deviceId,
  );
  const isLocal = Boolean(
    currentUserId &&
      currentLocalDeviceId &&
      ownerUserId === currentUserId &&
      deviceId === currentLocalDeviceId,
  );
  return {
    id: agent.id,
    baseUrl: localFallback?.baseUrl ?? fallbackBaseUrl,
    spaceId: agent.spaceId || localFallback?.spaceId || fallbackSpaceId,
    isLocal,
    ownerUserId,
    deviceId,
    device,
    clientId: agent.clientId ?? localFallback?.clientId,
    deviceName:
      device?.deviceName ?? agent.deviceName ?? localFallback?.deviceName,
    localWorkspaceId: agent.localWorkspaceId ?? localFallback?.localWorkspaceId,
    localAgentId: agent.localAgentId ?? localFallback?.localAgentId,
    workspaceId: localFallback?.workspaceId ?? agent.localWorkspaceId,
    displayName: agent.displayName || localFallback?.displayName || agent.id,
    workspacePath: agent.workspacePath ?? localFallback?.workspacePath ?? "",
    workspaceLabel: agent.workspaceLabel ?? localFallback?.workspaceLabel,
    goalId: subscription?.goalId ?? localFallback?.goalId,
    goalPathLabel: subscription?.goalPathLabel ?? localFallback?.goalPathLabel,
    stateFilter: subscription?.stateFilter?.length
      ? subscription.stateFilter
      : (localFallback?.stateFilter ?? ["todo"]),
    goalMd: agent.goalMd ?? localFallback?.goalMd,
    deliverySessionId: localFallback?.deliverySessionId,
    issueSubscriptionRunMode: agentIssueSubscriptionRunMode(
      agent.issueSubscriptionRunMode ?? localFallback?.issueSubscriptionRunMode,
    ),
    status: agent.status || localFallback?.status || "active",
    createdAt: agent.createdAt || localFallback?.createdAt || "",
    updatedAt: agent.updatedAt || localFallback?.updatedAt || "",
  };
}

export default function Space({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const { projects } = useConfig();
  const spaceData = useSpaceData({ isActive });
  const { actions } = spaceData;
  const [authBusy, setAuthBusy] = useState(false);
  const [authFlow, setAuthFlow] = useState<{
    token: string;
    expiresAt: number;
  } | null>(null);
  const authPollWarningShownRef = useRef(false);
  const [mode, setMode] = useState<ViewMode>("issues");
  const [issueQ, setIssueQ] = useState("");
  const [selectedGoalId, setSelectedGoalId] = useState("");
  const [selectedStatus, setSelectedStatus] = useState(
    ACTIVE_ISSUE_STATE_FILTER,
  );
  const [issueDetailId, setIssueDetailId] = useState<string | null>(null);
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const [spaceDialogMode, setSpaceDialogMode] = useState<"join" | "create" | null>(null);
  const [spaceDialogBusy, setSpaceDialogBusy] = useState(false);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);

  const session = spaceData.session;
  const goals = spaceData.goals;
  const issueQuery = useMemo<IssueQueryParams>(
    () => ({
      q: issueQ,
      goalId: selectedGoalId,
      includeSubtree: Boolean(selectedGoalId),
      state: selectedStatus,
      limit: 50,
    }),
    [issueQ, selectedGoalId, selectedStatus],
  );
  const issueQueryRef = useRef(issueQuery);
  const issueQueryKey = useMemo(
    () => buildIssueQueryKey(issueQuery),
    [issueQuery],
  );
  const issueList = getIssueListState(issueQuery);
  const issues = issueList.items;
  const issueDetailNavigation = useMemo(() => {
    if (!issueDetailId) {
      return { previousIssueId: null, nextIssueId: null };
    }
    const currentIndex = issues.findIndex((issue) => issue.id === issueDetailId);
    if (currentIndex < 0) {
      return { previousIssueId: null, nextIssueId: null };
    }
    return {
      previousIssueId: currentIndex > 0 ? issues[currentIndex - 1].id : null,
      nextIssueId: currentIndex < issues.length - 1 ? issues[currentIndex + 1].id : null,
    };
  }, [issueDetailId, issues]);
  const issuesLoading =
    issueList.isLoading ||
    (spaceData.boot === "ready" && issueList.lastFetchedAt === 0);
  const skills = spaceData.skills.items;
  const skillsLoading =
    spaceData.skills.isLoading ||
    (spaceData.boot === "ready" && spaceData.skills.lastFetchedAt === 0);
  const localAgents = spaceData.localAgents.items;
  const registeredAgents = spaceData.registeredAgents.items;
  const currentUserId = session?.user?.id ?? null;
  const admin = isSpaceAdmin(session);
  const activeMode: ViewMode = !admin && mode === "settings" ? "issues" : mode;
  const activeCacheSpaceId =
    spaceData.spaceId ||
    session?.space?.id ||
    session?.space?.slug ||
    DEFAULT_SPACE_ID;
  const currentIdentitySpaceId =
    session?.space?.id || activeCacheSpaceId;
  const spaceCacheKey = useCallback(
    (id: string) => `${activeCacheSpaceId}\n${id}`,
    [activeCacheSpaceId],
  );
  const agents = useMemo<LocalRegisteredAgent[]>(() => {
    const localById = new Map(localAgents.map((agent) => [agent.id, agent]));
    const cloudItems = registeredAgents.map((agent) =>
      registeredAgentToListItem(
        agent,
        localById.get(agent.id),
        session?.baseUrl ?? "",
        activeCacheSpaceId,
        currentIdentitySpaceId,
        currentUserId,
        localDeviceId,
      ),
    );
    const cloudIds = new Set(cloudItems.map((agent) => agent.id));
    const localOnlyItems = localAgents
      .filter((agent) => !cloudIds.has(agent.id))
      .filter((agent) => {
        return localAgentMatchesCurrentSpaceIdentity(
          agent,
          currentIdentitySpaceId,
          currentUserId,
          localDeviceId,
        );
      })
      .map((agent) => {
        return {
          ...agent,
          isLocal: true,
        };
      });
    return [...cloudItems, ...localOnlyItems].filter(
      isRegisteredAgentVisibleInList,
    );
  }, [
    activeCacheSpaceId,
    currentIdentitySpaceId,
    currentUserId,
    localAgents,
    localDeviceId,
    registeredAgents,
    session?.baseUrl,
  ]);

  useEffect(() => {
    let cancelled = false;
    preloadDeviceId()
      .then(() => {
        if (!cancelled) setLocalDeviceId(getDeviceId());
      })
      .catch(() => {
        if (!cancelled) setLocalDeviceId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const goalOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: "",
        label: t("space.filters.allGoals"),
        content: <GoalPathSelectLabel label={t("space.filters.allGoals")} />,
      },
      ...goals.map((goal) => {
        const label = goal.goalPathLabel || goal.title;
        return {
          value: goal.id,
          label,
          content: <GoalPathSelectLabel label={label} />,
        };
      }),
    ],
    [goals, t],
  );

  useEffect(() => {
    issueQueryRef.current = issueQuery;
  }, [issueQuery]);

  useEffect(() => {
    if (spaceData.boot !== "ready") return;
    if (activeMode === "issues") {
      const handle = window.setTimeout(() => {
        actions
          .refreshIssues(issueQuery, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS })
          .catch((error) => toast.error(spaceErrorMessage(error)));
      }, 220);
      return () => window.clearTimeout(handle);
    }
    if (activeMode === "goals") {
      void actions
        .refreshGoals({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS })
        .catch((error) => toast.error(spaceErrorMessage(error)));
    }
    if (activeMode === "skills") {
      void actions
        .refreshSkills({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS })
        .catch((error) => toast.error(spaceErrorMessage(error)));
    }
    if (activeMode === "settings") {
      void Promise.all([
        actions.refreshGoals({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }),
        actions.refreshLocalAgents({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }),
        actions.refreshRegisteredAgents({
          maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS,
        }),
      ]).catch((error) => toast.error(spaceErrorMessage(error)));
    }
  }, [actions, issueQuery, issueQueryKey, activeMode, spaceData.boot, toast]);

  const revalidateForEvents = useCallback(
    async (events: SpaceEvent[]) => {
      if (events.length === 0) return;
      const startedAt = nowForSpaceMetric();
      recordSpaceMetric("space_tab_visible_revalidate_start", {
        count: events.length,
      });
      let refreshIssueList = false;
      let refreshSkills = false;
      let refreshAgents = false;
      let refreshBoot = false;
      const touchedIssueIds = new Set<string>();

      for (const event of events) {
        const type = event.type;
        const resourceType = event.resourceType ?? "";
        if (
          resourceType === "issue" ||
          resourceType === "comment" ||
          type.startsWith("issue.") ||
          type.startsWith("comment.")
        ) {
          refreshIssueList = true;
          if (resourceType === "issue" && event.resourceId)
            touchedIssueIds.add(event.resourceId);
        }
        if (resourceType === "skill" || type.startsWith("skill.")) {
          refreshSkills = true;
        }
        if (
          resourceType === "registered_agent" ||
          resourceType === "delivery" ||
          resourceType === "subscription" ||
          type.startsWith("registered_agent.") ||
          type.startsWith("delivery.") ||
          type.startsWith("subscription.")
        ) {
          refreshAgents = true;
          if (resourceType === "delivery") refreshIssueList = true;
        }
        if (resourceType === "goal" || type.startsWith("goal.")) {
          refreshBoot = true;
          refreshIssueList = true;
        }
        if (
          resourceType === "space" ||
          resourceType === "membership" ||
          resourceType === "join_request" ||
          resourceType === "invitation" ||
          type.startsWith("space.") ||
          type.startsWith("membership.") ||
          type.startsWith("join_request.") ||
          type.startsWith("invitation.")
        ) {
          refreshBoot = true;
        }
      }

      const jobs: Array<Promise<void>> = [];
      if (refreshBoot)
        jobs.push(actions.ensureBootstrapped({ force: true, silent: true }));
      if (refreshIssueList)
        jobs.push(
          actions.refreshIssues(issueQueryRef.current, {
            force: true,
            silent: true,
          }),
        );
      if (
        issueDetailId &&
        (refreshIssueList || touchedIssueIds.has(issueDetailId))
      ) {
        jobs.push(
          actions.refreshIssueDetail(issueDetailId, {
            force: true,
            silent: true,
          }),
        );
      }
      if (refreshSkills) {
        jobs.push(actions.refreshSkills({ force: true, silent: true }));
        if (selectedSkillId) {
          jobs.push(
            actions.refreshSkillDetail(selectedSkillId, {
              force: true,
              silent: true,
            }),
          );
        }
      }
      if (refreshAgents) {
        jobs.push(actions.refreshLocalAgents({ force: true, silent: true }));
        jobs.push(
          actions.refreshRegisteredAgents({ force: true, silent: true }),
        );
      }
      try {
        await Promise.all(jobs);
        recordSpaceMetric("space_tab_visible_revalidate_end", {
          count: events.length,
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: true,
        });
      } catch (error) {
        recordSpaceMetric("space_tab_visible_revalidate_end", {
          count: events.length,
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: false,
          error: spaceErrorMessage(error),
        });
        throw error;
      }
    },
    [actions, issueDetailId, selectedSkillId],
  );

  useEffect(() => {
    if (!isActive || spaceData.boot !== "ready") return;
    let cancelled = false;
    const sync = async () => {
      try {
        const events = await actions.syncEvents({
          maxAgeMs: 5_000,
          silent: true,
        });
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
          if (result.status === "done") {
            stopAuth();
            toast.success(t("space.toasts.loginSuccess"));
            await actions.ensureBootstrapped({ force: true });
            void spaceAuthAck(authFlow.token).catch((error) => {
              console.warn("[Space] auth ack failed:", errMessage(error));
            });
            return;
          }
          if (result.status === "failed") {
            stopAuth();
            toast.error(String(result.error ?? t("space.toasts.loginFailed")));
            void spaceAuthAck(authFlow.token).catch((error) => {
              console.warn("[Space] auth ack failed:", errMessage(error));
            });
            return;
          }
        } catch (_error) {
          if (cancelled) return;
          if (
            !authPollWarningShownRef.current &&
            Date.now() < authFlow.expiresAt
          ) {
            authPollWarningShownRef.current = true;
            toast.warning(t("space.toasts.loginSlow"));
          }
        }
        const elapsed = Date.now() - startedAt;
        await wait(Math.max(0, AUTH_POLL_DELAY_MS - elapsed));
      }

      if (!cancelled) {
        stopAuth();
        toast.error(t("space.toasts.loginTimeout"));
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
      toast.info(t("space.toasts.browserLoginOpened"));
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
    if (activeMode === "issues")
      await actions.refreshIssues(issueQuery, { force: true });
    if (activeMode === "goals") await actions.refreshGoals({ force: true });
    if (activeMode === "skills") await actions.refreshSkills({ force: true });
    if (activeMode === "settings") {
      await Promise.all([
        actions.refreshGoals({ force: true }),
        actions.refreshLocalAgents({ force: true }),
        actions.refreshRegisteredAgents({ force: true }),
      ]);
    }
    toast.success(t("space.toasts.refreshed"));
  }, [actions, issueQuery, activeMode, t, toast]);

  const switchSpace = useCallback(async (spaceId: string) => {
    try {
      await actions.switchSpace(spaceId);
      setIssueDetailId(null);
      setSelectedSkillId(null);
      setMode("issues");
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  }, [actions, toast]);

  const joinSpace = useCallback(() => {
    setSpaceDialogMode("join");
  }, []);

  const createSpace = useCallback(() => {
    setSpaceDialogMode("create");
  }, []);

  const submitSpaceDialog = useCallback(async (input: SpaceQuickActionSubmitInput) => {
    if (!spaceDialogMode || input.mode !== spaceDialogMode) return;
    setSpaceDialogBusy(true);
    try {
      if (input.mode === "join") {
        const result = await spaceJoinSpace({ slug: input.slug });
        toast.success(
          result.status === "pending"
            ? t("space.toasts.spaceJoinRequested")
            : t("space.toasts.spaceJoined"),
        );
        await actions.ensureBootstrapped({ force: true });
        if (result.status === "joined") {
          await actions.switchSpace(result.space.id || result.space.slug);
        }
      } else {
        const result = await spaceCreateSpace({
          name: input.name,
          slug: input.slug,
        });
        if (input.avatarFilePath) {
          try {
            await spaceUpdateSpace({
              spaceId: result.space.id || result.space.slug,
              avatarFilePath: input.avatarFilePath,
            });
          } catch (error) {
            toast.warning(spaceErrorMessage(error));
          }
        }
        toast.success(t("space.toasts.spaceCreated"));
        await actions.ensureBootstrapped({ force: true });
        await actions.switchSpace(result.space.id || result.space.slug);
      }
      setSpaceDialogMode(null);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setSpaceDialogBusy(false);
    }
  }, [actions, spaceDialogMode, t, toast]);

  const logout = useCallback(async () => {
    try {
      await actions.logout();
      setIssueDetailId(null);
      toast.success(t("space.toasts.logoutSuccess"));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  }, [actions, t, toast]);

  if (spaceData.boot === "idle" || spaceData.boot === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t("space.common.loadingTeam")}
      </div>
    );
  }

  if (spaceData.boot === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]">
        <div className="text-center">
          <p>{spaceData.bootError ?? t("space.common.teamLoadFailed")}</p>
          <button
            type="button"
            onClick={() =>
              void actions
                .ensureBootstrapped({ force: true })
                .catch((error) => toast.error(spaceErrorMessage(error)))
            }
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]"
          >
            <RefreshCw className="h-4 w-4" />
            {t("space.common.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <SpaceLogin
        authBusy={authBusy}
        authFlow={authFlow}
        onLogin={startLogin}
      />
    );
  }

  return (
    <div
      className="relative h-full overflow-hidden bg-[var(--paper)]"
      style={SPACE_BACKGROUND_STYLE}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-20"
        style={PAPER_GRID_STYLE}
      />
      <div className="relative z-10 flex h-full min-h-0">
        <SpaceSidebar
          session={session}
          mode={activeMode}
          onSpaceTabChange={selectSpaceTab}
          onSpaceSwitch={switchSpace}
          onJoinSpace={joinSpace}
          onCreateSpace={createSpace}
          onLogout={logout}
          onOpenProfileSettings={() => setProfileSettingsOpen(true)}
        />
        <section className="flex min-w-0 flex-1 flex-col">
          {activeMode === "issues" && (
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
          {activeMode === "skills" && (
            <SkillsWorkspace
              admin={admin}
              skills={skills}
              loading={skillsLoading}
              selectedSkillId={selectedSkillId}
              projects={projects}
              actions={actions}
              skillDetailState={
                selectedSkillId
                  ? spaceData.skillDetails[spaceCacheKey(selectedSkillId)]
                  : undefined
              }
              isActive={isActive}
              onSelectSkill={setSelectedSkillId}
              onRefresh={refreshCurrent}
              onUploaded={(id) => setSelectedSkillId(id)}
            />
          )}
          {activeMode === "goals" && (
            <GoalsWorkspace
              admin={admin}
              session={session}
              goals={goals}
              actions={actions}
              onRefresh={() => actions.refreshGoals({ force: true })}
              onOpenIssuesForGoal={(goalId) => {
                setSelectedGoalId(goalId);
                setMode("issues");
              }}
            />
          )}
          {activeMode === "settings" && admin && (
            <SpaceSettingsWorkspace
              session={session}
              agents={agents}
              goals={goals}
              projects={projects}
              actions={actions}
              onRefresh={refreshCurrent}
              onRegister={() => setRegisterOpen(true)}
              onExit={() => setMode("issues")}
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
          onNavigateIssue={setIssueDetailId}
          previousIssueId={issueDetailNavigation.previousIssueId}
          nextIssueId={issueDetailNavigation.nextIssueId}
          onChanged={() =>
            void actions.refreshIssues(issueQuery, {
              force: true,
              silent: true,
            })
          }
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
            void actions.refreshIssues(issueQuery, {
              force: true,
              silent: true,
            });
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

      {profileSettingsOpen && (
        <SpaceProfileSettingsDialog
          session={session}
          actions={actions}
          onClose={() => setProfileSettingsOpen(false)}
        />
      )}

      {spaceDialogMode && (
        <SpaceQuickActionDialog
          mode={spaceDialogMode}
          busy={spaceDialogBusy}
          onClose={() => setSpaceDialogMode(null)}
          onSubmit={submitSpaceDialog}
        />
      )}
    </div>
  );
}
