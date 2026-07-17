import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalRegisteredAgent } from "@/api/spaceCloud";
import { ToastProvider } from "@/components/Toast";
import { i18n } from "@/i18n";
import type { SpaceActions } from "@/pages/space/spaceStore";
import { AgentsWorkspace } from "./AgentsWorkspace";

function renderWorkspace(
  refreshRegisteredAgents = vi.fn().mockResolvedValue(undefined),
  agents: LocalRegisteredAgent[] = [],
  admin = false,
) {
  const actions = { refreshRegisteredAgents } as unknown as SpaceActions;
  render(
    <ToastProvider>
      <AgentsWorkspace
        admin={admin}
        agents={agents}
        goals={[]}
        projects={[]}
        actions={actions}
        avatarPresets={{
          people: [],
          agents: [],
          lastFetchedAt: 0,
          isLoading: false,
          error: null,
        }}
        onRegister={vi.fn()}
        isActive
        onAgentConnecting={vi.fn()}
      />
    </ToastProvider>,
  );
  return refreshRegisteredAgents;
}

const testAgent: LocalRegisteredAgent = {
  id: "rag-1",
  baseUrl: "https://space.myagents.test",
  spaceId: "space-1",
  displayName: "Build Agent",
  workspacePath: "/tmp/build",
  stateFilter: ["todo"],
  issueSubscriptionRunMode: "single_session",
  status: "active",
  presence: "offline",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
};

describe("AgentsWorkspace", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("preserves card order when the app returns to the foreground", async () => {
    const refresh = renderWorkspace();
    await waitFor(() =>
      expect(refresh).toHaveBeenCalledWith({ force: true, silent: false }),
    );

    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() =>
      expect(refresh).toHaveBeenLastCalledWith({
        force: true,
        silent: true,
      }),
    );
  });

  it("offers an actionable hint and a native details button for never-online Agents", () => {
    renderWorkspace(undefined, [testAgent]);

    expect(
      screen.getByText(
        "Make sure the MyAgents client is running and can reach Space Cloud.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "View registration settings · Build Agent",
      }),
    ).toBeInTheDocument();
  });

  it("replaces Agent details with the editor when settings is opened", () => {
    renderWorkspace(undefined, [testAgent], true);

    fireEvent.click(
      screen.getByRole("button", {
        name: "View registration settings · Build Agent",
      }),
    );
    expect(screen.getByText("Registration info")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Agent Build Agent" }),
    );

    expect(
      screen.getByRole("heading", { name: "Edit Agent" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Registration info")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("heading", { name: "Edit Agent" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Registration info")).not.toBeInTheDocument();
  });
});
