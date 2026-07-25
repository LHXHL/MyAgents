import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../shared/config-types';
import { CUSTOM_EVENTS } from '../shared/constants';

const mocks = vi.hoisted(() => {
  const project = {
    id: 'helper-project',
    path: '/Users/me/.myagents',
    displayName: 'MA Helper',
    agentId: 'helper-agent',
  };
  const agent = {
    id: 'helper-agent',
    name: 'MA Helper',
    workspacePath: project.path,
    runtime: 'builtin',
    permissionMode: 'auto',
    reasoningEffort: undefined as string | undefined,
    runtimeConfig: undefined as { permissionMode?: string; reasoningEffort?: string } | undefined,
  };
  const provider = {
    id: 'provider-1',
    name: 'Provider',
    type: 'openai-compatible',
    baseUrl: 'https://example.com',
    primaryModel: 'mimo-v2.5-pro',
    models: [{ id: 'mimo-v2.5-pro', name: 'mimo-v2.5-pro' }],
  };

  return {
    project,
    agent,
    provider,
    multiAgentRuntime: false,
    resolveBuiltinSelection: vi.fn(() => ({ provider, model: 'mimo-v2.5-pro' })),
    createSession: vi.fn(async () => ({
      id: 'prepared-managed-session',
      agentDir: project.path,
      title: 'Prepared',
      createdAt: '2026-06-27T00:00:00.000Z',
      lastActiveAt: '2026-06-27T00:00:00.000Z',
    })),
    deleteSession: vi.fn(async () => true),
    startGlobalSidecar: vi.fn(async () => undefined),
    initGlobalSidecarReadyPromise: vi.fn(),
    markGlobalSidecarReady: vi.fn(),
    getGlobalServerUrl: vi.fn(async () => 'http://127.0.0.1:31415'),
    ensureSessionSidecar: vi.fn(async () => ({ port: 31417, isNew: true })),
    activateSession: vi.fn(async () => undefined),
    getSessionActivation: vi.fn(async () => null as { tab_id: string | null; task_id: string | null } | null),
    updateSessionTab: vi.fn(async () => undefined),
    cancelBackgroundCompletion: vi.fn(async () => undefined),
    releaseTabSession: vi.fn(async () => false),
    getSessionPort: vi.fn(async () => null),
    hasSessionSidecar: vi.fn(async () => true),
    startBackgroundCompletion: vi.fn(async () => ({ started: false })),
    setAppActiveCorrelation: vi.fn(),
    setAppActiveTabId: vi.fn(),
    track: vi.fn(),
    chatProps: [] as Array<Record<string, unknown>>,
    launcherProps: [] as Array<Record<string, unknown>>,
    sidebarProps: [] as Array<Record<string, unknown>>,
    tabbarProps: [] as Array<Record<string, unknown>>,
    settingsProps: [] as Array<Record<string, unknown>>,
  };
});

vi.mock('@/analytics', () => ({
  initAnalytics: vi.fn(async () => undefined),
  track: mocks.track,
  setAnalyticsContext: vi.fn(),
  clearAnalyticsContext: vi.fn(),
  setPendingSurface: vi.fn(),
  clearPendingSurface: vi.fn(),
  setPendingSessionBirth: vi.fn(),
  clearPendingSessionBirth: vi.fn(),
  birthContextForSurface: vi.fn((surface: string) => ({
    surface,
    entryIntent: surface === 'new_chat_button' ? 'new_chat' : 'unknown',
    hasInitialMessage: surface !== 'new_chat_button',
  })),
  hashAgentName: vi.fn(async () => 'agent-hash'),
  hashAgentNameSync: vi.fn(() => 'agent-hash'),
}));

vi.mock('@/api/tauriClient', () => ({
  stopTabSidecar: vi.fn(async () => undefined),
  setAppActiveCorrelation: mocks.setAppActiveCorrelation,
  startGlobalSidecar: mocks.startGlobalSidecar,
  initGlobalSidecarReadyPromise: mocks.initGlobalSidecarReadyPromise,
  markGlobalSidecarReady: mocks.markGlobalSidecarReady,
  getGlobalServerUrl: mocks.getGlobalServerUrl,
  getSessionActivation: mocks.getSessionActivation,
  updateSessionTab: mocks.updateSessionTab,
  ensureSessionSidecar: mocks.ensureSessionSidecar,
  releaseTabSession: mocks.releaseTabSession,
  activateSession: mocks.activateSession,
  upgradeSessionId: vi.fn(async () => true),
  getSessionPort: mocks.getSessionPort,
  hasSessionSidecar: mocks.hasSessionSidecar,
  getSessionGeneration: vi.fn(async () => 1),
  stopSseProxy: vi.fn(async () => undefined),
  startBackgroundCompletion: mocks.startBackgroundCompletion,
  cancelBackgroundCompletion: mocks.cancelBackgroundCompletion,
  updateGlobalServerUrl: vi.fn(),
  canRestoreSession: vi.fn(async () => true),
  getUserSchedulerLifecycleSnapshot: vi.fn(async () => ({ runningTaskCount: 0, protectedSessionIds: [] })),
  sessionHasPersistentOwners: vi.fn(async () => false),
}));

vi.mock('@/api/apiFetch', () => ({
  apiGetJson: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/api/cronTaskClient', () => ({
  getAllCronTasks: vi.fn(async () => []),
  getTabCronTask: vi.fn(async () => null),
  updateCronTaskTab: vi.fn(async () => undefined),
}));

vi.mock('@/api/sessionClient', () => ({
  createSession: mocks.createSession,
  deleteSession: mocks.deleteSession,
  getSessions: vi.fn(async () => []),
  updateSession: vi.fn(async () => undefined),
}));

vi.mock('@/components/ChatBootOverlay', () => ({
  default: () => <div data-testid="chat-boot-overlay" />,
}));

vi.mock('@/components/ConfirmDialog', () => ({
  default: () => <div data-testid="confirm-dialog" />,
}));

vi.mock('@/components/BugReportOverlay', () => ({
  default: () => <div data-testid="bug-report-overlay" />,
}));

vi.mock('@/components/CustomTitleBar', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="titlebar">{children}</div>,
}));

vi.mock('@/components/global-sidebar/GlobalSidebar', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.sidebarProps.push(props);
    return <aside data-testid="global-sidebar" />;
  },
}));

vi.mock('@/components/LinkContextMenuProvider', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/TabBar', () => ({
  default: (props: { tabs: Array<{ id: string; title: string; sessionId?: string | null; view?: string; sidecarConfigDisposition?: string }>; activeTabId: string | null; onCloseTab: (tabId: string) => Promise<void> }) => {
    mocks.tabbarProps.push(props);
    return <div data-testid="tabbar-active">{props.tabs.find(t => t.id === props.activeTabId)?.title ?? 'missing'}</div>;
  },
}));

vi.mock('@/context/TabProvider', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="tab-provider">{children}</div>,
}));

vi.mock('@/pages/Chat', () => {
  function MockChat(props: Record<string, unknown>) {
    const [streamChunks, setStreamChunks] = useState(0);
    mocks.chatProps.push(props);
    return (
      <button data-testid="chat-page" onClick={() => setStreamChunks((count) => count + 1)}>
        {streamChunks}
      </button>
    );
  }
  return { default: MockChat };
});

vi.mock('@/pages/Launcher', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.launcherProps.push(props);
    return <div data-testid="launcher-page" />;
  },
}));

vi.mock('@/pages/Settings', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.settingsProps.push(props);
    return <div data-testid="settings-page" />;
  },
}));

vi.mock('@/pages/TaskCenter', () => ({
  default: () => <div data-testid="taskcenter-page" />,
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock('@/hooks/useUpdater', () => ({
  useUpdater: () => ({
    updateReady: false,
    updateVersion: null,
    updateChecking: false,
    updateDownloading: false,
    updateInstalling: false,
    updatePreparing: false,
    pendingUpdateOnStartup: null,
    dismissPendingUpdate: vi.fn(),
    checkForUpdate: vi.fn(async () => 'up-to-date'),
    restartAndUpdate: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTrayEvents', () => ({
  useTrayEvents: vi.fn(),
}));

vi.mock('@/hooks/useHelperAgentModelDefaults', () => ({
  useHelperAgentModelDefaults: () => ({
    providerId: mocks.provider.id,
    model: 'mimo-v2.5-pro',
    setDefaults: vi.fn(),
  }),
}));

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    config: {
      projects: [mocks.project],
      agents: [mocks.agent],
      multiAgentRuntime: mocks.multiAgentRuntime,
      defaultPermissionMode: 'auto',
      teamSpaceEnabled: true,
    },
    isLoading: false,
    error: null,
    projects: [mocks.project],
    providers: [mocks.provider],
    apiKeys: { [mocks.provider.id]: 'key' },
    providerVerifyStatus: { [mocks.provider.id]: { status: 'valid' } },
    addProject: vi.fn(async () => mocks.project),
    updateProject: vi.fn(async () => undefined),
    patchProject: vi.fn(async () => undefined),
    removeProject: vi.fn(async () => undefined),
    touchProject: vi.fn(async () => undefined),
    addCustomProvider: vi.fn(async () => undefined),
    updateCustomProvider: vi.fn(async () => undefined),
    deleteCustomProvider: vi.fn(async () => undefined),
    refreshProviders: vi.fn(async () => undefined),
    savePresetCustomModels: vi.fn(async () => undefined),
    removePresetCustomModel: vi.fn(async () => undefined),
    savePrimaryModel: vi.fn(async () => undefined),
    saveProviderModelAliases: vi.fn(async () => undefined),
    saveApiKey: vi.fn(async () => undefined),
    deleteApiKey: vi.fn(async () => undefined),
    saveProviderVerifyStatus: vi.fn(async () => undefined),
    updateConfig: vi.fn(async () => undefined),
    patchProxySettings: vi.fn(async () => undefined),
    refreshConfig: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    refreshProviderData: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/hooks/useTabSwipeGesture', () => ({
  useTabSwipeGesture: vi.fn(),
}));

vi.mock('@/hooks/useSpaceBuildCapability', () => ({
  useSpaceBuildCapability: () => ({ isLoading: false, available: true, reason: null }),
}));

vi.mock('@/utils/browserMock', () => ({
  isBrowserDevMode: () => false,
  isTauriEnvironment: () => false,
}));

vi.mock('@/utils/frontendLogger', () => ({
  forceFlushLogs: vi.fn(async () => undefined),
  setLogServerUrl: vi.fn(),
  clearLogServerUrl: vi.fn(),
  setAppActiveTabId: mocks.setAppActiveTabId,
}));

vi.mock('@/utils/lastExitMarker', () => ({
  consumeCleanExitMarker: vi.fn(async () => true),
}));

vi.mock('@/utils/tabPersistenceDurable', () => ({
  persistOpenTabsDurable: vi.fn(async () => undefined),
  loadAndClearOpenTabsDurable: vi.fn(async () => null),
  clearOpenTabsDurable: vi.fn(async () => undefined),
}));

vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: vi.fn(async () => undefined),
}));

vi.mock('@/config/configService', () => ({
  ensureSelfAwarenessWorkspace: vi.fn(async () => mocks.project),
  resolveBuiltinSelection: mocks.resolveBuiltinSelection,
  pairBuiltinSelection: vi.fn((_provider, model) => ({ providerId: mocks.provider.id, model })),
  isProviderAvailable: vi.fn(() => true),
}));

vi.mock('@/config/services/agentConfigService', () => ({
  getAgentByWorkspacePath: vi.fn(() => mocks.agent),
  getAgentById: vi.fn(() => mocks.agent),
}));

import App from './App';

describe('App helper launch', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.chatProps.length = 0;
    mocks.launcherProps.length = 0;
    mocks.sidebarProps.length = 0;
    mocks.tabbarProps.length = 0;
    mocks.settingsProps.length = 0;
    mocks.agent.runtime = 'builtin';
    mocks.agent.permissionMode = 'auto';
    mocks.agent.reasoningEffort = undefined;
    mocks.agent.runtimeConfig = undefined;
    mocks.multiAgentRuntime = false;
    mocks.hasSessionSidecar.mockResolvedValue(true);
    mocks.ensureSessionSidecar.mockResolvedValue({ port: 31417, isNew: true });
    mocks.activateSession.mockResolvedValue(undefined);
    mocks.getSessionActivation.mockResolvedValue(null);
    mocks.updateSessionTab.mockResolvedValue(undefined);
    mocks.cancelBackgroundCompletion.mockResolvedValue(undefined);
    mocks.resolveBuiltinSelection.mockReturnValue({ provider: mocks.provider, model: 'mimo-v2.5-pro' });
  });

  function managedCodexProvider() {
    return {
      ...mocks.provider,
      id: CODEX_SUBSCRIPTION_PROVIDER_ID,
      name: 'Codex Subscription',
      type: 'subscription',
      baseUrl: '',
      execution: { kind: 'runtime-backed' as const, runtime: 'codex' as const, source: 'managed-provider' as const },
      primaryModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
    };
  }

  function latestLauncherProps() {
    const props = mocks.launcherProps.at(-1);
    if (!props) throw new Error('Launcher props were not captured');
    return props as {
      onLaunchProject: (
        project: typeof mocks.project,
        sessionId?: string,
        initialMessage?: unknown,
        analyticsContext?: unknown,
        sessionBirthHint?: unknown,
      ) => void;
    };
  }

  function latestSidebarProps() {
    const props = mocks.sidebarProps.at(-1);
    if (!props) throw new Error('GlobalSidebar props were not captured');
    return props as {
      onOpenCapabilities: () => void;
      onOpenSettings: () => void;
      onOpenTaskCenter: () => void;
      onOpenSpace: () => void;
      onOpenWorkspace: (
        project: typeof mocks.project,
        initialMessage?: unknown,
        entryIntent?: 'open_workspace' | 'workspace_init',
      ) => Promise<boolean>;
      onOpenSession: (session: { id: string; agentDir: string; title: string }, project: typeof mocks.project) => Promise<boolean>;
    };
  }

  function latestSettingsProps() {
    const props = [...mocks.settingsProps]
      .reverse()
      .find((candidate) => candidate.mode === 'capabilities');
    if (!props) throw new Error('Capabilities Settings props were not captured');
    return props;
  }

  it('prepares a managed Codex provider session when opening an empty Launcher workspace', async () => {
    mocks.agent.runtimeConfig = {
      permissionMode: 'suggest',
      reasoningEffort: 'xhigh',
    };
    mocks.resolveBuiltinSelection.mockReturnValue({
      provider: managedCodexProvider(),
      model: 'gpt-5.5',
    });

    render(<App />);

    await act(async () => {
      latestLauncherProps().onLaunchProject(mocks.project);
    });

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith(
        mocks.project.path,
        'codex',
        expect.objectContaining({
          runtimeSource: 'managed-provider',
          providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
          model: 'gpt-5.5',
          permissionMode: 'suggest',
          reasoningEffort: 'xhigh',
          providerExecutionIdentity: expect.objectContaining({
            kind: 'runtime-backed-provider',
            providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
            runtime: 'codex',
            runtimeSource: 'managed-provider',
            model: 'gpt-5.5',
          }),
          prepareForFirstUserMessage: true,
          materializationSourceSessionId: expect.stringMatching(/^pending-/),
        }),
      );
    });
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      'prepared-managed-session',
      mocks.project.path,
      'tab',
      expect.stringMatching(/^tab-/),
    );
  });

  it('uses a Launcher birth hint before stale config when opening an empty workspace', async () => {
    const providerExecutionIdentity = {
      kind: 'runtime-backed-provider' as const,
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex' as const,
      runtimeSource: 'managed-provider' as const,
      model: 'gpt-5.5',
    };

    render(<App />);

    await act(async () => {
      latestLauncherProps().onLaunchProject(
        mocks.project,
        undefined,
        undefined,
        { surface: 'agent_card', entryIntent: 'open_workspace' },
        {
          providerExecutionIdentity,
          permissionMode: 'fullAgency',
          reasoningEffort: 'xhigh',
          mcpEnabledServers: ['filesystem'],
          enabledPluginIds: ['plugin-a'],
        },
      );
    });

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith(
        mocks.project.path,
        'codex',
        expect.objectContaining({
          runtimeSource: 'managed-provider',
          providerExecutionIdentity,
          providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
          model: 'gpt-5.5',
          permissionMode: 'no-restrictions',
          reasoningEffort: 'xhigh',
          mcpEnabledServers: ['filesystem'],
          enabledPluginIds: ['plugin-a'],
          prepareForFirstUserMessage: true,
          materializationSourceSessionId: expect.stringMatching(/^pending-/),
        }),
      );
    });
  });

  it('opens a sidebar Session from a no-workspace functional Tab and revives the same Tab if its Sidecar died', async () => {
    render(<App />);
    act(() => latestSidebarProps().onOpenCapabilities());
    await waitFor(() => {
      expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2);
    });

    const session = {
      id: 'sidebar-session',
      agentDir: mocks.project.path,
      title: 'Sidebar history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    await act(async () => {
      await latestSidebarProps().onOpenSession(session, mocks.project);
    });
    await waitFor(() => {
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        session.id,
        mocks.project.path,
        'tab',
        expect.stringMatching(/^tab-/),
      );
      expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3);
    });
    const sessionTab = (mocks.tabbarProps.at(-1)?.tabs as Array<{ id: string; sessionId?: string }>).find(
      (tab) => tab.sessionId === session.id,
    );
    expect(sessionTab).toBeTruthy();

    mocks.hasSessionSidecar.mockResolvedValueOnce(false);
    await act(async () => {
      await latestSidebarProps().onOpenSession(session, mocks.project);
    });

    expect(mocks.ensureSessionSidecar).toHaveBeenLastCalledWith(
      session.id,
      mocks.project.path,
      'tab',
      sessionTab?.id,
    );
    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3);

    await act(async () => {
      await (mocks.tabbarProps.at(-1)?.onCloseTab as (tabId: string) => Promise<void>)(sessionTab!.id);
    });
    expect(mocks.releaseTabSession).toHaveBeenCalledWith(session.id, sessionTab!.id);
    expect(mocks.deleteSession).not.toHaveBeenCalled();
    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2);
    await waitFor(() => {
      expect(mocks.track).toHaveBeenCalledWith('history_open', expect.objectContaining({
        session_id: session.id,
        entry_source: 'global_sidebar',
      }));
    });
  });

  it('activates a new sidebar Session tab before its Sidecar is ready', async () => {
    let resolveEnsure!: (result: { port: number; isNew: boolean }) => void;
    mocks.ensureSessionSidecar.mockReturnValueOnce(new Promise((resolve) => {
      resolveEnsure = resolve;
    }));
    const session = {
      id: 'slow-sidebar-session',
      agentDir: mocks.project.path,
      title: 'Slow sidebar history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    render(<App />);

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = latestSidebarProps().onOpenSession(session, mocks.project);
    });

    await waitFor(() => {
      expect(screen.getByTestId('tabbar-active')).toHaveTextContent('Slow sidebar history');
      expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2);
    });
    const pendingTab = (mocks.tabbarProps.at(-1)?.tabs as Array<{
      sessionId?: string;
      sidecarConfigDisposition?: string;
    }>).find((tab) => tab.sessionId === session.id);
    expect(pendingTab?.sidecarConfigDisposition).toBe('pending');
    expect(screen.getByTestId('tab-provider')).toBeInTheDocument();
    expect(screen.getByTestId('chat-page')).toBeInTheDocument();
    expect(mocks.activateSession).not.toHaveBeenCalled();

    await act(async () => {
      resolveEnsure({ port: 31417, isNew: true });
      await openPromise;
    });
    expect(mocks.activateSession).toHaveBeenCalledWith(
      session.id,
      expect.stringMatching(/^tab-/),
      null,
      31417,
      mocks.project.path,
      false,
    );
    expect(screen.getByTestId('tab-provider')).toBeInTheDocument();
  });

  it('does not yank focus back when a slow sidebar Session finishes after the user switches tabs', async () => {
    let resolveEnsure!: (result: { port: number; isNew: boolean }) => void;
    mocks.ensureSessionSidecar.mockReturnValueOnce(new Promise((resolve) => {
      resolveEnsure = resolve;
    }));
    const session = {
      id: 'background-ready-session',
      agentDir: mocks.project.path,
      title: 'Background ready history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    render(<App />);

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = latestSidebarProps().onOpenSession(session, mocks.project);
    });
    await waitFor(() => expect(screen.getByTestId('tabbar-active')).toHaveTextContent('Background ready history'));

    act(() => latestSidebarProps().onOpenSettings());
    await waitFor(() => {
      const latest = mocks.tabbarProps.at(-1);
      const active = (latest?.tabs as Array<{ id: string; view?: string }>).find(
        (tab) => tab.id === latest?.activeTabId,
      );
      expect(active?.view).toBe('settings');
    });

    await act(async () => {
      resolveEnsure({ port: 31417, isNew: false });
      await openPromise;
    });

    const latest = mocks.tabbarProps.at(-1);
    const active = (latest?.tabs as Array<{ id: string; view?: string }>).find(
      (tab) => tab.id === latest?.activeTabId,
    );
    expect(active?.view).toBe('settings');
  });

  it('preserves Task ownership after optimistic activation of a cron-owned Session', async () => {
    mocks.getSessionActivation.mockResolvedValue({ tab_id: null, task_id: 'cron-task-1' });
    const session = {
      id: 'cron-owned-session',
      agentDir: mocks.project.path,
      title: 'Cron-owned history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    render(<App />);

    let opened = false;
    await act(async () => {
      opened = await latestSidebarProps().onOpenSession(session, mocks.project);
    });

    const sessionTab = (mocks.tabbarProps.at(-1)?.tabs as Array<{ id: string; sessionId?: string }>).find(
      (tab) => tab.sessionId === session.id,
    );
    expect(opened).toBe(true);
    expect(mocks.getSessionActivation).toHaveBeenCalledWith(session.id);
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      session.id,
      mocks.project.path,
      'tab',
      sessionTab?.id,
    );
    expect(sessionTab).toBeTruthy();
    expect(mocks.updateSessionTab).toHaveBeenCalledWith(session.id, sessionTab?.id);
    expect(mocks.activateSession).not.toHaveBeenCalled();
    expect(mocks.cancelBackgroundCompletion).not.toHaveBeenCalled();
  });

  it('restores the previous active tab when an optimistic sidebar Session open fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectEnsure!: (error: Error) => void;
    mocks.ensureSessionSidecar.mockReturnValueOnce(new Promise((_, reject) => {
      rejectEnsure = reject;
    }));
    const session = {
      id: 'failed-sidebar-session',
      agentDir: mocks.project.path,
      title: 'Failed sidebar history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    render(<App />);

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = latestSidebarProps().onOpenSession(session, mocks.project);
    });
    await waitFor(() => expect(screen.getByTestId('tabbar-active')).toHaveTextContent('Failed sidebar history'));

    let opened = true;
    await act(async () => {
      rejectEnsure(new Error('ensure failed'));
      opened = await openPromise;
    });

    expect(opened).toBe(false);
    expect(screen.getByTestId('tabbar-active')).toHaveTextContent('New Tab');
    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('opens a sidebar workspace as a fresh Chat tab without replacing the functional tab', async () => {
    render(<App />);
    act(() => latestSidebarProps().onOpenCapabilities());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2));

    let opened = false;
    await act(async () => {
      opened = await latestSidebarProps().onOpenWorkspace(mocks.project);
    });

    expect(opened).toBe(true);
    await waitFor(() => {
      expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3);
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        expect.any(String),
        mocks.project.path,
        'tab',
        expect.stringMatching(/^tab-/),
      );
      expect(mocks.chatProps.length).toBeGreaterThan(0);
    });
    expect(mocks.track).toHaveBeenCalledWith('workspace_open', expect.objectContaining({
      surface: 'global_sidebar',
      entry_intent: 'open_workspace',
    }));
  });

  it('keeps Settings and Capabilities as one tab each', async () => {
    render(<App />);

    act(() => latestSidebarProps().onOpenCapabilities());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2));
    act(() => latestSidebarProps().onOpenCapabilities());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2));

    await act(async () => latestSidebarProps().onOpenSettings());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3));
    await act(async () => latestSidebarProps().onOpenSettings());

    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3);
  });

  it('keeps Task Center and Team as one tab each', async () => {
    render(<App />);

    act(() => latestSidebarProps().onOpenTaskCenter());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2));
    act(() => latestSidebarProps().onOpenTaskCenter());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2));

    act(() => latestSidebarProps().onOpenSpace());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3));
    act(() => latestSidebarProps().onOpenSpace());

    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3);
  });

  it('routes capability deep links and item targets into the singleton Capabilities tab', async () => {
    render(<App />);
    const skillTarget = { kind: 'skill' as const, folderName: 'github', scope: 'user' as const };

    act(() => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
        detail: {
          section: 'plugins',
          mcpServerId: 'mcp-one',
          officialToolId: 'image-understanding',
          selectItem: skillTarget,
        },
      }));
    });

    await waitFor(() => expect(latestSettingsProps()).toEqual(expect.objectContaining({
      mode: 'capabilities',
      initialSection: 'plugins',
      initialMcpId: 'mcp-one',
      initialOfficialToolId: 'image-understanding',
      initialSelect: skillTarget,
    })));
    const firstNonce = latestSettingsProps().navigationNonce as number;

    act(() => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
        detail: { section: 'mcp', mcpServerId: 'mcp-two' },
      }));
    });

    await waitFor(() => expect(latestSettingsProps()).toEqual(expect.objectContaining({
      mode: 'capabilities',
      initialSection: 'mcp',
      initialMcpId: 'mcp-two',
      navigationNonce: firstNonce + 1,
    })));
    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2);
  });

  it('keeps streaming-local Chat renders outside the global sidebar owner', async () => {
    render(<App />);
    await act(async () => {
      await latestSidebarProps().onOpenWorkspace(mocks.project);
    });
    await waitFor(() => expect(screen.getByTestId('chat-page')).toHaveTextContent('0'));
    const sidebarRenderCount = mocks.sidebarProps.length;

    act(() => {
      fireEvent.click(screen.getByTestId('chat-page'));
      fireEvent.click(screen.getByTestId('chat-page'));
      fireEvent.click(screen.getByTestId('chat-page'));
    });

    expect(screen.getByTestId('chat-page')).toHaveTextContent('3');
    expect(mocks.sidebarProps).toHaveLength(sidebarRenderCount);
  });

  it('keeps external-runtime empty launches on the pending-session path', async () => {
    mocks.multiAgentRuntime = true;
    mocks.agent.runtime = 'codex';
    mocks.resolveBuiltinSelection.mockReturnValue({
      provider: managedCodexProvider(),
      model: 'gpt-5.5',
    });

    render(<App />);

    await act(async () => {
      latestLauncherProps().onLaunchProject(mocks.project);
    });

    await waitFor(() => expect(mocks.ensureSessionSidecar).toHaveBeenCalled());
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      expect.stringMatching(/^pending-tab-/),
      mocks.project.path,
      'tab',
      expect.stringMatching(/^tab-/),
    );
  });

  it('commits the helper tab before launching so the active tab is renderable', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      render(<App />);

      await act(async () => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
          detail: {
            description: 'help',
            providerId: mocks.provider.id,
            model: 'mimo-v2.5-pro',
            appVersion: 'test',
            images: [],
          },
        }));
      });

      await waitFor(() => expect(mocks.ensureSessionSidecar).toHaveBeenCalled());

      const launchStart = logSpy.mock.calls
        .map(call => String(call[0]))
        .find(message => message.includes('[App][launch] START'));

      expect(launchStart).toContain('view=launcher');
      expect(launchStart).not.toContain('view=undefined');
      expect(mocks.setAppActiveTabId).toHaveBeenCalledWith(
        expect.stringMatching(/^tab-/),
        expect.arrayContaining([expect.stringMatching(/^tab-/)]),
      );
      expect(mocks.setAppActiveCorrelation).toHaveBeenCalledWith(expect.objectContaining({
        tabId: expect.stringMatching(/^tab-/),
      }));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('releases the fork tab owner when fork tab activation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      render(<App />);

      await act(async () => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
          detail: {
            description: 'help',
            providerId: mocks.provider.id,
            model: 'mimo-v2.5-pro',
            appVersion: 'test',
            images: [],
          },
        }));
      });

      await waitFor(() => {
        expect(mocks.chatProps.some((props) => typeof props.onForkSession === 'function')).toBe(true);
      });

      mocks.activateSession.mockRejectedValueOnce(new Error('activate failed'));
      const chatProps = [...mocks.chatProps]
        .reverse()
        .find((props) => typeof props.onForkSession === 'function') as {
          onForkSession: (sessionId: string, agentDir: string, title: string) => Promise<boolean>;
        };

      let opened = true;
      await act(async () => {
        opened = await chatProps.onForkSession('fork-session', mocks.project.path, 'Fork');
      });

      expect(opened).toBe(false);
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        'fork-session',
        mocks.project.path,
        'tab',
        expect.stringMatching(/^tab-/),
      );
      expect(mocks.releaseTabSession).toHaveBeenCalledWith(
        'fork-session',
        expect.stringMatching(/^tab-/),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
