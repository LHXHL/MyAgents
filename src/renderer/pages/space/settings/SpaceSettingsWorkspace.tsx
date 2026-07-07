import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Bot, Camera, Check, ChevronRight, Copy, Loader2, MoreHorizontal, RefreshCw, Save, Shield, Trash2, Users, X } from "lucide-react";

import {
  spaceApproveJoinRequest,
  spaceErrorMessage,
  spaceGetMembers,
  spaceRejectJoinRequest,
  spaceRemoveMember,
  spaceUpdateMemberRole,
  spaceUpdateSpace,
  type LocalRegisteredAgent,
  type SpaceGoal,
  type SpaceMember,
  type SpaceMembersPayload,
  type SpaceSession,
} from "@/api/spaceCloud";
import myagentsWebLogo from "@/assets/brand/myagents-web-logo.png";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useToast } from "@/components/Toast";
import type { Project } from "@/config/types";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { useWorkspaceFileService } from "@/hooks/useWorkspaceFileService";
import { AgentsWorkspace } from "@/pages/space/agents/AgentsWorkspace";
import { SpaceAvatar } from "@/pages/space/SpaceAvatar";
import type { SpaceActions } from "@/pages/space/spaceStore";
import { SPACE_LIST_FRAME_CLASS } from "@/pages/space/spaceUi";

type SettingsSection = "members" | "agents" | "roles";
const SPACE_SETTINGS_ROOT_FRAME_CLASS = "mx-auto max-w-xl";

async function readAvatarPreview(
  fileService: ReturnType<typeof useWorkspaceFileService>,
  path: string,
): Promise<string> {
  const result = await fileService.readPathsAsBase64({ paths: [path] });
  const file = result.files[0];
  if (!file || file.error) throw new Error(file?.error || "Avatar preview failed");
  return `data:${file.mimeType};base64,${file.data}`;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

function quotaText(used?: number, max?: number): string {
  if (typeof used !== "number" || typeof max !== "number") return "-";
  return `${used} / ${max}`;
}

function metricValue(value: string | number | null | undefined): string {
  if (value === null || typeof value === "undefined" || value === "") return "-";
  return String(value);
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function planDisplay(plan?: string | null): string {
  const normalized = plan || "free";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function spaceAvatarUrl(space: SpaceSession["space"]): string | null {
  if (space.avatarUrl) return space.avatarUrl;
  if (space.spaceKind === "official" || space.slug === "official") return myagentsWebLogo;
  return null;
}

function SummaryMetric({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="min-w-0 rounded-xl bg-[var(--paper-elevated)]/70 px-3 py-1.5">
      <div className="truncate text-xs font-medium text-[var(--ink-muted)]">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-[var(--ink)]">{metricValue(value)}</div>
    </div>
  );
}

function ResourceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-10 min-w-0 items-center justify-between gap-3 rounded-xl bg-[var(--paper-elevated)]/55 px-3 py-2">
      <div className="min-w-0 truncate text-sm font-medium text-[var(--ink-muted)]">{label}</div>
      <div className="shrink-0 truncate text-right text-sm font-semibold text-[var(--ink-secondary)]">{value}</div>
    </div>
  );
}

function roleLabel(role: string, t: ReturnType<typeof useTranslation>["t"]): string {
  if (role === "owner") return t("space.settings.roleOwner");
  if (role === "admin") return t("space.settings.roleAdmin");
  return t("space.settings.roleMember");
}

function menuItems(pendingCount: number, t: ReturnType<typeof useTranslation>["t"]) {
  return [
    {
      id: "members" as const,
      label: t("space.settings.members"),
      icon: Users,
      hint:
        pendingCount > 0
          ? t("space.settings.pendingJoinCount", { count: pendingCount })
          : t("space.settings.membersHint"),
    },
    { id: "agents" as const, label: t("space.settings.agents"), icon: Bot, hint: t("space.settings.agentsHint") },
    { id: "roles" as const, label: t("space.settings.roles"), icon: Shield, hint: t("space.settings.rolesHint") },
  ];
}

export function SpaceSettingsWorkspace({
  session,
  agents,
  goals,
  projects,
  actions,
  onRefresh,
  onRegister,
  onExit,
}: {
  session: SpaceSession;
  agents: LocalRegisteredAgent[];
  goals: SpaceGoal[];
  projects: Project[];
  actions: SpaceActions;
  onRefresh: () => Promise<void>;
  onRegister: () => void;
  onExit: () => void;
}) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const fileService = useWorkspaceFileService(null);
  const [section, setSection] = useState<SettingsSection | null>(null);
  const [membersState, setMembersState] = useState<SpaceMembersPayload | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [name, setName] = useState(session.space.name);
  const [avatarFilePath, setAvatarFilePath] = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [editingOverview, setEditingOverview] = useState(false);
  const [pickingAvatar, setPickingAvatar] = useState(false);
  const [menuMemberId, setMenuMemberId] = useState<string | null>(null);
  const pendingCount = session.spaces?.find((space) => space.id === session.space.id)?.pendingJoinRequestCount ?? 0;
  const overviewUsage = membersState?.usage;
  const overviewLimits = membersState?.limits ?? session.spaces?.find((space) => space.id === session.space.id)?.limits;
  const memberQuotaReached = Boolean(
    overviewUsage &&
      overviewLimits &&
      overviewUsage.memberSeats >= overviewLimits.joinedMembersMax,
  );
  const agentQuotaReached = Boolean(
    overviewUsage &&
      overviewLimits &&
      overviewUsage.registeredAgents >= overviewLimits.registeredAgentsMax,
  );

  useEffect(() => {
    setName(session.space.name);
    setAvatarFilePath(null);
    setAvatarPreview(null);
    setEditingOverview(false);
    setPickingAvatar(false);
  }, [session.space.id, session.space.name, session.space.avatarUrl]);

  useEffect(() => {
    if (section !== null && section !== "members" && section !== "agents") return;
    let cancelled = false;
    setMembersLoading(true);
    spaceGetMembers(session.space.slug || session.space.id)
      .then((result) => {
        if (!cancelled) setMembersState(result);
      })
      .catch((error) => {
        if (!cancelled) toast.error(spaceErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [section, session.space.id, session.space.slug, toast]);

  const activeTitle = useMemo(() => {
    if (!section) return t("space.sidebar.settings");
    return menuItems(pendingCount, t).find((item) => item.id === section)?.label ?? t("space.sidebar.settings");
  }, [pendingCount, section, t]);

  const copySlug = async () => {
    await navigator.clipboard.writeText(session.space.slug || session.space.id);
    toast.success(t("space.toasts.spaceSlugCopied"));
  };

  const closeOverviewEditor = () => {
    if (busyKey === "overview" || pickingAvatar) return;
    setEditingOverview(false);
    setName(session.space.name);
    setAvatarFilePath(null);
    setAvatarPreview(null);
  };

  useCloseLayer(() => {
    if (!editingOverview) return false;
    if (busyKey === "overview" || pickingAvatar) return false;
    closeOverviewEditor();
    return true;
  }, 220);

  const pickAvatar = async () => {
    if (busyKey === "overview" || pickingAvatar) return;
    setPickingAvatar(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        title: t("space.profile.pickAvatarTitle"),
        filters: [{ name: t("space.profile.imageFilter"), extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      setAvatarFilePath(selected);
      setAvatarPreview(await readAvatarPreview(fileService, selected));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setPickingAvatar(false);
    }
  };

  const saveOverview = async () => {
    setBusyKey("overview");
    try {
      await spaceUpdateSpace({
        spaceId: session.space.slug || session.space.id,
        name: name.trim(),
        avatarFilePath,
      });
      toast.success(t("space.toasts.spaceUpdated"));
      await actions.ensureBootstrapped({ force: true });
      setEditingOverview(false);
      setAvatarFilePath(null);
      setAvatarPreview(null);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusyKey(null);
    }
  };

  const reloadMembers = async () => {
    setMembersLoading(true);
    try {
      setMembersState(await spaceGetMembers(session.space.slug || session.space.id));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setMembersLoading(false);
    }
  };

  const runMemberAction = async (key: string, action: () => Promise<unknown>) => {
    setBusyKey(key);
    try {
      await action();
      await reloadMembers();
      await actions.ensureBootstrapped({ force: true, silent: true });
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusyKey(null);
      setMenuMemberId(null);
    }
  };

  const renderShell = (children: ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--paper)]/40">
      <header className="border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)]/35 px-6 py-2 backdrop-blur-md">
        <div className="flex min-h-10 w-full items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={section ? () => setSection(null) : onExit}
              aria-label={section ? t("space.sidebar.settings") : t("space.sidebar.issues")}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-[var(--ink)]">
              {section ? (
                <button
                  type="button"
                  onClick={() => setSection(null)}
                  className="rounded-md text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                >
                  {t("space.sidebar.settings")}
                </button>
              ) : (
                <span className="text-[var(--ink)]">{t("space.sidebar.settings")}</span>
              )}
              {section ? (
                <>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                  <span className="truncate">{activeTitle}</span>
                </>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            aria-label={t("space.common.refresh")}
            title={t("space.common.refresh")}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-5">{children}</main>
    </div>
  );

  if (section === "agents") {
    return renderShell(
      <AgentsWorkspace
        admin
        agents={agents}
        goals={goals}
        projects={projects}
        actions={actions}
        onRegister={onRegister}
        registerDisabled={agentQuotaReached}
        registerDisabledHint={agentQuotaReached ? t("space.settings.agentQuotaReached") : undefined}
      />,
    );
  }

  if (section === "roles") {
    return renderShell(
      <div className={`${SPACE_LIST_FRAME_CLASS} space-y-3`}>
        {[
          [t("space.settings.roleOwner"), t("space.settings.ownerDescription")],
          [t("space.settings.roleAdmin"), t("space.settings.adminDescription")],
          [t("space.settings.roleMember"), t("space.settings.memberDescription")],
        ].map(([role, description]) => (
          <section key={role} className="rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)]/70 px-4 py-3.5">
            <h3 className="text-sm font-semibold text-[var(--ink)]">{role}</h3>
            <p className="mt-1 text-sm leading-relaxed text-[var(--ink-muted)]">{description}</p>
          </section>
        ))}
      </div>,
    );
  }

  if (section === "members") {
    return renderShell(
      <div className={`${SPACE_LIST_FRAME_CLASS} space-y-5`}>
        <div className="inline-flex min-h-11 max-w-full flex-wrap items-center gap-2 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)]/55 px-3 py-2">
          <span className="min-w-0 text-sm font-medium text-[var(--ink-secondary)]">
            {t("space.settings.joinByShortSlug")}
          </span>
          <code className="max-w-full shrink-0 truncate rounded-md bg-[var(--paper-inset)]/55 px-2 py-0.5 font-mono text-sm font-semibold text-[var(--ink)]">
            {session.space.slug || session.space.id}
          </code>
          <button type="button" onClick={copySlug} title={t("fileActions.copy")} aria-label={t("fileActions.copy")} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--button-secondary-bg)] text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]">
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        {memberQuotaReached ? (
          <div className="rounded-xl border border-[var(--line)] bg-[var(--warning-bg)] px-3 py-2 text-xs font-medium text-[var(--warning)]">
            {t("space.settings.memberQuotaReached")}
          </div>
        ) : null}
        {membersState?.joinRequests.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-[var(--ink)]">{t("space.settings.joinRequests")}</h3>
            {membersState.joinRequests.map((request) => (
              <div key={request.id} className="flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2">
                <SpaceAvatar name={request.user.name} email={request.user.email} avatarUrl={request.user.avatarUrl} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[var(--ink)]">{request.user.name || request.user.email}</div>
                  <div className="truncate text-xs text-[var(--ink-muted)]">{request.user.email}</div>
                </div>
                <button type="button" disabled={memberQuotaReached} title={memberQuotaReached ? t("space.settings.memberQuotaReached") : undefined} onClick={() => runMemberAction(`approve:${request.id}`, () => spaceApproveJoinRequest({ spaceId: session.space.slug || session.space.id, requestId: request.id }))} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--success)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-40">
                  <Check className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => runMemberAction(`reject:${request.id}`, () => spaceRejectJoinRequest({ spaceId: session.space.slug || session.space.id, requestId: request.id }))} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--error)] hover:bg-[var(--hover-bg)]">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {membersState?.invitations.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-[var(--ink)]">{t("space.settings.pendingInvitations")}</h3>
            {membersState.invitations.map((invitation) => (
              <div key={invitation.id} className="flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2">
                <SpaceAvatar name={invitation.email} email={invitation.email} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[var(--ink)]">{invitation.email}</div>
                  <div className="truncate text-xs text-[var(--ink-muted)]">{roleLabel(invitation.role, t)} · {invitation.status}</div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-[var(--ink)]">{t("space.settings.members")}</h3>
          {membersLoading ? <div className="min-h-8 rounded-lg text-sm text-[var(--ink-muted)]">{t("space.settings.loadingMembers")}</div> : null}
          {membersState?.members.map((member: SpaceMember) => (
            <div key={member.id} className="group flex items-center gap-3 border-b border-[var(--line-subtle)] px-1 py-3">
              <SpaceAvatar name={member.user.name} email={member.user.email} avatarUrl={member.user.avatarUrl} size={30} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-[var(--ink)]">{member.user.name || member.user.email}</div>
                <div className="truncate text-xs text-[var(--ink-muted)]">{member.user.email}</div>
              </div>
              <span className="rounded-full bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">{roleLabel(member.role, t)}</span>
              {member.role !== "owner" ? (
                <div className="relative">
                  <button type="button" onClick={() => setMenuMemberId(menuMemberId === member.id ? null : member.id)} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] opacity-0 transition-opacity hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] group-hover:opacity-100">
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  {menuMemberId === member.id ? (
                    <div className="absolute right-0 z-20 mt-1 w-36 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-1 shadow-md">
                      <button type="button" onClick={() => runMemberAction(`role:${member.id}`, () => spaceUpdateMemberRole({ spaceId: session.space.slug || session.space.id, memberId: member.id, role: member.role === "admin" ? "member" : "admin" }))} className="w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--ink)] hover:bg-[var(--hover-bg)]">
                        {member.role === "admin" ? t("space.settings.changeToMember") : t("space.settings.changeToAdmin")}
                      </button>
                      <button type="button" onClick={() => runMemberAction(`remove:${member.id}`, () => spaceRemoveMember({ spaceId: session.space.slug || session.space.id, memberId: member.id }))} className="w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--error)] hover:bg-[var(--hover-bg)]">
                        {t("space.settings.removeMember")}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>,
    );
  }

  const rootPreview = spaceAvatarUrl(session.space);
  const editPreview = avatarPreview ?? spaceAvatarUrl(session.space);
  const storageUsed = overviewUsage?.storageBytes ?? 0;
  const storageMax = overviewLimits?.storageBytesMax ?? 1024 * 1024 * 1024;
  const plan = planDisplay(session.space.planTier);
  const rootMenuItems = menuItems(pendingCount, t);

  return renderShell(
    <>
      {editingOverview ? (
        <OverlayBackdrop
          onClose={busyKey === "overview" || pickingAvatar ? undefined : closeOverviewEditor}
          className="z-[220] items-center justify-center px-4 py-8"
        >
          <section className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
            <header className="flex min-h-14 items-center justify-between gap-3 border-b border-[var(--line-subtle)] px-5">
              <h2 className="text-lg font-semibold text-[var(--ink)]">{t("space.settings.editOverviewTitle")}</h2>
              <button
                type="button"
                disabled={busyKey === "overview" || pickingAvatar}
                onClick={closeOverviewEditor}
                className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-60"
                aria-label={t("space.detail.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="grid gap-5 px-5 py-5">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  disabled={busyKey === "overview" || pickingAvatar}
                  onClick={() => void pickAvatar()}
                  className="group relative grid h-16 w-16 shrink-0 place-items-center rounded-full text-[var(--ink-muted)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent-warm)] disabled:cursor-wait disabled:opacity-70"
                  aria-label={t("space.spaceActions.chooseAvatar")}
                  title={t("space.spaceActions.chooseAvatar")}
                >
                  <SpaceAvatar name={name.trim() || session.space.name} avatarUrl={editPreview} size={52} />
                  <span className="absolute inset-0 grid place-items-center rounded-full bg-[var(--ink)]/45 text-[var(--paper)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    {pickingAvatar ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                  </span>
                </button>
                <div className="min-w-0">
                  <button
                    type="button"
                    disabled={busyKey === "overview" || pickingAvatar}
                    onClick={() => void pickAvatar()}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm font-semibold text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-wait disabled:opacity-70"
                  >
                    {pickingAvatar ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                    {t("space.spaceActions.chooseAvatar")}
                  </button>
                  <p className="mt-2 truncate text-xs text-[var(--ink-muted)]">
                    {avatarFilePath ? basename(avatarFilePath) : t("space.profile.avatarHint")}
                  </p>
                </div>
              </div>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-[var(--ink)]">{t("space.spaceActions.name")}</span>
                <input
                  value={name}
                  disabled={busyKey === "overview"}
                  onChange={(event) => setName(event.target.value)}
                  className="h-10 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)] disabled:cursor-wait disabled:opacity-70"
                />
              </label>
            </div>
            <footer className="flex justify-end gap-2 border-t border-[var(--line-subtle)] px-5 py-3">
              <button
                type="button"
                disabled={busyKey === "overview" || pickingAvatar}
                onClick={closeOverviewEditor}
                className="inline-flex h-9 items-center rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm font-semibold text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-wait disabled:opacity-70"
              >
                {t("space.common.cancel")}
              </button>
              <button
                type="button"
                disabled={busyKey === "overview" || pickingAvatar || !name.trim()}
                onClick={() => void saveOverview()}
                className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busyKey === "overview" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {t("space.common.save")}
              </button>
            </footer>
          </section>
        </OverlayBackdrop>
      ) : null}

      <div className={`${SPACE_SETTINGS_ROOT_FRAME_CLASS} space-y-4`}>
        <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
          <div className="px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <SpaceAvatar name={session.space.name} avatarUrl={rootPreview} size={52} />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-xl font-semibold text-[var(--ink)]">{session.space.name}</h2>
                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-sm font-medium text-[var(--ink-muted)]">
                  <span className="min-w-0 truncate">{session.space.slug}</span>
                  <button type="button" onClick={copySlug} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]" aria-label={t("space.toasts.spaceSlugCopied")} title={t("space.toasts.spaceSlugCopied")}>
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <button type="button" onClick={() => setEditingOverview(true)} className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)]/75 px-3 py-1.5 text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]">
                {t("space.settings.editOverview")}
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <SummaryMetric label={t("space.settings.currentRole")} value={roleLabel(session.membership.role, t)} />
              <SummaryMetric label={t("space.settings.plan")} value={plan} />
            </div>
          </div>
          <div className="border-t border-[var(--line-subtle)] px-5 py-3.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
              {t("space.settings.resourcesTitle", { plan })}
            </h3>
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <ResourceMetric label={t("space.settings.quotaMembers")} value={quotaText(overviewUsage?.memberSeats, overviewLimits?.joinedMembersMax)} />
              <ResourceMetric label={t("space.settings.quotaOpenIssues")} value={quotaText(overviewUsage?.openIssues, overviewLimits?.openIssuesMax)} />
              <ResourceMetric label={t("space.settings.quotaSkills")} value={quotaText(overviewUsage?.hostedSkills, overviewLimits?.hostedSkillsMax)} />
              <ResourceMetric label={t("space.settings.quotaAgents")} value={quotaText(overviewUsage?.registeredAgents, overviewLimits?.registeredAgentsMax)} />
              <ResourceMetric label={t("space.settings.quotaStorage")} value={`${formatBytes(storageUsed)} / ${formatBytes(storageMax)}`} />
            </div>
          </div>
        </section>

        <div className="space-y-2">
          {rootMenuItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className="group flex w-full items-center gap-3 rounded-xl border border-transparent bg-[var(--paper-elevated)]/60 px-4 py-3.5 text-left transition-colors hover:border-[var(--line)] hover:bg-[var(--paper-elevated)]"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--ink)]">{item.label}</span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">{item.hint}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ink-subtle)] transition-transform group-hover:translate-x-0.5" />
              </button>
            );
          })}
        </div>
      </div>
    </>,
  );
}
