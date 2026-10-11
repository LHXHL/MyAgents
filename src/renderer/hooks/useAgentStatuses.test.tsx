import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect } from 'react';

import { useAgentStatuses, type AgentStatusMap } from './useAgentStatuses';
import {
  __resetTaskCenterStoreForTest, subscribe, subscribePassive, getSnapshot,
  setSidebarWorkspaceSessionDemand, getAgentStatusesSnapshot, refresh,
} from './taskCenterStore';
import type { SessionMetadata } from '@/api/sessionClient';

const dataMocks = vi.hoisted(() => ({
  sessions: vi.fn<() => Promise<SessionMetadata[]>>(async () => []),
  cron: vi.fn(async () => []),
  listeners: new Map<string, Set<() => void>>(),
}));
vi.mock('@/api/sessionClient', () => ({ getSessions: dataMocks.sessions, deleteSession: vi.fn(), updateSession: vi.fn() }));
vi.mock('@/api/cronTaskClient', () => ({ getAllCronTasks: dataMocks.cron, getBackgroundSessions: vi.fn(async () => []) }));
vi.mock('@/api/tauriClient', () => ({ getUserSchedulerLifecycleSnapshot: vi.fn(async () => ({ deleteProtectedSessionIds: [] })) }));
vi.mock('@/config/configService', () => ({ loadAppConfig: vi.fn(async () => ({ agents: [] })) }));

vi.mock('@/utils/browserMock', () => ({
  isTauriEnvironment: () => true,
}));

vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: vi.fn(async (name: string, listener: () => void, signal: AbortSignal) => {
    const listeners = dataMocks.listeners.get(name) ?? new Set();
    dataMocks.listeners.set(name, listeners);
    listeners.add(listener);
    const unlisten = () => { listeners.delete(listener); };
    signal.addEventListener('abort', unlisten, { once: true });
    return { unlisten, isRegistered: () => listeners.has(listener) };
  }),
}));

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function status(agentName: string): AgentStatusMap {
  return {
    agent: {
      agentId: 'agent',
      agentName,
      enabled: true,
      channels: [],
    },
  };
}

function Probe() {
  const { statuses, loading, refresh } = useAgentStatuses(true);
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="name">{statuses.agent?.agentName ?? 'none'}</span>
      <button type="button" onClick={refresh}>refresh</button>
    </div>
  );
}

describe('useAgentStatuses', () => {
  beforeEach(() => {
    __resetTaskCenterStoreForTest();
    dataMocks.listeners.clear();
    invokeMock.mockReset();
    dataMocks.sessions.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    __resetTaskCenterStoreForTest();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('ignores stale slower status responses after a newer refresh resolves', async () => {
    const first = deferred<AgentStatusMap>();
    const second = deferred<AgentStatusMap>();
    invokeMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(<Probe />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('refresh'));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));

    second.resolve(status('new'));
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('new'));

    first.resolve(status('stale'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByTestId('name')).toHaveTextContent('new');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  it('shares one 5s cadence across 12 Chat subscribers without loading Task Center data', async () => {
    invokeMock.mockImplementation(async () => status('ready'));
    const counts = Array<number>(12).fill(0);
    function Counter({ index }: { index: number }) {
      useAgentStatuses();
      useLayoutEffect(() => { counts[index] += 1; });
      return null;
    }
    const view = render(<>{counts.map((_, index) => <Counter key={index} index={index} />)}</>);
    await waitFor(() => expect(getAgentStatusesSnapshot().loading).toBe(false));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(dataMocks.listeners.get('agent:status-changed')?.size).toBe(1);
    expect(dataMocks.sessions).not.toHaveBeenCalled();
    expect(dataMocks.cron).not.toHaveBeenCalled();
    counts.fill(0);
    invokeMock.mockClear();

    // Also verify the periodic lifecycle after a warm remount.
    view.unmount();
    vi.useFakeTimers();
    const next = render(<>{counts.map((_, index) => <Counter key={index} index={index} />)}</>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    counts.fill(0);
    invokeMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(counts).toEqual(Array(12).fill(0));
    next.unmount();
    expect(dataMocks.listeners.get('agent:status-changed')?.size).toBe(0);
    invokeMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('shares status events and requests with Task Center, including its 60s refresh', async () => {
    invokeMock.mockImplementation(async () => status('ready'));
    vi.useFakeTimers();
    const view = renderHook(() => useAgentStatuses());
    let stop!: () => void;
    await act(async () => {
      stop = subscribe(() => {});
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(dataMocks.listeners.get('agent:status-changed')?.size).toBe(1);
    expect(dataMocks.sessions).toHaveBeenCalled();
    invokeMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(invokeMock).toHaveBeenCalledTimes(12);
    invokeMock.mockResolvedValue(status('changed'));
    await act(async () => { for (const listener of dataMocks.listeners.get('agent:status-changed')!) listener(); });
    expect(view.result.current.statuses.agent.agentName).toBe('changed');
    act(() => stop());
    expect(dataMocks.listeners.get('agent:status-changed')?.size).toBe(1);
    view.unmount();
    expect(dataMocks.listeners.get('agent:status-changed')?.size).toBe(0);
  });

  it.each([false, true])('keeps healthy data and prevents an old mount from owning a remount (Task Center=%s)', async withTaskCenter => {
    const old = deferred<AgentStatusMap>();
    invokeMock.mockReturnValueOnce(old.promise).mockResolvedValue(status('current'));
    const first = renderHook(() => useAgentStatuses());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    let stopTaskCenter: (() => void) | undefined;
    if (withTaskCenter) {
      await act(async () => { stopTaskCenter = subscribe(() => {}); });
      expect(invokeMock).toHaveBeenCalledTimes(1);
    }
    first.unmount();
    act(() => stopTaskCenter?.());
    const second = renderHook(() => useAgentStatuses());
    await waitFor(() => expect(second.result.current.statuses.agent?.agentName).toBe('current'));
    await act(async () => old.resolve(status('stale')));
    expect(second.result.current.statuses.agent.agentName).toBe('current');
    const healthy = second.result.current.statuses;
    invokeMock.mockRejectedValueOnce(new Error('synthetic transport failure'));
    await act(async () => second.result.current.refresh());
    expect(second.result.current.statuses).toBe(healthy);
    expect(second.result.current.loading).toBe(false);
  });

  it.each(['workspace', 'search'])('finishes a shared sidebar %s read when the last Chat leaves, without passive polling', async reader => {
    const pending = deferred<AgentStatusMap>();
    invokeMock.mockReturnValue(pending.promise);
    const chat = renderHook(() => useAgentStatuses());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    dataMocks.sessions.mockResolvedValue([{
      id: 'im-session', agentDir: '/workspace', title: 'IM',
      createdAt: '2026-10-11T00:00:00Z', lastActiveAt: '2026-10-11T00:00:00Z',
    }]);
    let stopSidebar!: () => void;
    await act(async () => {
      stopSidebar = subscribePassive(() => {});
      if (reader === 'workspace') setSidebarWorkspaceSessionDemand(['/workspace']);
      else refresh('all', { force: true, reason: 'global-sidebar-search', silent: true });
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    chat.unmount();
    expect(dataMocks.listeners.get('agent:status-changed')?.size).toBe(0);
    const online = status('online');
    online.agent.channels = [{
      channelId: 'channel', channelType: 'telegram', status: 'online',
      uptimeSeconds: 1, restartCount: 0, bufferedMessages: 0,
      activeSessions: [{
        sessionKey: 'im:telegram:private:123', sessionId: 'im-session', sourceType: 'private',
        workspacePath: '/workspace', messageCount: 1, lastActive: '2026-10-11T00:00:00Z',
      }],
    }];
    await act(async () => pending.resolve(online));
    expect(getSnapshot().sessions.map(session => session.id)).toEqual(['im-session']);
    expect(getSnapshot().sessionTagsMap.get('im-session')).toEqual([{ type: 'im', platform: 'Telegram' }]);
    vi.useFakeTimers();
    invokeMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(invokeMock).not.toHaveBeenCalled();
    act(() => { setSidebarWorkspaceSessionDemand([]); stopSidebar(); });
  });

  it('disabled consumers own no polling or refresh work', async () => {
    const view = renderHook(() => useAgentStatuses(false));
    await act(async () => view.result.current.refresh());
    expect(invokeMock).not.toHaveBeenCalled();
    expect(dataMocks.listeners.get('agent:status-changed')?.size ?? 0).toBe(0);
    expect(view.result.current.loading).toBe(false);
  });
});
