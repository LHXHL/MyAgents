import {
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
    joinPolicy: "open_join",
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

  it("renders reauthentication as an account recovery action", () => {
    const onLogin = vi.fn();
    const onForgetAccount = vi.fn();
    render(
      <SpaceLogin
        authBusy={false}
        authFlow={null}
        onLogin={onLogin}
        reauthRequired
        accountName="User"
        onForgetAccount={onForgetAccount}
      />,
    );

    expect(
      screen.getByText(
        "The sign-in for User is no longer valid. Sign in again to continue.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Sign out and forget this account",
      }),
    );
    expect(onLogin).toHaveBeenCalledOnce();
    expect(onForgetAccount).toHaveBeenCalledOnce();
  });

  it("keeps Space navigation and removes the duplicate account entry", () => {
    render(<SpaceSidebar session={session} mode="issues" {...sidebarProps} />);
    expect(screen.getAllByText("Official Space").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Join Space" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Space" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /user/i })).not.toBeInTheDocument();
    expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("renders the localized Chinese Space navigation labels", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<SpaceSidebar session={session} mode="issues" {...sidebarProps} />);

    expect(
      screen.getByRole("button", { name: "加入空间" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "创建空间" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "议题 Issue" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "目标 Goals" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "技能 Skills" }),
    ).toBeInTheDocument();
  });

  it("expands Space navigation locally and keeps only one Space expanded", () => {
    const onSpaceSwitch = vi.fn();
    const maSpace = {
      id: "space-2",
      slug: "ma",
      name: "MA",
      joinPolicy: "approval_required",
    };
    const maMembership = {
      id: "membership-2",
      spaceId: "space-2",
      role: "owner" as const,
    };
    render(
      <SpaceSidebar
        session={{
          ...session,
          space: maSpace,
          membership: maMembership,
          spaces: [
            {
              ...session.space,
              membership: session.membership,
            },
            {
              ...maSpace,
              membership: maMembership,
            },
          ],
        }}
        mode="issues"
        {...sidebarProps}
        onSpaceSwitch={onSpaceSwitch}
      />,
    );

    const spaceList = screen.getByRole("list");
    const officialSpaceItem = screen.getByText("Official Space").closest("li");
    const activeSpaceItem = screen.getByText("MA").closest("li");
    expect(officialSpaceItem?.parentElement).toBe(spaceList);
    expect(activeSpaceItem?.parentElement).toBe(spaceList);
    expect(
      within(activeSpaceItem!).getByRole("navigation", {
        name: "MA",
      }),
    ).toBeInTheDocument();
    expect(
      within(officialSpaceItem!).queryByRole("navigation"),
    ).not.toBeInTheDocument();

    const officialSpaceToggle = within(officialSpaceItem!).getByRole("button", {
      name: /Official Space/,
    });
    const activeSpaceToggle = within(activeSpaceItem!).getByRole("button", {
      name: /MA/,
    });
    expect(officialSpaceToggle).toHaveAttribute("aria-expanded", "false");
    expect(activeSpaceToggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(officialSpaceToggle);

    expect(onSpaceSwitch).not.toHaveBeenCalled();
    expect(officialSpaceToggle).toHaveAttribute("aria-expanded", "true");
    expect(activeSpaceToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(officialSpaceItem!).getByRole("navigation", {
        name: "Official Space",
      }),
    ).toBeInTheDocument();
    expect(
      within(activeSpaceItem!).queryByRole("navigation"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(officialSpaceItem!).getByRole("button", { name: "Issues" }),
    );
    expect(onSpaceSwitch).toHaveBeenCalledWith("space-1", "issues");
  });

  it("localizes approval-required and unknown join policies without exposing tokens", async () => {
    await i18n.changeLanguage("zh-CN");
    const { rerender } = render(
      <SpaceSidebar
        session={{
          ...session,
          space: { ...session.space, joinPolicy: "approval_required" },
        }}
        mode="issues"
        {...sidebarProps}
      />,
    );

    expect(screen.getByText("需审核加入")).toBeInTheDocument();
    expect(screen.queryByText("approval required")).not.toBeInTheDocument();

    rerender(
      <SpaceSidebar
        session={{
          ...session,
          space: { ...session.space, joinPolicy: "future_policy" },
        }}
        mode="issues"
        {...sidebarProps}
      />,
    );

    expect(screen.getByText("未知加入方式")).toBeInTheDocument();
    expect(screen.queryByText("future policy")).not.toBeInTheDocument();
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

});
