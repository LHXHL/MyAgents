import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Bot, Check, Copy, Loader2, MoreHorizontal, RefreshCw, Settings, Shield, Trash2, UserPlus, Users } from "lucide-react";

import {
  spaceApproveJoinRequest,
  spaceErrorMessage,
  spaceGetMembers,
  spaceInviteMember,
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
import CustomSelect from "@/components/CustomSelect";
import { useToast } from "@/components/Toast";
import type { Project } from "@/config/types";
import { useWorkspaceFileService } from "@/hooks/useWorkspaceFileService";
import { AgentsWorkspace } from "@/pages/space/agents/AgentsWorkspace";
import { SpaceAvatar } from "@/pages/space/SpaceAvatar";
import type { SpaceActions } from "@/pages/space/spaceStore";

type SettingsSection = "overview" | "members" | "agents" | "roles";

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

function roleLabel(role: string, t: ReturnType<typeof useTranslation>["t"]): string {
  if (role === "owner") return t("space.settings.roleOwner");
  if (role === "admin") return t("space.settings.roleAdmin");
  return t("space.settings.roleMember");
}

function menuItems(pendingCount: number, t: ReturnType<typeof useTranslation>["t"]) {
  return [
    { id: "overview" as const, label: t("space.settings.overview"), icon: Settings, hint: t("space.settings.overviewHint") },
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
}: {
  session: SpaceSession;
  agents: LocalRegisteredAgent[];
  goals: SpaceGoal[];
  projects: Project[];
  actions: SpaceActions;
  onRefresh: () => Promise<void>;
  onRegister: () => void;
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
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
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
  }, [session.space.id, session.space.name, session.space.avatarUrl]);

  useEffect(() => {
    if (section !== "members" && section !== "overview" && section !== "agents") return;
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

  const pickAvatar = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    setAvatarFilePath(selected);
    setAvatarPreview(await readAvatarPreview(fileService, selected));
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

  const invite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    await runMemberAction("invite", async () => {
      await spaceInviteMember({ spaceId: session.space.slug || session.space.id, email, role: inviteRole });
      setInviteEmail("");
    });
  };

  const renderShell = (children: ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--paper)]/40">
      <header className="flex min-h-14 items-center justify-between border-b border-[var(--line-subtle)] px-5">
        <div className="flex min-w-0 items-center gap-2">
          {section ? (
            <button type="button" onClick={() => setSection(null)} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]">
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : null}
          <div className="min-w-0">
            <div className="text-xs font-medium text-[var(--ink-muted)]">{section ? `${t("space.sidebar.settings")} >` : session.space.name}</div>
            <h2 className="truncate text-lg font-semibold text-[var(--ink)]">{activeTitle}</h2>
          </div>
        </div>
        <button type="button" onClick={onRefresh} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]">
          <RefreshCw className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
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
        onRefresh={onRefresh}
        onRegister={onRegister}
        registerDisabled={agentQuotaReached}
        registerDisabledHint={agentQuotaReached ? t("space.settings.agentQuotaReached") : undefined}
      />,
    );
  }

  if (section === "roles") {
    return renderShell(
      <div className="max-w-3xl space-y-4 text-sm leading-relaxed text-[var(--ink-secondary)]">
        <h3 className="text-base font-semibold text-[var(--ink)]">{t("space.settings.roles")}</h3>
        <p><strong className="text-[var(--ink)]">{t("space.settings.roleOwner")}</strong> {t("space.settings.ownerDescription")}</p>
        <p><strong className="text-[var(--ink)]">{t("space.settings.roleAdmin")}</strong> {t("space.settings.adminDescription")}</p>
        <p><strong className="text-[var(--ink)]">{t("space.settings.roleMember")}</strong> {t("space.settings.memberDescription")}</p>
      </div>,
    );
  }

  if (section === "members") {
    return renderShell(
      <div className="space-y-5">
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3">
          <label className="min-w-0 flex-1 text-xs font-semibold text-[var(--ink-muted)]">
            {t("space.settings.email")}
            <input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]" />
          </label>
          <CustomSelect value={inviteRole} onChange={(value) => setInviteRole(value === "admin" ? "admin" : "member")} size="toolbar" className="w-32" options={[{ value: "member", label: t("space.settings.roleMember") }, { value: "admin", label: t("space.settings.roleAdmin") }]} />
          <button type="button" onClick={invite} disabled={busyKey === "invite" || memberQuotaReached} title={memberQuotaReached ? t("space.settings.memberQuotaReached") : undefined} className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] disabled:cursor-not-allowed disabled:opacity-60">
            {busyKey === "invite" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            {t("space.settings.addMember")}
          </button>
        </div>
        {memberQuotaReached ? (
          <div className="rounded-lg border border-[var(--line)] bg-[var(--warning-bg)] px-3 py-2 text-xs font-medium text-[var(--warning)]">
            {t("space.settings.memberQuotaReached")}
          </div>
        ) : null}
        {membersLoading ? <div className="text-sm text-[var(--ink-muted)]">{t("space.settings.loadingMembers")}</div> : null}
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

  if (section === "overview") {
    const preview = avatarPreview ?? session.space.avatarUrl ?? null;
    return renderShell(
      <div className="max-w-3xl space-y-4">
        <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
          <div className="flex items-start gap-4">
            <SpaceAvatar name={session.space.name} avatarUrl={preview} size={54} />
            <div className="min-w-0 flex-1">
              {editingOverview ? (
                <input value={name} onChange={(event) => setName(event.target.value)} className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm font-semibold text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]" />
              ) : (
                <h3 className="truncate text-lg font-semibold text-[var(--ink)]">{session.space.name}</h3>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
                <span>{session.space.slug}</span>
                <button type="button" onClick={copySlug} className="grid h-7 w-7 place-items-center rounded-lg hover:bg-[var(--hover-bg)]">
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <span>{session.space.spaceKind ?? "user"}</span>
                <span>{session.space.joinPolicy}</span>
              </div>
            </div>
            <button type="button" onClick={() => setEditingOverview((value) => !value)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]">
              {editingOverview ? t("space.common.cancel") : t("space.settings.editOverview")}
            </button>
          </div>
          {editingOverview ? (
            <div className="mt-4 flex items-center gap-2">
              <button type="button" onClick={pickAvatar} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]">
                {t("space.spaceActions.chooseAvatar")}
              </button>
              <button type="button" onClick={saveOverview} disabled={busyKey === "overview" || !name.trim()} className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--button-primary-text)] disabled:opacity-60">
                {busyKey === "overview" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("space.common.save")}
              </button>
            </div>
          ) : null}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-sm text-[var(--ink-secondary)]">
            <div className="mb-2 font-semibold text-[var(--ink)]">{t("space.settings.freeQuota")}</div>
            <div>{t("space.settings.plan")}: {session.space.planTier ?? "free"}</div>
            <div>{t("space.settings.currentRole")}: {roleLabel(session.membership.role, t)}</div>
            <div>{t("space.settings.joinPolicy")}: {session.space.joinPolicy}</div>
            <div>{t("space.settings.quotaMembers")}: {quotaText(overviewUsage?.memberSeats, overviewLimits?.joinedMembersMax)}</div>
            <div>{t("space.settings.quotaOpenIssues")}: {quotaText(overviewUsage?.openIssues, overviewLimits?.openIssuesMax)}</div>
            <div>{t("space.settings.quotaSkills")}: {quotaText(overviewUsage?.hostedSkills, overviewLimits?.hostedSkillsMax)}</div>
            <div>{t("space.settings.quotaAgents")}: {quotaText(overviewUsage?.registeredAgents, overviewLimits?.registeredAgentsMax)}</div>
            <div>{t("space.settings.quotaStorage")}: {formatBytes(overviewUsage?.storageBytes ?? 0)} / {formatBytes(overviewLimits?.storageBytesMax ?? 1024 * 1024 * 1024)}</div>
          </div>
        </div>
      </div>,
    );
  }

  return renderShell(
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {menuItems(pendingCount, t).map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.id} type="button" onClick={() => setSection(item.id)} className="min-h-28 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-left transition-colors hover:border-[var(--accent-warm)] hover:bg-[var(--paper)]">
            <Icon className="mb-3 h-5 w-5 text-[var(--accent-warm)]" />
            <div className="text-sm font-semibold text-[var(--ink)]">{item.label}</div>
            <div className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">{item.hint}</div>
          </button>
        );
      })}
    </div>,
  );
}
