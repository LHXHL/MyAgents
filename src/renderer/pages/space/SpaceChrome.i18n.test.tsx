import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpaceSession } from "@/api/spaceCloud";
import { i18n } from "@/i18n";
import { SpaceLogin, SpaceSidebar } from "./SpaceChrome";

vi.mock("@/hooks/useCloseLayer", () => ({
  useCloseLayer: vi.fn(),
}));

const session: SpaceSession = {
  user: { id: "u-1", email: "user@example.com", name: "User" },
  space: {
    id: "space-1",
    slug: "official",
    name: "Official Space",
    joinPolicy: "open",
  },
  membership: { id: "membership-1", role: "member" },
  baseUrl: "https://space.myagents.test",
  updatedAt: "2026-06-28T00:00:00.000Z",
};

describe("SpaceChrome i18n", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  const sidebarProps = {
    onSpaceTabChange: vi.fn(),
    onSpaceSwitch: vi.fn(),
    onJoinSpace: vi.fn(),
    onCreateSpace: vi.fn(),
    onLogout: vi.fn(),
    onOpenProfileSettings: vi.fn(),
  };

  it("renders login chrome in English", () => {
    render(<SpaceLogin authBusy={false} authFlow={null} onLogin={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: "MyAgents Community" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("MyAgents 社区")).not.toBeInTheDocument();
    expect(screen.queryByText("继续使用 Google")).not.toBeInTheDocument();
  });

  it("renders sidebar account menu in English without translating data", () => {
    render(<SpaceSidebar session={session} mode="issues" {...sidebarProps} />);

    expect(screen.getAllByText("Official Space").length).toBeGreaterThan(0);
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Join Space" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Space" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Agents" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Settings" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /user/i }));
    expect(screen.getAllByText("user@example.com").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("开放加入")).not.toBeInTheDocument();
    expect(screen.queryByText("退出登录")).not.toBeInTheDocument();
  });

  it("shows Space Settings only for admins and surfaces pending join requests", () => {
    const adminSession: SpaceSession = {
      ...session,
      membership: { ...session.membership, role: "admin" },
      spaces: [
        {
          ...session.space,
          membership: { ...session.membership, role: "admin" },
          canManage: true,
          pendingJoinRequestCount: 2,
        },
      ],
    };
    render(
      <SpaceSidebar session={adminSession} mode="settings" {...sidebarProps} />,
    );

    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Agents" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("closes the sidebar account menu when clicking outside", async () => {
    render(<SpaceSidebar session={session} mode="issues" {...sidebarProps} />);

    fireEvent.click(screen.getByRole("button", { name: /user/i }));
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Sign out" }),
      ).not.toBeInTheDocument();
    });
  });

  it("shows account-level Pro identity and refreshes a stale projection on open", async () => {
    const refreshAccountPlan = vi.fn().mockResolvedValue(undefined);
    const proSession: SpaceSession = {
      ...session,
      updatedAt: new Date().toISOString(),
      accountPlan: {
        effectiveTier: "pro",
        evaluatedAt: "2026-07-11T00:00:00.000Z",
        membership: {
          planTier: "pro",
          status: "active",
          startsAt: "2026-07-01T00:00:00.000Z",
          expiresAt: "2099-10-11T00:00:00.000Z",
          revokedAt: null,
          source: "operations",
          version: 1,
        },
      },
    };
    render(
      <SpaceSidebar
        session={proSession}
        mode="issues"
        {...sidebarProps}
        onRefreshAccountPlan={refreshAccountPlan}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /user/i }));

    expect(screen.getByText("PRO")).toBeInTheDocument();
    expect(screen.getByText(/Pro account · valid until/)).toBeInTheDocument();
    await waitFor(() => expect(refreshAccountPlan).toHaveBeenCalledTimes(1));
  });

  it("fails closed to Free when a cached active membership is already expired", async () => {
    const refreshAccountPlan = vi.fn().mockResolvedValue(undefined);
    const expiredSession: SpaceSession = {
      ...session,
      accountPlan: {
        effectiveTier: "pro",
        evaluatedAt: "2026-07-01T00:00:00.000Z",
        membership: {
          planTier: "pro",
          status: "active",
          startsAt: "2026-06-01T00:00:00.000Z",
          expiresAt: "2026-07-01T00:00:00.000Z",
          revokedAt: null,
          source: "operations",
          version: 1,
        },
      },
    };
    render(
      <SpaceSidebar
        session={expiredSession}
        mode="issues"
        {...sidebarProps}
        onRefreshAccountPlan={refreshAccountPlan}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /user/i }));

    expect(screen.queryByText("PRO")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Free account · Pro expired on/),
    ).toBeInTheDocument();
    await waitFor(() => expect(refreshAccountPlan).toHaveBeenCalledTimes(1));
  });

  it("shows a revoked membership as Free instead of expired Pro history", () => {
    const revokedSession: SpaceSession = {
      ...session,
      accountPlan: {
        effectiveTier: "free",
        evaluatedAt: "2026-07-11T00:00:00.000Z",
        membership: {
          planTier: "pro",
          status: "revoked",
          startsAt: "2026-06-01T00:00:00.000Z",
          expiresAt: "2026-07-01T00:00:00.000Z",
          revokedAt: "2026-06-20T00:00:00.000Z",
          source: "operations",
          version: 2,
        },
      },
    };
    render(
      <SpaceSidebar session={revokedSession} mode="issues" {...sidebarProps} />,
    );

    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /user/i }));

    expect(screen.getByText("FREE")).toBeInTheDocument();
    expect(screen.getByText("Free account")).toBeInTheDocument();
    expect(screen.queryByText(/Pro expired on/)).not.toBeInTheDocument();
  });
});
