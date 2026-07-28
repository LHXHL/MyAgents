import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SseEventMetadata } from '@/api/SseConnection';
import { useTabState } from './TabContext';
import TabProvider from './TabProvider';

type EventHandler = (
  eventName: string,
  data: unknown,
  metadata: SseEventMetadata,
) => void;
type StatusHandler = (
  status: 'connected' | 'disconnected' | 'reconnecting' | 'failed',
) => void;

const sseHarness = vi.hoisted(() => {
  const state = {
    connected: false,
    eventHandler: null as EventHandler | null,
    statusHandler: null as StatusHandler | null,
  };
  const connection = {
    setEventHandler: vi.fn((handler: EventHandler) => {
      state.eventHandler = handler;
    }),
    setStatusHandler: vi.fn((handler: StatusHandler) => {
      state.statusHandler = handler;
    }),
    connect: vi.fn(async () => {
      state.connected = true;
      state.statusHandler?.('connected');
    }),
    disconnect: vi.fn(async () => {
      state.connected = false;
    }),
    isConnected: vi.fn(() => state.connected),
    getConnectionGeneration: vi.fn(() => 1),
  };
  return { state, connection };
});

const tauriHarness = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  ensureSessionSidecar: vi.fn(async () => undefined),
}));

vi.mock('@/api/SseConnection', () => ({
  createSseConnection: () => sseHarness.connection,
}));

vi.mock('@/config/useConfigData', () => ({
  useConfigData: () => ({ config: { multiAgentRuntime: false } }),
}));

vi.mock('@/config/services/agentConfigService', () => ({
  getAgentByWorkspacePath: () => undefined,
}));

vi.mock('@/config/services/appConfigService', () => ({
  notifyConfigChanged: vi.fn(),
}));

vi.mock('@/analytics', () => ({
  track: vi.fn(),
  consumePendingSessionBirth: vi.fn(),
  peekPendingSessionBirth: vi.fn(),
  setPendingSessionBirth: vi.fn(),
  hashAgentNameSync: () => null,
  birthContextForSurface: vi.fn(),
}));

vi.mock('@/utils/frontendLogger', () => ({
  subscribeFrontendLogs: () => () => undefined,
  setCurrentTabId: vi.fn(),
  setFocusedTabId: vi.fn(),
}));

vi.mock('@/api/tauriClient', () => ({
  getTabServerUrl: vi.fn(async () => 'http://127.0.0.1:1234'),
  proxyFetch: tauriHarness.proxyFetch,
  isTauri: () => false,
  getSessionActivation: vi.fn(async () => null),
  getSessionPort: vi.fn(async () => null),
  ensureSessionSidecar: tauriHarness.ensureSessionSidecar,
  resetTabServerUrlCache: vi.fn(),
  setActiveCorrelation: vi.fn(),
  setFocusedCorrelationTabId: vi.fn(),
}));

function Probe() {
  const {
    sessionId,
    isLoading,
    sessionState,
    historyMessages,
    systemInitInfo,
    queuedMessages,
    sendMessage,
    cancelQueuedMessage,
    forceExecuteQueuedMessage,
  } = useTabState();
  return (
    <>
      <output data-testid="activity">
        {JSON.stringify({
          sessionId,
          isLoading,
          sessionState,
          historyCount: historyMessages.length,
          initModel: systemInitInfo?.model ?? null,
        })}
      </output>
      <output data-testid="init-tools">{JSON.stringify(systemInitInfo?.tools ?? [])}</output>
      <output data-testid="queue-ids">{JSON.stringify(queuedMessages.map(item => item.queueId))}</output>
      <button type="button" onClick={() => void sendMessage('hello')}>send message</button>
      <button type="button" onClick={() => void cancelQueuedMessage('queue-stale-cancel')}>cancel stale</button>
      <button type="button" onClick={() => void forceExecuteQueuedMessage('queue-stale-force')}>force stale</button>
    </>
  );
}

function readActivity(): {
  sessionId: string | null;
  isLoading: boolean;
  sessionState: string;
  historyCount: number;
  initModel: string | null;
} {
  return JSON.parse(screen.getByTestId('activity').textContent ?? '{}') as {
    sessionId: string | null;
    isLoading: boolean;
    sessionState: string;
    historyCount: number;
    initModel: string | null;
  };
}

function emit(eventName: string, data: unknown): void {
  const handler = sseHarness.state.eventHandler;
  if (!handler) throw new Error('SSE event handler is not installed');
  act(() => {
    handler(eventName, data, { connectionGeneration: 1 });
  });
}

function readQueueIds(): string[] {
  return JSON.parse(screen.getByTestId('queue-ids').textContent ?? '[]') as string[];
}

function readInitTools(): string[] {
  return JSON.parse(screen.getByTestId('init-tools').textContent ?? '[]') as string[];
}

const allowSessionOpening = () => () => undefined;

describe('TabProvider session activity ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseHarness.state.connected = false;
    sseHarness.state.eventHandler = null;
    sseHarness.state.statusHandler = null;
    tauriHarness.proxyFetch.mockRejectedValue(new Error('Unexpected proxyFetch call'));
  });

  it('does not reacquire a Tab owner while App is deleting the Session', async () => {
    const claimSessionOpeningTransition = vi.fn(() => null);
    render(
      <TabProvider
        tabId="tab-delete-race"
        agentDir="/tmp/workspace"
        sessionId="session-delete-race"
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.statusHandler).not.toBeNull());
    act(() => {
      sseHarness.state.connected = false;
      sseHarness.state.statusHandler?.('failed');
    });

    await waitFor(() => {
      expect(claimSessionOpeningTransition).toHaveBeenCalledWith('session-delete-race');
    });
    expect(tauriHarness.ensureSessionSidecar).not.toHaveBeenCalled();
  });

  it('does not submit a turn while App is deleting the Session', () => {
    const claimSessionOpeningTransition = vi.fn(() => null);
    render(
      <TabProvider
        tabId="tab-delete-send"
        agentDir="/tmp/workspace"
        sessionId="session-delete-send"
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'send message' }));

    expect(claimSessionOpeningTransition).toHaveBeenCalledWith('session-delete-send');
    expect(tauriHarness.proxyFetch.mock.calls.some(
      ([url]) => String(url).includes('/chat/send'),
    )).toBe(false);
  });

  it('holds turn admission until the backend accepts the send', async () => {
    let resolveSend!: (response: Response) => void;
    const sendResponse = new Promise<Response>((resolve) => {
      resolveSend = resolve;
    });
    tauriHarness.proxyFetch.mockReturnValueOnce(sendResponse);
    const releaseSendTransition = vi.fn();
    const claimSessionOpeningTransition = vi.fn(() => releaseSendTransition);
    render(
      <TabProvider
        tabId="tab-send-admission"
        agentDir="/tmp/workspace"
        sessionId="session-send-admission"
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'send message' }));
    await waitFor(() => {
      expect(tauriHarness.proxyFetch).toHaveBeenCalledWith(
        expect.stringContaining('/chat/send'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(releaseSendTransition).not.toHaveBeenCalled();

    await act(async () => {
      resolveSend(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await sendResponse;
    });
    await waitFor(() => expect(releaseSendTransition).toHaveBeenCalledOnce());
  });

  it.each([false, true])(
    'keeps system-init metadata-only when prewarm=%s',
    async (prewarm) => {
      render(
        <TabProvider
          tabId="tab-activity"
          agentDir="/tmp/workspace"
          sessionId="pending-activity"
          claimSessionOpeningTransition={allowSessionOpening}
        >
          <Probe />
        </TabProvider>,
      );

      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: false,
        sessionState: 'idle',
        historyCount: 0,
        initModel: null,
      });

      emit('chat:system-init', {
        info: { timestamp: '2026-07-15T00:00:00.000Z', model: 'model-a' },
        prewarm,
        runtime: 'builtin',
      });
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: false,
        sessionState: 'idle',
        historyCount: 0,
        initModel: 'model-a',
      });

      emit('chat:status', { sessionState: 'starting' });
      expect(readActivity()).toMatchObject({
        isLoading: true,
        sessionState: 'starting',
        historyCount: 0,
      });

      emit('chat:system-init', {
        info: { timestamp: '2026-07-15T00:00:01.000Z', model: 'model-b' },
        prewarm,
        runtime: 'builtin',
      });
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: true,
        sessionState: 'starting',
        historyCount: 0,
        initModel: 'model-b',
      });

      emit('chat:status', { sessionState: 'idle' });
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: false,
        sessionState: 'idle',
        historyCount: 0,
        initModel: 'model-b',
      });
    },
  );

  it('keeps the pending identity when App refuses system-init adoption', async () => {
    const onSessionIdChange = vi.fn(async () => false);
    render(
      <TabProvider
        tabId="tab-refused-upgrade"
        agentDir="/tmp/workspace"
        sessionId="pending-refused-upgrade"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:system-init', {
      info: { timestamp: '2026-07-15T00:00:00.000Z', model: 'model-a' },
      sessionId: 'real-refused-upgrade',
      runtime: 'builtin',
    });

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('real-refused-upgrade'));
    expect(readActivity().sessionId).toBe('pending-refused-upgrade');
  });

  it('commits system-init identity only after App accepts adoption', async () => {
    let resolveAdoption!: (accepted: boolean) => void;
    const onSessionIdChange = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveAdoption = resolve;
    }));
    render(
      <TabProvider
        tabId="tab-delayed-upgrade"
        agentDir="/tmp/workspace"
        sessionId="pending-delayed-upgrade"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:system-init', {
      info: { timestamp: '2026-07-15T00:00:00.000Z', model: 'model-a' },
      sessionId: 'real-delayed-upgrade',
      runtime: 'builtin',
    });

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('real-delayed-upgrade'));
    expect(readActivity().sessionId).toBe('pending-delayed-upgrade');

    await act(async () => {
      resolveAdoption(true);
    });
    await waitFor(() => expect(readActivity().sessionId).toBe('real-delayed-upgrade'));
  });

  it('keeps the live SSE owner when an active pending session receives its real id', async () => {
    const view = render(
      <TabProvider
        tabId="tab-upgrade"
        agentDir="/tmp/workspace"
        sessionId="pending-upgrade"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    emit('chat:status', { sessionState: 'starting' });
    expect(readActivity()).toMatchObject({
      sessionId: 'pending-upgrade',
      isLoading: true,
      sessionState: 'starting',
    });

    sseHarness.connection.disconnect.mockClear();
    tauriHarness.proxyFetch.mockClear();
    view.rerender(
      <TabProvider
        tabId="tab-upgrade"
        agentDir="/tmp/workspace"
        sessionId="session-upgrade"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => {
      expect(readActivity()).toMatchObject({
        sessionId: 'session-upgrade',
        isLoading: true,
        sessionState: 'starting',
      });
    });
    expect(sseHarness.connection.disconnect).not.toHaveBeenCalled();
    expect(tauriHarness.proxyFetch).not.toHaveBeenCalled();
  });

  it('clears runtime tool metadata when switching to another session', async () => {
    const view = render(
      <TabProvider tabId="tab-tools" agentDir="/tmp/workspace" sessionId="pending-tools-a" claimSessionOpeningTransition={allowSessionOpening}>
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:system-init', {
      info: {
        timestamp: '2026-07-15T00:00:00.000Z',
        model: 'codex-model',
        tools: ['mcp__playwright__browser_click'],
      },
      prewarm: false,
      runtime: 'codex',
    });
    expect(readInitTools()).toEqual(['mcp__playwright__browser_click']);

    view.rerender(
      <TabProvider tabId="tab-tools" agentDir="/tmp/workspace" sessionId="pending-tools-b" claimSessionOpeningTransition={allowSessionOpening}>
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(readInitTools()).toEqual([]));
  });

  it('restores a running session as active before any assistant chunk exists', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-rest?') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-rest',
            agentDir: '/tmp/workspace',
            title: 'Restored session',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:01.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'running',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/sessions/switch') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-rest"
        agentDir="/tmp/workspace"
        sessionId="session-rest"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => {
      expect(readActivity()).toEqual({
        sessionId: 'session-rest',
        isLoading: true,
        sessionState: 'running',
        historyCount: 0,
        initModel: null,
      });
    });

    expect(tauriHarness.proxyFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['queue-stale-cancel', 'cancel stale', '/chat/queue/cancel'],
    ['queue-stale-force', 'force stale', '/chat/queue/force'],
  ] as const)(
    'removes stale queue replica %s after the authority reports not-found',
    async (queueId, actionLabel, route) => {
      tauriHarness.proxyFetch.mockImplementation(async (url: string) => {
        if (url.endsWith(route)) {
          return new Response(JSON.stringify({
            success: false,
            stale: true,
            error: 'Queue item not found',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`Unexpected proxyFetch call: ${url}`);
      });

      render(
        <TabProvider
          tabId={`tab-${queueId}`}
          agentDir="/tmp/workspace"
          sessionId={`pending-${queueId}`}
          claimSessionOpeningTransition={allowSessionOpening}
        >
          <Probe />
        </TabProvider>,
      );

      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      emit('queue:added', { queueId, messageText: 'stale queued request' });
      expect(readQueueIds()).toContain(queueId);

      fireEvent.click(screen.getByRole('button', { name: actionLabel }));

      await waitFor(() => expect(readQueueIds()).not.toContain(queueId));
    },
  );
});
