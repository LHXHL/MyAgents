import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { defaultWorkspacePath: null as string | null, agents: [] },
  projects: [] as Array<Record<string, unknown>>,
  taskData: {
    sessions: [] as Array<Record<string, unknown>>,
    isSessionsLoading: false,
    error: null as string | null,
    sessionTagsMap: new Map(),
    workspaceSessionStates: new Map<string, { isLoading: boolean; error: string | null }>(),
    protectedSchedulerSessionIds: new Set(),
    refresh: vi.fn(),
    actions: {
      deleteSession: vi.fn(async () => true),
      setSessionFavorite: vi.fn(async () => true),
    },
  },
  addProject: vi.fn(),
  removeProject: vi.fn(),
  patchProject: vi.fn(),
  touchProject: vi.fn(),
  refreshConfig: vi.fn(),
  configError: null as string | null,
  forcedRail: true,
  isTauri: false,
}));

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    config: mocks.config,
    projects: mocks.projects,
    isLoading: false,
    error: mocks.configError,
    addProject: mocks.addProject,
    removeProject: mocks.removeProject,
    patchProject: mocks.patchProject,
    touchProject: mocks.touchProject,
    refreshConfig: mocks.refreshConfig,
  }),
}));

vi.mock('@/hooks/useTaskCenterData', () => ({
  useGlobalSidebarTaskCenterData: () => mocks.taskData,
}));

vi.mock('@/hooks/taskCenterStore', () => ({ ensureWorkspaceSessions: vi.fn() }));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({ openPathExternal: vi.fn() }),
}));

vi.mock('@/utils/browserMock', () => ({
  isBrowserDevMode: () => false,
  isTauriEnvironment: () => mocks.isTauri,
  pickFolderForDialog: vi.fn(),
}));

vi.mock('@/components/TaskCenterOverlay', () => ({
  default: ({ initialMode }: { initialMode?: string }) => (
    <div data-testid="task-center-overlay" data-initial-mode={initialMode} />
  ),
}));

vi.mock('@/components/FeedbackPopover', () => ({ default: () => null }));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

import { i18n } from '@/i18n';
import type { Tab } from '@/types/tab';
import { GLOBAL_SIDEBAR_PREFERENCE_KEY } from '@/utils/globalSidebarPreference';
import GlobalSidebar from './GlobalSidebar';

const launcherTab: Tab = {
  id: 'launcher-tab',
  agentDir: null,
  sessionId: null,
  view: 'launcher',
  title: 'Launcher',
  sidecarConfigDisposition: 'push',
};

type SidebarProps = ComponentProps<typeof GlobalSidebar>;

function renderSidebar(overrides: Partial<SidebarProps> = {}) {
  return render(
    <GlobalSidebar
      tabs={[launcherTab]}
      activeTab={launcherTab}
      activeWorkspacePath={null}
      onNewTab={vi.fn()}
      onOpenTaskCenter={vi.fn()}
      onOpenSpace={vi.fn()}
      onOpenCapabilities={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenBugReport={vi.fn()}
      onOpenWorkspace={vi.fn(async () => true)}
      onOpenSession={vi.fn(async () => true)}
      {...overrides}
    />,
  );
}

describe('GlobalSidebar rail flyout', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.projects.length = 0;
    mocks.taskData.sessions.length = 0;
    mocks.taskData.sessionTagsMap.clear();
    mocks.taskData.workspaceSessionStates.clear();
    mocks.config.defaultWorkspacePath = null;
    mocks.configError = null;
    mocks.forcedRail = true;
    mocks.isTauri = false;
    mocks.touchProject.mockResolvedValue(undefined);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: mocks.forcedRail,
        media: '(max-width: 1080px)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    await i18n.changeLanguage('zh-CN');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens idempotently on click even after the hover delay has elapsed', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });

    fireEvent.pointerEnter(trigger);
    act(() => vi.advanceTimersByTime(125));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('opens immediately from keyboard focus', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });

    fireEvent.focus(trigger);

    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('closes after a workspace navigation succeeds', async () => {
    const onOpenWorkspace = vi.fn(async () => true);
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar({ onOpenWorkspace });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.newChatHere')) }));
    });

    await vi.waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
  });

  it('closes on Escape from the rail trigger and restores trigger focus', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.click(trigger);
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes after the pointer leaves an otherwise idle flyout', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.click(trigger);
    const region = screen.getByRole('region', { name: 'Agent 工作区' });

    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(219));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
  });

  it('reserves tooltips for non-workspace rail actions', () => {
    renderSidebar();

    expect(screen.queryByRole('tooltip', { name: 'Agent 工作区' })).not.toBeInTheDocument();
    expect(screen.getByRole('tooltip', { name: '任务' })).toBeInTheDocument();
  });

  it('keeps one fixed toggle across manual rail/expanded and leaves forced rail branded but stable', () => {
    mocks.forcedRail = false;
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: [],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    const first = renderSidebar();
    const navigation = screen.getByRole('complementary', { name: String(i18n.t('app:globalSidebar.navigation')) });
    expect(navigation).toHaveAttribute('data-global-sidebar-mode', 'rail');
    expect(navigation).toHaveAttribute('data-global-sidebar-tabbar-toggle', 'true');
    const brandIcon = navigation.querySelector('[data-global-sidebar-brand-icon]');
    const brandRow = navigation.querySelector('[data-global-sidebar-brand-row]');
    const primaryNav = navigation.querySelector('[data-global-sidebar-primary-nav]');
    const workspaceRail = navigation.querySelector('[data-global-sidebar-workspace-rail]');
    const footerActions = navigation.querySelector('[data-global-sidebar-footer-actions]');
    expect(brandIcon).not.toBeNull();
    expect(brandRow).toHaveClass('global-sidebar-brand-row');
    expect(primaryNav).toHaveClass('global-sidebar-rail-stack');
    expect(primaryNav).not.toHaveClass('items-center', 'px-2', 'border-t', 'space-y-1');
    expect(workspaceRail).toHaveClass('global-sidebar-rail-stack');
    expect(workspaceRail).not.toHaveClass('items-center', 'px-2');
    expect(footerActions).toHaveClass('global-sidebar-rail-stack');
    expect(footerActions).not.toHaveClass('items-center', 'px-2');
    const expand = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.expand')) });
    expect(expand).toHaveAttribute('data-global-sidebar-toggle');
    expect(expand.className).toContain('left-[var(--global-sidebar-toggle-left)]');
    fireEvent.click(expand);
    const collapse = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.collapse')) });
    expect(collapse).toBe(expand);
    expect(collapse.className).toContain('left-[var(--global-sidebar-toggle-left)]');
    expect(navigation).toHaveAttribute('data-global-sidebar-mode', 'expanded');
    expect(navigation).toHaveAttribute('data-global-sidebar-tabbar-toggle', 'false');
    expect(navigation.querySelector('[data-global-sidebar-brand-icon]')).toBe(brandIcon);
    expect(navigation.querySelector('[data-global-sidebar-brand-row]')).toBe(brandRow);
    expect(navigation.querySelector('[data-global-sidebar-primary-nav]')).not.toHaveClass('global-sidebar-rail-stack');
    expect(navigation.querySelector('[data-global-sidebar-workspace-rail]')).not.toBeInTheDocument();
    expect(navigation.querySelector('[data-global-sidebar-footer-actions]')).not.toHaveClass('global-sidebar-rail-stack');
    expect(screen.getByText('MyAgents')).toBeInTheDocument();
    first.unmount();

    mocks.forcedRail = true;
    renderSidebar();
    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.expand')) })).not.toBeInTheDocument();
    expect(screen.getByAltText('MyAgents')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: String(i18n.t('app:globalSidebar.navigation')) }))
      .toHaveAttribute('data-global-sidebar-toggle-visible', 'false');
  });

  it('opens the global search overlay directly in search mode', async () => {
    mocks.isTauri = true;
    renderSidebar();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.search')) }));
      await Promise.resolve();
    });

    const overlay = screen.getByTestId('task-center-overlay');
    expect(overlay).toHaveAttribute('data-initial-mode', 'search');
  });

  it('keeps archived workspaces reachable when there are no active workspaces', () => {
    mocks.projects.push({
      id: 'archived-1',
      name: 'Archived project',
      path: '/work/archived',
      archivedAt: '2026-07-20T00:00:00.000Z',
    });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const archived = screen.getByRole('button', { name: /已归档/ });
    expect(archived).toBeInTheDocument();
    fireEvent.click(archived);
    expect(screen.getByText('Archived project')).toBeInTheDocument();
  });

  it('keeps the flyout alive while a menu-launched confirmation owns focus', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    const moreButton = screen.getByTitle(String(i18n.t('launcher:workspaceCard.more')));
    fireEvent.click(moreButton);
    fireEvent.click(screen.getByText(String(i18n.t('launcher:workspaceCard.remove'))));

    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(220));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    expect(moreButton).toHaveFocus();
  });

  it('returns focus to a nested menu anchor when Escape dismisses the portal', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    const moreButton = screen.getByTitle(String(i18n.t('launcher:workspaceCard.more')));
    fireEvent.click(moreButton);
    const pinItem = screen.getByText(String(i18n.t('launcher:workspaceCard.pin')));
    pinItem.focus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(moreButton).toHaveFocus();
    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(220));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('pages 11 sessions as 5 → 10 → 11, exposes every tag, and leaves no icon spacer for a closed session', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    for (let index = 1; index <= 11; index += 1) {
      mocks.taskData.sessions.push({
        id: `session-${index}`,
        agentDir: '/work/project-one',
        title: `Session ${index}`,
        createdAt: `2026-07-${String(index).padStart(2, '0')}T00:00:00.000Z`,
        lastActiveAt: `2026-07-${String(12 - index).padStart(2, '0')}T00:00:00.000Z`,
      });
    }
    mocks.taskData.workspaceSessionStates.set('/work/project-one', { isLoading: false, error: null });
    mocks.taskData.sessionTagsMap.set('session-1', [
      { type: 'im', platform: 'Telegram' },
      { type: 'cron' },
    ]);

    renderSidebar({ activeWorkspacePath: '/work/project-one' });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const workspaceRow = screen.getByText('Project one').closest('[data-global-sidebar-workspace-row]');
    expect(workspaceRow).toHaveClass('bg-[var(--hover-bg)]');
    expect(workspaceRow).not.toHaveClass('bg-[var(--paper-elevated)]', 'shadow-sm');
    const firstSession = screen.getByRole('button', { name: /Session 1/ });
    expect(firstSession.className).toContain('focus-visible:ring-2');
    expect(firstSession.firstElementChild?.textContent).toBe('Session 1');
    expect(firstSession).toHaveTextContent('Telegram');
    expect(firstSession).toHaveTextContent(String(i18n.t('app:sessionTags.cron')));
    const firstSessionRow = firstSession.closest('[data-global-sidebar-session-row]');
    expect(firstSession).toHaveClass('w-full');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-date]')).toHaveClass('ml-auto');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-action-overlay]')).toHaveClass('absolute');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-action-overlay]')).toHaveClass('pointer-events-none');
    const sessionDate = firstSessionRow?.querySelector('[data-global-sidebar-session-date]');
    const sessionMore = firstSessionRow?.querySelector('[data-global-sidebar-session-action-overlay] button');
    expect(sessionDate).not.toHaveClass('opacity-0');
    fireEvent.click(sessionMore!);
    expect(sessionDate).toHaveClass('opacity-0');
    fireEvent.click(sessionMore!);
    expect(screen.queryByText('Session 6')).not.toBeInTheDocument();
    expect(screen.queryByText('Session 11')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.loadMore')) }));
    expect(screen.getByText('Session 10')).toBeInTheDocument();
    expect(screen.queryByText('Session 11')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.loadMore')) }));
    expect(screen.getByText('Session 11')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.loadMore')) })).not.toBeInTheDocument();
  });

  it('keeps one workspace failure local while another workspace remains usable', () => {
    mocks.projects.push(
      { id: 'project-a', name: 'Project A', path: '/work/a' },
      { id: 'project-b', name: 'Project B', path: '/work/b' },
    );
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/a', '/work/b'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    mocks.taskData.sessions.push({
      id: 'session-b',
      agentDir: '/work/b',
      title: 'Healthy session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    mocks.taskData.workspaceSessionStates.set('/work/a', { isLoading: false, error: 'A failed' });
    mocks.taskData.workspaceSessionStates.set('/work/b', { isLoading: false, error: null });

    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    expect(screen.getByText('A failed')).toBeInTheDocument();
    expect(screen.getByText('Healthy session')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: String(i18n.t('launcher:rightRail.retry')) })).toHaveLength(1);
  });

  it('shows config loading failures with an explicit retry action', () => {
    mocks.configError = 'config unavailable';
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    expect(screen.getByText('config unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.retry')) }));
    expect(mocks.refreshConfig).toHaveBeenCalled();
  });
});
