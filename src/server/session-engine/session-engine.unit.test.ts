import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    useExternal: false,
    externalActive: false,
    externalProcessAlive: false,
    pendingExternalAsk: false,
  };

  return {
    state,
    broadcast: vi.fn(),
    cancelBuiltinImRequest: vi.fn(async () => ({ aborted: false, mode: 'unknown' as const })),
    cancelQueueItem: vi.fn<() => Promise<
      | { status: 'cancelled'; cancelledText: string }
      | { status: 'not_found' | 'not_cancelled' | 'unavailable' | 'error' }
    >>(async () => ({ status: 'not_found' as const })),
    consumeInjectedTurnOutcome: vi.fn<(injectedTurnId: string) => {
      status: 'complete' | 'stopped' | 'error';
      assistantMessagePresent: boolean;
      text: string;
      error?: string;
    } | undefined>(() => ({
      status: 'complete' as const,
      assistantMessagePresent: true,
      text: 'builtin answer',
    })),
    discardInjectedTurnOutcome: vi.fn(),
    enqueueUserMessage: vi.fn<(...args: unknown[]) => Promise<{
      queued: boolean;
      queueId?: string;
      isInFlight?: boolean;
      deliveryMode?: 'queue' | 'realtime' | 'turn';
      error?: string;
    }>>(async () => ({ queued: true, queueId: 'q1', isInFlight: false, deliveryMode: 'queue' as const })),
    forceExecuteQueueItem: vi.fn(async () => true),
    getAndClearLastAgentError: vi.fn<() => string | null>(() => null),
    getAgentState: vi.fn<() => Record<string, unknown>>(() => ({ sessionState: 'idle', agentDir: '/workspace' })),
    getAgents: vi.fn(() => ({ helper: { name: 'helper' } })),
    getLastBuiltinAssistantText: vi.fn(() => 'builtin latest'),
    getMcpServers: vi.fn(() => [{ id: 'fs' }]),
    getMessages: vi.fn<() => Array<{ id: string; role: 'user' | 'assistant'; content: string | unknown[]; timestamp: string }>>(() => []),
    getPendingInteractiveRequests: vi.fn<() => Array<{ type: string; data: unknown }>>(() => []),
    getQueueStatus: vi.fn(() => [{ id: 'q1', messagePreview: 'hello' }]),
    getSessionId: vi.fn(() => 'builtin-session'),
    getSessionModel: vi.fn(() => 'claude-sonnet'),
    getSessionPermissionMode: vi.fn(() => 'auto'),
    getSessionEnabledOfficialToolIds: vi.fn(() => ['image-understanding']),
    getSessionProviderEnv: vi.fn(() => undefined),
    getSessionProviderId: vi.fn(() => 'sensenova'),
    getSessionReasoningEffort: vi.fn(() => 'default'),
    getStreamingAssistantId: vi.fn<() => string | null>(() => null),
    getSystemInitInfo: vi.fn<() => unknown>(() => null),
    handleAskUserQuestionResponse: vi.fn(() => true),
    handlePermissionResponse: vi.fn(() => true),
    interruptCurrentResponse: vi.fn(async () => false),
    isSessionBusy: vi.fn(() => false),
    forkSession: vi.fn(async () => ({ success: true, newSessionId: 'forked' })),
    freezeCurrentSessionMetadataForImDetach: vi.fn(async () => ({ success: true, sessionId: 'old-im-session' })),
    materializeCurrentSessionMetadataForPublishedReset: vi.fn(async () => undefined),
    materializePendingDesktopSession: vi.fn(async () => ({ success: true, sessionId: 'builtin-session' })),
    resetSession: vi.fn(async () => undefined),
    rewindSession: vi.fn(async () => ({ success: true, content: 'rewound' })),
    setAgents: vi.fn(),
    setBackgroundAgentPermissionMode: vi.fn(),
    setInteractionScenario: vi.fn(),
    setMcpServers: vi.fn(),
    setSessionModel: vi.fn(),
    setSessionPermissionMode: vi.fn(),
    setSessionEnabledOfficialToolIds: vi.fn(),
    setSessionProviderEnv: vi.fn(),
    setSessionReasoningEffort: vi.fn(),
    stripPlaywrightResults: vi.fn((message: string) => message),
    switchToSession: vi.fn(async () => true),
    waitForSessionIdle: vi.fn(async () => true),
    awaitExternalSessionStarting: vi.fn(async () => undefined),
    cancelExternalImRequest: vi.fn(async () => ({ aborted: false, mode: 'unknown' as const })),
    cancelExternalQueueItem: vi.fn(() => null),
    didLastTurnSucceed: vi.fn(() => true),
    enqueueExternalSendForDesktop: vi.fn(() => ({
      queued: true,
      queueId: 'xq1',
      dispatch: Promise.resolve({ queued: true }),
    })),
    forceExecuteExternalQueueItem: vi.fn(async () => true),
    getActiveRuntimeSource: vi.fn<() => 'system-cli' | 'managed-provider'>(() => 'system-cli'),
    getActiveRuntimeType: vi.fn(() => 'codex'),
    getCurrentBoundSessionId: vi.fn<() => string | null>(() => null),
    getExternalLiveAssistantMessage: vi.fn<() => { id: string; role: 'user' | 'assistant'; content: string; timestamp: string } | null>(() => null),
    getExternalQueueStatus: vi.fn(() => [{ id: 'xq1', messagePreview: 'hello' }]),
    getExternalPendingInteractiveRequests: vi.fn(() => []),
    getExternalSessionId: vi.fn(() => 'external-session'),
    getExternalSessionModel: vi.fn(() => 'gpt-5'),
    getExternalSessionPermissionMode: vi.fn(() => 'no-restrictions'),
    getExternalSessionReasoningEffort: vi.fn(() => 'medium'),
    getExternalSessionState: vi.fn(() => 'idle'),
    getExternalSessionWorkspacePath: vi.fn(() => '/workspace'),
    getExternalSystemInitPayload: vi.fn(() => null),
    getLastExternalAssistantText: vi.fn(() => 'external answer'),
    hasExternalRuntimeProcess: vi.fn(() => state.externalProcessAlive || state.externalActive),
    hasPendingExternalAskUserQuestion: vi.fn((requestId: string) => Boolean(requestId) && state.pendingExternalAsk),
    isExternalSessionActive: vi.fn(() => state.externalActive),
    isExternalSessionStateRestoredFor: vi.fn(() => true),
    popLastUserMessageForRetry: vi.fn(async () => ({ success: true, content: 'retry' })),
    prewarmExternalSession: vi.fn(async () => ({ prewarmed: true })),
    respondExternalAskUserQuestion: vi.fn(async () => true),
    respondExternalPermission: vi.fn(async () => true),
    restoreExternalSessionState: vi.fn(),
    sendExternalMessage: vi.fn(async () => ({ queued: true })),
    setExternalModel: vi.fn(async () => ({ success: true })),
    setExternalPermissionMode: vi.fn(async () => ({ success: true })),
    setExternalReasoningEffort: vi.fn(async () => ({ success: true })),
    shouldUseExternalRuntime: vi.fn(() => state.useExternal),
    stopExternalSession: vi.fn(async () => true),
    updateExternalRuntimeConfig: vi.fn(async () => ({ success: true })),
    waitForExternalSessionIdle: vi.fn(async () => true),
    getSessionData: vi.fn((sessionId: string) => ({
      id: sessionId,
      agentDir: '/workspace',
      title: 'Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      enabledOfficialToolIds: ['image-understanding'],
      messages: [],
    })),
    updateSessionMetadata: vi.fn(async (sessionId: string, updates: Record<string, unknown>) => ({
      id: sessionId,
      agentDir: '/workspace',
      title: 'Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      ...updates,
      messages: [],
    })),
    getEffectiveOfficialToolIdsForSession: vi.fn((_workspacePath: string, sessionMeta?: { enabledOfficialToolIds?: string[] } | null, overrideIds?: readonly string[] | null) => (
      overrideIds !== null && overrideIds !== undefined
        ? [...overrideIds]
        : (sessionMeta?.enabledOfficialToolIds ? [...sessionMeta.enabledOfficialToolIds] : [])
    )),
    materializeProviderRouteEnv: vi.fn(() => undefined),
  };
});

vi.mock('../agent-session', () => ({
  cancelImRequest: mocks.cancelBuiltinImRequest,
  cancelQueueItem: mocks.cancelQueueItem,
  consumeInjectedTurnOutcome: mocks.consumeInjectedTurnOutcome,
  discardInjectedTurnOutcome: mocks.discardInjectedTurnOutcome,
  enqueueUserMessage: mocks.enqueueUserMessage,
  forceExecuteQueueItem: mocks.forceExecuteQueueItem,
  getAndClearLastAgentError: mocks.getAndClearLastAgentError,
  getAgentState: mocks.getAgentState,
  getAgents: mocks.getAgents,
  getLastBuiltinAssistantText: mocks.getLastBuiltinAssistantText,
  getMcpServers: mocks.getMcpServers,
  getMessages: mocks.getMessages,
  getPendingInteractiveRequests: mocks.getPendingInteractiveRequests,
  getQueueStatus: mocks.getQueueStatus,
  getSessionId: mocks.getSessionId,
  getSessionModel: mocks.getSessionModel,
  getSessionPermissionMode: mocks.getSessionPermissionMode,
  getSessionEnabledOfficialToolIds: mocks.getSessionEnabledOfficialToolIds,
  getSessionProviderEnv: mocks.getSessionProviderEnv,
  getSessionProviderId: mocks.getSessionProviderId,
  getSessionReasoningEffort: mocks.getSessionReasoningEffort,
  getStreamingAssistantId: mocks.getStreamingAssistantId,
  getSystemInitInfo: mocks.getSystemInitInfo,
  handleAskUserQuestionResponse: mocks.handleAskUserQuestionResponse,
  handlePermissionResponse: mocks.handlePermissionResponse,
  interruptCurrentResponse: mocks.interruptCurrentResponse,
  isSessionBusy: mocks.isSessionBusy,
  forkSession: mocks.forkSession,
  freezeCurrentSessionMetadataForImDetach: mocks.freezeCurrentSessionMetadataForImDetach,
  materializeCurrentSessionMetadataForPublishedReset: mocks.materializeCurrentSessionMetadataForPublishedReset,
  materializePendingDesktopSession: mocks.materializePendingDesktopSession,
  resetSession: mocks.resetSession,
  rewindSession: mocks.rewindSession,
  setAgents: mocks.setAgents,
  setBackgroundAgentPermissionMode: mocks.setBackgroundAgentPermissionMode,
  setInteractionScenario: mocks.setInteractionScenario,
  setMcpServers: mocks.setMcpServers,
  setSessionModel: mocks.setSessionModel,
  setSessionPermissionMode: mocks.setSessionPermissionMode,
  setSessionEnabledOfficialToolIds: mocks.setSessionEnabledOfficialToolIds,
  setSessionProviderEnv: mocks.setSessionProviderEnv,
  setSessionReasoningEffort: mocks.setSessionReasoningEffort,
  stripPlaywrightResults: mocks.stripPlaywrightResults,
  switchToSession: mocks.switchToSession,
  waitForSessionIdle: mocks.waitForSessionIdle,
}));

vi.mock('../runtimes/external-session', () => ({
  awaitExternalSessionStarting: mocks.awaitExternalSessionStarting,
  cancelExternalImRequest: mocks.cancelExternalImRequest,
  cancelExternalQueueItem: mocks.cancelExternalQueueItem,
  didLastTurnSucceed: mocks.didLastTurnSucceed,
  enqueueExternalSendForDesktop: mocks.enqueueExternalSendForDesktop,
  forceExecuteExternalQueueItem: mocks.forceExecuteExternalQueueItem,
  getActiveRuntimeSource: mocks.getActiveRuntimeSource,
  getActiveRuntimeType: mocks.getActiveRuntimeType,
  getCurrentBoundSessionId: mocks.getCurrentBoundSessionId,
  getExternalLiveAssistantMessage: mocks.getExternalLiveAssistantMessage,
  getExternalPendingInteractiveRequests: mocks.getExternalPendingInteractiveRequests,
  getExternalQueueStatus: mocks.getExternalQueueStatus,
  getExternalSessionId: mocks.getExternalSessionId,
  getExternalSessionModel: mocks.getExternalSessionModel,
  getExternalSessionPermissionMode: mocks.getExternalSessionPermissionMode,
  getExternalSessionReasoningEffort: mocks.getExternalSessionReasoningEffort,
  getExternalSessionState: mocks.getExternalSessionState,
  getExternalSessionWorkspacePath: mocks.getExternalSessionWorkspacePath,
  getExternalSystemInitPayload: mocks.getExternalSystemInitPayload,
  getLastExternalAssistantText: mocks.getLastExternalAssistantText,
  hasExternalRuntimeProcess: mocks.hasExternalRuntimeProcess,
  hasPendingExternalAskUserQuestion: mocks.hasPendingExternalAskUserQuestion,
  isExternalSessionActive: mocks.isExternalSessionActive,
  isExternalSessionStateRestoredFor: mocks.isExternalSessionStateRestoredFor,
  popLastUserMessageForRetry: mocks.popLastUserMessageForRetry,
  prewarmExternalSession: mocks.prewarmExternalSession,
  respondExternalAskUserQuestion: mocks.respondExternalAskUserQuestion,
  respondExternalPermission: mocks.respondExternalPermission,
  restoreExternalSessionState: mocks.restoreExternalSessionState,
  sendExternalMessage: mocks.sendExternalMessage,
  setExternalModel: mocks.setExternalModel,
  setExternalPermissionMode: mocks.setExternalPermissionMode,
  setExternalReasoningEffort: mocks.setExternalReasoningEffort,
  shouldUseExternalRuntime: mocks.shouldUseExternalRuntime,
  stopExternalSession: mocks.stopExternalSession,
  updateExternalRuntimeConfig: mocks.updateExternalRuntimeConfig,
  waitForExternalSessionIdle: mocks.waitForExternalSessionIdle,
}));

vi.mock('../utils/admin-config', () => ({
  getEffectiveOfficialToolIdsForSession: mocks.getEffectiveOfficialToolIdsForSession,
  materializeProviderRouteEnv: mocks.materializeProviderRouteEnv,
}));

vi.mock('../SessionStore', () => ({
  getSessionData: mocks.getSessionData,
  updateSessionMetadata: mocks.updateSessionMetadata,
}));

vi.mock('../sse', () => ({
  broadcast: mocks.broadcast,
}));

import {
  getAskUserQuestionResponseEngine,
  getPermissionResponseEngine,
  getSessionEngine,
  stopActiveTurn,
} from './selector';

const desktopScenario = { type: 'desktop' } as const;

describe('session-engine selector and adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.useExternal = false;
    mocks.state.externalActive = false;
    mocks.state.externalProcessAlive = false;
    mocks.state.pendingExternalAsk = false;
    mocks.isExternalSessionStateRestoredFor.mockReturnValue(true);
  });

  it('routes desktop sends through builtin while preserving desktop metadata', async () => {
    const result = await getSessionEngine().sendDesktopMessage({
      text: 'hello',
      images: [],
      permissionMode: 'auto',
      model: 'claude-sonnet',
      providerEnv: undefined,
      reasoningEffort: 'medium',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
      analyticsSource: 'floating_ball',
      analyticsOrigin: { kind: 'desktop', surface: 'floating_ball' },
      birthOrigin: { kind: 'desktop', surface: 'launcher_input' },
    });

    expect(result).toMatchObject({
      success: true,
      queued: true,
      queueId: 'q1',
      isInFlight: false,
      deliveryMode: 'queue',
    });
    expect(mocks.setInteractionScenario).toHaveBeenCalledWith(desktopScenario);
    expect(mocks.enqueueUserMessage).toHaveBeenCalledWith(
      'hello',
      [],
      'auto',
      'claude-sonnet',
      undefined,
      'medium',
      { source: 'desktop' },
      undefined,
      undefined,
      'floating_ball',
      { kind: 'desktop', surface: 'floating_ball' },
      {
        fromDesktopChatSend: true,
        sessionBirthOrigin: { kind: 'desktop', surface: 'launcher_input' },
      },
    );
  });

  it('exposes builtin read and config surfaces without route-level helpers', () => {
    mocks.getSessionId.mockReturnValueOnce('builtin-live');
    mocks.getLastBuiltinAssistantText.mockReturnValueOnce('builtin answer');
    mocks.getMessages.mockReturnValueOnce([
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'saved answer' }], timestamp: '2026-01-01T00:00:01.000Z' },
      { id: 'a-stream', role: 'assistant', content: 'streaming', timestamp: '2026-01-01T00:00:02.000Z' },
    ]);
    mocks.getStreamingAssistantId.mockReturnValueOnce('a-stream');
    mocks.getSystemInitInfo.mockReturnValueOnce({ model: 'claude-sonnet' });
    mocks.getPendingInteractiveRequests.mockReturnValueOnce([{ type: 'chat:permission-request', data: { requestId: 'p1' } }]);

    const engine = getSessionEngine();

    expect(engine.getRuntimeIdentity()).toEqual({
      kind: 'builtin',
      runtime: 'builtin',
      sessionId: 'builtin-live',
    });
    expect(engine.getLatestAssistantResult()).toEqual({
      sessionId: 'builtin-session',
      latestResult: 'builtin answer',
    });
    expect(engine.getStreamReplaySnapshot()).toMatchObject({
      replayMessages: [
        { id: 'u1', content: 'hello' },
        { id: 'a1', content: [{ type: 'text', text: 'saved answer' }] },
      ],
      systemInitPayload: { info: { model: 'claude-sonnet' } },
      pendingInteractiveRequests: [{ type: 'chat:permission-request', data: { requestId: 'p1' } }],
    });
    expect(engine.getSessionConfigSnapshot()).toEqual({
      success: true,
      runtime: 'builtin',
      model: 'claude-sonnet',
      mcpServerIds: ['fs'],
      agentNames: ['helper'],
      enabledOfficialToolIds: ['image-understanding'],
      permissionMode: 'auto',
      providerId: 'sensenova',
      providerRoute: { kind: 'provider', providerId: 'sensenova', model: 'claude-sonnet' },
      reasoningEffort: 'default',
    });
    expect(engine.getHeldImConfigSnapshot()).toEqual({
      model: 'claude-sonnet',
      permissionMode: 'auto',
      providerEnv: undefined,
      reasoningEffort: 'default',
    });
  });

  it('exposes external read, config, and restore surfaces behind the external adapter', () => {
    mocks.state.useExternal = true;
    mocks.getCurrentBoundSessionId.mockReturnValueOnce('bound-session');
    mocks.getExternalLiveAssistantMessage.mockReturnValueOnce({
      id: 'live',
      role: 'assistant',
      content: 'typing',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const engine = getSessionEngine();

    expect(engine.getRuntimeIdentity()).toEqual({
      kind: 'external',
      runtime: 'codex',
      runtimeSource: 'system-cli',
      sessionId: 'external-session',
      boundSessionId: 'bound-session',
    });
    expect(engine.getSessionConfigSnapshot()).toEqual({
      success: true,
      runtime: 'codex',
      runtimeSource: 'system-cli',
      model: 'gpt-5',
      mcpServerIds: null,
      agentNames: null,
      enabledOfficialToolIds: ['image-understanding'],
      permissionMode: 'no-restrictions',
      providerId: null,
      providerRoute: null,
      providerExecutionIdentity: null,
      reasoningEffort: 'medium',
    });
    expect(engine.getHeldImConfigSnapshot()).toEqual({
      model: 'gpt-5',
      permissionMode: 'no-restrictions',
      reasoningEffort: 'medium',
    });
    expect(engine.getLiveSessionOverlay('external-session')).toMatchObject({
      isActive: true,
      runtime: 'codex',
      liveStreamingMessage: { id: 'live', content: 'typing' },
      liveSessionState: 'idle',
    });

    expect(engine.restoreInitialSession('sid-restored', '/workspace')).toBe(true);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('sid-restored', '/workspace', { type: 'desktop' });
  });

  it('matches external live overlay by current bound session during prewarm/start', () => {
    mocks.state.useExternal = true;
    mocks.getExternalSessionId.mockReturnValueOnce('');
    mocks.getCurrentBoundSessionId.mockReturnValueOnce('starting-session');

    expect(getSessionEngine().getLiveSessionOverlay('starting-session')).toMatchObject({
      isActive: true,
      runtime: 'codex',
      liveSessionState: 'idle',
    });
  });

  it('returns external desktop admission before dispatch finishes and broadcasts dispatch failures', async () => {
    mocks.state.useExternal = true;
    let resolveDispatch!: (result: { queued: boolean; error?: string }) => void;
    const dispatch = new Promise<{ queued: boolean; error?: string }>((resolve) => {
      resolveDispatch = resolve;
    });
    mocks.enqueueExternalSendForDesktop.mockReturnValueOnce({
      queued: true,
      queueId: 'xq-runtime',
      dispatch,
    });

    const result = await getSessionEngine().sendDesktopMessage({
      text: 'hello external',
      images: [],
      permissionMode: 'auto',
      model: 'gpt-5',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
    });

    expect(result).toEqual({ success: true, queued: true, queueId: 'xq-runtime' });
    expect(mocks.enqueueExternalSendForDesktop).toHaveBeenCalledWith(
      'hello external',
      [],
      'auto',
      'gpt-5',
      {
        sessionId: 'sid',
        workspacePath: '/workspace',
        scenario: desktopScenario,
        analyticsSource: undefined,
        analyticsOrigin: undefined,
        birthOrigin: undefined,
        permissionMode: 'auto',
        model: 'gpt-5',
        reasoningEffort: undefined,
      },
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();

    resolveDispatch({ queued: false, error: 'runtime failed' });
    await dispatch;
    await Promise.resolve();

    expect(mocks.broadcast).toHaveBeenCalledWith('chat:agent-error', { message: 'runtime failed' });
  });

  it('keeps stop fallback on builtin when external runtime is selected but inactive', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = false;

    const result = await stopActiveTurn();

    expect(result).toEqual({ success: true, alreadyStopped: true });
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued builtin injected turn when the synchronous wait times out', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: true,
      queueId: 'q-timeout',
      isInFlight: false,
      deliveryMode: 'queue',
    });
    mocks.cancelQueueItem.mockResolvedValueOnce({
      status: 'cancelled',
      cancelledText: 'run cron',
    });
    mocks.waitForSessionIdle.mockResolvedValueOnce(false);

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'run cron',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'cron', taskId: 'task-1', intervalMinutes: 15, aiCanExit: false },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      error: 'Execution timed out',
    });
    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('q-timeout');
    expect(mocks.discardInjectedTurnOutcome).toHaveBeenCalledWith(
      expect.any(String),
      { retainForLateTerminal: false },
    );
  });

  it('clears stale builtin agent errors before starting an injected turn', async () => {
    mocks.getAndClearLastAgentError.mockReturnValueOnce('stale previous error');

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({ success: true, text: 'builtin answer' });
    expect(mocks.getAndClearLastAgentError).toHaveBeenCalledTimes(1);
    expect(mocks.getAndClearLastAgentError.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.enqueueUserMessage.mock.invocationCallOrder[0]);
  });

  it('uses the turn-local injected outcome instead of global message history', async () => {
    mocks.consumeInjectedTurnOutcome.mockReturnValueOnce({
      status: 'complete',
      assistantMessagePresent: true,
      text: '',
    });

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'memory update',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: true,
      enqueued: true,
      assistantMessagePresent: true,
      text: '',
    });
    expect(mocks.consumeInjectedTurnOutcome).toHaveBeenCalledTimes(1);
    const injectedTurnId = mocks.consumeInjectedTurnOutcome.mock.calls[0][0];
    expect(typeof injectedTurnId).toBe('string');
    expect(mocks.enqueueUserMessage.mock.calls[0][11]).toEqual({ injectedTurnId });
  });

  it('waits for a recovered builtin injected turn outcome after an early idle signal', async () => {
    mocks.consumeInjectedTurnOutcome
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({
        status: 'complete',
        assistantMessagePresent: true,
        text: 'replayed answer',
      });

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'space delivery',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 1,
    });

    expect(result).toMatchObject({
      success: true,
      enqueued: true,
      text: 'replayed answer',
    });
    expect(mocks.consumeInjectedTurnOutcome).toHaveBeenCalledTimes(2);
  });

  it('propagates turn-local injected errors without reading stale assistant text', async () => {
    mocks.consumeInjectedTurnOutcome.mockReturnValueOnce({
      status: 'error',
      assistantMessagePresent: false,
      text: '',
      error: 'turn failed',
    });

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'memory update',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 503,
      error: 'turn failed',
    });
  });

  it('gates external injected turns on the runtime success signal after idle', async () => {
    mocks.state.useExternal = true;
    mocks.sendExternalMessage.mockResolvedValueOnce({ queued: true });
    mocks.waitForExternalSessionIdle.mockResolvedValueOnce(true);
    mocks.didLastTurnSucceed.mockReturnValueOnce(false);

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'update memory',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 503,
      error: 'External runtime turn failed',
    });
    expect(mocks.getLastExternalAssistantText).not.toHaveBeenCalled();
  });

  it('forwards model sync source options to the external engine', async () => {
    mocks.state.useExternal = true;

    const result = await getSessionEngine().updateModel('channel-model', { imConfigSync: true });

    expect(result).toEqual({ success: true });
    expect(mocks.setExternalModel).toHaveBeenCalledWith('channel-model', { imConfigSync: true });
  });

  it('passes metadataBirthPending into external IM sends', async () => {
    mocks.state.useExternal = true;

    await getSessionEngine().enqueueImMessage({
      message: 'hello from im',
      requestId: 'req-1',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      metadataBirthPending: true,
    });

    expect(mocks.sendExternalMessage).toHaveBeenCalledWith(
      'hello from im',
      undefined,
      undefined,
      undefined,
      expect.objectContaining({
        sessionId: 'sid',
        workspacePath: '/workspace',
        requestId: 'req-1',
        metadataBirthPending: true,
      }),
    );
  });

  it('updates official tool ids through the builtin engine owner', async () => {
    const result = await getSessionEngine().updateOfficialToolIds(['image-understanding']);

    expect(result).toEqual({ success: true });
    expect(mocks.setSessionEnabledOfficialToolIds).toHaveBeenCalledWith(['image-understanding']);
    expect(mocks.updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('updates official tool ids through the external engine owner', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.getExternalSessionState.mockReturnValueOnce('idle');

    const result = await getSessionEngine().updateOfficialToolIds([]);

    expect(result).toEqual({ success: true });
    expect(mocks.updateSessionMetadata).not.toHaveBeenCalled();
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
  });

  it('stops an idle live external runtime process before applying tool config boundaries', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;
    mocks.getExternalSessionState.mockReturnValueOnce('idle');

    const result = await getSessionEngine().updateOfficialToolIds([]);

    expect(result).toEqual({ success: true });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
  });

  it('stops an idle live external runtime process before committing desktop materialization', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;
    mocks.getExternalSessionId.mockReturnValueOnce('runtime-thread-id');

    const result = await getSessionEngine().materializePendingDesktopSession({
      workspacePath: '/workspace',
      phase: 'commit',
      preparedSessionId: 'builtin-session',
    });

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.materializePendingDesktopSession.mock.invocationCallOrder[0]);
    expect(mocks.updateSessionMetadata).toHaveBeenCalledWith('builtin-session', { runtimeSessionId: 'runtime-thread-id' });
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('builtin-session', '/workspace', { type: 'desktop' });
  });

  it('stops the external runtime when an injected turn times out', async () => {
    mocks.state.useExternal = true;
    mocks.sendExternalMessage.mockResolvedValueOnce({ queued: true });
    mocks.waitForExternalSessionIdle.mockResolvedValueOnce(false);

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      error: 'Execution timed out',
    });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.didLastTurnSucceed).not.toHaveBeenCalled();
  });

  it('serializes external desktop reset against an in-flight runtime start', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;

    const result = await getSessionEngine().resetForNewDesktopSession('/workspace');

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.resetSession).toHaveBeenCalledTimes(1);
    expect(mocks.awaitExternalSessionStarting.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.stopExternalSession.mock.invocationCallOrder[0]);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resetSession.mock.invocationCallOrder[0]);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('builtin-session', '/workspace', { type: 'desktop' });
  });

  it('stops an idle live external runtime process before desktop reset mints a new session', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;

    const result = await getSessionEngine().resetForNewDesktopSession('/workspace');

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.resetSession).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resetSession.mock.invocationCallOrder[0]);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('builtin-session', '/workspace', { type: 'desktop' });
  });

  it('restores external switch when lifecycle is bound but transcript state is not seeded', async () => {
    mocks.state.useExternal = true;
    mocks.getCurrentBoundSessionId.mockReturnValueOnce('target-session');
    mocks.isExternalSessionStateRestoredFor.mockReturnValueOnce(false);

    const result = await getSessionEngine().switchToExistingSession(
      'target-session',
      '/workspace',
      (sessionId) => ({
        id: sessionId,
        agentDir: '/workspace',
        title: 'Target',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        runtime: 'codex',
      }),
    );

    expect(result).toEqual({ success: true, sessionId: 'target-session' });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('target-session', '/workspace', { type: 'desktop' });
  });

  it('stops an idle live external runtime process before switching external history sessions', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;

    const result = await getSessionEngine().switchToExistingSession(
      'target-session',
      '/workspace',
      (sessionId) => ({
        id: sessionId,
        agentDir: '/workspace',
        title: 'Target',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        runtime: 'codex',
      }),
    );

    expect(result).toEqual({ success: true, sessionId: 'target-session' });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.restoreExternalSessionState.mock.invocationCallOrder[0]);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('target-session', '/workspace', { type: 'desktop' });
  });

  it('rejects external history switches across Codex runtime sources', async () => {
    mocks.state.useExternal = true;
    mocks.getActiveRuntimeSource.mockReturnValueOnce('managed-provider');

    const result = await getSessionEngine().switchToExistingSession(
      'system-codex-session',
      '/workspace',
      (sessionId) => ({
        id: sessionId,
        agentDir: '/workspace',
        title: 'System Codex',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        runtime: 'codex',
        runtimeSource: 'system-cli',
      }),
    );

    expect(result).toMatchObject({
      success: false,
      status: 409,
      error: 'Session runtime source mismatch: persisted=system-cli, current=managed-provider',
    });
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).not.toHaveBeenCalled();
  });

  it('does not restore an external switch once an in-flight target start finishes seeded', async () => {
    mocks.state.useExternal = true;
    mocks.getCurrentBoundSessionId.mockReturnValue('target-session');
    mocks.isExternalSessionStateRestoredFor
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const getMetadata = vi.fn();

    const result = await getSessionEngine().switchToExistingSession(
      'target-session',
      '/workspace',
      getMetadata,
    );

    expect(result).toEqual({ success: true, sessionId: 'target-session' });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(getMetadata).not.toHaveBeenCalled();
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).not.toHaveBeenCalled();
  });

  it('freezes the current builtin IM session before resetting to a new IM session', async () => {
    const result = await getSessionEngine().resetForNewImSession('/workspace');

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledTimes(1);
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledWith(undefined, {
      allowMissingMetadata: false,
    });
    expect(mocks.resetSession).toHaveBeenCalledTimes(1);
    expect(mocks.materializeCurrentSessionMetadataForPublishedReset).toHaveBeenCalledTimes(1);
    expect(mocks.freezeCurrentSessionMetadataForImDetach.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resetSession.mock.invocationCallOrder[0]);
    expect(mocks.resetSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.materializeCurrentSessionMetadataForPublishedReset.mock.invocationCallOrder[0]);
  });

  it('freezes the current external IM session with external runtime config before reset', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.getActiveRuntimeType.mockReturnValueOnce('codex');
    mocks.getExternalSessionModel.mockReturnValueOnce('gpt-5');
    mocks.getExternalSessionPermissionMode.mockReturnValueOnce('no-restrictions');
    mocks.getExternalSessionReasoningEffort.mockReturnValueOnce('medium');

    const result = await getSessionEngine().resetForNewImSession('/workspace');

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledWith(
      {
        runtime: 'codex',
        runtimeSource: 'system-cli',
        model: 'gpt-5',
        permissionMode: 'no-restrictions',
        reasoningEffort: 'medium',
      },
      {
        allowMissingMetadata: false,
      },
    );
    expect(mocks.freezeCurrentSessionMetadataForImDetach.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.stopExternalSession.mock.invocationCallOrder[0]);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resetSession.mock.invocationCallOrder[0]);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('builtin-session', '/workspace', { type: 'desktop' });
  });

  it('stops an idle live external runtime process before external IM reset', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;

    const result = await getSessionEngine().resetForNewImSession('/workspace');

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resetSession.mock.invocationCallOrder[0]);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('builtin-session', '/workspace', { type: 'desktop' });
  });

  it('freezes the current external IM session through the engine facade', async () => {
    mocks.state.useExternal = true;
    mocks.getActiveRuntimeSource.mockReturnValueOnce('managed-provider');

    const result = await getSessionEngine().freezeCurrentSessionForImDetach({
      metadataBirthPending: true,
    });

    expect(result).toEqual({ success: true, sessionId: 'old-im-session' });
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledWith(
      {
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        model: 'gpt-5',
        permissionMode: 'no-restrictions',
        reasoningEffort: 'medium',
        providerExecutionIdentity: {
          kind: 'runtime-backed-provider',
          providerId: 'codex-sub',
          runtime: 'codex',
          runtimeSource: 'managed-provider',
          model: 'gpt-5',
        },
      },
      {
        allowMissingMetadata: true,
      },
    );
  });

  it('allows freezing explicit unindexed IM sessions with missing metadata', async () => {
    const result = await getSessionEngine().freezeCurrentSessionForImDetach({
      metadataBirthPending: false,
      metadataIndexed: false,
    });

    expect(result).toEqual({ success: true, sessionId: 'old-im-session' });
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledWith(undefined, {
      allowMissingMetadata: true,
    });
  });

  it('routes permission responses by external liveness compatibility', () => {
    mocks.state.useExternal = true;

    mocks.state.externalActive = false;
    expect(getPermissionResponseEngine().kind).toBe('builtin');

    mocks.state.externalActive = true;
    expect(getPermissionResponseEngine().kind).toBe('external');
  });

  it('routes AskUserQuestion responses by pending external request ownership', () => {
    mocks.state.useExternal = true;

    mocks.state.pendingExternalAsk = false;
    expect(getAskUserQuestionResponseEngine('ask-1').kind).toBe('builtin');

    mocks.state.pendingExternalAsk = true;
    expect(getAskUserQuestionResponseEngine('ask-1').kind).toBe('external');
  });
});
