import { useEffect, useMemo, useState, type ReactNode } from "react";
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

function menuItems(pendingCount: number) {
  return [
    { id: "overview" as const, label: "Overview", icon: Settings, hint: "Space 基本信息与配额" },
    { id: "members" as const, label: "Members", icon: Users, hint: pendingCount > 0 ? `${pendingCount} 人申请加入` : "成员、邀请与申请" },
    { id: "agents" as const, label: "Agents", icon: Bot, hint: "登记 Agent 与订阅目标" },
    { id: "roles" as const, label: "Roles & Permissions", icon: Shield, hint: "owner、admin、member 权限说明" },
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

  useEffect(() => {
    setName(session.space.name);
    setAvatarFilePath(null);
    setAvatarPreview(null);
    setEditingOverview(false);
  }, [session.space.id, session.space.name, session.space.avatarUrl]);

  useEffect(() => {
    if (section !== "members" && section !== "overview") return;
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
    if (!section) return "Settings";
    return menuItems(pendingCount).find((item) => item.id === section)?.label ?? "Settings";
  }, [pendingCount, section]);

  const copySlug = async () => {
    await navigator.clipboard.writeText(session.space.slug || session.space.id);
    toast.success("已复制 Space slug");
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
      toast.success("Space 已更新");
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
            <div className="text-xs font-medium text-[var(--ink-muted)]">{section ? "Settings >" : session.space.name}</div>
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
      />,
    );
  }

  if (section === "roles") {
    return renderShell(
      <div className="max-w-3xl space-y-4 text-sm leading-relaxed text-[var(--ink-secondary)]">
        <h3 className="text-base font-semibold text-[var(--ink)]">Roles & Permissions</h3>
        <p><strong className="text-[var(--ink)]">Owner</strong> 可以管理 Space 信息、成员、申请、邀请、Skills、Goals、Issues 与 Registered Agents。Owner 身份不能被 admin 修改或移除。</p>
        <p><strong className="text-[var(--ink)]">Admin</strong> 可以进入 Settings，管理成员、申请、邀请、Skills、Goals、Issues 与 Registered Agents，但不能改变 owner。</p>
        <p><strong className="text-[var(--ink)]">Member</strong> 可以浏览和参与当前 Space 的协作内容，但看不到 Settings 入口，也不能管理成员或登记 Agent。</p>
      </div>,
    );
  }

  if (section === "members") {
    return renderShell(
      <div className="space-y-5">
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3">
          <label className="min-w-0 flex-1 text-xs font-semibold text-[var(--ink-muted)]">
            Email
            <input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]" />
          </label>
          <CustomSelect value={inviteRole} onChange={(value) => setInviteRole(value === "admin" ? "admin" : "member")} size="toolbar" className="w-32" options={[{ value: "member", label: "成员" }, { value: "admin", label: "管理员" }]} />
          <button type="button" onClick={invite} disabled={busyKey === "invite"} className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] disabled:opacity-60">
            {busyKey === "invite" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            添加
          </button>
        </div>
        {membersLoading ? <div className="text-sm text-[var(--ink-muted)]">Loading...</div> : null}
        {membersState?.joinRequests.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-[var(--ink)]">申请加入</h3>
            {membersState.joinRequests.map((request) => (
              <div key={request.id} className="flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2">
                <SpaceAvatar name={request.user.name} email={request.user.email} avatarUrl={request.user.avatarUrl} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[var(--ink)]">{request.user.name || request.user.email}</div>
                  <div className="truncate text-xs text-[var(--ink-muted)]">{request.user.email}</div>
                </div>
                <button type="button" onClick={() => runMemberAction(`approve:${request.id}`, () => spaceApproveJoinRequest({ spaceId: session.space.slug || session.space.id, requestId: request.id }))} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--success)] hover:bg-[var(--hover-bg)]">
                  <Check className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => runMemberAction(`reject:${request.id}`, () => spaceRejectJoinRequest({ spaceId: session.space.slug || session.space.id, requestId: request.id }))} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--error)] hover:bg-[var(--hover-bg)]">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-[var(--ink)]">成员</h3>
          {membersState?.members.map((member: SpaceMember) => (
            <div key={member.id} className="group flex items-center gap-3 border-b border-[var(--line-subtle)] px-1 py-3">
              <SpaceAvatar name={member.user.name} email={member.user.email} avatarUrl={member.user.avatarUrl} size={30} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-[var(--ink)]">{member.user.name || member.user.email}</div>
                <div className="truncate text-xs text-[var(--ink-muted)]">{member.user.email}</div>
              </div>
              <span className="rounded-full bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">{member.role}</span>
              {member.role !== "owner" ? (
                <div className="relative">
                  <button type="button" onClick={() => setMenuMemberId(menuMemberId === member.id ? null : member.id)} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] opacity-100 hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]">
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  {menuMemberId === member.id ? (
                    <div className="absolute right-0 z-20 mt-1 w-36 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-1 shadow-md">
                      <button type="button" onClick={() => runMemberAction(`role:${member.id}`, () => spaceUpdateMemberRole({ spaceId: session.space.slug || session.space.id, memberId: member.id, role: member.role === "admin" ? "member" : "admin" }))} className="w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--ink)] hover:bg-[var(--hover-bg)]">
                        调整身份
                      </button>
                      <button type="button" onClick={() => runMemberAction(`remove:${member.id}`, () => spaceRemoveMember({ spaceId: session.space.slug || session.space.id, memberId: member.id }))} className="w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--error)] hover:bg-[var(--hover-bg)]">
                        移除
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
              编辑
            </button>
          </div>
          {editingOverview ? (
            <div className="mt-4 flex items-center gap-2">
              <button type="button" onClick={pickAvatar} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]">
                选择头像
              </button>
              <button type="button" onClick={saveOverview} disabled={busyKey === "overview" || !name.trim()} className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--button-primary-text)] disabled:opacity-60">
                {busyKey === "overview" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                保存
              </button>
            </div>
          ) : null}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-sm text-[var(--ink-secondary)]">
            <div className="mb-2 font-semibold text-[var(--ink)]">Free quota</div>
            <div>Members: {quotaText(overviewUsage?.memberSeats, overviewLimits?.joinedMembersMax)}</div>
            <div>Open issues: {quotaText(overviewUsage?.openIssues, overviewLimits?.openIssuesMax)}</div>
            <div>Skills: {quotaText(overviewUsage?.hostedSkills, overviewLimits?.hostedSkillsMax)}</div>
            <div>Agents: {quotaText(overviewUsage?.registeredAgents, overviewLimits?.registeredAgentsMax)}</div>
            <div>Storage: {formatBytes(overviewUsage?.storageBytes ?? 0)} / {formatBytes(overviewLimits?.storageBytesMax ?? 1024 * 1024 * 1024)}</div>
          </div>
        </div>
      </div>,
    );
  }

  return renderShell(
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {menuItems(pendingCount).map((item) => {
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
