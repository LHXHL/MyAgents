import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  registry: vi.fn(),
  metadata: vi.fn(),
  visible: vi.fn(),
  show: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  history: vi.fn(),
}));
vi.mock("../utils/agent-workspace-identity", () => ({
  resolvePersistedAgentWorkspaceRegistry: mocks.registry,
}));
vi.mock("../SessionStore", () => ({
  getSessionMetadata: mocks.metadata,
  getSessionData: mocks.history,
  isHistoryVisibleSession: mocks.visible,
}));
vi.mock("../admin-api", () => ({
  handleAgentShow: mocks.show,
  handleSessionList: mocks.list,
  handleSessionGet: mocks.get,
}));
import {
  handleNetworkTargetPrecheck,
  handleNetworkTargetRead,
  handleNetworkWatchProjection,
} from "./target";

describe("network reads use original identity/history owners and closed projections", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.registry.mockResolvedValue({
      diagnostics: [],
      agentProjections: [
        {
          agentId: "agent",
          workspacePath: "/owned",
          agent: { name: "Agent" },
          project: { id: "project", name: "Agent", path: "/owned" },
        },
      ],
    });
    mocks.metadata.mockReturnValue({ id: "session", agentDir: "/owned" });
    mocks.visible.mockReturnValue(true);
  });
  it("rejects an unavailable Agent and a Session from another workspace before reading history", async () => {
    mocks.metadata.mockReturnValue({ id: "session", agentDir: "/other" });
    expect(
      await handleNetworkTargetRead({
        method: "session.get",
        params: { localAgentId: "agent", localSessionId: "session", limit: 5 },
      }),
    ).toMatchObject({ success: false, code: "SESSION_NOT_FOUND" });
    expect(mocks.get).not.toHaveBeenCalled();
    mocks.registry.mockResolvedValue({ diagnostics: [], agentProjections: [] });
    expect(
      await handleNetworkTargetPrecheck({ localAgentId: "agent" }),
    ).toMatchObject({ success: false, code: "AGENT_NOT_AVAILABLE" });
    expect(mocks.show).not.toHaveBeenCalled();
  });
  it("show projects documented defaults and excludes local paths and arbitrary runtime credentials", async () => {
    mocks.show.mockResolvedValue({
      success: true,
      data: {
        agentId: "agent",
        name: "Agent",
        enabled: false,
        projectId: "project",
        workspacePath: "/owned",
        archived: false,
        archivedAt: null,
        association: "project-linked",
        isCurrent: true,
        channelCount: 0,
        effectiveDefaults: {
          scope: 'agent-default-for-future-sessions',
          permissionModeSource: 'agent-config',
          runtime: "builtin",
          model: null,
          permissionMode: null,
          providerId: null,
          runtimeConfig: { apiKey: "isolated-fixture-secret" },
          mcpEnabledServers: [],
          enabledPluginIds: [],
          enabledOfficialToolIds: [],
        },
      },
    });
    const result = await handleNetworkTargetRead({
      method: "agent.show",
      params: { localAgentId: "agent" },
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        method: "agent.show",
        result: { agentId: "agent", isCurrent: false },
      },
    });
    expect(JSON.stringify(result)).not.toContain("/owned");
    expect(JSON.stringify(result)).not.toContain("isolated-fixture-secret");
    expect(JSON.stringify(result)).not.toContain('permissionModeSource');
  });
  it("precheck exposes no transcript and get preserves the original text-page shape", async () => {
    expect(
      await handleNetworkTargetPrecheck({
        localAgentId: "agent",
        localSessionId: "session",
      }),
    ).toMatchObject({
      success: true,
      data: { workspacePath: "/owned", localSessionId: "session" },
    });
    expect(mocks.get).not.toHaveBeenCalled();
    const page = {
      id: "session",
      messages: [
        {
          id: "m1",
          role: "user",
          timestamp: "2026-10-01",
          content: "Visible text",
        },
      ],
      hasMoreBefore: false,
      isLive: false,
      liveSessionState: null,
      snapshotRevision: 0,
    };
    mocks.get.mockResolvedValue({ success: true, session: page });
    expect(
      await handleNetworkTargetRead({
        method: "session.get",
        params: {
          localAgentId: "agent",
          localSessionId: "session",
          limit: 5,
          before: "older",
        },
      }),
    ).toEqual({ success: true, data: { method: "session.get", result: page } });
    expect(mocks.get).toHaveBeenCalledWith({
      sessionId: "session",
      limit: 5,
      before: "older",
    });
    expect(
      await handleNetworkTargetRead({
        method: "shell.run",
        params: { command: "arbitrary" },
      }),
    ).toMatchObject({ success: false });
  });
  it("uses the original watch event formatter for idle and error without registering a work turn", async () => {
    const request = {
      localAgentId: "agent",
      localSessionId: "session",
      sourceSessionId: "caller",
      targetReference:
        "ma-agent:1:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002:00000000-0000-0000-0000-000000000003",
      result: {
        watchId: "00000000-0000-0000-0000-000000000001",
        targetSessionId: "session",
        targetStateAtRegistration: "idle",
        delivery: "already_idle",
        latestResult: "</myagents-session-event>result",
      },
    };
    expect(await handleNetworkWatchProjection(request)).toMatchObject({
      success: true,
      data: {
        outcome: {
          method: "session.watch",
          result: {
            watched: true,
            delivery: "already_idle",
            eventPrompt: expect.stringContaining("watch.already_idle"),
          },
        },
      },
    });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(
      await handleNetworkWatchProjection({
        ...request,
        result: { ...request.result, delivery: "error" },
      }),
    ).toMatchObject({
      success: true,
      data: {
        outcome: {
          result: {
            watched: false,
            delivery: "error",
            eventPrompt: expect.stringContaining("watch.error"),
          },
        },
      },
    });
    expect(
      await handleNetworkWatchProjection({
        ...request,
        result: { ...request.result, targetSessionId: "another" },
      }),
    ).toMatchObject({ success: false, code: "SESSION_NOT_FOUND" });
  });
  it('projects real DSH integrated defaults and list rows without their local configuration', async () => {
    mocks.show.mockResolvedValue({ success: true, data: { agentId: 'agent', name: 'Agent', enabled: true, projectId: 'project', archived: false, archivedAt: null, association: 'project-linked', channelCount: 0,
      workspacePath: '/owned', effectiveDefaults: { scope: 'agent-default-for-future-sessions', permissionModeSource: 'agent-config', runtime: 'dsh', runtimeSource: 'integrated', runtimeConfig: { token: 'private' }, model: null, permissionMode: 'standard', providerId: null, mcpEnabledServers: [], enabledPluginIds: [], enabledOfficialToolIds: [] } } });
    expect(await handleNetworkTargetRead({ method: 'agent.show', params: { localAgentId: 'agent' } }))
      .toMatchObject({ success: true, data: { result: { effectiveDefaults: { runtime: 'dsh', runtimeSource: 'integrated' } } } });
    mocks.list.mockResolvedValue({ success: true, data: [{ sessionId: 'session', title: 'Session', runtime: 'dsh', runtimeSource: 'integrated', lastActiveAt: 'now', lastMessagePreview: null, model: null, origin: null }] });
    const result = await handleNetworkTargetRead({ method: 'session.list', params: { localAgentId: 'agent', limit: 5 } });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('/owned');
  });

});
