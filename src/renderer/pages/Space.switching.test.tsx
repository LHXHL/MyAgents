import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpaceSession } from "@/api/spaceCloud";
import Space from "@/pages/Space";
import { __resetSpaceStoreForTest, __setSpaceStoreStateForTest, getSnapshot } from './space/spaceStore';

const harness = vi.hoisted(() => ({
  realStore: false,
  api: {
    spaceGetCapability: vi.fn(),
    spaceGetSession: vi.fn(),
    spaceGetOfficial: vi.fn(),
    spaceSetActiveSpace: vi.fn(),
    spaceListGoals: vi.fn().mockResolvedValue({ items: [] }),
    spaceListIssues: vi.fn().mockResolvedValue({ items: [], hasMore: false, nextCursor: null }),
    spaceListTools: vi.fn().mockResolvedValue({ items: [], hasMore: false, nextCursor: null }),
    spaceListEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: null, hasMore: false }),
  },
  data: null as unknown as Record<string, unknown>,
  actions: {
    switchSpace: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshIssues: vi.fn().mockResolvedValue(undefined),
    refreshGoals: vi.fn().mockResolvedValue(undefined),
    refreshSkills: vi.fn().mockResolvedValue(undefined),
    refreshTools: vi.fn().mockResolvedValue(undefined),
    refreshLocalAgents: vi.fn().mockResolvedValue(undefined),
    refreshRegisteredAgents: vi.fn().mockResolvedValue(undefined),
    syncEvents: vi.fn().mockResolvedValue([]),
  },
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => harness.toast,
}));

vi.mock("@/hooks/useConfig", () => ({
  useConfig: () => ({ projects: [] }),
}));

vi.mock("@/hooks/useWorkspaceFileService", () => ({
  useWorkspaceFileService: () => ({ readPathsAsBase64: vi.fn() }),
}));

vi.mock("@/identity/deviceIdentity", () => ({
  getDeviceId: () => "device-test",
  getPlatform: () => "macos",
  getAppVersionSync: () => "0.4.25",
  preloadDeviceId: () => Promise.resolve(),
}));

vi.mock("@/pages/space/useSpaceData", async (importOriginal) => {
  const actual = await importOriginal<typeof import('./space/useSpaceData')>();
  return { useSpaceData: (options: Parameters<typeof actual.useSpaceData>[0]) => harness.realStore ? actual.useSpaceData(options) : harness.data };
});

vi.mock("@/pages/space/spaceStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import('./space/spaceStore')>();
  return {
  ...actual,
  SPACE_VISIBLE_REFRESH_TTL_MS: 30_000,
  getIssueListState: (...args: Parameters<typeof actual.getIssueListState>) => harness.realStore ? actual.getIssueListState(...args) : ({
    items: [],
    hasMore: false,
    nextCursor: null,
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  }),
  };
});

vi.mock("@/pages/space/SpaceChrome", () => ({
  SpaceLogin: ({ onForgetAccount }: { onForgetAccount?: () => void }) => (
    <div>login{onForgetAccount && <button type="button" onClick={onForgetAccount}>forget account</button>}</div>
  ),
  SpaceSidebar: ({
    onSpaceTabChange,
    onSpaceSwitch,
  }: {
    onSpaceTabChange: (mode: string) => void;
    onSpaceSwitch: (spaceId: string, mode: string) => void;
  }) => (
    <aside>
      <button type="button" onClick={() => onSpaceTabChange("skills")}>
        show skills
      </button>
      <button type="button" onClick={() => onSpaceTabChange("goals")}>
        show goals
      </button>
      <button type="button" onClick={() => onSpaceTabChange("settings")}>
        show settings
      </button>
      <button type="button" onClick={() => onSpaceTabChange("issues")}>
        show issues
      </button>
      <button type="button" onClick={() => onSpaceSwitch("team", "skills")}>
        show team skills
      </button>
      <button type="button" onClick={() => onSpaceSwitch("team", "issues")}>
        show team issues
      </button>
    </aside>
  ),
}));

vi.mock("@/pages/space/issues/IssuesWorkspace", () => ({
  IssuesWorkspace: ({
    selectedStatus,
    selectedStatusPreset,
    onStatusChange,
    onOpenIssue,
  }: {
    selectedStatus: string;
    selectedStatusPreset: string;
    onStatusChange: (value: string) => void;
    onOpenIssue: (issueId: string) => void;
  }) => (
    <main>
      issues
      <output aria-label="selected issue status">
        {selectedStatus || "empty"}
      </output>
      <output aria-label="remembered issue status">
        {selectedStatusPreset || "empty"}
      </output>
      <button type="button" onClick={() => onStatusChange("open,todo,doing")}>
        set incomplete
      </button>
      <button type="button" onClick={() => onStatusChange("doing")}>
        set doing
      </button>
      <button type="button" onClick={() => onStatusChange("all")}>
        set all
      </button>
      <button
        type="button"
        onClick={() => onStatusChange(selectedStatusPreset)}
      >
        restore remembered status
      </button>
      <button type="button" onClick={() => onOpenIssue("issue-1")}>
        open issue detail
      </button>
    </main>
  ),
}));

vi.mock("@/pages/space/goals/GoalsWorkspace", () => ({
  GoalsWorkspace: ({
    onOpenIssuesForGoal,
  }: {
    onOpenIssuesForGoal: (goalId: string) => void;
  }) => (
    <main>
      goals
      <button type="button" onClick={() => onOpenIssuesForGoal("goal-1")}>
        open issues from goal
      </button>
    </main>
  ),
}));

vi.mock("@/pages/space/issues/CreateIssueDialog", () => ({
  CreateIssueDialog: () => null,
}));

vi.mock("@/pages/space/issues/IssueDetailDrawer", () => ({
  IssueDetailDrawer: ({ issueId, onClose }: { issueId: string; onClose: () => void }) => (
    <div role="dialog" aria-label="issue detail" data-issue-id={issueId}>
      <button type="button" onClick={onClose}>
        close issue detail
      </button>
    </div>
  ),
}));

vi.mock("@/pages/space/skills/SkillsWorkspace", () => ({
  SkillsWorkspace: () => <main>skills</main>,
}));

vi.mock("@/pages/space/tools/ToolsWorkspace", () => ({
  ToolsWorkspace: ({ spaceId, selectedToolId, onSelectTool }: {
    spaceId: string; selectedToolId: string | null; onSelectTool: (id: string) => void;
  }) => <main aria-label="tool market" data-space-id={spaceId} data-selected-tool={selectedToolId ?? ''}>
    tools
    <button type="button" onClick={() => onSelectTool('tool-detail')}>open tool</button>
  </main>,
}));

vi.mock("@/pages/space/settings/SpaceSettingsWorkspace", () => ({
  SpaceSettingsWorkspace: ({ onExit }: { onExit: () => void }) => (
    <main>
      settings
      <button type="button" onClick={onExit}>
        exit settings
      </button>
    </main>
  ),
}));

vi.mock("@/api/spaceCloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/spaceCloud")>();
  return {
    ...actual,
    ...harness.api,
    spaceWakeConnector: vi.fn().mockResolvedValue(undefined),
  };
});

function sessionFor(
  id: string,
  slug: string,
  baseUrl = "https://space.myagents.test",
  role: "admin" | "member" = "member",
): SpaceSession {
  return {
    baseUrl,
    user: { id: "user-1", email: "user@example.com", name: "User" },
    space: {
      id,
      slug,
      name: slug,
      joinPolicy: "open_join",
    },
    membership: { id: `membership-${id}`, role },
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function snapshot(
  spaceId: string,
  baseUrl = "https://space.myagents.test",
  role: "admin" | "member" = "member",
) {
  const session = sessionFor(`id-${spaceId}`, spaceId, baseUrl, role);
  return {
    boot: "ready",
    bootError: null,
    serviceBaseUrl: session.baseUrl,
    session,
    spaceId,
    goals: [],
    skills: { items: [], lastFetchedAt: 0, isLoading: false, error: null },
    tools: {
      items: [],
      nextCursor: null,
      hasMore: false,
      lastFetchedAt: 0,
      isLoading: false,
      isLoadingMore: false,
      error: null,
    },
    toolDetails: {},
    toolRevisions: {},
    issueDetails: {},
    localAgents: { items: [], lastFetchedAt: 0, isLoading: false, error: null },
    registeredAgents: {
      items: [],
      lastFetchedAt: 0,
      isLoading: false,
      error: null,
    },
    actions: harness.actions,
  };
}

describe("Space switching", () => {
  beforeEach(() => {
    harness.realStore = false;
    __resetSpaceStoreForTest();
    Object.values(harness.api).forEach((mock) => mock.mockClear());
    vi.useFakeTimers();
    harness.actions.switchSpace.mockReset().mockResolvedValue(undefined);
    harness.actions.logout.mockReset().mockResolvedValue(undefined);
    harness.actions.refreshIssues.mockClear();
    harness.actions.refreshGoals.mockClear();
    harness.actions.refreshSkills.mockClear();
    harness.actions.refreshLocalAgents.mockClear();
    harness.actions.refreshRegisteredAgents.mockClear();
    harness.actions.syncEvents.mockReset().mockResolvedValue([]);
    Object.values(harness.toast).forEach((mock) => mock.mockClear());
    harness.data = snapshot("ma");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off sustained event errors, limits notices and restores cadence on success", async () => {
    harness.actions.syncEvents.mockRejectedValue(new Error("network unavailable"));
    render(<Space isActive />);
    await act(async () => undefined);
    expect(harness.toast.error).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(harness.actions.syncEvents).toHaveBeenCalledTimes(2);
    expect(harness.toast.error).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(harness.actions.syncEvents).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(harness.toast.error).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(harness.toast.error).toHaveBeenCalledTimes(2);
    expect(harness.actions.syncEvents).toHaveBeenCalledTimes(6);
    harness.actions.syncEvents.mockResolvedValue([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    const recovered = harness.actions.syncEvents.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(harness.actions.syncEvents).toHaveBeenCalledTimes(recovered + 1);
  });

  it("does not overlap slow polls or schedule an old hidden-page completion", async () => {
    let resolve!: (events: []) => void;
    const pending = new Promise<[]>((done) => { resolve = done; });
    harness.actions.syncEvents.mockReturnValueOnce(pending);
    const view = render(<Space isActive />);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(harness.actions.syncEvents).toHaveBeenCalledTimes(1);
    view.rerender(<Space isActive={false} />);
    await act(async () => { resolve([]); await pending; });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(harness.actions.syncEvents).toHaveBeenCalledTimes(1);
    view.rerender(<Space isActive />);
    await act(async () => undefined);
    expect(harness.actions.syncEvents).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(harness.actions.syncEvents).toHaveBeenCalledTimes(3);
    expect(harness.toast.error).not.toHaveBeenCalled();
  });

  function useRealTeamStore(officialSlug = 'official') {
    harness.realStore = true;
    const team = { ...sessionFor('id-team', 'team'), sessionBindingId: 'binding-route' };
    const official = sessionFor('id-official', officialSlug);
    official.space.spaceKind = 'official';
    const result = { space: official.space, membership: official.membership, goals: [] };
    __setSpaceStoreStateForTest({ boot: 'ready', session: team, spaceId: 'team', serviceBaseUrl: team.baseUrl });
    harness.api.spaceGetCapability.mockReset().mockResolvedValue({ available: true, baseUrl: team.baseUrl });
    harness.api.spaceGetSession.mockReset().mockResolvedValue({ state: 'authenticated', session: { ...team, lastActiveSpaceId: 'official' } });
    harness.api.spaceGetOfficial.mockReset().mockResolvedValue(result);
    harness.api.spaceSetActiveSpace.mockReset().mockResolvedValue(undefined);
    return result;
  }

  it("counts real silent bootstrap failures triggered by events instead of treating them as success", async () => {
    useRealTeamStore();
    __setSpaceStoreStateForTest({
      bootLastFetchedAt: Date.now(),
      events: { items: [], cursor: null, initialized: true, lastFetchedAt: 0, isLoading: false, error: null },
    });
    let index = 0;
    harness.api.spaceListEvents.mockReset().mockImplementation(async () => ({
      items: [{ id: `goal-event-${++index}`, type: 'goal.updated', resourceType: 'goal', resourceId: 'goal-test', createdAt: new Date().toISOString() }],
      nextCursor: `cursor-${index}`, hasMore: false,
    }));
    harness.api.spaceGetOfficial.mockRejectedValue(new Error('Offline'));
    render(<Space isActive />);
    await act(async () => undefined);
    expect(harness.toast.error).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(harness.toast.error).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(harness.api.spaceGetOfficial).toHaveBeenCalledTimes(3);
    expect(getSnapshot().boot).toBe('ready');
    expect(getSnapshot().bootError).toBe('Offline');
    expect(harness.toast.error).toHaveBeenCalledTimes(1);
    harness.api.spaceListEvents.mockReset().mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  });

  it('opens official Tools when bootstrap returns the real community slug', async () => {
    useRealTeamStore('myagents');
    const consumed = vi.fn();
    render(<Space isActive pendingRoute={{ generation: 40, route: { version: 1, name: 'space.tools', params: { spaceId: 'official' } } }} onRouteConsumed={consumed} />);
    await act(async () => undefined);
    expect(screen.getByRole('main', { name: 'tool market' })).toHaveAttribute('data-space-id', 'myagents');
    expect(consumed).toHaveBeenCalledWith(40);
    expect(harness.toast.error).not.toHaveBeenCalled();
  });

  it.each(['space.tools', 'space.issue'] as const)('accepts the official alias for %s when the community is already current', async (name) => {
    const community = useRealTeamStore('myagents');
    const team = getSnapshot().session!;
    __setSpaceStoreStateForTest({ session: { ...team, ...community, lastActiveSpaceId: 'official' }, spaceId: 'myagents' });
    const consumed = vi.fn();
    const route = name === 'space.tools'
      ? { version: 1 as const, name, params: { spaceId: 'official' } }
      : { version: 1 as const, name, params: { spaceId: 'official', issueId: 'community-issue' } };
    render(<Space isActive pendingRoute={{ generation: 41, route }} onRouteConsumed={consumed} />);
    await act(async () => undefined);
    if (name === 'space.tools') expect(screen.getByRole('main', { name: 'tool market' })).toHaveAttribute('data-space-id', 'myagents');
    else expect(screen.getByRole('dialog', { name: 'issue detail' })).toHaveAttribute('data-issue-id', 'community-issue');
    expect(harness.api.spaceGetOfficial).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledWith(41);
    expect(harness.toast.error).not.toHaveBeenCalled();
  });

  it('retains the official Tools intent when real store bootstrap fails and recovers on retry', async () => {
    useRealTeamStore();
    harness.api.spaceGetOfficial.mockRejectedValueOnce({ code: 'SPACE_TRANSPORT_FAILED', message: 'Offline', retryable: true });
    const consumed = vi.fn();
    render(<Space isActive pendingRoute={{ generation: 30, route: { version: 1, name: 'space.tools', params: { spaceId: 'official' } } }} onRouteConsumed={consumed} />);
    await act(async () => undefined);
    expect(getSnapshot().spaceId).toBe('team');
    expect(consumed).not.toHaveBeenCalled();
    expect(screen.queryByRole('main', { name: 'tool market' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await act(async () => undefined);
    expect(screen.getByRole('main', { name: 'tool market' })).toHaveAttribute('data-space-id', 'official');
    expect(consumed).toHaveBeenCalledWith(30);
  });

  it('awaits the real listed official switch without restarting on its local projection', async () => {
    const official = useRealTeamStore();
    const team = getSnapshot().session!;
    __setSpaceStoreStateForTest({ session: { ...team, spaces: [{ ...official.space, membership: official.membership }] } });
    const persistence = deferred<void>();
    harness.api.spaceSetActiveSpace.mockReturnValueOnce(persistence.promise);
    const consumed = vi.fn();
    render(<Space isActive pendingRoute={{ generation: 33, route: { version: 1, name: 'space.tools', params: { spaceId: 'official' } } }} onRouteConsumed={consumed} />);
    await act(async () => undefined);
    expect(consumed).not.toHaveBeenCalled();
    expect(harness.api.spaceSetActiveSpace).toHaveBeenCalledOnce();
    await act(async () => persistence.resolve());
    expect(screen.getByRole('main', { name: 'tool market' })).toHaveAttribute('data-space-id', 'official');
    expect(consumed).toHaveBeenCalledWith(33);
    expect(harness.api.spaceGetOfficial).not.toHaveBeenCalled();
  });

  it.each(['persistence', 'bootstrap'])('supersedes a real old Tools switch during %s with a route to the current team', async (stage) => {
    const official = useRealTeamStore();
    const persistence = deferred<void>();
    const bootstrap = deferred<typeof official>();
    if (stage === 'persistence') harness.api.spaceSetActiveSpace.mockReturnValueOnce(persistence.promise);
    else harness.api.spaceGetOfficial.mockReturnValueOnce(bootstrap.promise);
    const consumed = vi.fn();
    const view = render(<Space isActive pendingRoute={{ generation: 31, route: { version: 1, name: 'space.tools', params: { spaceId: 'official' } } }} onRouteConsumed={consumed} />);
    await act(async () => undefined);
    view.rerender(<Space isActive pendingRoute={{ generation: 32, route: { version: 1, name: 'space.issue', params: { spaceId: 'team', issueId: 'new-team-issue' } } }} onRouteConsumed={consumed} />);
    await act(async () => undefined);
    await act(async () => { persistence.resolve(); bootstrap.resolve(official); });
    expect(getSnapshot().spaceId).toBe('team');
    expect(screen.getByRole('dialog', { name: 'issue detail' })).toHaveAttribute('data-issue-id', 'new-team-issue');
    expect(consumed).toHaveBeenCalledWith(32);
    expect(consumed).not.toHaveBeenCalledWith(31);
    expect(harness.api.spaceSetActiveSpace.mock.calls.map(call => call[0])).toEqual(['official', 'team']);
  });

  it('switches from a team to official Tools and resets detail when reopening', async () => {
    harness.data = snapshot('team');
    harness.actions.switchSpace.mockImplementationOnce(async () => { harness.data = snapshot('official'); });
    const consumed = vi.fn();
    const route = { generation: 20, route: { version: 1 as const, name: 'space.tools' as const, params: { spaceId: 'official' } } };
    const view = render(<Space isActive pendingRoute={route} onRouteConsumed={consumed} />);
    await act(async () => undefined);
    expect(harness.actions.switchSpace).toHaveBeenCalledWith('official', undefined);
    expect(screen.getByRole('main', { name: 'tool market' })).toHaveAttribute('data-space-id', 'official');
    expect(screen.queryByRole('dialog', { name: 'issue detail' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'open tool' }));
    expect(screen.getByRole('main', { name: 'tool market' })).toHaveAttribute('data-selected-tool', 'tool-detail');
    view.rerender(<Space isActive pendingRoute={{ ...route, generation: 21 }} onRouteConsumed={consumed} />);
    await act(async () => undefined);
    expect(screen.getByRole('main', { name: 'tool market' })).toHaveAttribute('data-selected-tool', '');
    expect(consumed).toHaveBeenLastCalledWith(21);
  });

  it.each(['signedOut', 'reauthRequired'])('retains Tools navigation while %s and continues after authentication', async (boot) => {
    harness.data = { ...snapshot('official'), boot, session: null };
    const consumed = vi.fn();
    const props = { isActive: true, pendingRoute: { generation: 22, route: { version: 1 as const, name: 'space.tools' as const, params: { spaceId: 'official' } } }, onRouteConsumed: consumed };
    const view = render(<Space {...props} />);
    expect(screen.getByText('login')).toBeInTheDocument();
    expect(consumed).not.toHaveBeenCalled();
    harness.data = snapshot('official');
    view.rerender(<Space {...props} />);
    await act(async () => undefined);
    expect(screen.getByRole('main', { name: 'tool market' })).toHaveAttribute('data-space-id', 'official');
    expect(consumed).toHaveBeenCalledWith(22);
  });

  it('retries a transient official Tools switch failure', async () => {
    harness.actions.switchSpace.mockRejectedValueOnce({ code: 'SPACE_TRANSPORT_FAILED', message: 'Offline', retryable: true });
    harness.actions.switchSpace.mockImplementationOnce(async () => { harness.data = snapshot('official'); });
    const consumed = vi.fn();
    const props = { isActive: true, pendingRoute: { generation: 23, route: { version: 1 as const, name: 'space.tools' as const, params: { spaceId: 'official' } } }, onRouteConsumed: consumed };
    const view = render(<Space {...props} />);
    await act(async () => undefined);
    expect(consumed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await act(async () => undefined);
    // The real store publishes the new snapshot to useSpaceData subscribers.
    view.rerender(<Space {...props} />);
    expect(screen.getByRole('main', { name: 'tool market' })).toHaveAttribute('data-space-id', 'official');
    expect(consumed).toHaveBeenCalledWith(23);
  });

  it('does not let a delayed Tools intent override a newer Issue intent', async () => {
    const switching = deferred<void>();
    harness.actions.switchSpace.mockReturnValueOnce(switching.promise);
    const consumed = vi.fn();
    const view = render(<Space isActive pendingRoute={{ generation: 24, route: { version: 1, name: 'space.tools', params: { spaceId: 'official' } } }} onRouteConsumed={consumed} />);
    view.rerender(<Space isActive pendingRoute={{ generation: 25, route: { version: 1, name: 'space.issue', params: { spaceId: 'id-ma', issueId: 'issue-new' } } }} onRouteConsumed={consumed} />);
    await act(async () => undefined);
    await act(async () => switching.resolve());
    expect(screen.getByRole('dialog', { name: 'issue detail' })).toHaveAttribute('data-issue-id', 'issue-new');
    expect(consumed).toHaveBeenCalledWith(25);
    expect(consumed).not.toHaveBeenCalledWith(24);
    expect(screen.queryByRole('main', { name: 'tool market' })).not.toBeInTheDocument();
  });

  it("opens the exact issue from an application route and consumes it once", async () => {
    const onRouteConsumed = vi.fn();
    render(
      <Space
        isActive
        pendingRoute={{
          generation: 11,
          route: { version: 1, name: "space.issue", params: { spaceId: "id-ma", issueId: "issue-11" } },
        }}
        onRouteConsumed={onRouteConsumed}
      />,
    );

    await act(async () => undefined);
    expect(screen.getByRole("dialog", { name: "issue detail" }))
      .toHaveAttribute("data-issue-id", "issue-11");
    expect(onRouteConsumed).toHaveBeenCalledOnce();
    expect(onRouteConsumed).toHaveBeenCalledWith(11);
    expect(harness.actions.switchSpace).toHaveBeenCalledWith('id-ma', undefined);
  });

  it("switches to the routed Space before opening its exact issue", async () => {
    const target = sessionFor("space-team", "team");
    const current = (harness.data.session as SpaceSession);
    current.spaces = [{
      ...target.space,
      membership: target.membership,
    }];
    const onRouteConsumed = vi.fn();
    render(
      <Space
        isActive
        pendingRoute={{
          generation: 12,
          route: { version: 1, name: "space.issue", params: { spaceId: "space-team", issueId: "issue-12" } },
        }}
        onRouteConsumed={onRouteConsumed}
      />,
    );

    await act(async () => undefined);
    expect(harness.actions.switchSpace).toHaveBeenCalledWith(
      "space-team",
      expect.objectContaining({ id: "space-team" }),
    );
    expect(screen.getByRole("dialog", { name: "issue detail" }))
      .toHaveAttribute("data-issue-id", "issue-12");
    expect(onRouteConsumed).toHaveBeenCalledWith(12);
  });

  it("does not open a stale issue when the routed Space is authoritatively unavailable", async () => {
    harness.actions.switchSpace.mockRejectedValueOnce({
      code: "SPACE_NOT_FOUND",
      message: "Space is unavailable",
      retryable: false,
    });
    const onRouteConsumed = vi.fn();
    render(
      <Space
        isActive
        pendingRoute={{
          generation: 13,
          route: { version: 1, name: "space.issue", params: { spaceId: "missing", issueId: "issue-stale" } },
        }}
        onRouteConsumed={onRouteConsumed}
      />,
    );

    await act(async () => undefined);
    expect(screen.queryByRole("dialog", { name: "issue detail" })).not.toBeInTheDocument();
    expect(screen.getByText(/已无法访问.*协作空间/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回协作空间" })).toBeInTheDocument();
    expect(harness.toast.error).toHaveBeenCalled();
    expect(onRouteConsumed).toHaveBeenCalledWith(13);
  });

  it("retains the route when switching Space fails transiently", async () => {
    harness.actions.switchSpace.mockRejectedValueOnce({
      code: "SPACE_TRANSPORT_FAILED",
      message: "Network unavailable",
      retryable: true,
    });
    const onRouteConsumed = vi.fn();
    render(
      <Space
        isActive
        pendingRoute={{
          generation: 14,
          route: { version: 1, name: "space.issue", params: { spaceId: "offline", issueId: "issue-retry" } },
        }}
        onRouteConsumed={onRouteConsumed}
      />,
    );

    await act(async () => undefined);
    expect(harness.toast.error).toHaveBeenCalled();
    expect(onRouteConsumed).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "issue detail" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(async () => undefined);
    expect(harness.actions.switchSpace).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog", { name: "issue detail" }))
      .toHaveAttribute("data-issue-id", "issue-retry");
    expect(onRouteConsumed).toHaveBeenCalledWith(14);
  });

  it("reloads Issues and resets the status when the active data scope changes", async () => {
    const view = render(<Space isActive />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(harness.actions.refreshIssues).toHaveBeenCalledTimes(1);
    expect(harness.actions.refreshGoals).toHaveBeenCalledTimes(1);
    expect(harness.actions.refreshIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "open,todo,doing" }),
      expect.any(Object),
    );
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("doing");

    harness.data = snapshot("myagents");
    view.rerender(<Space isActive />);

    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");
    expect(
      screen.getByRole("status", { name: "remembered issue status" }),
    ).toHaveTextContent("open,todo,doing");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(harness.actions.refreshIssues).toHaveBeenCalledTimes(2);
    expect(harness.actions.refreshGoals).toHaveBeenCalledTimes(2);
  });

  it("commits the target tab before Space persistence finishes", async () => {
    const switching = deferred<void>();
    harness.actions.switchSpace.mockReturnValueOnce(switching.promise);
    render(<Space isActive />);

    fireEvent.click(screen.getByRole("button", { name: "show team skills" }));

    expect(harness.actions.switchSpace).toHaveBeenCalledWith("team", undefined);
    expect(screen.getByRole("main")).toHaveTextContent("skills");

    await act(async () => {
      switching.resolve();
      await switching.promise;
    });
  });

  it("resets the Issue status to incomplete when entering another Space", () => {
    const view = render(<Space isActive />);

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("doing");

    fireEvent.click(screen.getByRole("button", { name: "show team issues" }));

    expect(harness.actions.switchSpace).toHaveBeenCalledWith("team", undefined);
    harness.data = snapshot("team");
    view.rerender(<Space isActive />);
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");
  });

  it("remembers the right-hand status behind All but resets after leaving Issues", () => {
    harness.data = snapshot("ma", undefined, "admin");
    render(<Space isActive />);

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    fireEvent.click(screen.getByRole("button", { name: "open issue detail" }));
    fireEvent.click(screen.getByRole("button", { name: "close issue detail" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("doing");
    fireEvent.click(screen.getByRole("button", { name: "set all" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("all");
    expect(
      screen.getByRole("status", { name: "remembered issue status" }),
    ).toHaveTextContent("doing");

    fireEvent.click(
      screen.getByRole("button", { name: "restore remembered status" }),
    );
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("doing");

    fireEvent.click(screen.getByRole("button", { name: "show skills" }));
    fireEvent.click(screen.getByRole("button", { name: "show issues" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");
    expect(
      screen.getByRole("status", { name: "remembered issue status" }),
    ).toHaveTextContent("open,todo,doing");

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    fireEvent.click(screen.getByRole("button", { name: "show goals" }));
    fireEvent.click(
      screen.getByRole("button", { name: "open issues from goal" }),
    );
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    fireEvent.click(screen.getByRole("button", { name: "show settings" }));
    fireEvent.click(screen.getByRole("button", { name: "exit settings" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");
  });

  it("resets when the Space page deactivates or Settings becomes inaccessible", () => {
    harness.data = snapshot("ma", undefined, "admin");
    const view = render(<Space isActive />);

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    view.rerender(<Space isActive={false} />);
    view.rerender(<Space isActive />);
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    fireEvent.click(screen.getByRole("button", { name: "show settings" }));
    harness.data = snapshot("ma", undefined, "member");
    view.rerender(<Space isActive />);
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");
  });

  it("completes an explicit forget-account operation without a background delay", async () => {
    const remoteLogout = deferred<void>();
    harness.actions.logout.mockReturnValueOnce(remoteLogout.promise);
    harness.data = { ...snapshot("ma"), boot: "reauthRequired", session: null,
      reauthAccount: sessionFor("id-ma", "ma") };
    render(<Space isActive />);
    fireEvent.click(screen.getByRole("button", { name: "forget account" }));
    expect(harness.actions.logout).toHaveBeenCalledTimes(1);
    await act(async () => { remoteLogout.resolve(); await remoteLogout.promise; });
    expect(harness.toast.success).toHaveBeenCalledTimes(1);
  });

  it("reports an explicit forget-account failure immediately", async () => {
    harness.actions.logout.mockRejectedValueOnce(new Error("remote unavailable"));
    harness.data = { ...snapshot("ma"), boot: "reauthRequired", session: null,
      reauthAccount: sessionFor("id-ma", "ma") };
    render(<Space isActive />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "forget account" }));
    });
    expect(harness.actions.logout).toHaveBeenCalledTimes(1);
    expect(harness.toast.error).toHaveBeenCalledTimes(1);
  });

  it("reloads the selected non-Issue workspace for the new Space", async () => {
    const view = render(<Space isActive />);
    fireEvent.click(screen.getByRole("button", { name: "show skills" }));

    expect(harness.actions.refreshSkills).toHaveBeenCalledTimes(1);

    harness.data = snapshot("myagents");
    view.rerender(<Space isActive />);

    expect(harness.actions.refreshSkills).toHaveBeenCalledTimes(2);
  });

  it("reloads the same Space slug when the service origin changes", async () => {
    harness.data = snapshot("official", "https://space.myagents.test");
    const view = render(<Space isActive />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(harness.actions.refreshIssues).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));

    harness.data = snapshot("official", "https://space-dev.myagents.test");
    view.rerender(<Space isActive />);

    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(harness.actions.refreshIssues).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
